import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/httpErrors.js';
import { canTransition } from './jobStateService.js';

const YOUTUBE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const YOUTUBE_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
const YOUTUBE_THUMBNAILS_SET_URL = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';
const YOUTUBE_PLAYLIST_ITEMS_URL = 'https://www.googleapis.com/youtube/v3/playlistItems';
const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const YOUTUBE_UPDATE_SCOPES = new Set([
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtubepartner',
]);
const ACTIVE_UPLOAD_STATUSES = new Set(['queued', 'retrying', 'uploading']);
const PRIVACY_STATUSES = new Set(['private', 'public', 'unlisted']);

export function createYouTubePublisherService(options = {}) {
  const repository = options.repository;
  const jobStateService = options.jobStateService;
  const youtubeOAuthService = options.youtubeOAuthService;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const serviceConfig = options.config ?? config.youtube;
  const localDataDir = options.localDataDir ?? config.localDataDir;
  const clock = options.clock ?? (() => new Date().toISOString());
  const activeUploads = new Map();

  if (!repository || !jobStateService || !youtubeOAuthService) {
    throw new TypeError('createYouTubePublisherService requires repository, jobStateService, and youtubeOAuthService');
  }

  function enqueueAttempt(attemptId) {
    if (activeUploads.has(attemptId)) {
      return { queued: false, alreadyRunning: true };
    }

    const upload = publishAttempt(attemptId)
      .catch(async (error) => {
        await markAttemptFailed(attemptId, error);
      })
      .finally(() => {
        activeUploads.delete(attemptId);
      });
    activeUploads.set(attemptId, upload);
    return { queued: true };
  }

  async function resumeQueuedAttempts() {
    const attempts = await repository.listPublishAttempts();
    const youtubeAttempts = attempts.filter(
      (attempt) => attempt.platform === 'youtube' && ACTIVE_UPLOAD_STATUSES.has(attempt.status),
    );
    for (const attempt of youtubeAttempts) {
      await enqueueAttempt(attempt.id);
    }
    return { queued: youtubeAttempts.length };
  }

  async function publishAttempt(attemptId) {
    const context = await buildAttemptContext(attemptId);
    const accessToken = await getAccessToken(context.account, {
      allowedScopes: new Set([YOUTUBE_UPLOAD_SCOPE, 'https://www.googleapis.com/auth/youtube']),
      requiredScopeLabel: YOUTUBE_UPLOAD_SCOPE,
      operation: 'upload videos',
    });
    await updateAttemptProgress(context.attempt.id, {
      status: 'uploading',
      stage: 'uploading',
      percent: 12,
      label: 'Starting YouTube resumable upload.',
      uploadedBytes: 0,
      totalBytes: context.video.sizeBytes,
    });

    const metadata = buildVideoResource(context, serviceConfig);
    const uploadUrl = await initiateResumableUpload({
      accessToken,
      metadata,
      mimeType: context.video.mimeType,
      sizeBytes: context.video.sizeBytes,
    });

    await updateAttemptProgress(context.attempt.id, {
      status: 'uploading',
      stage: 'uploading',
      percent: 15,
      label: 'YouTube upload session created.',
      uploadedBytes: 0,
      totalBytes: context.video.sizeBytes,
      patch: {
        uploadSessionCreatedAt: clock(),
        uploadSessionUrl: uploadUrl,
      },
    });

    const response = await uploadFileChunks({
      accessToken,
      attemptId: context.attempt.id,
      filePath: context.video.filePath,
      mimeType: context.video.mimeType,
      sizeBytes: context.video.sizeBytes,
    });

    const videoId = response.id;
    if (!videoId) {
      throw conflict('YouTube upload completed without a video id', { response });
    }

    const providerUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const thumbnailResult = await applyYouTubeThumbnailIfAvailable({ context, accessToken, videoId });
    await repository.updatePublishAttempt(context.attempt.id, {
      status: 'published',
      providerPostId: videoId,
      providerUrl,
      errorCode: null,
      errorMessage: null,
      metadata: {
        ...(context.attempt.metadata ?? {}),
        ...progressMetadata({
          stage: 'published',
          percent: 100,
          label: 'YouTube upload completed.',
          uploadedBytes: context.video.sizeBytes,
          totalBytes: context.video.sizeBytes,
        }),
        accountName: context.account.accountName,
        providerAccountId: context.account.providerAccountId ?? null,
        title: metadata.snippet.title,
        description: metadata.snippet.description,
        tags: metadata.snippet.tags ?? [],
        hashtags: Array.isArray(context.attempt.metadata?.hashtags) ? context.attempt.metadata.hashtags : [],
        thumbnailArtifactId: context.thumbnail?.artifact.id ?? context.attempt.metadata?.thumbnailArtifactId ?? null,
        thumbnailUrl: context.attempt.metadata?.thumbnailUrl ?? context.plan.metadata?.thumbnailUrl ?? context.job.metadata?.thumbnailUrl ?? null,
        thumbnailSource: context.attempt.metadata?.thumbnailSource ?? context.plan.metadata?.thumbnailSource ?? context.job.metadata?.thumbnailSource ?? null,
        privacyStatus: response.status?.privacyStatus ?? metadata.status.privacyStatus,
        youtube: {
          videoId,
          watchUrl: providerUrl,
          uploadStatus: response.status?.uploadStatus ?? null,
          privacyStatus: response.status?.privacyStatus ?? metadata.status.privacyStatus,
          thumbnail: thumbnailResult,
          response,
        },
      },
    });

    await reconcilePlanAndJob(context.plan.id);
    return { videoId, providerUrl, response };
  }

  async function updatePrivacy(attemptId, privacyStatus, context = {}) {
    const nextPrivacyStatus = normalizePrivacyStatus(privacyStatus);
    const attempt = await repository.getPublishAttempt(attemptId);
    if (!attempt) throw notFound('Publication not found', { attemptId });
    if (attempt.platform !== 'youtube') {
      throw badRequest('Privacy changes are only wired for YouTube publications right now', {
        attemptId,
        platform: attempt.platform,
      });
    }
    const videoId = attempt.providerPostId ?? attempt.metadata?.youtube?.videoId;
    if (!videoId) {
      const updated = await repository.updatePublishAttempt(attempt.id, {
        metadata: {
          ...(attempt.metadata ?? {}),
          privacyStatus: nextPrivacyStatus,
          publisherStatus: `Visibility will be set to ${nextPrivacyStatus} when upload completes.`,
          adminUpdatedAt: clock(),
          adminUpdatedBy: context.actorUid ?? null,
        },
      });
      return { publication: updated, providerUpdated: false };
    }

    const account = attempt.connectedAccountId ? await repository.getSocialAccount(attempt.connectedAccountId) : null;
    if (!account) throw conflict('No connected YouTube account is assigned to this publication', { attemptId });
    const accessToken = await getAccessToken(account, {
      allowedScopes: YOUTUBE_UPDATE_SCOPES,
      requiredScopeLabel: 'https://www.googleapis.com/auth/youtube.force-ssl',
      operation: 'update YouTube video visibility',
    });
    const currentStatus = await fetchVideoStatus(accessToken, videoId);
    const response = await updateVideoStatus(accessToken, videoId, {
      ...currentStatus,
      privacyStatus: nextPrivacyStatus,
    });

    const providerPrivacyStatus = response.status?.privacyStatus ?? nextPrivacyStatus;
    const updated = await repository.updatePublishAttempt(attempt.id, {
      metadata: {
        ...(attempt.metadata ?? {}),
        privacyStatus: providerPrivacyStatus,
        publisherStatus: `YouTube visibility set to ${providerPrivacyStatus}.`,
        adminUpdatedAt: clock(),
        adminUpdatedBy: context.actorUid ?? null,
        youtube: {
          ...(attempt.metadata?.youtube ?? {}),
          videoId,
          privacyStatus: providerPrivacyStatus,
          privacyUpdatedAt: clock(),
          privacyUpdateResponse: response,
        },
      },
    });
    return { publication: updated, providerUpdated: true, response };
  }

  async function updateMetadata(attemptId, metadataPatch, context = {}) {
    const attempt = await repository.getPublishAttempt(attemptId);
    if (!attempt) throw notFound('Publication not found', { attemptId });
    if (attempt.platform !== 'youtube') {
      throw badRequest('Metadata changes are only wired for YouTube publications in the YouTube publisher service', {
        attemptId,
        platform: attempt.platform,
      });
    }

    const metadata = {
      ...(attempt.metadata ?? {}),
      ...(metadataPatch ?? {}),
      adminUpdatedAt: clock(),
      adminUpdatedBy: context.actorUid ?? null,
    };
    const videoId = attempt.providerPostId ?? metadata.youtube?.videoId;
    if (!videoId) {
      const updated = await repository.updatePublishAttempt(attempt.id, {
        metadata: {
          ...metadata,
          publisherStatus: 'YouTube metadata will be applied when upload completes.',
        },
      });
      return { publication: updated, providerUpdated: false };
    }

    const account = attempt.connectedAccountId ? await repository.getSocialAccount(attempt.connectedAccountId) : null;
    if (!account) throw conflict('No connected YouTube account is assigned to this publication', { attemptId });
    const accessToken = await getAccessToken(account, {
      allowedScopes: YOUTUBE_UPDATE_SCOPES,
      requiredScopeLabel: 'https://www.googleapis.com/auth/youtube.force-ssl',
      operation: 'update YouTube video metadata',
    });

    const currentVideo = await fetchVideoResource(accessToken, videoId);
    const response = await updateVideoMetadata(accessToken, videoId, {
      snippet: buildUpdatedSnippet(currentVideo.snippet, metadata, serviceConfig),
      status: sanitizeMutableVideoStatus({
        ...(currentVideo.status ?? {}),
        privacyStatus: metadata.privacyStatus ?? currentVideo.status?.privacyStatus,
      }),
    });

    const [plan, job] = await Promise.all([
      repository.getPublishPlan(attempt.planId),
      repository.getJob(attempt.jobId),
    ]);
    let thumbnailResult = null;
    if (plan && job) {
      const thumbnail = await resolveThumbnailArtifact({
        job,
        plan,
        attempt: {
          ...attempt,
          metadata,
        },
      });
      if (thumbnail?.filePath) {
        try {
          const thumbnailResponse = await uploadYouTubeThumbnail({ accessToken, videoId, thumbnail });
          thumbnailResult = {
            status: 'uploaded',
            artifactId: thumbnail.artifact.id,
            response: thumbnailResponse,
          };
        } catch (error) {
          thumbnailResult = {
            status: 'failed',
            artifactId: thumbnail.artifact.id,
            error: sanitizeError(error),
          };
        }
      }
    }

    const updated = await repository.updatePublishAttempt(attempt.id, {
      metadata: {
        ...metadata,
        title: metadata.title ?? response.snippet?.title ?? currentVideo.snippet?.title ?? '',
        description: metadata.description ?? attempt.metadata?.description ?? '',
        tags: Array.isArray(metadata.tags) ? metadata.tags : response.snippet?.tags ?? [],
        hashtags: Array.isArray(metadata.hashtags) ? metadata.hashtags : attempt.metadata?.hashtags ?? [],
        privacyStatus: response.status?.privacyStatus ?? metadata.privacyStatus ?? currentVideo.status?.privacyStatus,
        publisherStatus:
          thumbnailResult?.status === 'failed'
            ? 'YouTube metadata updated. Thumbnail update failed.'
            : 'YouTube metadata updated.',
        youtube: {
          ...(attempt.metadata?.youtube ?? {}),
          videoId,
          watchUrl: attempt.providerUrl ?? `https://www.youtube.com/watch?v=${videoId}`,
          privacyStatus: response.status?.privacyStatus ?? metadata.privacyStatus ?? currentVideo.status?.privacyStatus,
          metadataUpdatedAt: clock(),
          metadataUpdateResponse: response,
          thumbnail: thumbnailResult ?? attempt.metadata?.youtube?.thumbnail ?? null,
        },
      },
    });
    return { publication: updated, providerUpdated: true, response, thumbnail: thumbnailResult };
  }

  async function deletePublication(attemptId, context = {}) {
    const attempt = await repository.getPublishAttempt(attemptId);
    if (!attempt) throw notFound('Publication not found', { attemptId });
    if (attempt.platform !== 'youtube') {
      throw badRequest('Deletion is only wired for YouTube publications in the YouTube publisher service', {
        attemptId,
        platform: attempt.platform,
      });
    }
    const deletingAttempt = await markPublicationDeleteRequested(attempt, context, 'Deleting YouTube video.');

    try {
      const videoId = deletingAttempt.providerPostId ?? deletingAttempt.metadata?.youtube?.videoId;
      if (!videoId) {
        return markPublicationDeleted(deletingAttempt, {
          providerDeleted: false,
          context,
          message: 'No YouTube video id was stored; marked deleted in NewLeaf only.',
        });
      }

      const account = deletingAttempt.connectedAccountId ? await repository.getSocialAccount(deletingAttempt.connectedAccountId) : null;
      if (!account) throw conflict('No connected YouTube account is assigned to this publication', { attemptId });
      const accessToken = await getAccessToken(account, {
        allowedScopes: YOUTUBE_UPDATE_SCOPES,
        requiredScopeLabel: 'https://www.googleapis.com/auth/youtube.force-ssl',
        operation: 'delete YouTube videos',
      });
      const response = await deleteVideo(accessToken, videoId);
      return markPublicationDeleted(deletingAttempt, {
        providerDeleted: true,
        context,
        message: 'YouTube video deleted.',
        providerResponse: response,
        providerPatch: {
          youtube: {
            ...(deletingAttempt.metadata?.youtube ?? {}),
            videoId,
            deletedAt: clock(),
            deleteResponse: response,
          },
        },
      });
    } catch (error) {
      await markPublicationDeleteFailed(attempt, error, context);
      throw error;
    }
  }

  async function importChannelPublications({ accountId = null, maxResults = Number.POSITIVE_INFINITY, actorUid = 'local-admin' } = {}) {
    const account = accountId
      ? await repository.getSocialAccount(accountId)
      : await resolveDefaultYouTubeAccount();
    if (!account) throw conflict('No connected YouTube account is available for channel sync');
    if (account.platform !== 'youtube') {
      throw badRequest('Channel sync requires a YouTube account', { accountId: account.id, platform: account.platform });
    }

    const accessToken = await getAccessToken(account, {
      allowedScopes: new Set([YOUTUBE_READONLY_SCOPE, 'https://www.googleapis.com/auth/youtube']),
      requiredScopeLabel: YOUTUBE_READONLY_SCOPE,
      operation: 'sync channel videos',
    });
    const channel = account.metadata?.channel?.uploadsPlaylistId
      ? account.metadata.channel
      : await youtubeOAuthService.fetchMyChannel(accessToken);
    if (!account.metadata?.channel?.uploadsPlaylistId && channel?.id) {
      await repository.upsertSocialAccount({
        ...account,
        metadata: {
          ...(account.metadata ?? {}),
          channel,
          channelSyncedAt: clock(),
        },
      });
    }
    const uploadsPlaylistId = channel?.uploadsPlaylistId;
    if (!uploadsPlaylistId) {
      throw conflict('Unable to find the YouTube uploads playlist for this account', { accountId: account.id });
    }

    const playlistItems = await fetchUploadsPlaylistItems(accessToken, uploadsPlaylistId, maxResults);
    const videoIds = playlistItems
      .map((item) => item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId)
      .filter(Boolean);
    const videos = await fetchVideosById(accessToken, videoIds);
    const existingAttempts = await repository.listPublishAttempts({ platform: 'youtube' });
    const existingByVideoId = new Map(
      existingAttempts
        .filter((attempt) => attempt.providerPostId || attempt.metadata?.youtube?.videoId)
        .map((attempt) => [attempt.providerPostId ?? attempt.metadata.youtube.videoId, attempt]),
    );

    const publications = [];
    let imported = 0;
    let updated = 0;
    for (const videoId of videoIds) {
      const video = videos.get(videoId);
      const playlistItem = playlistItems.find(
        (item) => (item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId) === videoId,
      );
      if (!video && !playlistItem) continue;

      const existing = existingByVideoId.get(videoId);
      const publication = existing
        ? await updateImportedPublication(existing, { repository, account, video, playlistItem, clock })
        : await createImportedPublication({ repository, account, videoId, video, playlistItem, actorUid, clock });
      publications.push(publication);
      if (existing) {
        updated += 1;
      } else {
        imported += 1;
      }
    }

    return {
      account,
      publications,
      imported,
      updated,
      scanned: playlistItems.length,
      uploadsPlaylistId,
    };
  }

  async function buildAttemptContext(attemptId) {
    const attempt = await repository.getPublishAttempt(attemptId);
    if (!attempt) throw notFound('Publish attempt not found', { attemptId });
    if (attempt.platform !== 'youtube') {
      throw badRequest('Publish attempt is not a YouTube attempt', { attemptId, platform: attempt.platform });
    }

    const [plan, job] = await Promise.all([
      repository.getPublishPlan(attempt.planId),
      repository.getJob(attempt.jobId),
    ]);
    if (!plan) throw notFound('Publish plan not found', { planId: attempt.planId });
    if (!job) throw notFound('Job not found', { jobId: attempt.jobId });

    const account = attempt.connectedAccountId ? await repository.getSocialAccount(attempt.connectedAccountId) : null;
    if (!account) {
      throw conflict('No connected YouTube account is assigned to this publish attempt', {
        attemptId,
        connectedAccountId: attempt.connectedAccountId,
      });
    }
    if (account.platform !== 'youtube') {
      throw conflict('Assigned account is not a YouTube account', {
        attemptId,
        connectedAccountId: account.id,
        platform: account.platform,
      });
    }

    const video = await resolveVideoArtifact(job);
    const thumbnail = await resolveThumbnailArtifact({ job, plan, attempt });
    return { attempt, plan, job, account, video, thumbnail };
  }

  async function resolveVideoArtifact(job) {
    const artifacts = await repository.listArtifactsForJob(job.id);
    const artifact =
      artifacts.find((candidate) => candidate.id === job.currentVideoArtifactId) ??
      latestByDate(artifacts.filter((candidate) => candidate.kind === 'video'));
    if (!artifact) {
      throw conflict('No video artifact is available for this job', { jobId: job.id });
    }
    if (artifact.storageProvider !== 'local-disk') {
      throw conflict('Only local-disk video artifacts can be uploaded to YouTube in local mode', {
        artifactId: artifact.id,
        storageProvider: artifact.storageProvider,
      });
    }

    const rootDir = path.resolve(process.cwd(), localDataDir);
    const candidatePath = artifact.metadata?.localPath
      ? path.resolve(artifact.metadata.localPath)
      : path.resolve(rootDir, artifact.storageKey);
    if (!isPathInside(rootDir, candidatePath)) {
      throw conflict('Video artifact path is outside local storage', { artifactId: artifact.id });
    }

    const stat = await fsp.stat(candidatePath);
    return {
      artifact,
      filePath: candidatePath,
      mimeType: artifact.mimeType || 'video/mp4',
      sizeBytes: stat.size,
    };
  }

  async function resolveDefaultYouTubeAccount() {
    const accounts = await repository.listSocialAccounts({ platform: 'youtube' });
    return (
      accounts.find((account) => isUsableConnectedAccount(account) && account.tokenSecretRef) ??
      accounts.find(isUsableConnectedAccount) ??
      null
    );
  }

  async function resolveThumbnailArtifact({ job, plan, attempt }) {
    const metadata = {
      ...(job.metadata ?? {}),
      ...(plan.metadata ?? {}),
      ...(attempt.metadata ?? {}),
    };
    const artifacts = await repository.listArtifactsForJob(job.id);
    const artifact =
      artifacts.find((candidate) => candidate.id === metadata.thumbnailArtifactId && candidate.kind === 'thumbnail') ??
      latestByDate(artifacts.filter((candidate) => candidate.kind === 'thumbnail'));
    if (!artifact || artifact.storageProvider !== 'local-disk') {
      return null;
    }

    const rootDir = path.resolve(process.cwd(), localDataDir);
    const candidatePath = artifact.metadata?.localPath
      ? path.resolve(artifact.metadata.localPath)
      : path.resolve(rootDir, artifact.storageKey);
    if (!isPathInside(rootDir, candidatePath)) {
      throw conflict('Thumbnail artifact path is outside local storage', { artifactId: artifact.id });
    }

    const stat = await fsp.stat(candidatePath);
    return {
      artifact,
      filePath: candidatePath,
      mimeType: artifact.mimeType || 'image/jpeg',
      sizeBytes: stat.size,
    };
  }

  async function applyYouTubeThumbnailIfAvailable({ context, accessToken, videoId }) {
    if (!context.thumbnail?.filePath) {
      return null;
    }

    await updateAttemptProgress(context.attempt.id, {
      status: 'processing',
      stage: 'provider_processing',
      percent: 94,
      label: 'Uploading selected YouTube thumbnail.',
      uploadedBytes: context.video.sizeBytes,
      totalBytes: context.video.sizeBytes,
    });

    try {
      const response = await uploadYouTubeThumbnail({
        accessToken,
        videoId,
        thumbnail: context.thumbnail,
      });
      return {
        status: 'uploaded',
        artifactId: context.thumbnail.artifact.id,
        response,
      };
    } catch (error) {
      return {
        status: 'failed',
        artifactId: context.thumbnail.artifact.id,
        error: sanitizeError(error),
      };
    }
  }

  async function getAccessToken(account, { allowedScopes, requiredScopeLabel, operation }) {
    if (!account.tokenSecretRef) {
      throw conflict('YouTube account does not have an OAuth token secret', { accountId: account.id });
    }

    const secret = await repository.getSecret(account.tokenSecretRef);
    if (!secret?.value) {
      throw conflict('YouTube OAuth token secret was not found', {
        accountId: account.id,
        tokenSecretRef: account.tokenSecretRef,
      });
    }

    const token = secret.value;
    const refreshToken = token.refreshToken;
    if (refreshToken) {
      const refreshed = await youtubeOAuthService.refreshAccessToken(refreshToken);
      const mergedValue = {
        ...token,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? refreshToken,
        tokenType: refreshed.tokenType,
        expiresAt: refreshed.expiresAt,
        scope: refreshed.scope ?? token.scope,
      };
      await repository.putSecret({
        id: secret.id,
        provider: secret.provider,
        kind: secret.kind,
        value: mergedValue,
        metadata: {
          ...(secret.metadata ?? {}),
          scopes: refreshed.scopes.length ? refreshed.scopes : secret.metadata?.scopes ?? [],
          refreshedAt: clock(),
          hasRefreshToken: true,
        },
      });
      assertRequiredScope(mergedValue.scope, refreshed.scopes.length ? refreshed.scopes : secret.metadata?.scopes ?? [], {
        allowedScopes,
        requiredScopeLabel,
        operation,
      });
      return refreshed.accessToken;
    }

    if (token.accessToken && !isExpired(token.expiresAt)) {
      assertRequiredScope(token.scope, secret.metadata?.scopes ?? [], { allowedScopes, requiredScopeLabel, operation });
      return token.accessToken;
    }

    throw conflict('YouTube OAuth token cannot be refreshed. Reconnect the account from Accounts.', {
      accountId: account.id,
      tokenHealth: account.tokenHealth,
    });
  }

  function assertRequiredScope(scope, scopes = [], { allowedScopes, requiredScopeLabel, operation }) {
    const granted = new Set([
      ...String(scope ?? '').split(/\s+/).filter(Boolean),
      ...(Array.isArray(scopes) ? scopes : []),
    ]);
    if (!Array.from(allowedScopes).some((candidate) => granted.has(candidate))) {
      throw conflict(`Connected YouTube account is missing the scope required to ${operation}. Reconnect the account.`, {
        requiredScope: requiredScopeLabel,
        grantedScopes: Array.from(granted),
      });
    }
  }

  async function fetchVideoStatus(accessToken, videoId) {
    const url = new URL(YOUTUBE_VIDEOS_URL);
    url.searchParams.set('part', 'status');
    url.searchParams.set('id', videoId);
    const response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw conflict('Unable to read YouTube video status', {
        status: response.status,
        response: payload,
      });
    }
    const status = payload.items?.[0]?.status;
    if (!status) {
      throw notFound('YouTube video was not found for this account', { videoId });
    }
    return sanitizeMutableVideoStatus(status);
  }

  async function fetchVideoResource(accessToken, videoId) {
    const url = new URL(YOUTUBE_VIDEOS_URL);
    url.searchParams.set('part', 'snippet,status');
    url.searchParams.set('id', videoId);
    const response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw conflict('Unable to read YouTube video metadata', {
        status: response.status,
        response: payload,
      });
    }
    const video = payload.items?.[0];
    if (!video) {
      throw notFound('YouTube video was not found for this account', { videoId });
    }
    return video;
  }

  async function uploadYouTubeThumbnail({ accessToken, videoId, thumbnail }) {
    const url = new URL(YOUTUBE_THUMBNAILS_SET_URL);
    url.searchParams.set('videoId', videoId);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': thumbnail.mimeType,
      },
      body: await fsp.readFile(thumbnail.filePath),
    });
    const payload = await readResponseBody(response);
    assertProviderOk(response, payload, 'Unable to upload YouTube thumbnail');
    return payload;
  }

  async function updateVideoStatus(accessToken, videoId, status) {
    const url = new URL(YOUTUBE_VIDEOS_URL);
    url.searchParams.set('part', 'status');
    const body = {
      id: videoId,
      status: sanitizeMutableVideoStatus(status),
    };
    const response = await fetchImpl(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw conflict('Unable to update YouTube video visibility', {
        status: response.status,
        response: payload,
      });
    }
    return payload;
  }

  async function updateVideoMetadata(accessToken, videoId, { snippet, status }) {
    const url = new URL(YOUTUBE_VIDEOS_URL);
    url.searchParams.set('part', 'snippet,status');
    const body = {
      id: videoId,
      snippet,
      status: sanitizeMutableVideoStatus(status),
    };
    const response = await fetchImpl(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw conflict('Unable to update YouTube video metadata', {
        status: response.status,
        response: payload,
      });
    }
    return payload;
  }

  async function deleteVideo(accessToken, videoId) {
    const url = new URL(YOUTUBE_VIDEOS_URL);
    url.searchParams.set('id', videoId);
    const response = await fetchImpl(url, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });
    if (response.status === 204) {
      return { deleted: true, status: 204 };
    }
    const payload = await readResponseBody(response);
    if (response.status === 404) {
      return { deleted: true, alreadyMissing: true, status: 404, response: payload };
    }
    throw conflict('Unable to delete YouTube video', {
      status: response.status,
      response: payload,
    });
  }

  async function fetchUploadsPlaylistItems(accessToken, playlistId, maxResults) {
    const limit = Number.isFinite(Number(maxResults)) ? Math.max(0, Number(maxResults)) : Number.POSITIVE_INFINITY;
    const items = [];
    let pageToken = null;
    while (items.length < limit) {
      const url = new URL(YOUTUBE_PLAYLIST_ITEMS_URL);
      url.searchParams.set('part', 'snippet,contentDetails,status');
      url.searchParams.set('playlistId', playlistId);
      url.searchParams.set('maxResults', String(Math.min(50, limit - items.length)));
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const response = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw conflict('Unable to list YouTube channel uploads', {
          status: response.status,
          response: payload,
        });
      }

      items.push(...(payload.items ?? []));
      pageToken = payload.nextPageToken;
      if (!pageToken) break;
    }
    return items;
  }

  async function fetchVideosById(accessToken, videoIds) {
    const videos = new Map();
    for (const chunk of chunkArray(videoIds, 50)) {
      const url = new URL(YOUTUBE_VIDEOS_URL);
      url.searchParams.set('part', 'snippet,status,statistics,contentDetails');
      url.searchParams.set('id', chunk.join(','));
      const response = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw conflict('Unable to read YouTube video details', {
          status: response.status,
          response: payload,
        });
      }
      for (const video of payload.items ?? []) {
        videos.set(video.id, video);
      }
    }
    return videos;
  }

  async function initiateResumableUpload({ accessToken, metadata, mimeType, sizeBytes }) {
    const url = new URL(YOUTUBE_UPLOAD_URL);
    url.searchParams.set('uploadType', 'resumable');
    url.searchParams.set('part', 'snippet,status');

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(sizeBytes),
        'x-upload-content-type': mimeType,
      },
      body: JSON.stringify(metadata),
    });
    const location = response.headers.get('location');
    if (!response.ok || !location) {
      throw conflict('Unable to start YouTube resumable upload', {
        status: response.status,
        response: await readResponseBody(response),
      });
    }
    return location;
  }

  async function uploadFileChunks({ accessToken, attemptId, filePath, mimeType, sizeBytes }) {
    const chunkSize = Math.max(256 * 1024, Number(serviceConfig.uploadChunkBytes) || 8 * 1024 * 1024);
    let start = 0;
    let finalResponse = null;

    while (start < sizeBytes) {
      const end = Math.min(start + chunkSize - 1, sizeBytes - 1);
      const contentLength = end - start + 1;
      const response = await fetchImpl(await getUploadSessionUrl(attemptId), {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-length': String(contentLength),
          'content-type': mimeType,
          'content-range': `bytes ${start}-${end}/${sizeBytes}`,
        },
        body: fs.createReadStream(filePath, { start, end }),
        duplex: 'half',
      });

      if (response.status === 308) {
        const uploadedBytes = uploadedBytesFromRange(response.headers.get('range')) ?? end + 1;
        start = uploadedBytes;
        await updateAttemptProgress(attemptId, {
          status: 'uploading',
          stage: 'uploading',
          percent: uploadPercent(uploadedBytes, sizeBytes),
          label: 'Uploading video bytes to YouTube.',
          uploadedBytes,
          totalBytes: sizeBytes,
        });
        continue;
      }

      if (response.ok) {
        finalResponse = await response.json().catch(() => ({}));
        await updateAttemptProgress(attemptId, {
          status: 'processing',
          stage: 'provider_processing',
          percent: 90,
          label: 'YouTube is processing the uploaded video.',
          uploadedBytes: sizeBytes,
          totalBytes: sizeBytes,
        });
        break;
      }

      throw conflict('YouTube chunk upload failed', {
        status: response.status,
        response: await readResponseBody(response),
      });
    }

    if (!finalResponse) {
      throw conflict('YouTube upload ended before a final response was received');
    }
    return finalResponse;
  }

  async function getUploadSessionUrl(attemptId) {
    const attempt = await repository.getPublishAttempt(attemptId);
    const sessionUrl = attempt?.metadata?.uploadSessionUrl;
    if (!sessionUrl) {
      throw conflict('YouTube upload session URL is missing', { attemptId });
    }
    return sessionUrl;
  }

  async function updateAttemptProgress(attemptId, { status, stage, percent, label, uploadedBytes, totalBytes, patch = {} }) {
    const attempt = await repository.getPublishAttempt(attemptId);
    if (!attempt) return null;
    const metadata = clearFailureMetadata(attempt.metadata);
    return repository.updatePublishAttempt(attemptId, {
      status,
      metadata: {
        ...metadata,
        ...progressMetadata({ stage, percent, label, uploadedBytes, totalBytes }),
        ...patch,
      },
    });
  }

  async function markAttemptFailed(attemptId, error) {
    const attempt = await repository.getPublishAttempt(attemptId);
    if (!attempt) return;
    await repository.updatePublishAttempt(attemptId, {
      status: 'failed',
      errorCode: error.name === 'HttpError' ? `http_${error.status}` : 'youtube_publish_failed',
      errorMessage: error.message,
      metadata: {
        ...(attempt.metadata ?? {}),
        ...progressMetadata({
          stage: 'failed',
          percent: 0,
          label: error.message,
          uploadedBytes: attempt.metadata?.uploadedBytes ?? null,
          totalBytes: attempt.metadata?.totalBytes ?? null,
        }),
        failureDetails: sanitizeError(error),
      },
    });
    await reconcilePlanAndJob(attempt.planId);
  }

  async function markPublicationDeleted(
    attempt,
    { providerDeleted, context = {}, message, providerResponse = null, providerPatch = {} },
  ) {
    const updated = await repository.updatePublishAttempt(attempt.id, {
      status: 'deleted',
      providerUrl: null,
      errorCode: null,
      errorMessage: null,
      metadata: {
        ...(attempt.metadata ?? {}),
        ...progressMetadata({
          stage: 'deleted',
          percent: 100,
          label: message,
          uploadedBytes: attempt.metadata?.uploadedBytes ?? null,
          totalBytes: attempt.metadata?.totalBytes ?? null,
        }),
        deletedAt: clock(),
        deletedBy: context.actorUid ?? null,
        deleteReason: context.reason ?? null,
        providerDeleted,
        providerDeleteResponse: providerResponse,
        ...providerPatch,
      },
    });
    await reconcilePlanAndJob(attempt.planId);
    return { publication: updated, providerDeleted, response: providerResponse };
  }

  async function markPublicationDeleteRequested(attempt, context = {}, label = 'Deleting video from channel.') {
    return repository.updatePublishAttempt(attempt.id, {
      status: 'delete_requested',
      metadata: {
        ...(attempt.metadata ?? {}),
        ...progressMetadata({
          stage: 'deleting',
          percent: 45,
          label,
          uploadedBytes: attempt.metadata?.uploadedBytes ?? null,
          totalBytes: attempt.metadata?.totalBytes ?? null,
        }),
        deleteRequest: {
          requestedAt: clock(),
          requestedBy: context.actorUid ?? null,
          reason: context.reason ?? null,
        },
      },
    });
  }

  async function markPublicationDeleteFailed(attempt, error, context = {}) {
    await repository.updatePublishAttempt(attempt.id, {
      status: attempt.status,
      errorCode: error.name === 'HttpError' ? `http_${error.status}` : 'youtube_delete_failed',
      errorMessage: error.message,
      metadata: {
        ...(attempt.metadata ?? {}),
        ...progressMetadata({
          stage: 'delete_failed',
          percent: 0,
          label: error.message,
          uploadedBytes: attempt.metadata?.uploadedBytes ?? null,
          totalBytes: attempt.metadata?.totalBytes ?? null,
        }),
        deleteFailedAt: clock(),
        deleteRequestedBy: context.actorUid ?? null,
        deleteFailureDetails: sanitizeError(error),
      },
    });
  }

  async function reconcilePlanAndJob(planId) {
    const plan = await repository.getPublishPlan(planId);
    if (!plan) return;
    const attempts = await repository.listPublishAttempts({ planId });
    if (attempts.length === 0) return;

    const allTerminal = attempts.every((attempt) => ['published', 'failed', 'delete_requested', 'deleted'].includes(attempt.status));
    const allDeleted = attempts.every((attempt) => attempt.status === 'deleted');
    const allPublished = attempts.every((attempt) => attempt.status === 'published');
    const hasFailed = attempts.some((attempt) => attempt.status === 'failed');
    const shouldArchiveAfterDelete =
      attempts.some((attempt) => attempt.status === 'deleted') &&
      attempts.every((attempt) => attempt.status === 'deleted' || (attempt.status === 'failed' && !attempt.providerPostId));

    if (allDeleted || shouldArchiveAfterDelete) {
      await repository.updatePublishPlan(planId, {
        status: 'deleted',
        metadata: {
          ...(plan.metadata ?? {}),
          archivedToAuditAt: clock(),
          archiveReason: allDeleted ? 'all_publications_deleted' : 'deleted_publications_with_failed_leftovers',
        },
      });
      return;
    }

    if (allPublished) {
      await repository.updatePublishPlan(planId, { status: 'published' });
      await transitionJobIfAllowed(plan.jobId, 'published', 'publish_complete');
      return;
    }

    if (allTerminal && hasFailed) {
      await repository.updatePublishPlan(planId, { status: 'partial_failed' });
      await transitionJobIfAllowed(plan.jobId, 'partial_failed', 'publish_partial_failed');
    }
  }

  async function transitionJobIfAllowed(jobId, nextStatus, reason) {
    const job = await repository.getJob(jobId);
    if (!job || job.status === nextStatus || !canTransition(job.status, nextStatus)) {
      return;
    }
    await jobStateService.transitionJob(jobId, nextStatus, {
      actorUid: 'youtube-publisher',
      reason,
    });
  }

  async function waitForAttempt(attemptId) {
    return activeUploads.get(attemptId) ?? null;
  }

  return {
    deletePublication,
    enqueueAttempt,
    importChannelPublications,
    publishAttempt,
    resumeQueuedAttempts,
    updateMetadata,
    updatePrivacy,
    waitForAttempt,
  };
}

