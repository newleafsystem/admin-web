import { badGateway, badRequest, conflict } from '../lib/httpErrors.js';

const SYNCABLE_PLATFORMS = new Set(['youtube', 'x', 'linkedin', 'instagram', 'facebook']);
const X_USER_TWEETS_URL = 'https://api.x.com/2/users';
const LINKEDIN_POSTS_URL = 'https://api.linkedin.com/rest/posts';
const DEFAULT_LINKEDIN_API_VERSION = '202604';

export function createSocialPublicationImportService(options = {}) {
  const repository = options.repository;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const serviceConfig = options.config ?? {};
  const clock = options.clock ?? (() => new Date().toISOString());
  const getAccessToken = options.getAccessToken;
  const youtubeImporter = options.youtubeImporter;

  if (!repository || !getAccessToken) {
    throw new TypeError('createSocialPublicationImportService requires repository and getAccessToken');
  }

  async function importChannelPublications({ platform, accountId = null, maxResults = Number.POSITIVE_INFINITY, actorUid = 'local-admin' } = {}) {
    const normalizedPlatform = normalizePlatform(platform);
    if (normalizedPlatform === 'youtube') {
      if (!youtubeImporter) {
        throw conflict('YouTube channel sync is not available in this runtime');
      }
      return youtubeImporter({ accountId, maxResults, actorUid });
    }

    const importer = providerImporters[normalizedPlatform];
    if (!importer) {
      throw badRequest('Channel import is not wired for this platform', {
        platform: normalizedPlatform,
        supported: Array.from(SYNCABLE_PLATFORMS),
      });
    }

    const account = await resolveConnectedAccount(normalizedPlatform, accountId);
    const accessToken = await getAccessToken(account, importer.tokenOptions);
    const records = await importer.fetchRecords({ account, accessToken, maxResults });
    const result = await upsertImportedPublications({ account, actorUid, records });
    return {
      account,
      publications: result.publications,
      imported: result.imported,
      updated: result.updated,
      scanned: records.length,
    };
  }

  async function resolveConnectedAccount(platform, accountId) {
    const account = accountId
      ? await repository.getSocialAccount(accountId)
      : await resolveDefaultAccount(platform);
    if (!account) {
      throw conflict(`No connected ${platformLabel(platform)} account is available for channel sync`);
    }
    if (account.platform !== platform) {
      throw badRequest('Channel sync account does not match requested platform', {
        accountId: account.id,
        accountPlatform: account.platform,
        requestedPlatform: platform,
      });
    }
    if (!account.tokenSecretRef) {
      throw conflict(`${platformLabel(platform)} account does not have an OAuth token secret`, { accountId: account.id });
    }
    return account;
  }

  async function resolveDefaultAccount(platform) {
    const accounts = await repository.listSocialAccounts({ platform });
    return (
      accounts.find((account) => isUsableConnectedAccount(account) && account.tokenSecretRef) ??
      accounts.find(isUsableConnectedAccount) ??
      null
    );
  }

  const providerImporters = {
    x: {
      tokenOptions: {
        platform: 'x',
        operation: 'sync X posts',
        requiredScopes: ['tweet.read', 'users.read'],
      },
      fetchRecords: fetchXPublications,
    },
    linkedin: {
      tokenOptions: {
        platform: 'linkedin',
        operation: 'sync LinkedIn posts',
        requiredAnyScopes: ['r_member_social', 'w_member_social', 'r_organization_social', 'w_organization_social'],
      },
      fetchRecords: fetchLinkedInPublications,
    },
    facebook: {
      tokenOptions: {
        platform: 'facebook',
        operation: 'sync Facebook Page videos',
        requiredScopes: ['pages_read_engagement'],
      },
      fetchRecords: fetchFacebookPublications,
    },
    instagram: {
      tokenOptions: {
        platform: 'instagram',
        operation: 'sync Instagram videos',
        requiredScopes: ['instagram_basic'],
      },
      fetchRecords: fetchInstagramPublications,
    },
  };

  async function fetchXPublications({ account, accessToken, maxResults }) {
    const userId = account.providerAccountId;
    if (!userId) {
      throw conflict('X account is missing a user id', { accountId: account.id });
    }
    const limit = normalizeMaxResults(maxResults);
    const tweets = [];
    const mediaByKey = new Map();
    let paginationToken = null;

    while (tweets.length < limit) {
      const url = new URL(`${X_USER_TWEETS_URL}/${encodeURIComponent(userId)}/tweets`);
      url.searchParams.set('tweet.fields', 'attachments,created_at,entities,public_metrics,text');
      url.searchParams.set('expansions', 'attachments.media_keys');
      url.searchParams.set('media.fields', 'alt_text,duration_ms,media_key,preview_image_url,public_metrics,type,url');
      url.searchParams.set('max_results', String(Math.min(100, Math.max(5, limit - tweets.length))));
      if (paginationToken) url.searchParams.set('pagination_token', paginationToken);

      const payload = await getJson(url, accessToken, 'Unable to list X posts');
      for (const media of payload.includes?.media ?? []) {
        if (media.media_key) mediaByKey.set(media.media_key, media);
      }
      tweets.push(...(payload.data ?? []));
      paginationToken = payload.meta?.next_token;
      if (!paginationToken) break;
    }

    return tweets
      .slice(0, limit)
      .map((tweet) => {
        const mediaItems = (tweet.attachments?.media_keys ?? []).map((key) => mediaByKey.get(key)).filter(Boolean);
        const videos = mediaItems.filter((media) => ['video', 'animated_gif'].includes(String(media.type ?? '').toLowerCase()));
        const media = videos[0];
        if (!media) return null;
        return normalizeExternalRecord({
          account,
          platform: 'x',
          providerPostId: tweet.id,
          providerUrl: `https://x.com/i/web/status/${tweet.id}`,
          title: firstLine(tweet.text) || 'X video post',
          description: tweet.text ?? '',
          publishedAt: tweet.created_at ?? null,
          thumbnailUrl: media.preview_image_url ?? null,
          statistics: tweet.public_metrics ?? {},
          raw: { tweet, media },
          providerMetadata: {
            tweetId: tweet.id,
            mediaKey: media.media_key ?? null,
            mediaType: media.type ?? null,
          },
        });
      })
      .filter(Boolean);
  }

  async function fetchLinkedInPublications({ account, accessToken, maxResults }) {
    const owner = getLinkedInOwnerUrn(account);
    const limit = normalizeMaxResults(maxResults);
    const posts = [];
    let start = 0;

    while (posts.length < limit) {
      const url = new URL(LINKEDIN_POSTS_URL);
      url.searchParams.set('q', 'author');
      url.searchParams.set('author', owner);
      url.searchParams.set('count', String(Math.min(100, limit - posts.length)));
      url.searchParams.set('start', String(start));
      url.searchParams.set('sortBy', 'LAST_MODIFIED');

      const payload = await getJson(url, accessToken, 'Unable to list LinkedIn posts', linkedInHeaders(accessToken));
      const elements = payload.elements ?? [];
      posts.push(...elements);
      if (elements.length === 0 || posts.length >= Number(payload.paging?.total ?? limit)) break;
      start += elements.length;
    }

    return posts
      .slice(0, limit)
      .filter((post) => isLinkedInVideoPost(post))
      .map((post) => {
        const media = post.content?.media ?? {};
        const providerPostId = post.id ?? post.entity ?? media.id;
        return normalizeExternalRecord({
          account,
          platform: 'linkedin',
          providerPostId,
          providerUrl: providerPostId ? `https://www.linkedin.com/feed/update/${providerPostId}/` : null,
          title: media.title?.text ?? firstLine(post.commentary) ?? 'LinkedIn video post',
          description: post.commentary ?? '',
          publishedAt: post.publishedAt ? new Date(Number(post.publishedAt)).toISOString() : null,
          thumbnailUrl: media.thumbnail ?? null,
          statistics: {},
          raw: post,
          providerMetadata: {
            owner,
            postId: providerPostId,
            videoUrn: media.id ?? null,
          },
        });
      });
  }

  async function fetchFacebookPublications({ account, accessToken, maxResults }) {
    const pageId = account.providerAccountId ?? account.metadata?.page?.id;
    if (!pageId) {
      throw conflict('Facebook account is missing a Page id', { accountId: account.id });
    }
    const limit = normalizeMaxResults(maxResults);
    const videos = [];
    let nextUrl = graphUrl(`${pageId}/videos`, {
      fields: 'id,title,description,created_time,permalink_url,picture,length,views',
      limit: String(Math.min(100, limit)),
    });

    while (nextUrl && videos.length < limit) {
      const payload = await getJson(nextUrl, accessToken, 'Unable to list Facebook Page videos');
      videos.push(...(payload.data ?? []));
      nextUrl = payload.paging?.next ? new URL(payload.paging.next) : null;
    }

    return videos.slice(0, limit).map((video) => normalizeExternalRecord({
      account,
      platform: 'facebook',
      providerPostId: video.id,
      providerUrl: video.permalink_url ?? `https://www.facebook.com/watch/?v=${video.id}`,
      title: video.title ?? firstLine(video.description) ?? 'Facebook video',
      description: video.description ?? '',
      publishedAt: video.created_time ?? null,
      thumbnailUrl: video.picture ?? null,
      statistics: {
        viewCount: video.views ?? null,
      },
      raw: video,
      providerMetadata: {
        pageId,
        videoId: video.id,
      },
    }));
  }

  async function fetchInstagramPublications({ account, accessToken, maxResults }) {
    const instagramAccountId =
      account.providerAccountId ?? account.metadata?.instagramAccount?.id ?? account.metadata?.page?.connected_instagram_account?.id;
    if (!instagramAccountId) {
      throw conflict('Instagram account is missing an Instagram Business or Creator id', { accountId: account.id });
    }
    const limit = normalizeMaxResults(maxResults);
    const mediaItems = [];
    let nextUrl = graphUrl(`${instagramAccountId}/media`, {
      fields: 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count',
      limit: String(Math.min(100, limit)),
    });

    while (nextUrl && mediaItems.length < limit) {
      const payload = await getJson(nextUrl, accessToken, 'Unable to list Instagram media');
      mediaItems.push(...(payload.data ?? []));
      nextUrl = payload.paging?.next ? new URL(payload.paging.next) : null;
    }

    return mediaItems
      .slice(0, limit)
      .filter((media) => ['VIDEO', 'REELS'].includes(String(media.media_type ?? '').toUpperCase()))
      .map((media) => normalizeExternalRecord({
        account,
        platform: 'instagram',
        providerPostId: media.id,
        providerUrl: media.permalink ?? null,
        title: firstLine(media.caption) || 'Instagram video',
        description: media.caption ?? '',
        publishedAt: media.timestamp ?? null,
        thumbnailUrl: media.thumbnail_url ?? null,
        statistics: {
          likeCount: media.like_count ?? null,
          commentCount: media.comments_count ?? null,
        },
        raw: media,
        providerMetadata: {
          instagramAccountId,
          mediaId: media.id,
          mediaType: media.media_type ?? null,
        },
      }));
  }

  async function upsertImportedPublications({ account, actorUid, records }) {
    const existingAttempts = await repository.listPublishAttempts({ platform: account.platform });
    const existingByPostId = new Map(
      existingAttempts
        .filter((attempt) => attempt.providerPostId)
        .map((attempt) => [attempt.providerPostId, attempt]),
    );

    const publications = [];
    let imported = 0;
    let updated = 0;
    for (const record of records) {
      const existing = existingByPostId.get(record.providerPostId);
      const publication = existing
        ? await updateImportedPublication(existing, { account, record })
        : await createImportedPublication({ account, actorUid, record });
      publications.push(publication);
      if (existing) updated += 1;
      else imported += 1;
    }

    return { publications, imported, updated };
  }

  async function createImportedPublication({ account, actorUid, record }) {
    const safeId = sanitizeExternalId(record.providerPostId);
    const jobId = `external_${record.platform}_${safeId}`;
    const planId = `external_${record.platform}_plan_${safeId}`;
    const attemptId = `external_${record.platform}_attempt_${safeId}`;
    const metadata = buildImportedMetadata({ account, record });

    const existingJob = await repository.getJob(jobId);
    if (!existingJob) {
      await repository.createJob({
        id: jobId,
        title: metadata.title,
        type: 'external_video',
        status: 'published',
        sourceType: `external_${record.platform}`,
        ownerUid: actorUid,
        metadata: {
          externalSource: metadata.externalSource,
          sourceArtifact: metadata.providerUrl,
          videoUrl: metadata.providerUrl,
          thumbnailUrl: metadata.thumbnailUrl,
          publishedAt: metadata.publishedAt,
          owner: account.accountName,
          provider: platformLabel(record.platform),
        },
      });
    } else {
      await repository.updateJob(jobId, {
        title: metadata.title,
        status: existingJob.status ?? 'published',
        metadata: {
          ...(existingJob.metadata ?? {}),
          sourceArtifact: metadata.providerUrl,
          videoUrl: metadata.providerUrl,
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
        platforms: [record.platform],
        metadata: {
          title: metadata.title,
          description: metadata.description,
          externalSource: metadata.externalSource,
        },
        createdBy: actorUid,
      });
    }

    const existingAttempt = await repository.getPublishAttempt(attemptId);
    if (existingAttempt) {
      return updateImportedPublication(existingAttempt, { account, record });
    }

    return repository.createPublishAttempt({
      id: attemptId,
      planId,
      jobId,
      platform: record.platform,
      connectedAccountId: account.id,
      status: 'published',
      providerPostId: record.providerPostId,
      providerUrl: metadata.providerUrl,
      metadata,
    });
  }

  async function updateImportedPublication(attempt, { account, record }) {
    const metadata = buildImportedMetadata({ account, record });
    const existingMetadata = attempt.metadata ?? {};
    const platformMetadata = record.providerMetadata ?? {};
    const mergedMetadata = {
      ...existingMetadata,
      ...metadata,
      [record.platform]: {
        ...(existingMetadata[record.platform] ?? {}),
        ...platformMetadata,
        imported: true,
        response: record.raw ?? null,
      },
    };

    return repository.updatePublishAttempt(attempt.id, {
      connectedAccountId: attempt.connectedAccountId ?? account.id,
      status: attempt.status === 'deleted' ? attempt.status : 'published',
      providerPostId: record.providerPostId,
      providerUrl: attempt.status === 'deleted' ? attempt.providerUrl : metadata.providerUrl,
      errorCode: null,
      errorMessage: null,
      metadata: mergedMetadata,
    });
  }

  function buildImportedMetadata({ account, record }) {
    const syncedAt = clock();
    const platformMetadata = {
      ...(record.providerMetadata ?? {}),
      imported: true,
      response: record.raw ?? null,
    };
    return {
      externalSource: `${record.platform}_channel_import`,
      accountName: account.accountName,
      providerAccountId: account.providerAccountId ?? null,
      title: normalizeText(record.title, 300) || `${platformLabel(record.platform)} video`,
      description: String(record.description ?? ''),
      tags: [],
      hashtags: extractHashtags(record.description),
      privacyStatus: record.privacyStatus ?? 'public',
      publishedAt: record.publishedAt ?? null,
      thumbnailUrl: record.thumbnailUrl ?? null,
      providerUrl: record.providerUrl ?? null,
      importedAt: syncedAt,
      syncedAt,
      statistics: record.statistics ?? {},
      ...progressMetadata({
        stage: 'published',
        percent: 100,
        label: `Imported from ${platformLabel(record.platform)}.`,
      }),
      [record.platform]: platformMetadata,
    };
  }

  function graphUrl(path, params = {}) {
    const url = new URL(`https://graph.facebook.com/${serviceConfig.meta?.graphVersion ?? 'v21.0'}/${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  async function getJson(url, accessToken, message, extraHeaders = {}) {
    const response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...extraHeaders,
      },
    });
    const payload = await readResponseBody(response);
    if (!response.ok) {
      throw badGateway(message, {
        status: response.status,
        response: payload,
      });
    }
    return payload;
  }

  function linkedInHeaders(token) {
    return {
      authorization: `Bearer ${token}`,
      'Linkedin-Version': serviceConfig.linkedin?.apiVersion ?? DEFAULT_LINKEDIN_API_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    };
  }

  return {
    importChannelPublications,
    syncablePlatforms: Array.from(SYNCABLE_PLATFORMS),
  };
}

function normalizeExternalRecord(input) {
  if (!input.providerPostId) {
    throw conflict('Imported provider record is missing a provider id', {
      platform: input.platform,
      response: input.raw,
    });
  }
  return {
    ...input,
    providerPostId: String(input.providerPostId),
  };
}

function getLinkedInOwnerUrn(account) {
  const owner = account.metadata?.organizationUrn ?? account.metadata?.ownerUrn ?? null;
  if (owner) return owner;
  if (!account.providerAccountId) {
    throw conflict('LinkedIn account is missing a member or organization id', { accountId: account.id });
  }
  return `urn:li:person:${account.providerAccountId}`;
}

function isLinkedInVideoPost(post) {
  const mediaId = String(post.content?.media?.id ?? '');
  if (mediaId.toLowerCase().includes(':video:')) return true;
  const contentType = String(post.content?.media?.type ?? post.content?.type ?? '').toLowerCase();
  return contentType.includes('video');
}

function normalizeMaxResults(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(5000, Math.trunc(numeric)));
}

function normalizePlatform(platform) {
  const normalized = String(platform ?? '').toLowerCase();
  if (normalized === 'twitter') return 'x';
  if (SYNCABLE_PLATFORMS.has(normalized)) return normalized;
  throw badRequest('Unsupported publication sync platform', {
    platform,
    supported: Array.from(SYNCABLE_PLATFORMS),
  });
}

function isUsableConnectedAccount(account) {
  const status = String(account?.status ?? '').toLowerCase();
  const tokenHealth = String(account?.tokenHealth ?? '').toLowerCase();
  return ['connected', 'configured'].includes(status) && !['refresh failed', 'disconnected'].includes(tokenHealth);
}

function firstLine(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 140) ?? '';
}

function extractHashtags(value) {
  const matches = String(value ?? '').match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return Array.from(new Set(matches.map((tag) => tag.replace(/^#+/, '').slice(0, 60))));
}

function progressMetadata({ stage, percent, label }) {
  return {
    publisherStatus: label,
    progressStage: stage,
    progressPercent: percent,
    progressLabel: label,
    uploadedBytes: null,
    totalBytes: null,
    lastProgressAt: new Date().toISOString(),
  };
}

function normalizeText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function sanitizeExternalId(value) {
  return String(value ?? 'unknown')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);
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
