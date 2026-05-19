import { badRequest, conflict, notFound } from '../lib/httpErrors.js';
import {
  buildObjectStorageJobPrefix,
  isObjectStorageProvider,
} from '../lib/assetStorage.js';

export const RECOMMENDATION_BATCH_STATUSES = Object.freeze(['draft', 'approved', 'published', 'archived']);
export const RECOMMENDATION_DIRECTIONS = Object.freeze(['BULLISH', 'BEARISH', 'NEUTRAL']);
export const MAX_RECOMMENDATIONS_PER_BATCH = 50;
const MAX_GENERATION_PROMPTS = 25;
const MAX_GENERATION_PROMPT_CHARS = 4000;
const RECOMMENDATION_DELETE_PLATFORMS = Object.freeze(['youtube', 'x', 'linkedin', 'facebook', 'instagram']);
const RECOMMENDATION_JOB_DELETE_STATUSES = new Set([
  'draft',
  'source_ingested',
  'content_extracted',
  'script_ready',
  'video_requested',
  'video_ready',
  'review_required',
  'approved',
  'publishing',
  'published',
  'partial_failed',
  'failed',
]);

export function createRecommendationBatchService({
  repository,
  jobStateService,
  publisherService,
  artifactStorageService,
  recommendationGenerationService,
  recommendationMarketDataService,
  recommendationOutputService,
  clock = () => new Date().toISOString(),
} = {}) {
  if (!repository) {
    throw new Error('recommendationBatchService requires repository');
  }

  async function listBatches(filters = {}) {
    const batches = await repository.listRecommendationBatches({
      status: cleanBatchStatus(filters.status, { optional: true }),
    });
    return batches.map(normalizeBatchRecord);
  }

  async function getBatch(batchId) {
    const batch = await requireBatch(batchId);
    return normalizeBatchRecord(batch);
  }

  async function createBatch(input, { actorUid = null } = {}) {
    const timestamp = clock();
    const normalized = normalizeBatchInput(input, { timestamp });
    const batch = await repository.createRecommendationBatch({
      ...normalized,
      status: 'draft',
      channels: initialChannels(timestamp),
      createdBy: actorUid,
      metadata: {
        ...(normalized.metadata ?? {}),
        source: 'admin-curated',
      },
    });
    return normalizeBatchRecord(batch);
  }

  async function updateBatch(batchId, input, { actorUid = null } = {}) {
    const existing = await requireBatch(batchId);
    if (existing.status === 'published') {
      throw conflict('Published recommendation batches cannot be edited. Create a new batch or republish channels.', {
        batchId,
      });
    }

    const normalized = normalizeBatchInput(
      {
        ...existing,
        ...input,
        recommendations: Object.prototype.hasOwnProperty.call(input, 'recommendations')
          ? input.recommendations
          : existing.recommendations,
      },
      { timestamp: existing.createdAt ?? clock(), partial: true },
    );
    const updated = await repository.updateRecommendationBatch(batchId, {
      ...normalized,
      status: existing.status === 'approved' ? 'draft' : existing.status,
      approvedAt: null,
      approvedBy: null,
      updatedBy: actorUid,
    });
    return normalizeBatchRecord(updated);
  }

  async function generateRecommendations(input, { actorUid = null } = {}) {
    if (!recommendationGenerationService?.generateRecommendations) {
      throw conflict('AI recommendation generation is not configured.');
    }

    const timestamp = clock();
    const request = normalizeGenerationInput(input);
    const existing = request.batchId
      ? await requireBatch(request.batchId)
      : await findOpenBatchForTradeDate(request.tradeDate);

    if (existing?.status === 'published') {
      throw conflict('Published recommendation batches cannot be edited. Create a new batch or republish channels.', {
        batchId: existing.id,
      });
    }
    if (existing?.status === 'archived') {
      throw conflict('Archived recommendation batches cannot be edited', {
        batchId: existing.id,
      });
    }

    const batchContext = batchContextForGeneration(existing, request, timestamp);
    const existingRecommendations = normalizeRecommendations(batchContext.recommendations ?? [], { allowEmpty: true });
    const remainingSlots = MAX_RECOMMENDATIONS_PER_BATCH - existingRecommendations.length;
    if (remainingSlots <= 0) {
      throw conflict(`This batch already has ${MAX_RECOMMENDATIONS_PER_BATCH} recommendations.`, {
        maxItems: MAX_RECOMMENDATIONS_PER_BATCH,
      });
    }

    const marketDataResult = await buildMarketDataDrafts({
      service: recommendationMarketDataService,
      prompts: request.prompts,
      batch: batchContext,
    });
    const generated = await recommendationGenerationService.generateRecommendations({
      prompts: request.prompts,
      batch: batchContext,
      existingRecommendations,
      maxRecommendations: MAX_RECOMMENDATIONS_PER_BATCH,
      marketDrafts: marketDataResult.drafts,
    });
    const mergedRecommendations = mergeMarketDraftsIntoGenerated(
      generated.recommendations.slice(0, remainingSlots),
      marketDataResult.drafts,
      request.prompts,
    );
    const generatedRecommendations = normalizeGeneratedRecommendations(
      mergedRecommendations,
      {
        existingRecommendations,
        prompts: request.prompts,
        timestamp,
      },
    );
    if (generatedRecommendations.length === 0) {
      throw conflict('AI recommendation generation did not produce any usable recommendations.');
    }

    const recommendations = [...existingRecommendations, ...generatedRecommendations];
    const generationSummary = {
      at: timestamp,
      by: actorUid,
      provider: generated.provider,
      model: generated.model,
      promptCount: request.prompts.length,
      generatedCount: generatedRecommendations.length,
      appendedToBatchId: existing?.id ?? null,
      marketData: {
        calculatedCount: marketDataResult.drafts.length,
        warningCount: marketDataResult.warnings.length,
        warnings: marketDataResult.warnings.slice(0, 20),
      },
    };
    const normalized = normalizeBatchInput(
      {
        ...batchContext,
        recommendations,
        metadata: mergeGenerationMetadata(batchContext.metadata, generationSummary),
      },
      { timestamp: batchContext.createdAt ?? timestamp },
    );

    const saved = existing
      ? await repository.updateRecommendationBatch(existing.id, {
          ...normalized,
          status: 'draft',
          approvedAt: null,
          approvedBy: null,
          publicData: null,
          updatedBy: actorUid,
        })
      : await repository.createRecommendationBatch({
          ...normalized,
          status: 'draft',
          channels: initialChannels(timestamp),
          createdBy: actorUid,
        });

    return normalizeBatchRecord(saved);
  }

  async function approveBatch(batchId, { actorUid = null } = {}) {
    const existing = await requireBatch(batchId);
    if (existing.status === 'published') {
      return normalizeBatchRecord(existing);
    }
    if (existing.status === 'archived') {
      throw conflict('Archived recommendation batches cannot be approved', { batchId });
    }
    assertRecommendationCount(existing.recommendations);
    const timestamp = clock();
    const approved = await repository.updateRecommendationBatch(batchId, {
      status: 'approved',
      approvedAt: timestamp,
      approvedBy: actorUid,
      channels: mergeChannels(existing.channels, {
        review: { status: 'approved', updatedAt: timestamp, actorUid },
      }),
    });
    return normalizeBatchRecord(approved);
  }

  async function publishBatch(batchId, { actorUid = null } = {}) {
    const existing = await requireBatch(batchId);
    if (existing.status === 'archived') {
      throw conflict('Archived recommendation batches cannot be published', { batchId });
    }
    if (existing.status === 'draft') {
      throw conflict('Approve the recommendation batch before publishing it', { batchId });
    }

    const timestamp = clock();
    const publicData = buildPublicRecommendationBatch(existing, timestamp);
    const scriptJob = await ensureScriptJob(existing, publicData, { actorUid, timestamp });
    const outputArtifacts = recommendationOutputService?.ensureOutputs
      ? await recommendationOutputService.ensureOutputs({
          batch: existing,
          publicData,
          scriptJob,
          actorUid,
          timestamp,
        })
      : normalizePlainObject(existing.outputArtifacts);
    const channels = mergeChannels(existing.channels, {
      liveSite: {
        status: 'published',
        updatedAt: timestamp,
        actorUid,
        artifact: 'api-public-recommendation-batch',
      },
      email: {
        status: existing.channels?.email?.status === 'sent' ? 'sent' : 'queued',
        updatedAt: timestamp,
        actorUid,
      },
      pdf: {
        status: outputArtifacts.pdf ? 'ready' : existing.channels?.pdf?.status === 'ready' ? 'ready' : 'queued',
        updatedAt: timestamp,
        actorUid,
        artifactId: outputArtifacts.pdf?.artifactId ?? existing.channels?.pdf?.artifactId ?? null,
      },
      script: {
        status: 'ready',
        updatedAt: timestamp,
        actorUid,
        jobId: scriptJob.id,
        artifactId: outputArtifacts.videoScript?.artifactId ?? existing.channels?.script?.artifactId ?? null,
      },
      social: {
        status: outputArtifacts.socialCopy ? 'ready' : existing.channels?.social?.status ?? 'not_requested',
        updatedAt: timestamp,
        actorUid,
        artifactId: outputArtifacts.socialCopy?.artifactId ?? existing.channels?.social?.artifactId ?? null,
      },
      archive: {
        status: outputArtifacts.archive ? 'ready' : existing.channels?.archive?.status ?? 'not_requested',
        updatedAt: timestamp,
        actorUid,
        artifactId: outputArtifacts.archive?.artifactId ?? existing.channels?.archive?.artifactId ?? null,
      },
      video: {
        status: scriptJob.status ?? 'script_ready',
        updatedAt: timestamp,
        actorUid,
        jobId: scriptJob.id,
      },
    });

    const published = await repository.updateRecommendationBatch(batchId, {
      status: 'published',
      publicData,
      scriptJobId: scriptJob.id,
      outputArtifacts,
      channels,
      publishedAt: existing.publishedAt ?? timestamp,
      publishedBy: existing.publishedBy ?? actorUid,
    });
    return normalizeBatchRecord(published);
  }

  async function deleteBatch(batchId, input = {}, { actorUid = null } = {}) {
    const existing = await requireBatch(batchId);
    const request = normalizeDeleteInput(input);
    const timestamp = clock();
    const cleanup = {
      reason: request.reason,
      recommendationBatchId: existing.id,
      publicDataRemoved: existing.status === 'published' || Boolean(existing.publicData),
      selectedPlatforms: request.platforms,
      publications: [],
      outputArtifacts: null,
      videoJob: null,
      recommendationRecord: null,
    };
    const scriptJob = existing.scriptJobId ? await repository.getJob(existing.scriptJobId) : null;

    if (scriptJob && request.platforms.length > 0) {
      cleanup.publications = await deleteSelectedPublications({
        jobId: scriptJob.id,
        platforms: request.platforms,
        actorUid,
        reason: request.reason,
        timestamp,
      });
    }

    if (scriptJob && request.removeVideoJob) {
      cleanup.videoJob = await deleteRecommendationVideoJob({
        job: scriptJob,
        actorUid,
        reason: request.reason,
        timestamp,
      });
    } else if (request.removeOutputArtifacts) {
      cleanup.outputArtifacts = await deleteRecommendationOutputArtifacts({
        outputArtifacts: existing.outputArtifacts,
        actorUid,
        reason: request.reason,
      });
    }

    if (request.removeRecommendation) {
      if (!repository.deleteRecommendationBatch) {
        throw conflict('Recommendation batch deletion is not supported by this repository');
      }
      const deleted = await repository.deleteRecommendationBatch(existing.id);
      cleanup.recommendationRecord = {
        deleted: Boolean(deleted),
        id: deleted?.id ?? existing.id,
        status: deleted?.status ?? existing.status,
      };
      return {
        recommendationBatch: null,
        cleanup,
      };
    }

    const archived = await repository.updateRecommendationBatch(existing.id, {
      status: 'archived',
      publicData: null,
      scriptJobId: request.removeVideoJob ? null : existing.scriptJobId,
      outputArtifacts: request.removeOutputArtifacts ? {} : normalizePlainObject(existing.outputArtifacts),
      channels: archivedChannels(existing.channels, {
        actorUid,
        reason: request.reason,
        timestamp,
        removedVideoJob: Boolean(cleanup.videoJob?.job?.id),
        removedOutputArtifacts: request.removeOutputArtifacts,
        removedPublications: cleanup.publications.length > 0,
      }),
      metadata: {
        ...normalizePlainObject(existing.metadata),
        archivedAt: timestamp,
        archivedBy: actorUid,
        archiveReason: request.reason,
        previousStatus: existing.status,
      },
    });

    cleanup.recommendationRecord = {
      deleted: false,
      id: archived.id,
      status: archived.status,
    };
    return {
      recommendationBatch: normalizeBatchRecord(archived),
      cleanup,
    };
  }

  async function getLatestPublishedBatch() {
    const batch = await repository.getLatestPublishedRecommendationBatch();
    return batch ? normalizeBatchRecord(batch) : null;
  }

  async function getPublishedBatch(batchId) {
    const batch = await requireBatch(batchId);
    if (batch.status !== 'published') {
      throw notFound('Published recommendation batch not found', { batchId });
    }
    return normalizeBatchRecord(batch);
  }

  async function findOpenBatchForTradeDate(tradeDate) {
    return findOpenBatchForTradeDateFromRepository(repository, tradeDate);
  }

  async function requireBatch(batchId) {
    const normalizedId = cleanString(batchId, { maxLength: 160 });
    if (!normalizedId) {
      throw badRequest('Recommendation batch id is required');
    }
    const batch = await repository.getRecommendationBatch(normalizedId);
    if (!batch) {
      throw notFound('Recommendation batch not found', { batchId: normalizedId });
    }
    return batch;
  }

  async function ensureScriptJob(batch, publicData, { actorUid, timestamp }) {
    if (batch.scriptJobId) {
      const existingJob = await repository.getJob(batch.scriptJobId);
      if (existingJob) {
        return existingJob;
      }
    }
    const script = buildHeyGenScript(publicData);
    const scenes = buildHeyGenScenes(publicData);
    const createJob = jobStateService?.createJob
      ? (input) => jobStateService.createJob(input)
      : (input) => repository.createJob(input);

    return createJob({
      title: `Daily Picks - ${publicData.tradeDate}`,
      type: 'recommendation_video',
      status: 'script_ready',
      sourceType: 'text_to_heygen',
      ownerUid: actorUid,
      targetDurationSec: 180,
      metadata: {
        owner: actorUid ?? 'admin',
        topic: 'Daily picks recommendations',
        sourceArtifact: 'Recommendation batch',
        sourceType: 'text_to_heygen',
        stage: 'Recommendation script ready',
        intakeMode: 'text_to_heygen',
        intakeModeLabel: 'Text to HeyGen',
        recommendationBatchId: batch.id,
        recommendationTradeDate: publicData.tradeDate,
        prompt: script,
        reviewScriptText: script,
        scriptPreview: scenes.map((scene) => scene.narration),
        scriptQuality: 'Generated from approved recommendation batch',
        scenes,
        recommendations: publicData.recommendations.map((item) => ({
          id: item.id,
          symbol: item.symbol,
          strategy: item.strategy,
          direction: item.direction,
          thesis: item.thesis,
          riskNotes: item.riskNotes,
        })),
        createdFromRecommendationAt: timestamp,
      },
    });
  }

  async function deleteSelectedPublications({ jobId, platforms, actorUid, reason, timestamp }) {
    const platformSet = new Set(platforms);
    const attempts = await repository.listPublishAttempts({ jobId });
    const selected = attempts.filter((attempt) =>
      attempt.status !== 'deleted' && platformSet.has(cleanPlatform(attempt.platform)),
    );
    const deleted = [];

    for (const attempt of selected) {
      if (isProviderBackedAttempt(attempt)) {
        if (!publisherService?.deletePublication) {
          throw conflict('Provider publication deletion is not configured for recommendation cleanup', {
            attemptId: attempt.id,
            platform: attempt.platform,
          });
        }
        const result = await publisherService.deletePublication(attempt.id, {
          actorUid,
          reason,
        });
        deleted.push({
          attemptId: attempt.id,
          platform: attempt.platform,
          status: result.publication?.status ?? 'deleted',
          providerDeleted: Boolean(result.providerDeleted),
          providerPostId: attempt.providerPostId ?? null,
          providerUrl: attempt.providerUrl ?? null,
        });
        continue;
      }

      const updated = await repository.updatePublishAttempt(attempt.id, {
        status: 'deleted',
        providerUrl: null,
        errorCode: null,
        errorMessage: null,
        metadata: {
          ...normalizePlainObject(attempt.metadata),
          deletedAt: timestamp,
          deletedBy: actorUid,
          deleteReason: reason,
          previousStatus: attempt.status,
          providerDeleted: false,
          publisherStatus: 'Removed as part of recommendation cleanup.',
          progressStage: 'deleted',
          progressPercent: 100,
          progressLabel: 'Removed as part of recommendation cleanup.',
        },
      });
      deleted.push({
        attemptId: attempt.id,
        platform: attempt.platform,
        status: updated?.status ?? 'deleted',
        providerDeleted: false,
        providerPostId: attempt.providerPostId ?? null,
        providerUrl: attempt.providerUrl ?? null,
      });
    }

    return deleted;
  }

  async function deleteRecommendationVideoJob({ job, actorUid, reason, timestamp }) {
    if (!RECOMMENDATION_JOB_DELETE_STATUSES.has(job.status)) {
      throw conflict('Recommendation video workflow cannot be deleted in its current status', {
        jobId: job.id,
        status: job.status,
      });
    }

    const [publishPlans, publishAttempts] = await Promise.all([
      repository.listPublishPlans({ jobId: job.id }),
      repository.listPublishAttempts({ jobId: job.id }),
    ]);
    const remainingProviderBackedAttempts = publishAttempts.filter(isProviderBackedAttempt);
    if (remainingProviderBackedAttempts.length > 0) {
      throw conflict('Recommendation video still has live provider publications. Select every live platform before deleting the video workflow.', {
        jobId: job.id,
        providerPublicationIds: remainingProviderBackedAttempts.map((attempt) => attempt.id),
        providerPlatforms: [...new Set(remainingProviderBackedAttempts.map((attempt) => attempt.platform))],
      });
    }

    const artifacts = await repository.listArtifactsForJob(job.id);
    const storageCleanup = await cleanupJobArtifactStorage({
      artifacts,
      jobId: job.id,
      artifactStorageService,
    });
    const archivedPublishing = await archivePublishingRecordsForRecommendationDelete({
      repository,
      job,
      publishPlans,
      publishAttempts,
      actorUid,
      reason,
      timestamp,
    });
    const deleted = await repository.deleteJob(job.id);
    return {
      ...deleted,
      publishPlans: archivedPublishing.publishPlans,
      publishAttempts: archivedPublishing.publishAttempts,
      storageCleanup,
    };
  }

  async function deleteRecommendationOutputArtifacts({ outputArtifacts, actorUid, reason }) {
    const artifactIds = collectOutputArtifactIds(outputArtifacts);
    const deletedArtifacts = [];
    const storageCleanup = {
      artifactCount: artifactIds.length,
      objectStorageCount: 0,
      deletedObjectCount: 0,
      skippedObjectCount: 0,
      objects: [],
    };

    for (const artifactId of artifactIds) {
      const artifact = await repository.getArtifact(artifactId);
      if (!artifact) {
        deletedArtifacts.push({ artifactId, deleted: false, reason: 'artifact_not_found' });
        continue;
      }
      const cleanup = await cleanupObjectStorageArtifact(artifact, artifactStorageService);
      if (cleanup) {
        storageCleanup.objectStorageCount += 1;
        storageCleanup.deletedObjectCount += cleanup.deleted ? 1 : 0;
        storageCleanup.skippedObjectCount += cleanup.skipped ? 1 : 0;
        storageCleanup.objects.push(cleanup);
      }
      const deleted = repository.deleteArtifact ? await repository.deleteArtifact(artifact.id) : null;
      deletedArtifacts.push({
        artifactId: artifact.id,
        kind: artifact.kind,
        storageProvider: artifact.storageProvider,
        storageKey: artifact.storageKey,
        deleted: Boolean(deleted),
        deletedBy: actorUid,
        reason,
      });
    }

    return {
      artifacts: deletedArtifacts,
      storageCleanup,
    };
  }

  return {
    listBatches,
    getBatch,
    createBatch,
    updateBatch,
    generateRecommendations,
    approveBatch,
    publishBatch,
    deleteBatch,
    getLatestPublishedBatch,
    getPublishedBatch,
  };
}