function buildVideoResource({ attempt, plan, job }, serviceConfig = config.youtube) {
  const metadata = {
    ...(job.metadata ?? {}),
    ...(plan.metadata ?? {}),
    ...(attempt.metadata ?? {}),
  };
  const title = normalizeText(metadata.title ?? job.title, 100) || 'NewLeaf video';
  const description = normalizeText(
    appendHashtags(
      metadata.description ?? metadata.caption ?? job.metadata?.reviewSummary?.summary ?? '',
      metadata.hashtags,
      5000,
    ),
    5000,
  );
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 50)
    : [];

  return {
    snippet: {
      title,
      description,
      categoryId: String(metadata.categoryId ?? serviceConfig.defaultCategoryId),
      ...(tags.length > 0 ? { tags } : {}),
    },
    status: {
      privacyStatus: normalizePrivacyStatus(metadata.privacyStatus ?? serviceConfig.defaultPrivacyStatus),
      selfDeclaredMadeForKids: Boolean(metadata.selfDeclaredMadeForKids ?? false),
      containsSyntheticMedia: Boolean(metadata.containsSyntheticMedia ?? job.sourceType === 'text_to_heygen'),
    },
  };
}

function buildUpdatedSnippet(currentSnippet = {}, metadata = {}, serviceConfig = config.youtube) {
  const title = normalizeText(metadata.title ?? currentSnippet.title, 100) || 'NewLeaf video';
  const description = normalizeText(
    appendHashtags(metadata.description ?? currentSnippet.description ?? '', metadata.hashtags, 5000),
    5000,
  );
  let tagSource = [];
  if (Array.isArray(metadata.tags)) {
    tagSource = metadata.tags;
  } else if (Array.isArray(currentSnippet.tags)) {
    tagSource = currentSnippet.tags;
  }
  const tags = tagSource.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 50);
  const snippet = {
    title,
    description,
    categoryId: String(metadata.categoryId ?? currentSnippet.categoryId ?? serviceConfig.defaultCategoryId),
  };
  if (currentSnippet.defaultLanguage) snippet.defaultLanguage = currentSnippet.defaultLanguage;
  if (currentSnippet.defaultAudioLanguage) snippet.defaultAudioLanguage = currentSnippet.defaultAudioLanguage;
  if (tags.length > 0) snippet.tags = tags;
  return snippet;
}

