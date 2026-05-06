import { Router, raw } from 'express';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { badRequest, conflict, notFound } from '../lib/httpErrors.js';
import {
  optionalNumber,
  optionalObject,
  optionalString,
  pickDefined,
  rejectUnknownFields,
  requireObject,
  requireString,
} from '../lib/validation.js';
import { JOB_STATUSES } from '../services/jobStateService.js';

const QUEUE_DELETABLE_STATUSES = new Set([
  'draft',
  'source_ingested',
  'content_extracted',
  'script_ready',
  'video_requested',
  'video_ready',
  'review_required',
  'approved',
  'publishing',
  'partial_failed',
  'failed',
]);

export function createJobsRouter({
  repository,
  jobStateService,
  heygenService,
  videoAssemblyService,
  videoReviewService,
  videoThumbnailService,
}) {
  const router = Router();

  router.post(
    '/',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, ['title', 'type', 'sourceType', 'status', 'targetDurationSec', 'metadata']);
      const status = optionalString(body, 'status', { maxLength: 80, defaultValue: 'draft' });
      if (!JOB_STATUSES.includes(status)) {
        throw badRequest('Unsupported initial job status', { status, allowed: JOB_STATUSES });
      }
      const metadata = optionalObject(body, 'metadata', { defaultValue: {} });
      const job = await jobStateService.createJob({
        title: requireString(body, 'title', { maxLength: 300 }),
        type: optionalString(body, 'type', { maxLength: 100, defaultValue: 'trade_video' }),
        status,
        sourceType: optionalString(body, 'sourceType', { maxLength: 80, defaultValue: null }),
        targetDurationSec: optionalNumber(body, 'targetDurationSec', { min: 1, max: 3600, defaultValue: null }),
        metadata: {
          ...metadata,
          owner: operatorLabel(req.user),
        },
        ownerUid: req.user.uid,
      });
      res.status(201).json({ job });
    }),
  );

  router.get(
    '/',
    requireRole('admin', 'editor', 'reviewer', 'publisher', 'viewer'),
    asyncHandler(async (req, res) => {
      const status = req.query.status;
      if (status && !JOB_STATUSES.includes(status)) {
        throw badRequest('Unsupported status filter', { status, allowed: JOB_STATUSES });
      }
      const jobs = await repository.listJobs({ status });
      res.json({ jobs });
    }),
  );

  router.get(
    '/:jobId',
    requireRole('admin', 'editor', 'reviewer', 'publisher', 'viewer'),
    asyncHandler(async (req, res) => {
      const job = await repository.getJob(req.params.jobId);
      if (!job) throw notFound('Job not found', { jobId: req.params.jobId });
      const artifacts = await repository.listArtifactsForJob(req.params.jobId);
      const providerJobs = await repository.listProviderJobs({ jobId: req.params.jobId });
      res.json({ job, artifacts, providerJobs });
    }),
  );

  router.patch(
    '/:jobId',
    requireRole('admin', 'editor', 'reviewer'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, ['title', 'targetDurationSec', 'metadata', 'status']);

      const patch = pickDefined({
        title: optionalString(body, 'title', { maxLength: 300 }),
        targetDurationSec: optionalNumber(body, 'targetDurationSec', { min: 1, max: 3600 }),
        metadata: optionalObject(body, 'metadata'),
      });

      let job;
      if (body.status) {
        job = await jobStateService.transitionJob(req.params.jobId, body.status, {
          actorUid: req.user.uid,
          reason: 'manual_patch',
          updates: patch,
        });
      } else {
        job = await repository.updateJob(req.params.jobId, patch);
      }

      if (!job) throw notFound('Job not found', { jobId: req.params.jobId });
      res.json({ job });
    }),
  );

  router.delete(
    '/:jobId',
    requireRole('admin', 'reviewer'),
    asyncHandler(async (req, res) => {
      const body = req.body ? requireObject(req.body) : {};
      rejectUnknownFields(body, ['reason']);
      const reason = optionalString(body, 'reason', {
        maxLength: 500,
        defaultValue: 'admin_deleted_content_queue_job',
      });
      const job = await repository.getJob(req.params.jobId);
      if (!job) throw notFound('Job not found', { jobId: req.params.jobId });
      if (!QUEUE_DELETABLE_STATUSES.has(job.status)) {
        throw conflict('Only jobs that have not entered publishing can be deleted from the content queue', {
          jobId: job.id,
          status: job.status,
          allowed: Array.from(QUEUE_DELETABLE_STATUSES),
        });
      }

      const [publishPlans, publishAttempts] = await Promise.all([
        repository.listPublishPlans({ jobId: job.id }),
        repository.listPublishAttempts({ jobId: job.id }),
      ]);
      const providerBackedAttempts = publishAttempts.filter((attempt) =>
        attempt.status !== 'deleted' && (attempt.status === 'published' || attempt.providerPostId || attempt.providerUrl),
      );
      if (providerBackedAttempts.length > 0) {
        throw conflict('Job has live provider publication records. Delete published videos first, then remove the queue job.', {
          jobId: job.id,
          providerPublicationCount: providerBackedAttempts.length,
          providerPublicationIds: providerBackedAttempts.map((attempt) => attempt.id),
        });
      }

      const archivedPublishing = await archivePublishingRecordsForQueueDelete(repository, {
        job,
        publishPlans,
        publishAttempts,
        actorUid: req.user.uid,
        reason,
      });
      const deleted = await repository.deleteJob(job.id);
      res.json({
        deleted: {
          ...deleted,
          publishPlans: archivedPublishing.publishPlans,
          publishAttempts: archivedPublishing.publishAttempts,
        },
        task: {
          type: 'delete_content_queue_job',
          queued: false,
          note: 'Content job, local artifact records, provider job records, and failed or stuck publishing records were removed from the active queue.',
        },
      });
    }),
  );

  router.post(
    '/:jobId/extract',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const job = await jobStateService.markExtractionRequested(req.params.jobId, {
        actorUid: req.user.uid,
      });
      res.status(202).json({
        job,
        task: {
          type: 'extract_content',
          queued: false,
          TODO: 'Enqueue PDF/transcript extraction in Cloud Tasks or Cloudflare Queues.',
        },
      });
    }),
  );

  router.post(
    '/:jobId/generate-script',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const existing = await repository.getJob(req.params.jobId);
      if (!existing) throw notFound('Job not found', { jobId: req.params.jobId });
      assertTextToHeyGenJob(existing, 'generate_script');

      const job = await jobStateService.transitionJob(req.params.jobId, 'script_ready', {
        actorUid: req.user.uid,
        reason: 'generate_script',
      });
      res.status(202).json({
        job,
        task: {
          type: 'generate_script',
          queued: false,
          TODO: 'Connect script generation provider and store structured scenes as a script artifact.',
        },
      });
    }),
  );

  router.post(
    '/:jobId/generate-pdf',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const job = await repository.getJob(req.params.jobId);
      if (!job) throw notFound('Job not found', { jobId: req.params.jobId });
      res.status(202).json({
        job,
        task: {
          type: 'generate_pdf',
          queued: false,
          TODO: 'Run PDF rendering in Cloud Run with Playwright/Puppeteer and store the artifact.',
        },
      });
    }),
  );

  router.post(
    '/:jobId/generate-video',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const result = await requestHeyGenVideo({
        req,
        repository,
        jobStateService,
        videoAssemblyService,
        regenerate: false,
      });
      res.status(202).json(result);
    }),
  );

  router.post(
    '/:jobId/regenerate-video',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const result = await requestHeyGenVideo({
        req,
        repository,
        jobStateService,
        videoAssemblyService,
        regenerate: true,
      });
      res.status(202).json(result);
    }),
  );

  router.post(
    '/:jobId/video-assembly/segments/:heygenVideoId/complete',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const body = req.body ? requireObject(req.body) : {};
      rejectUnknownFields(body, ['completedVideoUrl', 'sourceUrl']);
      const completedVideoUrl =
        optionalString(body, 'completedVideoUrl', { maxLength: 2000 }) ??
        requireString(body, 'sourceUrl', { maxLength: 2000 });
      const result = await videoAssemblyService.completeSegmentForLocalTesting({
        jobId: req.params.jobId,
        heygenVideoId: req.params.heygenVideoId,
        completedVideoUrl,
        actorUid: req.user.uid,
      });
      const job = await repository.getJob(req.params.jobId);
      const artifacts = await repository.listArtifactsForJob(req.params.jobId);
      const providerJobs = await repository.listProviderJobs({ jobId: req.params.jobId });
      res.status(202).json({ result, job, artifacts, providerJobs });
    }),
  );

  router.post(
    '/:jobId/video-assembly/segments/:heygenVideoId/upload',
    requireRole('admin', 'editor'),
    raw({ type: '*/*', limit: '500mb' }),
    asyncHandler(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw badRequest('Segment upload body must contain file bytes');
      }

      const result = await videoAssemblyService.completeSegmentUpload({
        jobId: req.params.jobId,
        heygenVideoId: req.params.heygenVideoId,
        buffer: req.body,
        filename: optionalString(req.query, 'filename', { maxLength: 300, defaultValue: 'segment.mp4' }),
        mimeType: optionalString(req.query, 'mimeType', {
          maxLength: 200,
          defaultValue: req.get('content-type') ?? 'video/mp4',
        }),
        actorUid: req.user.uid,
      });
      const job = await repository.getJob(req.params.jobId);
      const artifacts = await repository.listArtifactsForJob(req.params.jobId);
      const providerJobs = await repository.listProviderJobs({ jobId: req.params.jobId });
      res.status(202).json({ result, job, artifacts, providerJobs });
    }),
  );

  router.post(
    '/:jobId/provider-jobs/:providerJobId/poll',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const providerJob = await repository.getProviderJob(req.params.providerJobId);
      if (!providerJob || providerJob.jobId !== req.params.jobId) {
        throw notFound('Provider job not found', {
          jobId: req.params.jobId,
          providerJobId: req.params.providerJobId,
        });
      }
      if (providerJob.provider !== 'heygen') {
        throw badRequest('Only HeyGen provider jobs can be polled from this endpoint', {
          provider: providerJob.provider,
        });
      }

      const pollResult = await heygenService.pollProviderJob(providerJob);
      let action = 'polled_provider_job';
      if (pollResult.terminalStatus === 'success' || pollResult.terminalStatus === 'failed') {
        const applied = await jobStateService.applyHeyGenWebhook(
          {
            provider: 'heygen',
            eventType: `poll:${pollResult.terminalStatus}`,
            videoId: pollResult.videoId,
            callbackId: providerJob.callbackId,
            terminalStatus: pollResult.terminalStatus,
            videoUrl: pollResult.videoUrl,
            errorCode: pollResult.errorCode,
            errorMessage: pollResult.errorMessage,
            payload: pollResult.providerResponse ?? pollResult,
          },
          {
            actorUid: req.user.uid,
          },
        );
        action = applied.action;
      } else {
        await repository.updateProviderJob(providerJob.id, {
          status: pollResult.status ?? providerJob.status,
          lastPolledAt: new Date().toISOString(),
        });
      }

      const job = await repository.getJob(req.params.jobId);
      const artifacts = await repository.listArtifactsForJob(req.params.jobId);
      const providerJobs = await repository.listProviderJobs({ jobId: req.params.jobId });
      res.status(202).json({ action, pollResult, job, artifacts, providerJobs });
    }),
  );

  router.post(
    '/:jobId/generate-summary',
    requireRole('admin', 'editor', 'reviewer'),
    asyncHandler(async (req, res) => {
      const job = await repository.getJob(req.params.jobId);
      if (!job) throw notFound('Job not found', { jobId: req.params.jobId });

      const artifacts = await repository.listArtifactsForJob(req.params.jobId);
      const providerJobs = await repository.listProviderJobs({ jobId: req.params.jobId });
      const summary = await videoReviewService.generateSummary({ job, artifacts, providerJobs });
      const updatedJob = await repository.updateJob(job.id, {
        metadata: {
          ...(job.metadata ?? {}),
          reviewSummary: summary,
          reviewSummaryGeneratedAt: summary.generatedAt,
        },
      });

      res.json({ job: updatedJob, summary });
    }),
  );

  router.post(
    '/:jobId/thumbnail/upload',
    requireRole('admin', 'editor', 'reviewer'),
    raw({ type: '*/*', limit: '25mb' }),
    asyncHandler(async (req, res) => {
      const result = await videoThumbnailService.uploadThumbnail({
        jobId: req.params.jobId,
        buffer: req.body,
        filename: optionalString(req.query, 'filename', { maxLength: 300, defaultValue: 'thumbnail.jpg' }),
        mimeType: optionalString(req.query, 'mimeType', {
          maxLength: 200,
          defaultValue: req.get('content-type') ?? 'image/jpeg',
        }),
        actorUid: req.user.uid,
      });
      const artifacts = await repository.listArtifactsForJob(req.params.jobId);
      const providerJobs = await repository.listProviderJobs({ jobId: req.params.jobId });
      res.status(201).json({
        ...result,
        artifacts,
        providerJobs,
        task: {
          type: 'upload_thumbnail',
          queued: false,
        },
      });
    }),
  );

  router.post(
    '/:jobId/thumbnail/generate',
    requireRole('admin', 'editor', 'reviewer'),
    asyncHandler(async (req, res) => {
      const body = req.body ? requireObject(req.body) : {};
      rejectUnknownFields(body, ['atSeconds']);
      const result = await videoThumbnailService.generateThumbnail({
        jobId: req.params.jobId,
        atSeconds: optionalNumber(body, 'atSeconds', { min: 0, max: 3600, defaultValue: 2 }),
        actorUid: req.user.uid,
      });
      const artifacts = await repository.listArtifactsForJob(req.params.jobId);
      const providerJobs = await repository.listProviderJobs({ jobId: req.params.jobId });
      res.status(201).json({
        ...result,
        artifacts,
        providerJobs,
        task: {
          type: 'generate_thumbnail',
          queued: false,
          note: 'Thumbnail was generated from the current local video artifact.',
        },
      });
    }),
  );

  router.post(
    '/:jobId/approve',
    requireRole('admin', 'reviewer'),
    asyncHandler(async (req, res) => {
      const existing = await repository.getJob(req.params.jobId);
      if (!existing) throw notFound('Job not found', { jobId: req.params.jobId });
      if (['approved', 'publishing', 'published'].includes(existing.status)) {
        return res.json({ job: existing, alreadyApproved: true });
      }

      let reviewableJob = existing;
      if (existing.status === 'video_ready') {
        reviewableJob = await jobStateService.transitionJob(req.params.jobId, 'review_required', {
          actorUid: req.user.uid,
          reason: 'open_review',
        });
      }

      const job = await jobStateService.transitionJob(reviewableJob.id, 'approved', {
        actorUid: req.user.uid,
        reason: 'approve_job',
      });
      res.json({ job });
    }),
  );

  return router;
}