function normalizeDeleteInput(input = {}) {
  const body = normalizePlainObject(input);
  const removeVideoJob = cleanBoolean(body.removeVideoJob, true);
  return {
    reason: cleanString(body.reason, { maxLength: 500 }) ?? 'admin_deleted_recommendation_batch',
    removeRecommendation: cleanBoolean(body.removeRecommendation, true),
    removeVideoJob,
    removeOutputArtifacts: removeVideoJob || cleanBoolean(body.removeOutputArtifacts, true),
    platforms: normalizeDeletePlatforms(body.platforms),
  };
}

function normalizeDeletePlatforms(platforms) {
  if (platforms === null || platforms === undefined) {
    return [...RECOMMENDATION_DELETE_PLATFORMS];
  }
  if (!Array.isArray(platforms)) {
    throw badRequest('platforms must be an array');
  }
  const unique = [];
  for (const platform of platforms) {
    const normalized = cleanPlatform(platform);
    if (!normalized) continue;
    if (!RECOMMENDATION_DELETE_PLATFORMS.includes(normalized)) {
      throw badRequest('Recommendation cleanup platform is not supported', {
        platform: normalized,
        allowedValues: RECOMMENDATION_DELETE_PLATFORMS,
      });
    }
    if (!unique.includes(normalized)) {
      unique.push(normalized);
    }
  }
  return unique;
}

