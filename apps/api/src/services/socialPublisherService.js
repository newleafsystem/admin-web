import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/httpErrors.js';
import { canTransition } from './jobStateService.js';
import { createSocialPublicationImportService } from './socialPublicationImportService.js';

const DEFAULT_ENABLED_PLATFORMS = ['youtube', 'x', 'linkedin', 'instagram', 'facebook'];
const ACTIVE_UPLOAD_STATUSES = new Set(['queued', 'retrying', 'uploading', 'processing']);
const TERMINAL_STATUSES = new Set(['published', 'failed', 'delete_requested', 'deleted']);

const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const X_MEDIA_UPLOAD_URL = 'https://api.x.com/2/media/upload';
const X_MEDIA_UPLOAD_INITIALIZE_URL = `${X_MEDIA_UPLOAD_URL}/initialize`;
const X_TWEETS_URL = 'https://api.x.com/2/tweets';

const LINKEDIN_VIDEOS_URL = 'https://api.linkedin.com/rest/videos';
const LINKEDIN_POSTS_URL = 'https://api.linkedin.com/rest/posts';

const DEFAULT_LINKEDIN_API_VERSION = '202604';

export function createSocialPublisherService(options = {}) {
  const repository = options.repository;
  const jobStateService = options.jobStateService;
  const youtubePublisherService = options.youtubePublisherService;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const serviceConfig = options.config ?? config;
  const localDataDir = options.localDataDir ?? config.localDataDir;
  const clock = options.clock ?? (() => new Date().toISOString());
  const enabledPlatforms = new Set(serviceConfig.social?.publisherEnabledPlatforms ?? DEFAULT_ENABLED_PLATFORMS);
  const activeUploads = new Map();
  const publicationImportService = options.publicationImportService ?? createSocialPublicationImportService({
    repository,
    fetch: fetchImpl,
    config: serviceConfig,
    clock,
    getAccessToken,
    youtubeImporter: youtubePublisherService?.importChannelPublications,
  });

  if (!repository || !jobStateService) {
    throw new TypeError('createSocialPublisherService requires repository and jobStateService');
  }

  function enqueueAttempt(attemptOrId) {
    const attemptId = typeof attemptOrId === 'string' ? attemptOrId : attemptOrId?.id;
    if (!attemptId) {
      return { queued: false, reason: 'missing_attempt_id' };
    }

    const platform = typeof attemptOrId === 'object' ? attemptOrId.platform : null;
    if (platform === 'youtube') {
      return youtubePublisherService?.enqueueAttempt(attemptId) ?? { queued: false, reason: 'youtube_worker_unavailable' };
    }

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
    const resumable = attempts.filter(
      (attempt) => enabledPlatforms.has(attempt.platform) && ACTIVE_UPLOAD_STATUSES.has(attempt.status),
    );
    let queued = 0;
    for (const attempt of resumable) {
      const result = enqueueAttempt(attempt);
      if (result.queued) queued += 1;
    }
    return { queued };
  }

  async function publishAttempt(attemptId) {
    const context = await buildAttemptContext(attemptId);
    if (!enabledPlatforms.has(context.attempt.platform)) {
      throw conflict('Publisher worker is not enabled for this platform', {
        platform: context.attempt.platform,
        enabled: Array.from(enabledPlatforms),
      });
    }

    if (context.attempt.platform === 'youtube') {
      return youtubePublisherService.publishAttempt(attemptId);
    }
    if (context.attempt.platform === 'x') {
      return publishToX(context);
    }
    if (context.attempt.platform === 'linkedin') {
      return publishToLinkedIn(context);
    }
    if (context.attempt.platform === 'facebook') {
      return publishToFacebook(context);
    }
    if (context.attempt.platform === 'instagram') {
      return publishToInstagram(context);
    }

    throw badRequest('Unsupported publisher platform', { platform: context.attempt.platform });
  }

  async function updatePrivacy(attemptId, privacyStatus, context = {}) {
    const attempt = await repository.getPublishAttempt(attemptId);
    if (!attempt) throw notFound('Publication not found', { attemptId });
    if (attempt.platform === 'youtube') {
      return youtubePublisherService.updatePrivacy(attemptId, privacyStatus, context);
    }

    const updated = await repository.updatePublishAttempt(attempt.id, {
      metadata: {
        ...(attempt.metadata ?? {}),
        privacyStatus,
        publisherStatus:
          `${platformLabel(attempt.platform)} visibility was updated in NewLeaf. Provider-side visibility edits are not available for this platform worker yet.`,
        adminUpdatedAt: clock(),
        adminUpdatedBy: context.actorUid ?? null,
      },
    });
    return { publication: updated, providerUpdated: false };
  }

  async function updateMetadata(attemptId, metadata, context = {}) {
    const attempt = await repository.getPublishAttempt(attemptId);
    if (!attempt) throw notFound('Publication not found', { attemptId });
    if (attempt.platform === 'youtube' && youtubePublisherService?.updateMetadata) {
      return youtubePublisherService.updateMetadata(attemptId, metadata, context);
    }

    const updated = await repository.updatePublishAttempt(attempt.id, {
      metadata: {
        ...(attempt.metadata ?? {}),
        ...metadata,
        publisherStatus:
          `${platformLabel(attempt.platform)} metadata was updated in NewLeaf. Provider-side metadata edits are not available for this platform worker yet.`,
        adminUpdatedAt: clock(),
        adminUpdatedBy: context.actorUid ?? null,
      },
    });
    return { publication: updated, providerUpdated: false };
  }

  async function deletePublication(attemptId, context = {}) {
    const attempt = await repository.getPublishAttempt(attemptId);
    if (!attempt) throw notFound('Publication not found', { attemptId });
    if (attempt.platform === 'youtube') {
      return youtubePublisherService.deletePublication(attemptId, context);
    }
    const deletingAttempt = await markPublicationDeleteRequested(
      attempt,
      context,
      `Deleting video from ${platformLabel(attempt.platform)}.`,
    );

    try {
      const providerPostId = deletingAttempt.providerPostId;
      if (!providerPostId) {
        return markPublicationDeleted(deletingAttempt, {
          providerDeleted: false,
          context,
          message: `No ${platformLabel(deletingAttempt.platform)} provider id was stored; marked deleted in NewLeaf only.`,
        });
      }

      const account = deletingAttempt.connectedAccountId ? await repository.getSocialAccount(deletingAttempt.connectedAccountId) : null;
      if (!account) {
        throw conflict(`No connected ${platformLabel(deletingAttempt.platform)} account is assigned to this publication`, {
          attemptId,
        });
      }

      if (deletingAttempt.platform === 'x') {
        return deleteXPublication({ attempt: deletingAttempt, account, providerPostId, context });
      }
      if (deletingAttempt.platform === 'linkedin') {
        return deleteLinkedInPublication({ attempt: deletingAttempt, account, providerPostId, context });
      }
      if (deletingAttempt.platform === 'facebook') {
        return deleteFacebookPublication({ attempt: deletingAttempt, account, providerPostId, context });
      }
      if (deletingAttempt.platform === 'instagram') {
        return deleteInstagramPublication({ attempt: deletingAttempt, account, providerPostId, context });
      }

      throw badRequest('Unsupported publisher platform', { platform: deletingAttempt.platform });
    } catch (error) {
      await markPublicationDeleteFailed(attempt, error, context);
      throw error;
    }
  }

  async function importChannelPublications({ platform, ...options } = {}) {
    return publicationImportService.importChannelPublications({ platform, ...options });
  }

  async function buildAttemptContext(attemptId) {
    const attempt = await repository.getPublishAttempt(attemptId);
    if (!attempt) throw notFound('Publish attempt not found', { attemptId });

    const [plan, job] = await Promise.all([
      repository.getPublishPlan(attempt.planId),
      repository.getJob(attempt.jobId),
    ]);
    if (!plan) throw notFound('Publish plan not found', { planId: attempt.planId });
    if (!job) throw notFound('Job not found', { jobId: attempt.jobId });

    const account = attempt.connectedAccountId ? await repository.getSocialAccount(attempt.connectedAccountId) : null;
    if (!account) {
      throw conflict(`No connected ${attempt.platform} account is assigned to this publish attempt`, {
        attemptId,
        connectedAccountId: attempt.connectedAccountId,
      });
    }
    if (account.platform !== attempt.platform) {
      throw conflict('Assigned account platform does not match publish attempt platform', {
        attemptId,
        accountPlatform: account.platform,
        attemptPlatform: attempt.platform,
      });
    }

    const metadata = mergePublishMetadata({ attempt, plan, job });
    const video = attempt.platform === 'instagram'
      ? await resolveVideoArtifact(job, { optional: true, requireLocal: false })
      : await resolveVideoArtifact(job, { requireLocal: !['facebook'].includes(attempt.platform) });
    return { attempt, plan, job, account, metadata, video };
  }

  async function resolveVideoArtifact(job, { optional = false, requireLocal = true } = {}) {
    const artifacts = await repository.listArtifactsForJob(job.id);
    const artifact =
      artifacts.find((candidate) => candidate.id === job.currentVideoArtifactId) ??
      latestByDate(artifacts.filter((candidate) => candidate.kind === 'video'));
    if (!artifact) {
      if (optional) return null;
      throw conflict('No video artifact is available for this job', { jobId: job.id });
    }

    if (artifact.storageProvider === 'provider-url' && /^https?:\/\//i.test(artifact.storageKey)) {
      if (requireLocal) {
        throw conflict('This platform requires local video bytes, but the selected artifact only has a provider URL', {
          artifactId: artifact.id,
          platformHint: 'Upload or generate a local video artifact before publishing to this platform.',
        });
      }
      return {
        artifact,
        filePath: null,
        filename: artifact.metadata?.filename ?? path.basename(new URL(artifact.storageKey).pathname) ?? 'video.mp4',
        mimeType: artifact.mimeType || 'video/mp4',
        sizeBytes: Number(artifact.sizeBytes ?? 0),
        publicUrl: artifact.storageKey,
      };
    }

    if (artifact.storageProvider !== 'local-disk') {
      if (optional) return null;
      throw conflict('Only local-disk video artifacts can be uploaded by the local publisher worker', {
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
      filename: artifact.metadata?.filename ?? path.basename(candidatePath),
      mimeType: artifact.mimeType || 'video/mp4',
      sizeBytes: stat.size,
      publicUrl: getArtifactPublicUrl(artifact),
    };
  }

  async function publishToX(context) {
    const token = await getAccessToken(context.account, {
      platform: 'x',
      operation: 'publish video posts on X',
      requiredScopes: ['tweet.write', 'media.write'],
    });
    const uploadChunkBytes = serviceConfig.x?.uploadChunkBytes ?? 4 * 1024 * 1024;
    const mediaMetadata = await ensureXMediaUpload(context, token, uploadChunkBytes);

    await waitForXMediaProcessing(context.attempt.id, token, mediaMetadata.mediaId, mediaMetadata.processingInfo);

    await updateAttemptProgress(context.attempt.id, {
      status: 'processing',
      stage: 'provider_processing',
      percent: 88,
      label: 'Creating X post with uploaded video.',
      uploadedBytes: context.video.sizeBytes,
      totalBytes: context.video.sizeBytes,
    });

    const payload = {
      text: buildCaption(context, 280),
      media: {
        media_ids: [mediaMetadata.mediaId],
      },
    };
    const response = await postJson(X_TWEETS_URL, token, payload, 'Unable to create X post');
    const tweetId = response.data?.id;
    if (!tweetId) {
      throw conflict('X post response did not include a post id', { response });
    }

    return markAttemptPublished(context, {
      providerPostId: tweetId,
      providerUrl: `https://x.com/i/web/status/${tweetId}`,
      label: 'X post published.',
      metadataPatch: {
        x: {
          ...(context.attempt.metadata?.x ?? {}),
          mediaId: mediaMetadata.mediaId,
          mediaKey: mediaMetadata.mediaKey,
          tweetId,
          response,
        },
      },
    });
  }

  async function deleteXPublication({ attempt, account, providerPostId, context }) {
    const token = await getAccessToken(account, {
      platform: 'x',
      operation: 'delete X posts',
      requiredScopes: ['tweet.write'],
    });
    const response = await deleteRequest(`${X_TWEETS_URL}/${encodeURIComponent(providerPostId)}`, token, 'Unable to delete X post');
    return markPublicationDeleted(attempt, {
      providerDeleted: Boolean(response.data?.deleted ?? true),
      context,
      message: 'X post deleted.',
      providerResponse: response,
      providerPatch: {
        x: {
          ...(attempt.metadata?.x ?? {}),
          tweetId: providerPostId,
          deletedAt: clock(),
          deleteResponse: response,
        },
      },
    });
  }

  async function ensureXMediaUpload(context, token, uploadChunkBytes) {
    const existingMedia = context.attempt.metadata?.x;
    if (existingMedia?.mediaId) {
      return {
        mediaId: existingMedia.mediaId,
        mediaKey: existingMedia.mediaKey ?? null,
        processingInfo: existingMedia.processingInfo ?? null,
      };
    }

    await updateAttemptProgress(context.attempt.id, {
      status: 'uploading',
      stage: 'uploading',
      percent: 10,
      label: 'Starting X chunked media upload.',
      uploadedBytes: 0,
      totalBytes: context.video.sizeBytes,
    });

    const initResponse = await postJson(
      X_MEDIA_UPLOAD_INITIALIZE_URL,
      token,
      {
        media_type: context.video.mimeType,
        total_bytes: context.video.sizeBytes,
        media_category: context.metadata.xMediaCategory ?? 'tweet_video',
        shared: false,
      },
      'Unable to initialize X media upload',
    );
    const mediaId = initResponse.data?.id ?? initResponse.media_id_string ?? initResponse.media_id;
    if (!mediaId) {
      throw conflict('X media upload initialize response did not include a media id', { response: initResponse });
    }

    await repository.updatePublishAttempt(context.attempt.id, {
      metadata: {
        ...(context.attempt.metadata ?? {}),
        ...progressMetadata({
          stage: 'uploading',
          percent: 12,
          label: 'X media upload session created.',
          uploadedBytes: 0,
          totalBytes: context.video.sizeBytes,
        }),
        x: {
          mediaId,
          mediaKey: initResponse.data?.media_key ?? null,
          initResponse,
          uploadSessionCreatedAt: clock(),
        },
      },
    });

    let uploadedBytes = 0;
    let segmentIndex = 0;
    const file = await fsp.open(context.video.filePath, 'r');
    try {
      while (uploadedBytes < context.video.sizeBytes) {
        const end = Math.min(uploadedBytes + uploadChunkBytes - 1, context.video.sizeBytes - 1);
        const chunk = await readFileRange(file, uploadedBytes, end);
        const form = new FormData();
        form.set('segment_index', String(segmentIndex));
        form.set('media', new Blob([toUint8Array(chunk)], { type: context.video.mimeType }), context.video.filename);
        await postForm(`${X_MEDIA_UPLOAD_URL}/${mediaId}/append`, token, form, 'Unable to upload X media chunk');

        uploadedBytes += chunk.length;
        segmentIndex += 1;
        await updateAttemptProgress(context.attempt.id, {
          status: 'uploading',
          stage: 'uploading',
          percent: uploadPercent(uploadedBytes, context.video.sizeBytes, 12, 74),
          label: 'Uploading video bytes to X.',
          uploadedBytes,
          totalBytes: context.video.sizeBytes,
        });
      }
    } finally {
      await file.close();
    }

    const finalizeResponse = await postWithoutBody(
      `${X_MEDIA_UPLOAD_URL}/${mediaId}/finalize`,
      token,
      'Unable to finalize X media upload',
    );
    const data = finalizeResponse.data ?? finalizeResponse;
    const processingInfo = data.processing_info ?? null;
    await repository.updatePublishAttempt(context.attempt.id, {
      status: processingInfo ? 'processing' : 'uploading',
      metadata: {
        ...(await getAttemptMetadata(context.attempt.id)),
        ...progressMetadata({
          stage: processingInfo ? 'provider_processing' : 'uploading',
          percent: processingInfo ? 78 : 82,
          label: processingInfo ? 'X is processing the uploaded video.' : 'X media upload finalized.',
          uploadedBytes: context.video.sizeBytes,
          totalBytes: context.video.sizeBytes,
        }),
        x: {
          ...((await getAttemptMetadata(context.attempt.id)).x ?? {}),
          mediaId,
          mediaKey: data.media_key ?? initResponse.data?.media_key ?? null,
          processingInfo,
          finalizeResponse,
        },
      },
    });

    return {
      mediaId,
      mediaKey: data.media_key ?? initResponse.data?.media_key ?? null,
      processingInfo,
    };
  }

  async function waitForXMediaProcessing(attemptId, token, mediaId, processingInfo) {
    let info = processingInfo;
    if (!info) return null;

    for (let poll = 0; poll < maxStatusPolls(); poll += 1) {
      if (info.state === 'succeeded') return info;
      if (info.state === 'failed') {
        throw conflict('X media processing failed', { mediaId, processingInfo: info });
      }
      await delay(Math.max(1, Math.min(Number(info.check_after_secs ?? 2), 10)) * 1000);
      const url = new URL(X_MEDIA_UPLOAD_URL);
      url.searchParams.set('command', 'STATUS');
      url.searchParams.set('media_id', mediaId);
      const response = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      const payload = await readResponseBody(response);
      assertProviderOk(response, payload, 'Unable to read X media processing status');
      info = payload.data?.processing_info ?? payload.processing_info ?? null;
      await updateAttemptProgress(attemptId, {
        status: 'processing',
        stage: 'provider_processing',
        percent: Math.min(87, 78 + Number(info?.progress_percent ?? poll)),
        label: `X media processing ${info?.state ?? 'in progress'}.`,
      });
    }
    throw conflict('Timed out waiting for X media processing', { mediaId });
  }

  async function publishToLinkedIn(context) {
    const token = await getAccessToken(context.account, {
      platform: 'linkedin',
      operation: 'publish video posts on LinkedIn',
      requiredAnyScopes: ['w_member_social', 'w_organization_social'],
    });
    const owner = getLinkedInOwnerUrn(context);
    const headers = linkedInHeaders(token);

    await updateAttemptProgress(context.attempt.id, {
      status: 'uploading',
      stage: 'uploading',
      percent: 10,
      label: 'Initializing LinkedIn video upload.',
      uploadedBytes: 0,
      totalBytes: context.video.sizeBytes,
    });

    const initResponse = await postJson(
      `${LINKEDIN_VIDEOS_URL}?action=initializeUpload`,
      token,
      {
        initializeUploadRequest: {
          owner,
          fileSizeBytes: context.video.sizeBytes,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      },
      'Unable to initialize LinkedIn video upload',
      headers,
    );
    const value = initResponse.value ?? {};
    if (!value.video || !Array.isArray(value.uploadInstructions) || value.uploadInstructions.length === 0) {
      throw conflict('LinkedIn initializeUpload response did not include video upload instructions', { response: initResponse });
    }

    await repository.updatePublishAttempt(context.attempt.id, {
      metadata: {
        ...(context.attempt.metadata ?? {}),
        ...progressMetadata({
          stage: 'uploading',
          percent: 15,
          label: 'LinkedIn upload URLs created.',
          uploadedBytes: 0,
          totalBytes: context.video.sizeBytes,
        }),
        linkedin: {
          owner,
          videoUrn: value.video,
          uploadToken: value.uploadToken ?? '',
          uploadUrlsExpireAt: value.uploadUrlsExpireAt ?? null,
          initializeResponse: initResponse,
        },
      },
    });

    const uploadedPartIds = [];
    const file = await fsp.open(context.video.filePath, 'r');
    let uploadedBytes = 0;
    try {
      for (const instruction of value.uploadInstructions) {
        const firstByte = Number(instruction.firstByte);
        const lastByte = Number(instruction.lastByte);
        const chunk = await readFileRange(file, firstByte, lastByte);
        const uploadResponse = await fetchImpl(instruction.uploadUrl, {
          method: 'PUT',
          headers: {
            'content-type': context.video.mimeType,
            'content-length': String(chunk.length),
          },
          body: chunk,
        });
        const uploadBody = await readResponseBody(uploadResponse);
        assertProviderOk(uploadResponse, uploadBody, 'Unable to upload LinkedIn video part');
        uploadedPartIds.push(stripQuotes(uploadResponse.headers.get('etag') ?? uploadResponse.headers.get('ETag') ?? ''));
        uploadedBytes += chunk.length;
        await updateAttemptProgress(context.attempt.id, {
          status: 'uploading',
          stage: 'uploading',
          percent: uploadPercent(uploadedBytes, context.video.sizeBytes, 15, 70),
          label: 'Uploading video bytes to LinkedIn.',
          uploadedBytes,
          totalBytes: context.video.sizeBytes,
        });
      }
    } finally {
      await file.close();
    }

    await postJson(
      `${LINKEDIN_VIDEOS_URL}?action=finalizeUpload`,
      token,
      {
        finalizeUploadRequest: {
          video: value.video,
          uploadToken: value.uploadToken ?? '',
          uploadedPartIds: uploadedPartIds.filter(Boolean),
        },
      },
      'Unable to finalize LinkedIn video upload',
      headers,
    );

    await waitForLinkedInVideo(context.attempt.id, token, value.video);

    const postResponse = await fetchImpl(LINKEDIN_POSTS_URL, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        author: owner,
        commentary: buildCaption(context, 3000),
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
        content: {
          media: {
            title: context.metadata.title,
            id: value.video,
          },
        },
      }),
    });
    const postPayload = await readResponseBody(postResponse);
    assertProviderOk(postResponse, postPayload, 'Unable to create LinkedIn video post');
    const postId = postResponse.headers.get('x-restli-id') ?? postPayload.id;
    if (!postId) {
      throw conflict('LinkedIn post response did not include a post id', { response: postPayload });
    }

    return markAttemptPublished(context, {
      providerPostId: postId,
      providerUrl: `https://www.linkedin.com/feed/update/${postId}/`,
      label: 'LinkedIn video post published.',
      metadataPatch: {
        linkedin: {
          ...(context.attempt.metadata?.linkedin ?? {}),
          owner,
          videoUrn: value.video,
          uploadedPartIds,
          postId,
          postResponse: postPayload,
        },
      },
    });
  }

  async function deleteLinkedInPublication({ attempt, account, providerPostId, context }) {
    const token = await getAccessToken(account, {
      platform: 'linkedin',
      operation: 'delete LinkedIn posts',
      requiredAnyScopes: ['w_member_social', 'w_organization_social'],
    });
    const response = await deleteRequest(
      `${LINKEDIN_POSTS_URL}/${encodeURIComponent(providerPostId)}`,
      token,
      'Unable to delete LinkedIn post',
      {
        ...linkedInHeaders(token),
        'X-RestLi-Method': 'DELETE',
      },
    );
    return markPublicationDeleted(attempt, {
      providerDeleted: true,
      context,
      message: 'LinkedIn post deleted.',
      providerResponse: response,
      providerPatch: {
        linkedin: {
          ...(attempt.metadata?.linkedin ?? {}),
          postId: providerPostId,
          deletedAt: clock(),
          deleteResponse: response,
        },
      },
    });
  }

  async function waitForLinkedInVideo(attemptId, token, videoUrn) {
    const headers = linkedInHeaders(token);
    const encodedUrn = encodeURIComponent(videoUrn);
    for (let poll = 0; poll < maxStatusPolls(); poll += 1) {
      await updateAttemptProgress(attemptId, {
        status: 'processing',
        stage: 'provider_processing',
        percent: Math.min(88, 78 + poll),
        label: 'LinkedIn is processing the uploaded video.',
      });
      const response = await fetchImpl(`${LINKEDIN_VIDEOS_URL}/${encodedUrn}`, { headers });
      const payload = await readResponseBody(response);
      if (response.status === 404) {
        await delay(2000);
        continue;
      }
      assertProviderOk(response, payload, 'Unable to read LinkedIn video processing status');
      if (!payload.status || payload.status === 'AVAILABLE') return payload;
      if (payload.status === 'PROCESSING_FAILED') {
        throw conflict('LinkedIn video processing failed', { videoUrn, response: payload });
      }
      await delay(2000);
    }
    return null;
  }

  async function publishToFacebook(context) {
    const token = await getAccessToken(context.account, {
      platform: 'facebook',
      operation: 'publish Facebook Page videos',
      requiredScopes: ['pages_manage_posts'],
    });
    const pageId = context.account.providerAccountId ?? context.metadata.pageId;
    if (!pageId) {
      throw conflict('Facebook account is missing a Page id', { accountId: context.account.id });
    }

    await updateAttemptProgress(context.attempt.id, {
      status: 'uploading',
      stage: 'uploading',
      percent: 15,
      label: 'Uploading video to Facebook Page.',
      uploadedBytes: 0,
      totalBytes: context.video.sizeBytes,
    });

    const url = new URL(`https://graph-video.facebook.com/${metaGraphVersion()}/${pageId}/videos`);
    const form = new FormData();
    form.set('title', context.metadata.title);
    form.set('description', buildCaption(context, 5000));
    form.set('published', String(context.metadata.privacyStatus !== 'private'));
    if (context.video.publicUrl) {
      form.set('file_url', context.video.publicUrl);
    } else {
      const file = await fsp.readFile(context.video.filePath);
      form.set('source', new Blob([toUint8Array(file)], { type: context.video.mimeType }), context.video.filename);
    }

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: form,
    });
    const payload = await readResponseBody(response);
    assertProviderOk(response, payload, 'Unable to publish Facebook Page video');
    const videoId = payload.id;
    if (!videoId) {
      throw conflict('Facebook video response did not include a video id', { response: payload });
    }

    return markAttemptPublished(context, {
      providerPostId: videoId,
      providerUrl: `https://www.facebook.com/${pageId}/videos/${videoId}/`,
      label: 'Facebook Page video published.',
      metadataPatch: {
        facebook: {
          pageId,
          videoId,
          response: payload,
        },
      },
    });
  }

  async function deleteFacebookPublication({ attempt, account, providerPostId, context }) {
    const token = await getAccessToken(account, {
      platform: 'facebook',
      operation: 'delete Facebook Page videos',
      requiredScopes: ['pages_manage_posts'],
    });
    const response = await deleteRequest(
      `https://graph.facebook.com/${metaGraphVersion()}/${encodeURIComponent(providerPostId)}`,
      token,
      'Unable to delete Facebook Page video',
    );
    return markPublicationDeleted(attempt, {
      providerDeleted: Boolean(response.success ?? response.deleted ?? true),
      context,
      message: 'Facebook Page video deleted.',
      providerResponse: response,
      providerPatch: {
        facebook: {
          ...(attempt.metadata?.facebook ?? {}),
          videoId: providerPostId,
          deletedAt: clock(),
          deleteResponse: response,
        },
      },
    });
  }

  async function publishToInstagram(context) {
    const token = await getAccessToken(context.account, {
      platform: 'instagram',
      operation: 'publish Instagram videos',
      requiredScopes: ['instagram_content_publish'],
    });
    const instagramAccountId =
      context.account.providerAccountId ?? context.account.metadata?.instagramAccount?.id ?? context.metadata.instagramAccountId;
    if (!instagramAccountId) {
      throw conflict('Instagram account is missing an Instagram professional account id', { accountId: context.account.id });
    }

    const videoUrl = context.video?.publicUrl ?? getPublicVideoUrl(context);
    if (!videoUrl) {
      throw conflict('Instagram publishing requires a public HTTPS video URL. Upload the asset to Firebase Storage / GCS or expose local API through a public tunnel and set PUBLIC_BASE_URL.', {
        jobId: context.job.id,
        localOnly: true,
      });
    }

    await updateAttemptProgress(context.attempt.id, {
      status: 'uploading',
      stage: 'uploading',
      percent: 20,
      label: 'Creating Instagram media container.',
      uploadedBytes: context.video?.sizeBytes ?? null,
      totalBytes: context.video?.sizeBytes ?? null,
    });

    const createUrl = new URL(`https://graph.facebook.com/${metaGraphVersion()}/${instagramAccountId}/media`);
    const createPayload = new URLSearchParams({
      media_type: context.metadata.instagramMediaType ?? 'REELS',
      video_url: videoUrl,
      caption: buildCaption(context, 2200),
      share_to_feed: String(context.metadata.shareToFeed ?? true),
    });
    const container = await postUrlEncoded(createUrl, token, createPayload, 'Unable to create Instagram media container');
    const creationId = container.id;
    if (!creationId) {
      throw conflict('Instagram media container response did not include a creation id', { response: container });
    }

    await repository.updatePublishAttempt(context.attempt.id, {
      status: 'processing',
      metadata: {
        ...(await getAttemptMetadata(context.attempt.id)),
        ...progressMetadata({
          stage: 'provider_processing',
          percent: 55,
          label: 'Instagram is processing the media container.',
          uploadedBytes: context.video?.sizeBytes ?? null,
          totalBytes: context.video?.sizeBytes ?? null,
        }),
        instagram: {
          creationId,
          videoUrl,
          createResponse: container,
        },
      },
    });

    await waitForInstagramContainer(context.attempt.id, token, creationId);

    const publishUrl = new URL(`https://graph.facebook.com/${metaGraphVersion()}/${instagramAccountId}/media_publish`);
    const publishPayload = new URLSearchParams({ creation_id: creationId });
    const publishResponse = await postUrlEncoded(
      publishUrl,
      token,
      publishPayload,
      'Unable to publish Instagram media container',
    );
    const mediaId = publishResponse.id;
    if (!mediaId) {
      throw conflict('Instagram publish response did not include a media id', { response: publishResponse });
    }
    const permalink = await fetchInstagramPermalink(token, mediaId);

    return markAttemptPublished(context, {
      providerPostId: mediaId,
      providerUrl: permalink,
      label: 'Instagram video published.',
      metadataPatch: {
        instagram: {
          ...(context.attempt.metadata?.instagram ?? {}),
          creationId,
          mediaId,
          permalink,
          publishResponse,
        },
      },
    });
  }

  async function deleteInstagramPublication({ attempt, account, providerPostId, context }) {
    const token = await getAccessToken(account, {
      platform: 'instagram',
      operation: 'delete Instagram media',
      requiredScopes: ['instagram_content_publish'],
    });
    const response = await deleteRequest(
      `https://graph.facebook.com/${metaGraphVersion()}/${encodeURIComponent(providerPostId)}`,
      token,
      'Unable to delete Instagram media through Graph API',
    );
    return markPublicationDeleted(attempt, {
      providerDeleted: Boolean(response.success ?? response.deleted ?? true),
      context,
      message: 'Instagram media deleted.',
      providerResponse: response,
      providerPatch: {
        instagram: {
          ...(attempt.metadata?.instagram ?? {}),
          mediaId: providerPostId,
          deletedAt: clock(),
          deleteResponse: response,
        },
      },
    });
  }

  async function waitForInstagramContainer(attemptId, token, creationId) {
    for (let poll = 0; poll < maxStatusPolls(); poll += 1) {
      await delay(3000);
      const url = new URL(`https://graph.facebook.com/${metaGraphVersion()}/${creationId}`);
      url.searchParams.set('fields', 'status_code,status');
      const response = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      const payload = await readResponseBody(response);
      assertProviderOk(response, payload, 'Unable to read Instagram media container status');
      const statusCode = String(payload.status_code ?? '').toUpperCase();
      if (statusCode === 'FINISHED') return payload;
      if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
        throw conflict('Instagram media container processing failed', { creationId, response: payload });
      }
      await updateAttemptProgress(attemptId, {
        status: 'processing',
        stage: 'provider_processing',
        percent: Math.min(88, 55 + poll * 3),
        label: `Instagram media container ${payload.status ?? statusCode ?? 'processing'}.`,
      });
    }
    throw conflict('Timed out waiting for Instagram media container processing', { creationId });
  }

  async function fetchInstagramPermalink(token, mediaId) {
    const url = new URL(`https://graph.facebook.com/${metaGraphVersion()}/${mediaId}`);
    url.searchParams.set('fields', 'permalink');
    const response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    const payload = await readResponseBody(response);
    if (!response.ok) {
      return `https://www.instagram.com/p/${mediaId}/`;
    }
    return payload.permalink ?? `https://www.instagram.com/p/${mediaId}/`;
  }

  async function getAccessToken(account, { platform, operation, requiredScopes = [], requiredAnyScopes = [] }) {
    if (!account.tokenSecretRef) {
      throw conflict(`${platformLabel(platform)} account does not have an OAuth token secret`, { accountId: account.id });
    }

    const secret = await repository.getSecret(account.tokenSecretRef);
    if (!secret?.value) {
      throw conflict(`${platformLabel(platform)} OAuth token secret was not found`, {
        accountId: account.id,
        tokenSecretRef: account.tokenSecretRef,
      });
    }

    let token = secret.value;
    if (platform === 'x' && token.refreshToken && isExpired(token.expiresAt)) {
      token = await refreshXAccessToken(secret, token);
    }

    if (!token.accessToken) {
      throw conflict(`${platformLabel(platform)} OAuth token is missing an access token`, { accountId: account.id });
    }
    if (isExpired(token.expiresAt)) {
      throw conflict(`${platformLabel(platform)} OAuth token is expired. Reconnect the account from Accounts.`, {
        accountId: account.id,
        expiresAt: token.expiresAt,
      });
    }

    assertScopes({
      account,
      secret,
      token,
      requiredScopes,
      requiredAnyScopes,
      operation,
      platform,
    });
    return token.accessToken;
  }

  async function refreshXAccessToken(secret, token) {
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (serviceConfig.x?.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${serviceConfig.x.clientId}:${serviceConfig.x.clientSecret}`).toString('base64')}`;
    }
    const response = await fetchImpl(X_TOKEN_URL, {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
        client_id: serviceConfig.x.clientId,
      }),
    });
    const payload = await readResponseBody(response);
    assertProviderOk(response, payload, 'Unable to refresh X OAuth token');
    const expiresIn = Number(payload.expires_in ?? 0);
    const refreshExpiresIn = Number(payload.refresh_token_expires_in ?? 0);
    const refreshed = {
      ...token,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? token.refreshToken,
      tokenType: payload.token_type ?? token.tokenType,
      expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : token.expiresAt,
      refreshExpiresAt:
        refreshExpiresIn > 0 ? new Date(Date.now() + refreshExpiresIn * 1000).toISOString() : token.refreshExpiresAt,
      scope: payload.scope ?? token.scope,
    };
    await repository.putSecret({
      id: secret.id,
      provider: secret.provider,
      kind: secret.kind,
      value: refreshed,
      metadata: {
        ...(secret.metadata ?? {}),
        scopes: payload.scope ? payload.scope.split(/\s+/).filter(Boolean) : secret.metadata?.scopes ?? [],
        refreshedAt: clock(),
        hasRefreshToken: Boolean(refreshed.refreshToken),
      },
    });
    return refreshed;
  }

  async function markAttemptPublished(context, { providerPostId, providerUrl, label, metadataPatch }) {
    const latestMetadata = await getAttemptMetadata(context.attempt.id);
    await repository.updatePublishAttempt(context.attempt.id, {
      status: 'published',
      providerPostId,
      providerUrl,
      errorCode: null,
      errorMessage: null,
      metadata: {
        ...latestMetadata,
        ...progressMetadata({
          stage: 'published',
          percent: 100,
          label,
          uploadedBytes: context.video?.sizeBytes ?? latestMetadata.uploadedBytes ?? null,
          totalBytes: context.video?.sizeBytes ?? latestMetadata.totalBytes ?? null,
        }),
        accountName: context.account.accountName,
        providerAccountId: context.account.providerAccountId ?? null,
        title: context.metadata.title,
        description: context.metadata.description,
        tags: context.metadata.tags,
        hashtags: context.metadata.hashtags,
        thumbnailArtifactId: context.metadata.thumbnailArtifactId ?? null,
        thumbnailUrl: context.metadata.thumbnailUrl ?? null,
        thumbnailSource: context.metadata.thumbnailSource ?? null,
        privacyStatus: context.metadata.privacyStatus,
        ...metadataPatch,
      },
    });
    await reconcilePlanAndJob(context.plan.id);
    return { providerPostId, providerUrl };
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
    const failureMessage = providerFailureMessage(error);
    await repository.updatePublishAttempt(attempt.id, {
      status: attempt.status,
      errorCode: error.name === 'HttpError' ? `http_${error.status}` : `${attempt.platform}_delete_failed`,
      errorMessage: failureMessage,
      metadata: {
        ...(attempt.metadata ?? {}),
        ...progressMetadata({
          stage: 'delete_failed',
          percent: 0,
          label: failureMessage,
          uploadedBytes: attempt.metadata?.uploadedBytes ?? null,
          totalBytes: attempt.metadata?.totalBytes ?? null,
        }),
        deleteFailedAt: clock(),
        deleteRequestedBy: context.actorUid ?? null,
        deleteFailureDetails: sanitizeError(error),
      },
    });
  }

  async function updateAttemptProgress(attemptId, { status, stage, percent, label, uploadedBytes, totalBytes, patch = {} }) {
    const attempt = await repository.getPublishAttempt(attemptId);
    if (!attempt) return null;
    const metadata = clearFailureMetadata(attempt.metadata);
    return repository.updatePublishAttempt(attemptId, {
      ...(status ? { status } : {}),
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
    const failureMessage = providerFailureMessage(error);
    await repository.updatePublishAttempt(attemptId, {
      status: 'failed',
      errorCode: error.name === 'HttpError' ? `http_${error.status}` : `${attempt.platform}_publish_failed`,
      errorMessage: failureMessage,
      metadata: {
        ...(attempt.metadata ?? {}),
        ...progressMetadata({
          stage: 'failed',
          percent: 0,
          label: failureMessage,
          uploadedBytes: attempt.metadata?.uploadedBytes ?? null,
          totalBytes: attempt.metadata?.totalBytes ?? null,
        }),
        failureDetails: sanitizeError(error),
      },
    });
    await reconcilePlanAndJob(attempt.planId);
  }

  async function reconcilePlanAndJob(planId) {
    const plan = await repository.getPublishPlan(planId);
    if (!plan) return;
    const attempts = await repository.listPublishAttempts({ planId });
    if (attempts.length === 0) return;

    const allTerminal = attempts.every((attempt) => TERMINAL_STATUSES.has(attempt.status));
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
      actorUid: 'social-publisher',
      reason,
    });
  }

  async function getAttemptMetadata(attemptId) {
    return (await repository.getPublishAttempt(attemptId))?.metadata ?? {};
  }

  function linkedInHeaders(token) {
    return {
      authorization: `Bearer ${token}`,
      'Linkedin-Version': serviceConfig.linkedin?.apiVersion ?? DEFAULT_LINKEDIN_API_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    };
  }

  function metaGraphVersion() {
    return serviceConfig.meta?.graphVersion ?? 'v21.0';
  }

  function maxStatusPolls() {
    return Number(serviceConfig.social?.publisherStatusMaxPolls ?? 20);
  }

  function getArtifactPublicUrl(artifact) {
    if (artifact.metadata?.publicUrl && isPublicHttpUrl(artifact.metadata.publicUrl)) {
      return artifact.metadata.publicUrl;
    }
    if (!serviceConfig.publicBaseUrl || !isPublicHttpUrl(serviceConfig.publicBaseUrl)) {
      return null;
    }
    return new URL(`/api/v1/assets/${artifact.id}/content`, serviceConfig.publicBaseUrl).toString();
  }

  function getPublicVideoUrl(context) {
    const candidates = [
      context.metadata.publicVideoUrl,
      context.metadata.videoUrl,
      context.video?.publicUrl,
      context.video?.artifact?.metadata?.publicUrl,
      context.video?.artifact?.metadata?.downloadUrl,
    ];
    return candidates.find((candidate) => isPublicHttpUrl(candidate)) ?? null;
  }

  async function postForm(url, token, form, message) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: form,
    });
    const payload = await readResponseBody(response);
    assertProviderOk(response, payload, message);
    return payload;
  }

  async function postJson(url, token, payload, message, extraHeaders = {}) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
    });
    const responsePayload = await readResponseBody(response);
    assertProviderOk(response, responsePayload, message);
    return responsePayload;
  }

  async function postUrlEncoded(url, token, payload, message) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: payload,
    });
    const responsePayload = await readResponseBody(response);
    assertProviderOk(response, responsePayload, message);
    return responsePayload;
  }

  async function postWithoutBody(url, token, message) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    const responsePayload = await readResponseBody(response);
    assertProviderOk(response, responsePayload, message);
    return responsePayload;
  }

  async function deleteRequest(url, token, message, extraHeaders = {}) {
    const response = await fetchImpl(url, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${token}`,
        ...extraHeaders,
      },
    });
    if (response.status === 204) {
      return { deleted: true, status: 204 };
    }
    const responsePayload = await readResponseBody(response);
    if (response.status === 404) {
      return { deleted: true, alreadyMissing: true, status: 404, response: responsePayload };
    }
    assertProviderOk(response, responsePayload, message);
    return responsePayload;
  }

  function waitForAttempt(attemptId) {
    return activeUploads.get(attemptId) ?? null;
  }

  return {
    deletePublication,
    enabledPlatforms: Array.from(enabledPlatforms),
    enqueueAttempt,
    importChannelPublications,
    publishAttempt,
    resumeQueuedAttempts,
    syncablePlatforms: publicationImportService.syncablePlatforms,
    updateMetadata,
    updatePrivacy,
    waitForAttempt,
  };
}

function mergePublishMetadata({ attempt, plan, job }) {
  const metadata = {
    ...(job.metadata ?? {}),
    ...(plan.metadata ?? {}),
    ...(attempt.metadata ?? {}),
  };
  const title = normalizeText(metadata.title ?? job.title, 100) || 'NewLeaf video';
  const description = normalizeText(
    metadata.description ?? metadata.caption ?? job.metadata?.reviewSummary?.summary ?? '',
    5000,
  );
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 50)
    : [];
  const hashtags = Array.isArray(metadata.hashtags)
    ? metadata.hashtags.map(normalizeHashtag).filter(Boolean).slice(0, 30)
    : [];

  return {
    ...metadata,
    title,
    description,
    caption: normalizeText(metadata.caption ?? '', 5000),
    tags,
    hashtags,
    privacyStatus: normalizePrivacyStatus(metadata.privacyStatus),
  };
}

function buildCaption(context, maxLength) {
  const base = context.metadata.caption || [context.metadata.title, context.metadata.description]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
  const hashtags = context.metadata.hashtags?.length
    ? context.metadata.hashtags
    : context.metadata.tags ?? [];
  const hashtagText = buildHashtagText(hashtags);
  return fitTextWithSuffix(base, hashtagText, maxLength) || context.metadata.title;
}

function buildHashtagText(hashtags = []) {
  const unique = Array.from(new Set(hashtags.map(normalizeHashtag).filter(Boolean)));
  return unique.length ? `\n\n${unique.map((tag) => `#${tag}`).join(' ')}` : '';
}

function fitTextWithSuffix(text, suffix, maxLength) {
  const base = String(text ?? '').trim();
  if (!suffix) return normalizeText(base, maxLength);
  if (suffix.length >= maxLength) return normalizeText(suffix.trim(), maxLength);
  const available = maxLength - suffix.length;
  const trimmedBase = base.length > available ? `${base.slice(0, Math.max(0, available - 1)).trim()}` : base;
  return normalizeText(`${trimmedBase}${suffix}`, maxLength);
}

function normalizeHashtag(value) {
  return String(value ?? '')
    .trim()
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}_]+/gu, '')
    .slice(0, 60);
}

function getLinkedInOwnerUrn(context) {
  const owner =
    context.metadata.linkedinOwnerUrn ??
    context.account.metadata?.organizationUrn ??
    context.account.metadata?.ownerUrn ??
    null;
  if (owner) return owner;
  if (!context.account.providerAccountId) {
    throw conflict('LinkedIn account is missing a member or organization id', { accountId: context.account.id });
  }
  return `urn:li:person:${context.account.providerAccountId}`;
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

function uploadPercent(uploadedBytes, totalBytes, minPercent, span) {
  if (!totalBytes) return minPercent;
  return Math.min(minPercent + span, Math.max(minPercent, Math.round(minPercent + (uploadedBytes / totalBytes) * span)));
}

async function readFileRange(file, start, end) {
  const length = end - start + 1;
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await file.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

function toUint8Array(buffer) {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

async function readResponseBody(response) {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function assertProviderOk(response, payload, message) {
  if (response.ok) return;
  throw conflict(message, {
    status: response.status,
    response: payload,
  });
}

function assertScopes({ account, secret, token, requiredScopes, requiredAnyScopes, operation, platform }) {
  const granted = getGrantedScopes(account, secret, token);
  const missing = requiredScopes.filter((scope) => !granted.has(scope));
  const hasAny = requiredAnyScopes.length === 0 || requiredAnyScopes.some((scope) => granted.has(scope));
  if (missing.length === 0 && hasAny) return;
  throw conflict(`Connected ${platformLabel(platform)} account is missing the scope required to ${operation}. Reconnect the account.`, {
    requiredScopes,
    requiredAnyScopes,
    grantedScopes: Array.from(granted),
  });
}

function getGrantedScopes(account, secret, token) {
  return new Set([
    ...(Array.isArray(account.scopes) ? account.scopes : []),
    ...(Array.isArray(secret.metadata?.scopes) ? secret.metadata.scopes : []),
    ...(Array.isArray(token.scopes) ? token.scopes : []),
    ...String(token.scope ?? '').split(/\s+/).filter(Boolean),
  ]);
}

function normalizePrivacyStatus(value) {
  const normalized = String(value ?? '').toLowerCase();
  return ['private', 'public', 'unlisted'].includes(normalized) ? normalized : 'public';
}

function normalizeText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) <= Date.now() + 60_000;
}

function latestByDate(records) {
  return [...records].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt ?? left.createdAt ?? 0);
    const rightTime = Date.parse(right.updatedAt ?? right.createdAt ?? 0);
    return rightTime - leftTime;
  })[0];
}

function isPathInside(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isPublicHttpUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      host !== 'localhost' &&
      host !== '127.0.0.1' &&
      host !== '0.0.0.0' &&
      !host.endsWith('.local') &&
      !host.startsWith('10.') &&
      !host.startsWith('192.168.') &&
      !/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    );
  } catch {
    return false;
  }
}

function stripQuotes(value) {
  return String(value ?? '').replace(/^"+|"+$/g, '');
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function platformLabel(platform) {
  const labels = {
    youtube: 'YouTube',
    x: 'X',
    linkedin: 'LinkedIn',
    instagram: 'Instagram',
    facebook: 'Facebook',
  };
  return labels[platform] ?? platform;
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

function providerFailureMessage(error) {
  const response = error.details?.response;
  const firstError = Array.isArray(response?.errors) ? response.errors[0] : null;
  const providerDetail =
    response?.detail ??
    response?.error_description ??
    response?.error?.message ??
    firstError?.detail ??
    firstError?.message ??
    null;
  const providerTitle = response?.title ?? firstError?.title ?? null;
  if (providerTitle && providerDetail) {
    return `${providerTitle}: ${providerDetail}`;
  }
  return providerDetail ?? error.message;
}
