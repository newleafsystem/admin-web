import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { badRequest, conflict, notFound } from '../lib/httpErrors.js';
import { canTransition } from '../services/jobStateService.js';
import {
  optionalObject,
  optionalNumber,
  optionalString,
  optionalStringArray,
  rejectUnknownFields,
  requireAllowed,
  requireObject,
  requireString,
} from '../lib/validation.js';

const SUPPORTED_PLATFORMS = ['youtube', 'x', 'linkedin', 'instagram', 'facebook', 'tiktok'];
const DEFAULT_ENABLED_PUBLISH_PLATFORMS = ['youtube', 'x', 'linkedin', 'instagram', 'facebook'];
const SYNCABLE_IMPORT_PLATFORMS = ['youtube', 'x', 'linkedin', 'instagram', 'facebook'];

export function createPublishingRouter({ repository, jobStateService, publisherService, videoReviewService }) {
  const router = Router();

  router.get(
    '/publish-plans',
    requireRole('admin', 'publisher', 'reviewer', 'viewer'),
    asyncHandler(async (req, res) => {
      const plans = await repository.listPublishPlans({
        jobId: req.query.jobId,
        status: req.query.status,
      });
      const plansWithAttempts = await Promise.all(
        plans.map(async (plan) => ({
          ...plan,
          attempts: await hydratePublishAttemptsWithAccounts(repository, await repository.listPublishAttempts({ planId: plan.id })),
        })),
      );
      res.json({ plans: plansWithAttempts });
    }),
  );

  router.post(
    '/publish-plans/generate-youtube-tags',
    requireRole('admin', 'publisher', 'reviewer'),
    asyncHandler(async (req, res) => {
      if (!videoReviewService?.generateYouTubeTags) {
        throw conflict('AI tag generation is not available in this runtime');
      }
      const body = requireObject(req.body);
      rejectUnknownFields(body, ['jobId', 'title', 'description', 'hashtags']);
      const jobId = requireString(body, 'jobId', { maxLength: 200 });
      const job = await repository.getJob(jobId);
      if (!job) throw notFound('Job not found', { jobId });
      const artifacts = await repository.listArtifactsForJob(job.id);
      const result = await videoReviewService.generateYouTubeTags({
        job,
        artifacts,
        metadata: {
          title: optionalString(body, 'title', { maxLength: 300, defaultValue: job.title }),
          description: optionalString(body, 'description', { minLength: 0, maxLength: 5000, defaultValue: '' }),
          hashtags: optionalStringArray(body, 'hashtags', { minItems: 0, maxItems: 30 }),
        },
      });
      res.json(result);
    }),
  );

  router.post(
    '/publish-plans',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, ['jobId', 'platforms', 'metadata', 'scheduledAt', 'republishOfPublicationId']);
      const jobId = requireString(body, 'jobId', { maxLength: 200 });
      const job = await repository.getJob(jobId);
      if (!job) throw notFound('Job not found', { jobId });
      const republishSourceAttemptId = optionalString(body, 'republishOfPublicationId', {
        maxLength: 200,
        defaultValue: null,
      });
      const republishSource = republishSourceAttemptId
        ? await validateRepublishSource(repository, { sourceAttemptId: republishSourceAttemptId, jobId })
        : null;

      const platforms = Array.from(
        new Set(optionalStringArray(body, 'platforms', { minItems: 1, maxItems: 10 }).map((platform) => platform.toLowerCase())),
      );
      if (platforms.length === 0) {
        throw badRequest('platforms must contain at least one platform');
      }
      const unsupported = platforms.filter((platform) => !SUPPORTED_PLATFORMS.includes(platform));
      if (unsupported.length > 0) {
        throw conflict('Publish plan contains unsupported platforms', { unsupported, supported: SUPPORTED_PLATFORMS });
      }
      const enabledPublishPlatforms = getEnabledPublishPlatforms(publisherService);
      const disabled = platforms.filter((platform) => !enabledPublishPlatforms.includes(platform));
      if (disabled.length > 0) {
        throw conflict('Publish plan contains platforms whose publisher workers are not enabled yet', {
          disabled,
          enabled: enabledPublishPlatforms,
        });
      }

      const missingAccounts = await findMissingConnectedAccounts(repository, platforms);
      if (missingAccounts.length > 0) {
        throw conflict('Publish plan contains platforms without connected accounts', {
          platforms: missingAccounts,
        });
      }

      if (!republishSource) {
        const unavailable = await findUnavailablePublishPlatforms(repository, { jobId, platforms });
        if (unavailable.length > 0) {
          throw conflict('Publish plan contains platforms already published, planned, or in progress for this job', {
            unavailable,
          });
        }
      }

      const metadata = {
        ...normalizePublishMetadata(optionalObject(body, 'metadata', { defaultValue: {} })),
        ...(republishSource ? republishMetadataForSource(republishSource, req.user.uid) : {}),
      };
      const plan = await repository.createPublishPlan({
        jobId,
        platforms,
        metadata,
        scheduledAt: optionalString(body, 'scheduledAt', { maxLength: 80, defaultValue: null }),
        createdBy: req.user.uid,
      });
      res.status(201).json({ plan });
    }),
  );

  router.get(
    '/publish-plans/:planId',
    requireRole('admin', 'publisher', 'reviewer', 'viewer'),
    asyncHandler(async (req, res) => {
      const plan = await repository.getPublishPlan(req.params.planId);
      if (!plan) throw notFound('Publish plan not found', { planId: req.params.planId });
      const attempts = await hydratePublishAttemptsWithAccounts(
        repository,
        await repository.listPublishAttempts({ planId: req.params.planId }),
      );
      res.json({ plan, attempts });
    }),
  );

  router.post(
    '/publish-plans/:planId/approve',
    requireRole('admin', 'reviewer'),
    asyncHandler(async (req, res) => {
      const plan = await repository.getPublishPlan(req.params.planId);
      if (!plan) throw notFound('Publish plan not found', { planId: req.params.planId });
      const updated = await repository.updatePublishPlan(req.params.planId, {
        status: 'approved',
        approvedBy: req.user.uid,
      });
      res.json({ plan: updated });
    }),
  );

  router.post(
    '/publish-plans/:planId/publish',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      const plan = await repository.getPublishPlan(req.params.planId);
      if (!plan) throw notFound('Publish plan not found', { planId: req.params.planId });
      if (plan.status !== 'approved') {
        throw conflict('Publish plan must be approved before publishing', {
          planId: plan.id,
          status: plan.status,
        });
      }
      const job = await repository.getJob(plan.jobId);
      if (!job) throw notFound('Job not found', { jobId: plan.jobId });
      validatePublishMetadata(plan.metadata);
      const isRepublish = isRepublishPlan(plan);
      const allowedJobStatuses = isRepublish
        ? ['approved', 'partial_failed', 'publishing', 'published']
        : ['approved', 'partial_failed', 'publishing'];
      if (!allowedJobStatuses.includes(job.status)) {
        throw conflict('Job must be approved before publishing can start', {
          jobId: job.id,
          status: job.status,
          allowed: allowedJobStatuses,
        });
      }
      const enabledPublishPlatforms = getEnabledPublishPlatforms(publisherService);
      const disabled = plan.platforms.filter((platform) => !enabledPublishPlatforms.includes(platform));
      if (disabled.length > 0) {
        throw conflict('Publish plan contains platforms whose publisher workers are not enabled yet', {
          disabled,
          enabled: enabledPublishPlatforms,
        });
      }

      const missingAccounts = await findMissingConnectedAccounts(repository, plan.platforms);
      if (missingAccounts.length > 0) {
        throw conflict('Cannot publish to platforms without connected accounts', {
          platforms: missingAccounts,
        });
      }

      if (!isRepublish) {
        const unavailable = await findUnavailablePublishPlatforms(repository, {
          jobId: plan.jobId,
          platforms: plan.platforms,
          ignorePlanId: plan.id,
        });
        if (unavailable.length > 0) {
          throw conflict('Cannot publish to platforms already published, planned, or in progress for this job', {
            unavailable,
          });
        }
      }

      const updatedPlan = await repository.updatePublishPlan(plan.id, { status: 'publishing' });
      if (job.status !== 'publishing' && canTransition(job.status, 'publishing')) {
        await jobStateService.transitionJob(job.id, 'publishing', {
          actorUid: req.user.uid,
          reason: 'publish_plan',
        });
      }
      const attempts = [];
      for (const platform of plan.platforms) {
        const account = await resolveConnectedAccount(repository, platform);
        const missingAccount = !account;
        const attempt = await repository.createPublishAttempt({
          planId: plan.id,
          jobId: plan.jobId,
          platform,
          connectedAccountId: account?.id ?? null,
          status: missingAccount ? 'failed' : 'queued',
          metadata: {
            ...publicationMetadataForAttempt(plan.metadata),
            accountName: account?.accountName ?? null,
            providerAccountId: account?.providerAccountId ?? null,
            ...publishProgressMetadata(
              missingAccount ? 'blocked' : 'queued',
              missingAccount
                ? 'No connected account is available for this platform.'
                : 'Queued for publisher worker.',
            ),
          },
          errorCode: missingAccount ? 'missing_connected_account' : null,
          errorMessage: missingAccount ? `No connected ${platform} account is available.` : null,
        });
        attempts.push(attempt);
        enqueuePublisherAttempt(publisherService, attempt);
      }

      res.status(202).json({ plan: updatedPlan, attempts });
    }),
  );

  router.post(
    '/publish-attempts/:attemptId/retry',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      const attempt = await repository.getPublishAttempt(req.params.attemptId);
      if (!attempt) throw notFound('Publish attempt not found', { attemptId: req.params.attemptId });
      const account = attempt.connectedAccountId ? null : await resolveConnectedAccount(repository, attempt.platform);
      const retryMetadata = clearFailureMetadata(attempt.metadata);
      const updated = await repository.updatePublishAttempt(attempt.id, {
        connectedAccountId: attempt.connectedAccountId ?? account?.id ?? null,
        status: attempt.connectedAccountId || account ? 'queued' : 'failed',
        errorCode: attempt.connectedAccountId || account ? null : 'missing_connected_account',
        errorMessage: attempt.connectedAccountId || account ? null : `No connected ${attempt.platform} account is available.`,
        attemptNo: attempt.attemptNo + 1,
        metadata: {
          ...retryMetadata,
          accountName: attempt.metadata?.accountName ?? account?.accountName ?? null,
          providerAccountId: attempt.metadata?.providerAccountId ?? account?.providerAccountId ?? null,
          ...publishProgressMetadata(
            attempt.connectedAccountId || account ? 'queued' : 'blocked',
            attempt.connectedAccountId || account
              ? 'Queued for publisher worker.'
              : 'No connected account is available for this platform.',
          ),
        },
      });
      res.status(202).json({
        attempt: updated,
        task: {
          type: 'publish_retry',
          queued: enqueuePublisherAttempt(publisherService, updated).queued,
        },
      });
    }),
  );

  router.post(
    '/publish-attempts/:attemptId/process',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      const attempt = await repository.getPublishAttempt(req.params.attemptId);
      if (!attempt) throw notFound('Publish attempt not found', { attemptId: req.params.attemptId });
      const task = enqueuePublisherAttempt(publisherService, attempt);
      res.status(202).json({ attempt, task });
    }),
  );

  router.get(
    '/publications',
    requireRole('admin', 'publisher', 'reviewer', 'viewer'),
    asyncHandler(async (req, res) => {
      const attempts = await repository.listPublishAttempts({ status: req.query.status });
      res.json({ publications: await hydratePublishAttemptsWithAccounts(repository, attempts) });
    }),
  );

  router.post(
    '/publications/import/youtube',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      if (!publisherService?.importChannelPublications) {
        throw conflict('YouTube channel sync is not available in this runtime');
      }

      const body = req.body ? requireObject(req.body) : {};
      rejectUnknownFields(body, ['accountId', 'maxResults']);
      const result = await publisherService.importChannelPublications({
        platform: 'youtube',
        accountId: optionalString(body, 'accountId', { maxLength: 200, defaultValue: null }),
        maxResults: optionalNumber(body, 'maxResults', { min: 1, max: 5000, defaultValue: undefined }),
        actorUid: req.user.uid,
      });

      res.status(200).json({
        publications: await hydratePublishAttemptsWithAccounts(repository, result.publications),
        imported: result.imported,
        updated: result.updated,
        scanned: result.scanned,
        accountId: result.account?.id ?? null,
      });
    }),
  );

  router.post(
    '/publications/import/:platform',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      if (!publisherService?.importChannelPublications) {
        throw conflict('Publication sync is not available in this runtime');
      }

      const platform = normalizeImportPlatform(req.params.platform);
      const body = req.body ? requireObject(req.body) : {};
      rejectUnknownFields(body, ['accountId', 'maxResults']);
      const result = await publisherService.importChannelPublications({
        platform,
        accountId: optionalString(body, 'accountId', { maxLength: 200, defaultValue: null }),
        maxResults: optionalNumber(body, 'maxResults', { min: 1, max: 5000, defaultValue: undefined }),
        actorUid: req.user.uid,
      });

      res.status(200).json({
        publications: await hydratePublishAttemptsWithAccounts(repository, result.publications),
        imported: result.imported,
        updated: result.updated,
        scanned: result.scanned,
        accountId: result.account?.id ?? null,
        platform,
      });
    }),
  );

  router.patch(
    '/publications/:attemptId',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      const attempt = await repository.getPublishAttempt(req.params.attemptId);
      if (!attempt) throw notFound('Publication not found', { attemptId: req.params.attemptId });

      const body = requireObject(req.body);
      rejectUnknownFields(body, [
        'title',
        'description',
        'tags',
        'hashtags',
        'privacyStatus',
        'thumbnailArtifactId',
        'thumbnailUrl',
        'thumbnailSource',
        'metadata',
      ]);
      const metadata = {
        ...(attempt.metadata ?? {}),
        ...optionalObject(body, 'metadata', { defaultValue: {} }),
        adminUpdatedAt: new Date().toISOString(),
        adminUpdatedBy: req.user.uid,
      };
      if (hasOwn(body, 'title')) {
        metadata.title = optionalString(body, 'title', { minLength: 1, maxLength: 300, defaultValue: '' });
      }
      if (hasOwn(body, 'description')) {
        metadata.description = optionalString(body, 'description', { minLength: 1, maxLength: 5000, defaultValue: '' });
      }
      if (hasOwn(body, 'tags')) {
        metadata.tags = optionalStringArray(body, 'tags', { minItems: 0, maxItems: 50 });
      }
      if (hasOwn(body, 'hashtags')) {
        metadata.hashtags = optionalStringArray(body, 'hashtags', { minItems: 0, maxItems: 30 }).map((hashtag) =>
          hashtag.replace(/^#+/, ''),
        );
      }
      if (hasOwn(body, 'privacyStatus')) {
        metadata.privacyStatus = requireAllowed(
          optionalString(body, 'privacyStatus', { maxLength: 20, defaultValue: 'private' }),
          'privacyStatus',
          ['private', 'public', 'unlisted'],
        );
      }
      if (hasOwn(body, 'thumbnailArtifactId')) {
        metadata.thumbnailArtifactId = optionalString(body, 'thumbnailArtifactId', { maxLength: 200, defaultValue: null });
      }
      if (hasOwn(body, 'thumbnailUrl')) {
        metadata.thumbnailUrl = optionalString(body, 'thumbnailUrl', { maxLength: 1000, defaultValue: null });
      }
      if (hasOwn(body, 'thumbnailSource')) {
        metadata.thumbnailSource = optionalString(body, 'thumbnailSource', { maxLength: 80, defaultValue: null });
      }

      let updated = await repository.updatePublishAttempt(attempt.id, { metadata });
      let task = {
        type: 'publication_update',
        queued: false,
        providerUpdated: false,
      };
      if (hasPublicationMetadataChange(body) && publisherService?.updateMetadata) {
        const result = await publisherService.updateMetadata(updated.id, metadata, {
          actorUid: req.user.uid,
        });
        updated = result.publication;
        task = {
          type: 'publication_metadata_update',
          queued: false,
          providerUpdated: result.providerUpdated,
        };
      }
      if (hasOwn(body, 'privacyStatus') && publisherService) {
        const result = await publisherService.updatePrivacy(updated.id, metadata.privacyStatus, {
          actorUid: req.user.uid,
        });
        updated = result.publication;
        task = {
          type: 'youtube_privacy_update',
          queued: false,
          providerUpdated: result.providerUpdated,
        };
      }
      res.json({
        publication: updated,
        task,
      });
    }),
  );

  router.post(
    '/publications/:attemptId/delete',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      const attempt = await repository.getPublishAttempt(req.params.attemptId);
      if (!attempt) throw notFound('Publication not found', { attemptId: req.params.attemptId });
      const body = req.body ? requireObject(req.body) : {};
      rejectUnknownFields(body, ['reason']);
      const reason = optionalString(body, 'reason', { maxLength: 500, defaultValue: null });
      const result = publisherService
        ? await publisherService.deletePublication(attempt.id, {
            actorUid: req.user.uid,
            reason,
          })
        : await markPublicationDeletedLocally(repository, attempt, {
            actorUid: req.user.uid,
            reason,
          });

      res.status(200).json({
        publication: result.publication,
        task: {
          type: 'publication_delete',
          queued: false,
          providerDeleted: result.providerDeleted,
        },
      });
    }),
  );

  router.post(
    '/publications/delete',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, ['jobId', 'platforms', 'reason']);
      const jobId = requireString(body, 'jobId', { maxLength: 200 });
      const platforms = new Set(optionalStringArray(body, 'platforms', { minItems: 0, maxItems: 10 }).map((platform) => platform.toLowerCase()));
      const reason = optionalString(body, 'reason', { maxLength: 500, defaultValue: null });

      const job = await repository.getJob(jobId);
      if (!job) throw notFound('Job not found', { jobId });

      const attempts = (await repository.listPublishAttempts({ jobId })).filter((attempt) => {
        if (platforms.size > 0 && !platforms.has(attempt.platform)) return false;
        return attempt.status !== 'deleted' && (attempt.status === 'published' || attempt.providerPostId);
      });
      if (attempts.length === 0) {
        throw conflict('No published platform records are available to delete for this job', {
          jobId,
          platforms: Array.from(platforms),
        });
      }

      const deleted = [];
      const failed = [];
      for (const attempt of attempts) {
        try {
          const result = publisherService
            ? await publisherService.deletePublication(attempt.id, {
                actorUid: req.user.uid,
                reason,
              })
            : await markPublicationDeletedLocally(repository, attempt, {
                actorUid: req.user.uid,
                reason,
              });
          deleted.push(result.publication);
        } catch (error) {
          failed.push({
            attemptId: attempt.id,
            platform: attempt.platform,
            message: error.message,
            details: error.details ?? null,
          });
        }
      }

      res.status(failed.length > 0 ? 207 : 200).json({
        publications: deleted,
        failed,
        task: {
          type: 'bulk_publication_delete',
          requested: attempts.length,
          deleted: deleted.length,
          failed: failed.length,
        },
      });
    }),
  );

  router.post(
    '/publications/:attemptId/hype',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      const attempt = await repository.getPublishAttempt(req.params.attemptId);
      if (!attempt) throw notFound('Publication not found', { attemptId: req.params.attemptId });
      const body = req.body ? requireObject(req.body) : {};
      rejectUnknownFields(body, ['strategy']);
      const hypeRequests = attempt.metadata?.hypeRequests ?? [];

      const updated = await repository.updatePublishAttempt(attempt.id, {
        metadata: {
          ...(attempt.metadata ?? {}),
          hypeRequests: [
            {
              requestedAt: new Date().toISOString(),
              requestedBy: req.user.uid,
              strategy: optionalString(body, 'strategy', { maxLength: 200, defaultValue: 'boost_visibility' }),
            },
            ...hypeRequests,
          ],
        },
      });

      res.status(202).json({
        publication: updated,
        task: {
          type: 'publication_hype',
          queued: false,
          TODO: 'Trigger platform-specific boost, repost, pin, comment, or campaign workflows.',
        },
      });
    }),
  );

  return router;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasPublicationMetadataChange(body) {
  return [
    'title',
    'description',
    'tags',
    'hashtags',
    'thumbnailArtifactId',
    'thumbnailUrl',
    'thumbnailSource',
    'metadata',
  ].some((field) => hasOwn(body, field));
}