function cleanPlatform(platform) {
  const normalized = cleanString(platform, { maxLength: 40 })?.toLowerCase();
  if (normalized === 'twitter') return 'x';
  return normalized;
}

function cleanBoolean(value, defaultValue = false) {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  throw badRequest('Expected a boolean cleanup value');
}

function isProviderBackedAttempt(attempt = {}) {
  return attempt.status !== 'deleted'
    && (attempt.status === 'published' || Boolean(attempt.providerPostId) || Boolean(attempt.providerUrl));
}

async function archivePublishingRecordsForRecommendationDelete({
  repository,
  job,
  publishPlans,
  publishAttempts,
  actorUid,
  reason,
  timestamp,
}) {
  const archivedAttempts = [];
  for (const attempt of publishAttempts) {
    if (attempt.status === 'deleted') {
      archivedAttempts.push(attempt);
      continue;
    }
    const archived = await repository.updatePublishAttempt(attempt.id, {
      status: 'deleted',
      providerUrl: null,
      errorCode: null,
      errorMessage: null,
      metadata: {
        ...normalizePlainObject(attempt.metadata),
        archivedToAuditAt: timestamp,
        archiveReason: reason,
        previousStatus: attempt.status,
        archivedBy: actorUid ?? null,
        providerDeleted: false,
        publisherStatus: 'Removed with recommendation cleanup.',
        progressStage: 'deleted',
        progressPercent: 100,
        progressLabel: 'Removed with recommendation cleanup.',
      },
    });
    archivedAttempts.push(archived);
  }

  const archivedPlans = [];
  for (const plan of publishPlans) {
    if (plan.status === 'deleted') {
      archivedPlans.push(plan);
      continue;
    }
    const archived = await repository.updatePublishPlan(plan.id, {
      status: 'deleted',
      metadata: {
        ...normalizePlainObject(plan.metadata),
        archivedToAuditAt: timestamp,
        archiveReason: reason,
        previousStatus: plan.status,
        archivedBy: actorUid ?? null,
        sourceJobStatus: job.status,
      },
    });
    archivedPlans.push(archived);
  }

  return {
    publishPlans: archivedPlans,
    publishAttempts: archivedAttempts,
  };
}