function progressMetadata({ stage, percent, label, uploadedBytes, totalBytes }) {
  return {
    publisherStatus: label,
    progressStage: stage,
    progressPercent: percent,
    progressLabel: label,
    uploadedBytes,
    totalBytes,
    lastProgressAt: new Date().toISOString(),
  };
}

async function createImportedPublication({ repository, account, videoId, video, playlistItem, actorUid, clock }) {
  const metadata = buildImportedPublicationMetadata({ account, videoId, video, playlistItem, clock });
  const jobId = `external_youtube_${sanitizeExternalId(videoId)}`;
  const planId = `external_youtube_plan_${sanitizeExternalId(videoId)}`;
  const attemptId = `external_youtube_attempt_${sanitizeExternalId(videoId)}`;

  const existingJob = await repository.getJob(jobId);
  if (!existingJob) {
    await repository.createJob({
      id: jobId,
      title: metadata.title,
      type: 'external_video',
      status: 'published',
      sourceType: 'external_youtube',
      ownerUid: actorUid,
      metadata: {
        externalSource: 'youtube_channel_import',
        sourceArtifact: metadata.providerUrl,
        youtubeUrl: metadata.providerUrl,
        thumbnailUrl: metadata.thumbnailUrl,
        publishedAt: metadata.publishedAt,
        owner: account.accountName,
      },
    });
  } else {
    await repository.updateJob(jobId, {
      title: metadata.title,
      status: existingJob.status ?? 'published',
      metadata: {
        ...(existingJob.metadata ?? {}),
        sourceArtifact: metadata.providerUrl,
        youtubeUrl: metadata.providerUrl,
        thumbnailUrl: metadata.thumbnailUrl,
        publishedAt: metadata.publishedAt,
      },
    });
  }

  if (!(await repository.getPublishPlan(planId))) {
    await repository.createPublishPlan({
      id: planId,
      jobId,
      status: 'published',
      platforms: ['youtube'],
      metadata: {
        title: metadata.title,
        externalSource: 'youtube_channel_import',
      },
      createdBy: actorUid,
    });
  }

  const existingAttempt = await repository.getPublishAttempt(attemptId);
  if (existingAttempt) {
    return updateImportedPublication(existingAttempt, { repository, account, video, playlistItem, clock });
  }

  return repository.createPublishAttempt({
    id: attemptId,
    planId,
    jobId,
    platform: 'youtube',
    connectedAccountId: account.id,
    status: 'published',
    providerPostId: videoId,
    providerUrl: metadata.providerUrl,
    metadata,
  });
}