function normalizePublishMetadata(metadata) {
  const normalized = {
    ...metadata,
    title: requireString(metadata, 'title', { maxLength: 300 }),
    description: requireString(metadata, 'description', { maxLength: 5000 }),
    tags: normalizeMetadataList(metadata.tags, { maxItems: 50 }),
    hashtags: normalizeMetadataList(metadata.hashtags, { maxItems: 30 }).map((hashtag) => hashtag.replace(/^#+/, '')),
  };
  return normalized;
}

async function validateRepublishSource(repository, { sourceAttemptId, jobId }) {
  const source = await repository.getPublishAttempt(sourceAttemptId);
  if (!source) throw notFound('Source publication not found', { attemptId: sourceAttemptId });
  if (source.jobId !== jobId) {
    throw badRequest('Republish source must belong to the selected video', {
      sourceAttemptId,
      sourceJobId: source.jobId,
      jobId,
    });
  }
  if (source.platform !== 'youtube') {
    throw badRequest('Only YouTube publications can be used as a republish source', {
      sourceAttemptId,
      platform: source.platform,
    });
  }
  if (source.status !== 'published') {
    throw conflict('Only published YouTube records can be republished', {
      sourceAttemptId,
      status: source.status,
    });
  }
  if (!source.providerPostId && !source.providerUrl) {
    throw conflict('Source YouTube publication is missing provider identifiers', {
      sourceAttemptId,
    });
  }
  return source;
}

function republishMetadataForSource(source, actorUid) {
  return {
    republishSourceAttemptId: source.id,
    republishSourcePlatform: source.platform,
    republishSourceProviderPostId: source.providerPostId ?? null,
    republishSourceProviderUrl: source.providerUrl ?? source.metadata?.providerUrl ?? null,
    republishRequestedAt: new Date().toISOString(),
    republishRequestedBy: actorUid,
  };
}

function isRepublishPlan(plan) {
  return Boolean(plan?.metadata?.republishSourceAttemptId);
}

function validatePublishMetadata(metadata = {}) {
  if (!String(metadata.title ?? '').trim()) {
    throw badRequest('Publish title is required before publishing');
  }
  if (!String(metadata.description ?? '').trim()) {
    throw badRequest('Publish description is required before publishing');
  }
}

function publicationMetadataForAttempt(metadata = {}) {
  return {
    title: metadata.title,
    description: metadata.description,
    tags: normalizeMetadataList(metadata.tags, { maxItems: 50 }),
    hashtags: normalizeMetadataList(metadata.hashtags, { maxItems: 30 }),
    caption: metadata.caption ?? null,
    thumbnailArtifactId: metadata.thumbnailArtifactId ?? null,
    thumbnailUrl: metadata.thumbnailUrl ?? null,
    thumbnailSource: metadata.thumbnailSource ?? null,
    privacyStatus: metadata.privacyStatus,
  };
}

function normalizeMetadataList(value, { maxItems }) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw badRequest('Publish metadata tags and hashtags must be arrays');
  }
  const seen = new Set();
  const output = [];
  for (const item of value) {
    const text = String(item ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(text);
    if (output.length >= maxItems) break;
  }
  return output;
}

function getEnabledPublishPlatforms(publisherService) {
  return publisherService?.enabledPlatforms ?? DEFAULT_ENABLED_PUBLISH_PLATFORMS;
}

function normalizeImportPlatform(platform) {
  const normalized = String(platform ?? '').toLowerCase();
  return requireAllowed(normalized === 'twitter' ? 'x' : normalized, 'platform', SYNCABLE_IMPORT_PLATFORMS);
}

function enqueuePublisherAttempt(publisherService, attempt) {
  if (!publisherService || attempt.status !== 'queued') {
    return { queued: false };
  }
  return publisherService.enqueueAttempt(attempt);
}

async function markPublicationDeletedLocally(repository, attempt, context = {}) {
  const updated = await repository.updatePublishAttempt(attempt.id, {
    status: 'deleted',
    providerUrl: null,
    errorCode: null,
    errorMessage: null,
    metadata: {
      ...(attempt.metadata ?? {}),
      ...publishProgressMetadata('deleted', 'Marked deleted in NewLeaf. Provider deletion service is unavailable.'),
      deletedAt: new Date().toISOString(),
      deletedBy: context.actorUid ?? null,
      deleteReason: context.reason ?? null,
      providerDeleted: false,
    },
  });
  return { publication: updated, providerDeleted: false };
}

async function hydratePublishAttemptsWithAccounts(repository, attempts) {
  const hydrated = [];
  for (const attempt of attempts) {
    const metadataPatch = missingProgressMetadata(attempt)
      ? publishProgressMetadata(progressStageForAttempt(attempt), attempt.metadata?.publisherStatus ?? progressLabelForAttempt(attempt))
      : {};

    if ((attempt.connectedAccountId || !['queued', 'retrying'].includes(attempt.status)) && Object.keys(metadataPatch).length === 0) {
      hydrated.push(attempt);
      continue;
    }

    const account = attempt.connectedAccountId ? null : await resolveConnectedAccount(repository, attempt.platform);
    if (!attempt.connectedAccountId && !account && Object.keys(metadataPatch).length === 0) {
      hydrated.push(attempt);
      continue;
    }

    hydrated.push(
      await repository.updatePublishAttempt(attempt.id, {
        connectedAccountId: attempt.connectedAccountId ?? account?.id ?? null,
        metadata: {
          ...(attempt.metadata ?? {}),
          ...metadataPatch,
          accountName: attempt.metadata?.accountName ?? account?.accountName ?? null,
          providerAccountId: attempt.metadata?.providerAccountId ?? account?.providerAccountId ?? null,
        },
      }),
    );
  }
  return hydrated;
}

async function resolveConnectedAccount(repository, platform) {
  const accounts = await repository.listSocialAccounts({ platform });
  return (
    accounts.find((account) => isUsableConnectedAccount(account) && account.tokenSecretRef) ??
    accounts.find(isUsableConnectedAccount) ??
    null
  );
}

async function findMissingConnectedAccounts(repository, platforms) {
  const missing = [];
  for (const platform of platforms) {
    const account = await resolveConnectedAccount(repository, platform);
    if (!account) {
      missing.push(platform);
    }
  }
  return missing;
}

async function findUnavailablePublishPlatforms(repository, { jobId, platforms, ignorePlanId = null }) {
  const targetPlatforms = new Set(platforms);
  const unavailable = new Map();
  const mark = (platform, reason) => {
    if (targetPlatforms.has(platform) && !unavailable.has(platform)) {
      unavailable.set(platform, reason);
    }
  };

  const attempts = await repository.listPublishAttempts({ jobId });
  for (const attempt of attempts) {
    if (attempt.planId === ignorePlanId) {
      continue;
    }
    if (['queued', 'retrying', 'uploading', 'processing', 'published', 'delete_requested'].includes(attempt.status)) {
      mark(attempt.platform, attempt.status === 'published' ? 'already_published' : 'publishing_in_progress');
    }
  }

  const plans = await repository.listPublishPlans({ jobId });
  for (const plan of plans) {
    if (plan.id === ignorePlanId || !['draft', 'approved', 'publishing'].includes(plan.status)) {
      continue;
    }
    for (const platform of plan.platforms ?? []) {
      mark(platform, 'already_planned');
    }
  }

  return Array.from(unavailable.entries()).map(([platform, reason]) => ({ platform, reason }));
}

function isUsableConnectedAccount(account) {
  const status = String(account?.status ?? '').toLowerCase();
  const tokenHealth = String(account?.tokenHealth ?? '').toLowerCase();
  return ['connected', 'configured'].includes(status) && !['refresh failed', 'disconnected'].includes(tokenHealth);
}

function publishProgressMetadata(stage, label, patch = {}) {
  return {
    publisherStatus: label,
    progressStage: stage,
    progressPercent: progressPercentForStage(stage),
    progressLabel: label,
    lastProgressAt: new Date().toISOString(),
    ...patch,
  };
}

function missingProgressMetadata(attempt) {
  const metadata = attempt.metadata ?? {};
  return metadata.progressStage === undefined || metadata.progressPercent === undefined || !metadata.progressLabel;
}

function clearFailureMetadata(metadata = {}) {
  const { failureDetails, ...rest } = metadata ?? {};
  return rest;
}

function progressStageForAttempt(attempt) {
  if (attempt.status === 'published') return 'published';
  if (attempt.status === 'failed') return 'failed';
  if (attempt.status === 'delete_requested') return 'delete_requested';
  if (attempt.status === 'retrying') return 'queued';
  return attempt.status ?? 'queued';
}

function progressPercentForStage(stage) {
  const percentages = {
    blocked: 0,
    failed: 0,
    queued: 10,
    uploading: 45,
    provider_processing: 80,
    published: 100,
    delete_requested: 45,
    deleted: 100,
  };
  return percentages[stage] ?? 0;
}

function progressLabelForAttempt(attempt) {
  const labels = {
    failed: attempt.errorMessage ?? 'Publish attempt failed.',
    published: 'Published on platform.',
    delete_requested: 'Deleting video from channel.',
    deleted: 'Deleted from platform.',
    retrying: 'Queued for retry.',
    queued: 'Queued for publisher worker.',
  };
  return labels[attempt.status] ?? attempt.status ?? 'Queued for publisher worker.';
}