async function cleanupJobArtifactStorage({ artifacts, jobId, artifactStorageService }) {
  const objectStorageArtifacts = artifacts.filter((artifact) => isObjectStorageProvider(artifact.storageProvider));
  const objects = [];

  for (const artifact of objectStorageArtifacts) {
    const result = await cleanupObjectStorageArtifact(artifact, artifactStorageService);
    objects.push(result ?? {
      artifactId: artifact.id,
      storageProvider: artifact.storageProvider,
      storageKey: artifact.storageKey,
      deleted: false,
      skipped: true,
      reason: 'object_storage_delete_not_configured',
    });
  }

  let prefix = null;
  if (artifactStorageService?.shouldUseObjectStorage?.() && artifactStorageService.deleteObjectStoragePrefix) {
    const storagePrefix = buildObjectStorageJobPrefix(jobId);
    const result = await artifactStorageService.deleteObjectStoragePrefix(storagePrefix, {
      ignoreNotFound: true,
    });
    prefix = {
      storagePrefix,
      deleted: Boolean(result.deleted),
      skipped: Boolean(result.skipped),
      reason: result.reason ?? null,
    };
  }

  return {
    artifactCount: artifacts.length,
    objectStorageCount: objectStorageArtifacts.length,
    deletedObjectCount: objects.filter((object) => object.deleted).length,
    skippedObjectCount: objects.filter((object) => object.skipped).length,
    prefix,
    objects,
  };
}

