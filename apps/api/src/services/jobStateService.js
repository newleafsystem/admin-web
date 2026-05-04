import { badRequest, conflict, notFound } from '../lib/httpErrors.js';

export const JOB_STATUSES = Object.freeze([
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

const TRANSITIONS = Object.freeze({
  draft: ['source_ingested', 'failed'],
  source_ingested: ['content_extracted', 'failed'],
  content_extracted: ['script_ready', 'failed'],
  script_ready: ['video_requested', 'failed'],
  video_requested: ['video_ready', 'failed'],
  video_ready: ['review_required', 'video_requested', 'failed'],
  review_required: ['approved', 'script_ready', 'video_requested', 'failed'],
  approved: ['publishing', 'review_required'],
  publishing: ['published', 'partial_failed', 'failed'],
  published: [],
  partial_failed: ['publishing', 'failed'],
  failed: ['draft', 'source_ingested', 'content_extracted', 'script_ready', 'video_requested'],
});

export function createJobStateService({ repository, videoAssemblyService = null }) {
  return {
    statuses: JOB_STATUSES,

    async createJob(input) {
      return repository.createJob({
        title: input.title,
        type: input.type,
        status: input.status,
        sourceType: input.sourceType,
        ownerUid: input.ownerUid,
        targetDurationSec: input.targetDurationSec,
        metadata: input.metadata,
      });
    },

    async transitionJob(jobId, nextStatus, context = {}) {
      assertKnownStatus(nextStatus);
      const current = await repository.getJob(jobId);
      if (!current) {
        throw notFound('Job not found', { jobId });
      }
      if (!canTransition(current.status, nextStatus)) {
        throw conflict('Invalid job status transition', {
          jobId,
          from: current.status,
          to: nextStatus,
          allowed: TRANSITIONS[current.status] ?? [],
        });
      }

      return repository.updateJob(jobId, {
        ...context.updates,
        status: nextStatus,
        lastTransition: {
          from: current.status,
          to: nextStatus,
          reason: context.reason ?? null,
          actorUid: context.actorUid ?? null,
          at: new Date().toISOString(),
        },
      });
    },

    async markExtractionRequested(jobId, context = {}) {
      const job = await repository.getJob(jobId);
      if (!job) throw notFound('Job not found', { jobId });
      const nextStatus = job.status === 'draft' ? 'source_ingested' : 'content_extracted';
      return this.transitionJob(jobId, nextStatus, {
        ...context,
        reason: context.reason ?? 'extract_content',
      });
    },

    async createVideoRequest(jobId, requestPayload, context = {}) {
      const callbackId = context.callbackId ?? `${jobId}-${Date.now()}`;
      const job = await this.transitionJob(jobId, 'video_requested', {
        actorUid: context.actorUid,
        reason: context.regenerate ? 'regenerate_video' : 'generate_video',
      });
      const providerJob = await repository.createProviderJob({
        jobId,
        provider: 'heygen',
        status: 'processing',
        externalId: requestPayload.videoId ?? null,
        callbackId,
        requestPayload,
      });
      return { job, providerJob };
    },

    async applyHeyGenWebhook(event, context = {}) {
      const providerJob = await repository.findProviderJob({
        provider: 'heygen',
        externalId: event.videoId,
        callbackId: event.callbackId,
      });

      if (!providerJob) {
        return { action: 'stored_unmatched_event' };
      }

      const providerPatch = {
        lastProviderEventAt: new Date().toISOString(),
        status: event.terminalStatus ?? providerJob.status,
      };

      if (event.terminalStatus === 'failed') {
        providerPatch.errorCode = event.errorCode ?? 'heygen_failed';
        providerPatch.errorMessage = event.errorMessage ?? 'HeyGen video generation failed';
      }

      await repository.updateProviderJob(providerJob.id, providerPatch);

      if (providerJob.requestPayload?.assembly?.projectId && videoAssemblyService) {
        const updatedProviderJob = await repository.getProviderJob(providerJob.id);
        if (event.terminalStatus === 'success') {
          return videoAssemblyService.handleSegmentCompleted({
            providerJob: updatedProviderJob,
            event,
            actorUid: context.actorUid ?? 'heygen:webhook',
          });
        }
        if (event.terminalStatus === 'failed') {
          return videoAssemblyService.handleSegmentFailed({
            providerJob: updatedProviderJob,
            event,
            actorUid: context.actorUid ?? 'heygen:webhook',
          });
        }
        return { action: 'updated_segment_provider_job' };
      }

      if (event.terminalStatus === 'success') {
        const artifact = await repository.createArtifact({
          jobId: providerJob.jobId,
          kind: 'video',
          storageProvider: 'provider-url',
          storageKey: event.videoUrl ?? `heygen://${event.videoId}`,
          mimeType: 'video/mp4',
          metadata: {
            provider: 'heygen',
            externalId: event.videoId,
            TODO: 'Download the completed video into Firebase Storage / GCS before production publishing.',
          },
        });
        await repository.updateJob(providerJob.jobId, {
          status: 'video_ready',
          currentVideoArtifactId: artifact.id,
          lastTransition: {
            from: 'video_requested',
            to: 'video_ready',
            reason: 'heygen_webhook_success',
            actorUid: context.actorUid ?? 'heygen:webhook',
            at: new Date().toISOString(),
          },
        });
        return { action: 'marked_video_ready', artifact };
      }

      if (event.terminalStatus === 'failed') {
        await repository.updateJob(providerJob.jobId, {
          status: 'failed',
          lastTransition: {
            from: 'video_requested',
            to: 'failed',
            reason: 'heygen_webhook_failed',
            actorUid: context.actorUid ?? 'heygen:webhook',
            at: new Date().toISOString(),
          },
        });
        return { action: 'marked_failed' };
      }

      return { action: 'updated_provider_job' };
    },
  };
}

export function canTransition(fromStatus, toStatus) {
  return Boolean(TRANSITIONS[fromStatus]?.includes(toStatus));
}

function assertKnownStatus(status) {
  if (!JOB_STATUSES.includes(status)) {
    throw badRequest('Unknown job status', { status, allowed: JOB_STATUSES });
  }
}
