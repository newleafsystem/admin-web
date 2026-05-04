import { describeIdempotency } from "./idempotency.js";
import { getProviderLimits } from "./limits.js";
import { validatePublishPlan } from "./validation.js";

function getPlanFromAttempt(attempt = {}) {
  return attempt.plan ?? attempt.publishPlan ?? {};
}

function summarizeAttempt(attempt = {}) {
  const plan = getPlanFromAttempt(attempt);
  const video = plan.video ?? plan.videoAsset ?? plan.artifacts?.video ?? {};
  const metadata = plan.metadata ?? {};

  return {
    attemptId: attempt.attemptId ?? attempt.publishAttemptId ?? attempt.id ?? null,
    planId: attempt.planId ?? plan.planId ?? null,
    jobId: attempt.jobId ?? plan.jobId ?? null,
    platform: attempt.platform ?? plan.platform ?? null,
    connectedAccountId: attempt.connectedAccountId ?? null,
    attemptNo: attempt.attemptNo ?? null,
    video: {
      storageKey: video.storageKey ?? null,
      mimeType: video.mimeType ?? null,
      sizeBytes: video.sizeBytes ?? null,
      durationSec: video.durationSec ?? null,
      width: video.width ?? null,
      height: video.height ?? null,
      checksum: video.checksum ?? null
    },
    metadata: {
      title: metadata.title ?? null,
      caption: metadata.caption ?? null,
      description: metadata.description ?? null,
      tags: metadata.tags ?? [],
      privacy: metadata.privacy ?? null,
      scheduledAt: metadata.scheduledAt ?? null
    }
  };
}

export function createPlaceholderPublisher({
  platform,
  displayName,
  todos,
  limits = getProviderLimits(platform)
}) {
  return Object.freeze({
    platform,
    displayName,
    todos: Object.freeze([...todos]),
    limits,

    async validate(plan) {
      const result = validatePublishPlan(plan, limits);

      return {
        ...result,
        platform,
        providerReadiness: "placeholder"
      };
    },

    async publish(attempt) {
      return {
        ok: true,
        platform,
        provider: displayName,
        status: "placeholder_not_sent",
        networkCallPerformed: false,
        providerPostId: null,
        providerUrl: null,
        providerProcessingState: "not_started",
        idempotency: describeIdempotency(platform, attempt),
        requestSnapshot: summarizeAttempt(attempt),
        responseSnapshot: {
          placeholder: true,
          message: `${displayName} publishing is not implemented yet.`
        },
        todos
      };
    },

    async refreshStatus(attempt) {
      return {
        ok: true,
        platform,
        provider: displayName,
        status: "placeholder_not_checked",
        networkCallPerformed: false,
        providerPostId: attempt?.providerPostId ?? null,
        providerUrl: attempt?.providerUrl ?? null,
        providerProcessingState: "unknown",
        idempotency: describeIdempotency(platform, attempt),
        responseSnapshot: {
          placeholder: true,
          message: `${displayName} status refresh is not implemented yet.`
        },
        todos
      };
    }
  });
}