async function cleanupObjectStorageArtifact(artifact, artifactStorageService) {
  if (!isObjectStorageProvider(artifact.storageProvider)) {
    return null;
  }
  if (!artifactStorageService?.deleteObjectStorageArtifact) {
    return {
      artifactId: artifact.id,
      storageProvider: artifact.storageProvider,
      storageKey: artifact.storageKey,
      deleted: false,
      skipped: true,
      reason: 'object_storage_delete_not_configured',
    };
  }
  const result = await artifactStorageService.deleteObjectStorageArtifact(artifact, {
    ignoreNotFound: true,
  });
  return {
    artifactId: artifact.id,
    storageProvider: artifact.storageProvider,
    storageKey: artifact.storageKey,
    deleted: Boolean(result.deleted),
    skipped: Boolean(result.skipped),
    reason: result.reason ?? null,
  };
}

function archivedChannels(channels, {
  actorUid,
  reason,
  timestamp,
  removedVideoJob,
  removedOutputArtifacts,
  removedPublications,
}) {
  const deletedChannel = {
    status: 'deleted',
    updatedAt: timestamp,
    actorUid,
    reason,
  };
  return mergeChannels(channels, {
    liveSite: deletedChannel,
    email: deletedChannel,
    pdf: removedOutputArtifacts ? deletedChannel : { status: 'archived', updatedAt: timestamp, actorUid, reason },
    script: removedOutputArtifacts ? deletedChannel : { status: 'archived', updatedAt: timestamp, actorUid, reason },
    social: removedPublications || removedOutputArtifacts
      ? deletedChannel
      : { status: 'archived', updatedAt: timestamp, actorUid, reason },
    archive: removedOutputArtifacts ? deletedChannel : { status: 'archived', updatedAt: timestamp, actorUid, reason },
    video: removedVideoJob ? deletedChannel : { status: 'archived', updatedAt: timestamp, actorUid, reason },
  });
}

function collectOutputArtifactIds(outputArtifacts = {}) {
  const ids = [];
  for (const value of Object.values(normalizePlainObject(outputArtifacts))) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const artifactId = cleanString(value.artifactId ?? value.id, { maxLength: 160 });
    if (artifactId && !ids.includes(artifactId)) {
      ids.push(artifactId);
    }
  }
  return ids;
}

function normalizeGenerationInput(input = {}) {
  const batchId = cleanString(input.batchId, { maxLength: 160 });
  const tradeDate = cleanDate(input.tradeDate);
  if (!batchId && !tradeDate) {
    throw badRequest('tradeDate is required when batchId is not provided');
  }

  return {
    batchId,
    tradeDate,
    title: cleanString(input.title, { maxLength: 160 }),
    theme: cleanString(input.theme, { maxLength: 240 }),
    dateRange: cleanString(input.dateRange, { maxLength: 160 }),
    prompts: normalizeGenerationPrompts(input.prompts),
  };
}

function normalizeGenerationPrompts(prompts) {
  if (!Array.isArray(prompts)) {
    throw badRequest('prompts must be an array');
  }
  const normalized = prompts
    .map((item, index) => {
      const prompt = typeof item === 'string'
        ? cleanString(item, { maxLength: MAX_GENERATION_PROMPT_CHARS })
        : cleanString(item?.prompt, { maxLength: MAX_GENERATION_PROMPT_CHARS });
      if (!prompt) {
        return null;
      }
      return {
        id: cleanString(item?.id, { maxLength: 80 }) ?? `prompt_${index + 1}`,
        prompt,
      };
    })
    .filter(Boolean);

  if (normalized.length === 0) {
    throw badRequest('At least one prompt is required');
  }
  if (normalized.length > MAX_GENERATION_PROMPTS) {
    throw badRequest(`prompts cannot contain more than ${MAX_GENERATION_PROMPTS} items`, {
      maxItems: MAX_GENERATION_PROMPTS,
    });
  }
  return normalized;
}

function normalizeBatchInput(input = {}, { timestamp, partial = false } = {}) {
  const tradeDate = cleanDate(input.tradeDate);
  if (!partial && !tradeDate) {
    throw badRequest('tradeDate is required');
  }
  const recommendations = normalizeRecommendations(input.recommendations ?? [], { allowEmpty: partial });
  return {
    tradeDate,
    weekId: cleanString(input.weekId, { maxLength: 80 }) ?? weekIdForDate(tradeDate),
    title: cleanString(input.title, { maxLength: 160 }) ?? `Daily Picks - ${tradeDate}`,
    theme: cleanString(input.theme, { maxLength: 240 }) ?? '',
    dateRange: cleanString(input.dateRange, { maxLength: 160 }) ?? tradeDate,
    recommendations,
    metadata: normalizePlainObject(input.metadata),
    createdAt: input.createdAt ?? timestamp,
  };
}

async function findOpenBatchForTradeDateFromRepository(repository, tradeDate) {
  const batches = await repository.listRecommendationBatches({});
  return batches.find((batch) => batch.tradeDate === tradeDate && ['draft', 'approved'].includes(batch.status)) ?? null;
}

function batchContextForGeneration(existing, request, timestamp) {
  const tradeDate = request.tradeDate ?? existing?.tradeDate;
  return {
    id: existing?.id ?? null,
    tradeDate,
    weekId: existing?.weekId ?? weekIdForDate(tradeDate),
    title: request.title ?? existing?.title ?? `Daily Picks - ${tradeDate}`,
    theme: request.theme ?? existing?.theme ?? '',
    dateRange: request.dateRange ?? existing?.dateRange ?? tradeDate,
    recommendations: existing?.recommendations ?? [],
    metadata: existing?.metadata ?? {},
    createdAt: existing?.createdAt ?? timestamp,
  };
}

async function buildMarketDataDrafts({ service, prompts, batch }) {
  if (!service?.buildRecommendationDraft) {
    return { drafts: [], warnings: [] };
  }

  const drafts = [];
  const warnings = [];
  for (const prompt of prompts) {
    try {
      const result = await service.buildRecommendationDraft({
        prompt: prompt.prompt,
        promptId: prompt.id,
        batch,
      });
      if (result?.recommendation) {
        drafts.push(result.recommendation);
      }
      for (const warning of result?.warnings ?? []) {
        warnings.push({
          promptId: prompt.id,
          symbol: result?.intent?.symbol ?? null,
          warning,
        });
      }
    } catch (error) {
      warnings.push({
        promptId: prompt.id,
        warning: error.message ?? 'Market data calculation failed.',
      });
    }
  }

  return { drafts, warnings };
}