async function updateImportedPublication(attempt, { repository, account, video, playlistItem, clock }) {
  const videoId = attempt.providerPostId ?? attempt.metadata?.youtube?.videoId;
  const metadata = buildImportedPublicationMetadata({ account, videoId, video, playlistItem, clock });
  const existingMetadata = attempt.metadata ?? {};
  const isImportedRecord =
    existingMetadata.externalSource === 'youtube_channel_import' || String(attempt.id).startsWith('external_youtube_attempt_');
  const mergedMetadata = {
    ...existingMetadata,
    ...metadata,
    youtube: {
      ...(existingMetadata.youtube ?? {}),
      ...metadata.youtube,
      imported: isImportedRecord,
    },
  };
  if (!isImportedRecord) {
    delete mergedMetadata.externalSource;
    delete mergedMetadata.importedAt;
  }

  return repository.updatePublishAttempt(attempt.id, {
    connectedAccountId: attempt.connectedAccountId ?? account.id,
    status: attempt.status === 'deleted' ? attempt.status : 'published',
    providerPostId: videoId,
    providerUrl: attempt.status === 'deleted' ? attempt.providerUrl : metadata.providerUrl,
    errorCode: null,
    errorMessage: null,
    metadata: mergedMetadata,
  });
}

function buildImportedPublicationMetadata({ account, videoId, video, playlistItem, clock }) {
  const snippet = video?.snippet ?? playlistItem?.snippet ?? {};
  const status = video?.status ?? {};
  const statistics = video?.statistics ?? {};
  const title = normalizeText(snippet.title, 300) || 'Untitled YouTube video';
  const description = String(snippet.description ?? '');
  const tags = Array.isArray(snippet.tags) ? snippet.tags.map((tag) => String(tag)).filter(Boolean).slice(0, 50) : [];
  const privacyStatus = status.privacyStatus ?? playlistItem?.status?.privacyStatus ?? 'unknown';
  const publishedAt = snippet.publishedAt ?? playlistItem?.contentDetails?.videoPublishedAt ?? playlistItem?.snippet?.publishedAt ?? null;
  const thumbnailUrl = bestThumbnailUrl(snippet.thumbnails);
  const providerUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const syncedAt = clock();

  return {
    externalSource: 'youtube_channel_import',
    accountName: account.accountName,
    providerAccountId: account.providerAccountId ?? null,
    title,
    description,
    tags,
    privacyStatus,
    publishedAt,
    thumbnailUrl,
    providerUrl,
    importedAt: syncedAt,
    syncedAt,
    statistics,
    ...progressMetadata({
      stage: 'published',
      percent: 100,
      label: 'Imported from YouTube channel.',
      uploadedBytes: null,
      totalBytes: null,
    }),
    youtube: {
      videoId,
      watchUrl: providerUrl,
      imported: true,
      publishedAt,
      thumbnailUrl,
      privacyStatus,
      uploadStatus: status.uploadStatus ?? null,
      response: video ?? null,
      playlistItem: playlistItem ?? null,
    },
  };
}