function operatorLabel(user) {
  return user?.email ?? user?.displayName ?? user?.uid ?? 'Unknown operator';
}

async function requestHeyGenVideo({ req, repository, jobStateService, videoAssemblyService, regenerate }) {
  const job = await repository.getJob(req.params.jobId);
  if (!job) throw notFound('Job not found', { jobId: req.params.jobId });
  assertTextToHeyGenJob(job, regenerate ? 'regenerate_video' : 'generate_video');

  const body = req.body ? requireObject(req.body) : {};
  rejectUnknownFields(body, ['script', 'metadata']);
  const transitionedJob = await jobStateService.transitionJob(job.id, 'video_requested', {
    actorUid: req.user.uid,
    reason: regenerate ? 'regenerate_video' : 'generate_video',
  });
  const result = await videoAssemblyService.createAssemblyRequest({
    job: transitionedJob,
    script: optionalObject(body, 'script', { defaultValue: null }),
    actorUid: req.user.uid,
    regenerate,
  });

  return {
    job: result.job,
    providerJob: result.providerJobs[0] ?? null,
    providerJobs: result.providerJobs,
    manifest: result.manifest,
    manifestArtifact: result.manifestArtifact,
    task: {
      type: regenerate ? 'regenerate_video' : 'generate_video',
      queued: false,
      segmentCount: result.manifest.segments.length,
      note: 'HeyGen segment requests were created. Segment completion updates the manifest, and stitching starts when all required segments complete.',
    },
  };
}

function assertTextToHeyGenJob(job, operation) {
  const hasScript = Array.isArray(job.metadata?.scriptPreview) && job.metadata.scriptPreview.filter(Boolean).length > 0;
  const hasPrompt = typeof job.metadata?.prompt === 'string' && job.metadata.prompt.trim().length > 0;
  if (job.sourceType !== 'text_to_heygen' || (!hasScript && !hasPrompt)) {
    throw badRequest('HeyGen regeneration is only available for text-to-HeyGen jobs with script content', {
      operation,
      jobId: job.id,
      sourceType: job.sourceType,
    });
  }
}

async function archivePublishingRecordsForQueueDelete(repository, { job, publishPlans, publishAttempts, actorUid, reason }) {
  const archivedAt = new Date().toISOString();
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
        ...(attempt.metadata ?? {}),
        archivedToAuditAt: archivedAt,
        archiveReason: reason,
        previousStatus: attempt.status,
        archivedBy: actorUid ?? null,
        providerDeleted: false,
        publisherStatus: 'Removed from active content queue.',
        progressStage: 'deleted',
        progressPercent: 100,
        progressLabel: 'Removed from active content queue.',
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
        ...(plan.metadata ?? {}),
        archivedToAuditAt: archivedAt,
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