function mergeMarketDraftsIntoGenerated(rawRecommendations, marketDrafts, prompts) {
  if (!Array.isArray(marketDrafts) || marketDrafts.length === 0) {
    return rawRecommendations;
  }

  const byPromptId = new Map(
    marketDrafts
      .filter((draft) => draft.sourcePromptId)
      .map((draft) => [draft.sourcePromptId, draft]),
  );
  return rawRecommendations.map((item, index) => {
    const sourcePromptId =
      cleanString(item.sourcePromptId ?? item.promptId, { maxLength: 80 }) ?? prompts[index]?.id ?? null;
    const draft = byPromptId.get(sourcePromptId);
    return draft ? mergeRecommendationWithMarketDraft(item, draft) : item;
  });
}

function mergeRecommendationWithMarketDraft(item, draft) {
  const itemLifecycle = normalizePlainObject(item.lifecycle);
  const draftLifecycle = normalizePlainObject(draft.lifecycle);
  const marketDataDraftSummary = {
    source: 'newleaf-market-data-service',
    sourcePromptId: draft.sourcePromptId,
    symbol: draft.symbol,
    strategy: draft.strategy ?? null,
  };

  if (!hasCalculatedMarketDraft(draft, draftLifecycle)) {
    return {
      ...item,
      sourcePromptId: draft.sourcePromptId ?? item.sourcePromptId,
      symbol: draft.symbol ?? item.symbol,
      strategy: draft.strategy ?? item.strategy,
      direction: draft.direction ?? item.direction,
      price: draft.price ?? item.price,
      expiry: draft.expiry ?? item.expiry,
      sentiment: {
        ...normalizePlainObject(item.sentiment),
        ...normalizePlainObject(draft.sentiment),
      },
      lifecycle: {
        ...itemLifecycle,
        marketDataDraft: marketDataDraftSummary,
        marketData: draftLifecycle.marketData ?? itemLifecycle.marketData,
        gammaContext: draftLifecycle.gammaContext ?? itemLifecycle.gammaContext,
        sentimentContext: draftLifecycle.sentimentContext ?? itemLifecycle.sentimentContext,
        warnings: mergeLifecycleWarnings(itemLifecycle.warnings, draftLifecycle.warnings),
      },
    };
  }

  return {
    ...item,
    sourcePromptId: draft.sourcePromptId ?? item.sourcePromptId,
    symbol: draft.symbol,
    strategy: draft.strategy,
    direction: draft.direction,
    price: draft.price,
    expiry: draft.expiry,
    dte: draft.dte,
    rewardRisk: draft.rewardRisk,
    oddsOfProfit: draft.oddsOfProfit,
    maxProfit: draft.maxProfit,
    maxLoss: draft.maxLoss,
    netCredit: draft.netCredit,
    netDebit: draft.netDebit,
    legs: draft.legs,
    greeks: draft.greeks,
    breakevens: draft.breakevens,
    ivContext: {
      ...normalizePlainObject(item.ivContext),
      ...normalizePlainObject(draft.ivContext),
    },
    sentiment: {
      ...normalizePlainObject(item.sentiment),
      ...normalizePlainObject(draft.sentiment),
    },
    lifecycle: {
      ...itemLifecycle,
      marketDataDraft: marketDataDraftSummary,
      metricAssumptions: draftLifecycle.metricAssumptions,
      marketData: draftLifecycle.marketData,
      gammaContext: draftLifecycle.gammaContext,
      sentimentContext: draftLifecycle.sentimentContext,
      calculation: draftLifecycle.calculation,
      technicalIndicators: draftLifecycle.technicalIndicators,
      strategyAdvisor: draftLifecycle.strategyAdvisor,
      warnings: draftLifecycle.warnings,
    },
  };
}

function hasCalculatedMarketDraft(draft, lifecycle) {
  return Boolean(
    draft.strategy &&
    draft.direction &&
    (
      Object.keys(normalizePlainObject(lifecycle.metricAssumptions)).length > 0 ||
      (Array.isArray(draft.legs) && draft.legs.length > 0)
    ),
  );
}

function mergeLifecycleWarnings(left, right) {
  const values = [
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : []),
  ]
    .map((value) => cleanString(value, { maxLength: 500 }))
    .filter(Boolean);
  return values.length > 0 ? Array.from(new Set(values)) : undefined;
}

function normalizeGeneratedRecommendations(rawRecommendations, { existingRecommendations, prompts, timestamp }) {
  const usedIds = new Set(existingRecommendations.map((item) => item.id).filter(Boolean));
  const maxSortOrder = existingRecommendations.reduce(
    (maxValue, item) => Math.max(maxValue, Number(item.sortOrder) || 0),
    0,
  );

  return rawRecommendations.map((item, index) => {
    const sortOrder = maxSortOrder + ((index + 1) * 10);
    const symbol = cleanSymbol(item.symbol);
    const id = uniqueRecommendationId({
      requestedId: item.id,
      symbol,
      sortOrder,
      usedIds,
    });
    const sourcePromptId =
      cleanString(item.sourcePromptId ?? item.promptId, { maxLength: 80 }) ?? prompts[index]?.id ?? null;
    const lifecycle = withMetricAssumptions(item, {
      sourcePromptId,
      timestamp,
    });
    const metricPatch = stripUnsupportedGeneratedMetrics(item, lifecycle);
    return normalizeRecommendation(
      {
        ...item,
        ...metricPatch,
        id,
        tileId: cleanString(item.tileId, { maxLength: 120 }) ?? id,
        symbol,
        sortOrder,
        lifecycle: metricPatch.lifecycle ?? lifecycle,
      },
      index,
    );
  });
}

function withMetricAssumptions(item, { sourcePromptId, timestamp }) {
  const lifecycle = normalizePlainObject(item.lifecycle);
  const metricAssumptions = firstPlainObject(
    lifecycle.metricAssumptions,
    item.metricAssumptions,
    item.metricsAssumptions,
    item.metricBasis,
    item.metricsBasis,
    item.metricsRationale,
  );

  return {
    ...lifecycle,
    ...(metricAssumptions ? { metricAssumptions } : {}),
    generation: {
      ...normalizePlainObject(lifecycle.generation),
      source: 'ai',
      generatedAt: timestamp,
      sourcePromptId,
    },
  };
}