function bestThumbnailUrl(thumbnails = {}) {
  return (
    thumbnails.maxres?.url ??
    thumbnails.standard?.url ??
    thumbnails.high?.url ??
    thumbnails.medium?.url ??
    thumbnails.default?.url ??
    null
  );
}

function sanitizeExternalId(value) {
  return String(value ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function uploadPercent(uploadedBytes, totalBytes) {
  if (!totalBytes) return 15;
  return Math.min(89, Math.max(15, Math.round(15 + (uploadedBytes / totalBytes) * 74)));
}

function uploadedBytesFromRange(rangeHeader) {
  const match = String(rangeHeader ?? '').match(/bytes=0-(\d+)/i);
  if (!match) return null;
  return Number(match[1]) + 1;
}

function latestByDate(records) {
  return [...records].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt ?? left.createdAt ?? 0);
    const rightTime = Date.parse(right.updatedAt ?? right.createdAt ?? 0);
    return rightTime - leftTime;
  })[0];
}

function normalizeText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function isUsableConnectedAccount(account) {
  const status = String(account?.status ?? '').toLowerCase();
  const tokenHealth = String(account?.tokenHealth ?? '').toLowerCase();
  return ['connected', 'configured'].includes(status) && !['refresh failed', 'disconnected'].includes(tokenHealth);
}