function stripUnsupportedGeneratedMetrics(item, lifecycle) {
  const patch = {};
  const lifecyclePatch = {};

  if (hasGeneratedQuantitativeMetrics(item) && !hasMetricSupport(item, lifecycle)) {
    Object.assign(patch, {
      rewardRisk: null,
      oddsOfProfit: null,
      probabilityOfProfit: null,
      maxProfit: null,
      maxLoss: null,
      netCredit: null,
      netDebit: null,
    });
    lifecyclePatch.metricWarning =
      'AI returned quantitative metrics without per-prompt assumptions, so NewLeaf withheld those values for admin review.';
  }

  if (hasGeneratedMarketPrice(item) && !hasTrustedMarketPrice(lifecycle)) {
    Object.assign(patch, {
      price: null,
      underlyingPrice: null,
    });
    lifecyclePatch.priceWarning =
      'AI returned a market price without a trusted market-data draft, so NewLeaf withheld the price for admin review.';
  }

  if (Object.keys(lifecyclePatch).length > 0) {
    patch.lifecycle = {
      ...lifecycle,
      ...lifecyclePatch,
    };
  }

  return patch;
}

function hasGeneratedQuantitativeMetrics(item) {
  return [
    item.rewardRisk,
    item.oddsOfProfit ?? item.probabilityOfProfit,
    item.maxProfit,
    item.maxLoss,
    item.netCredit,
    item.netDebit,
  ]
    .some((value) => value !== null && value !== undefined && value !== '');
}

function hasGeneratedMarketPrice(item) {
  return [item.price, item.underlyingPrice, item.currentPrice]
    .some((value) => value !== null && value !== undefined && value !== '');
}

function hasTrustedMarketPrice(lifecycle) {
  const marketData = normalizePlainObject(lifecycle.marketData);
  const draft = normalizePlainObject(lifecycle.marketDataDraft);
  const trustedSource = ['alpaca', 'newleaf-api'].includes(marketData.source);
  return (
    draft.source === 'newleaf-market-data-service' &&
    trustedSource &&
    Number.isFinite(Number(marketData.spotPrice))
  );
}

function hasMetricSupport(item, lifecycle) {
  if (Object.keys(normalizePlainObject(lifecycle.metricAssumptions)).length > 0) {
    return true;
  }
  return Array.isArray(item.legs) && item.legs.some((leg) =>
    ['premium', 'credit', 'debit', 'price', 'mid', 'netCredit', 'netDebit', 'width', 'maxLoss']
      .some((field) => leg?.[field] !== null && leg?.[field] !== undefined && leg?.[field] !== ''),
  );
}

function firstPlainObject(...values) {
  for (const value of values) {
    const normalized = normalizePlainObject(value);
    if (Object.keys(normalized).length > 0) {
      return normalized;
    }
  }
  return null;
}