function appendHashtags(text, hashtags = [], maxLength = 5000) {
  const base = String(text ?? '').trim();
  const normalized = Array.isArray(hashtags)
    ? Array.from(new Set(hashtags.map(normalizeHashtag).filter(Boolean)))
    : [];
  if (normalized.length === 0) {
    return base;
  }
  const suffix = `\n\n${normalized.map((tag) => `#${tag}`).join(' ')}`;
  if (suffix.length >= maxLength) {
    return suffix.trim().slice(0, maxLength);
  }
  const available = maxLength - suffix.length;
  const trimmedBase = base.length > available ? base.slice(0, Math.max(0, available - 1)).trim() : base;
  return `${trimmedBase}${suffix}`;
}

function normalizeHashtag(value) {
  return String(value ?? '')
    .trim()
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}_]+/gu, '')
    .slice(0, 60);
}

function normalizePrivacyStatus(value) {
  const normalized = String(value ?? '').toLowerCase();
  return PRIVACY_STATUSES.has(normalized) ? normalized : 'private';
}

function sanitizeMutableVideoStatus(status = {}) {
  const privacyStatus = normalizePrivacyStatus(status.privacyStatus);
  const mutable = {
    privacyStatus,
  };
  if (status.embeddable !== undefined) mutable.embeddable = Boolean(status.embeddable);
  if (status.license !== undefined) mutable.license = status.license;
  if (status.publicStatsViewable !== undefined) mutable.publicStatsViewable = Boolean(status.publicStatsViewable);
  if (status.selfDeclaredMadeForKids !== undefined) {
    mutable.selfDeclaredMadeForKids = Boolean(status.selfDeclaredMadeForKids);
  }
  if (status.containsSyntheticMedia !== undefined) {
    mutable.containsSyntheticMedia = Boolean(status.containsSyntheticMedia);
  }
  if (privacyStatus === 'private' && status.publishAt) {
    mutable.publishAt = status.publishAt;
  }
  return mutable;
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) <= Date.now() + 60_000;
}

function isPathInside(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readResponseBody(response) {
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sanitizeError(error) {
  return {
    name: error.name,
    message: error.message,
    status: error.status ?? null,
    details: error.details ?? null,
  };
}

function clearFailureMetadata(metadata = {}) {
  const { failureDetails, ...rest } = metadata ?? {};
  return rest;
}