function uniqueRecommendationId({ requestedId, symbol, sortOrder, usedIds }) {
  const requested = cleanString(requestedId, { maxLength: 120 });
  const fallback = `pick_${sortOrder}_${String(symbol ?? 'ai').toLowerCase()}`;
  const base = sanitizeRecommendationId(requested ?? fallback) || `pick_${sortOrder}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function sanitizeRecommendationId(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function mergeGenerationMetadata(metadata, generationSummary) {
  const normalizedMetadata = normalizePlainObject(metadata);
  const generationHistory = Array.isArray(normalizedMetadata.generationHistory)
    ? normalizedMetadata.generationHistory.slice(-9)
    : [];
  return {
    ...normalizedMetadata,
    source: normalizedMetadata.source ?? 'admin-ai-assisted',
    lastGeneration: generationSummary,
    generationHistory: [...generationHistory, generationSummary],
  };
}

function normalizeBatchRecord(batch = {}) {
  return {
    ...batch,
    recommendations: normalizeRecommendations(batch.recommendations ?? [], { allowEmpty: true }),
    channels: normalizeChannels(batch.channels),
    publicData: batch.publicData ? buildPublicRecommendationBatch(batch, batch.publishedAt ?? batch.updatedAt) : null,
  };
}

function normalizeRecommendations(rawRecommendations, { allowEmpty = false } = {}) {
  if (!Array.isArray(rawRecommendations)) {
    throw badRequest('recommendations must be an array');
  }
  if (!allowEmpty) {
    assertRecommendationCount(rawRecommendations);
  }
  if (rawRecommendations.length > MAX_RECOMMENDATIONS_PER_BATCH) {
    throw badRequest(`recommendations cannot contain more than ${MAX_RECOMMENDATIONS_PER_BATCH} items`, {
      maxItems: MAX_RECOMMENDATIONS_PER_BATCH,
    });
  }

  return rawRecommendations.map((item, index) => normalizeRecommendation(item, index));
}

function normalizeRecommendation(item = {}, index = 0) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw badRequest(`recommendations[${index}] must be an object`);
  }
  const symbol = cleanSymbol(item.symbol);
  const strategy = cleanString(item.strategy, { maxLength: 120 });
  const thesis = cleanString(item.thesis, { maxLength: 1400 });
  if (!symbol || !strategy || !thesis) {
    throw badRequest(`recommendations[${index}] requires symbol, strategy, and thesis`);
  }
  const sortOrder = cleanNumber(item.sortOrder, (index + 1) * 10, 1, 1000);
  const id = cleanString(item.id, { maxLength: 120 }) ?? `pick_${sortOrder}_${symbol.toLowerCase()}`;
  const direction = cleanBatchDirection(item.direction);
  const maxProfit = cleanNumber(item.maxProfit, null, 0, 100000000);
  const maxLoss = cleanNumber(item.maxLoss, null, 0, 100000000);
  const rewardRisk = cleanNumber(item.rewardRisk, null, 0, 1000);
  const oddsOfProfit = cleanNumber(item.oddsOfProfit ?? item.probabilityOfProfit, null, 0, 100);

  return {
    id,
    tileId: cleanString(item.tileId, { maxLength: 120 }) ?? id,
    symbol,
    strategy,
    direction,
    price: cleanNumber(item.price ?? item.underlyingPrice, null, 0, 10000000),
    expiry: cleanString(item.expiry, { maxLength: 40 }) ?? '',
    dte: cleanNumber(item.dte, null, 0, 10000),
    rewardRisk,
    oddsOfProfit,
    maxProfit,
    maxLoss,
    netCredit: cleanNumber(item.netCredit, null, 0, 100000000),
    netDebit: cleanNumber(item.netDebit, null, 0, 100000000),
    thesis,
    riskNotes: cleanString(item.riskNotes ?? item.risk, { maxLength: 1400 }) ?? '',
    entry: cleanString(item.entry, { maxLength: 900 }) ?? '',
    exit: cleanString(item.exit, { maxLength: 900 }) ?? '',
    ivContext: normalizePlainObject(item.ivContext),
    sentiment: normalizePlainObject(item.sentiment),
    lifecycle: normalizePlainObject(item.lifecycle),
    legs: Array.isArray(item.legs) ? item.legs.map(normalizePlainObject) : [],
    greeks: normalizePlainObject(item.greeks),
    breakevens: normalizePlainObject(item.breakevens),
    sortOrder,
  };
}

function assertRecommendationCount(recommendations) {
  if (!Array.isArray(recommendations) || recommendations.length === 0) {
    throw badRequest('At least one recommendation is required');
  }
  if (recommendations.length > MAX_RECOMMENDATIONS_PER_BATCH) {
    throw badRequest(`Only ${MAX_RECOMMENDATIONS_PER_BATCH} recommendations can be published per batch`, {
      maxItems: MAX_RECOMMENDATIONS_PER_BATCH,
    });
  }
}

function buildPublicRecommendationBatch(batch, publishedAt) {
  const recommendations = normalizeRecommendations(batch.recommendations ?? [], { allowEmpty: true })
    .sort((left, right) => left.sortOrder - right.sortOrder);
  return {
    id: batch.id,
    recommendationBatchId: batch.id,
    tradeDate: batch.tradeDate,
    weekId: batch.weekId ?? weekIdForDate(batch.tradeDate),
    title: batch.title,
    theme: batch.theme ?? '',
    dateRange: batch.dateRange ?? batch.tradeDate,
    status: 'published',
    publishedAt: batch.publishedAt ?? publishedAt ?? null,
    source: batch.metadata?.source ?? 'admin-curated',
    recommendations,
    picks: recommendations,
  };
}

function buildHeyGenScript(publicData) {
  const lines = [
    `NewLeaf daily picks for ${publicData.tradeDate}.`,
    publicData.theme ? `Market theme: ${publicData.theme}.` : '',
    'These ideas are educational, model-estimated, and not guaranteed. Use defined risk and your own suitability checks.',
    ...publicData.recommendations.map((item, index) => {
      const metrics = [
        item.direction ? `${item.direction.toLowerCase()} setup` : '',
        item.oddsOfProfit != null ? `${item.oddsOfProfit}% model probability` : '',
        item.rewardRisk != null ? `${item.rewardRisk} reward to risk` : '',
        item.expiry ? `expiry ${item.expiry}` : '',
      ].filter(Boolean).join(', ');
      return [
        `Pick ${index + 1}: ${item.symbol}, ${item.strategy}.`,
        metrics ? `Key metrics: ${metrics}.` : '',
        `Thesis: ${item.thesis}`,
        item.riskNotes ? `Risk note: ${item.riskNotes}` : '',
      ].filter(Boolean).join(' ');
    }),
    'Review the full card before acting, size positions carefully, and treat every trade as a risk-managed plan.',
  ].filter(Boolean);
  return lines.join('\n\n');
}

function buildHeyGenScenes(publicData) {
  return [
    {
      id: 'intro',
      title: publicData.title,
      narration: `Today on NewLeaf: ${publicData.theme || 'five curated options ideas with defined risk.'}`,
    },
    ...publicData.recommendations.map((item, index) => ({
      id: item.id,
      title: `${index + 1}. ${item.symbol} ${item.strategy}`,
      narration: `${item.symbol}: ${item.thesis}${item.riskNotes ? ` Risk note: ${item.riskNotes}` : ''}`,
    })),
    {
      id: 'close',
      title: 'Risk reminder',
      narration: 'These recommendations are educational and not guaranteed. Review the full thesis, risks, and position size before acting.',
    },
  ];
}

function initialChannels(timestamp) {
  return {
    liveSite: { status: 'not_requested', updatedAt: timestamp },
    email: { status: 'not_requested', updatedAt: timestamp },
    pdf: { status: 'not_requested', updatedAt: timestamp },
    script: { status: 'not_requested', updatedAt: timestamp },
    social: { status: 'not_requested', updatedAt: timestamp },
    archive: { status: 'not_requested', updatedAt: timestamp },
    video: { status: 'not_requested', updatedAt: timestamp },
  };
}

function normalizeChannels(channels = {}) {
  return {
    ...initialChannels(null),
    ...normalizePlainObject(channels),
  };
}

function mergeChannels(current, patch) {
  return {
    ...normalizeChannels(current),
    ...Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [
        key,
        {
          ...(current?.[key] ?? {}),
          ...value,
        },
      ]),
    ),
  };
}

function cleanBatchStatus(status, { optional = false } = {}) {
  const value = cleanString(status, { maxLength: 40 });
  if (!value) {
    return optional ? undefined : 'draft';
  }
  if (!RECOMMENDATION_BATCH_STATUSES.includes(value)) {
    throw badRequest('Recommendation batch status is not supported', {
      status: value,
      allowedValues: RECOMMENDATION_BATCH_STATUSES,
    });
  }
  return value;
}

function cleanBatchDirection(direction) {
  const value = cleanString(direction, { maxLength: 40 })?.toUpperCase() ?? 'NEUTRAL';
  if (!RECOMMENDATION_DIRECTIONS.includes(value)) {
    throw badRequest('Recommendation direction is not supported', {
      direction: value,
      allowedValues: RECOMMENDATION_DIRECTIONS,
    });
  }
  return value;
}

function cleanSymbol(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!symbol) return null;
  if (!/^[A-Z0-9^][A-Z0-9.\-^=]{0,23}$/.test(symbol)) {
    throw badRequest('Recommendation symbol is not valid', { symbol });
  }
  return symbol;
}

function cleanDate(value) {
  const date = cleanString(value, { maxLength: 20 });
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw badRequest('tradeDate must use YYYY-MM-DD format');
  }
  return date;
}

function weekIdForDate(value) {
  return value ? value.slice(0, 10) : null;
}

function cleanString(value, { maxLength = 500 } = {}) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function cleanNumber(value, defaultValue = null, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  if (value === null || value === undefined || value === '') return defaultValue;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw badRequest('Expected a numeric recommendation value');
  }
  if (numberValue < min || numberValue > max) {
    throw badRequest('Recommendation numeric value is out of range', { min, max });
  }
  return numberValue;
}

function normalizePlainObject(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}
