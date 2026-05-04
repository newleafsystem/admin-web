export const IDEMPOTENCY_GUIDANCE = Object.freeze([
  "Use the persisted publishAttempt ID as the idempotency boundary.",
  "Persist provider upload IDs before creating the final public post.",
  "Retry by resuming from the last persisted provider step when possible.",
  "Never create duplicate public posts for the same publishAttempt.",
  "Store request and response snapshots for audit logs and debugging."
]);

export function getAttemptId(attempt = {}) {
  return attempt.attemptId ?? attempt.publishAttemptId ?? attempt.id ?? null;
}

export function buildIdempotencyKey(platform, attempt = {}) {
  if (attempt.idempotencyKey) {
    return attempt.idempotencyKey;
  }

  const attemptId = getAttemptId(attempt);

  if (attemptId) {
    return `${platform}:publishAttempt:${attemptId}`;
  }

  const fallbackParts = [
    platform,
    attempt.planId,
    attempt.jobId,
    attempt.connectedAccountId,
    attempt.attemptNo ?? 1
  ].filter(Boolean);

  if (fallbackParts.length > 1) {
    return `${fallbackParts.join(":")}:placeholder`;
  }

  return `${platform}:publishAttempt:missing`;
}

export function describeIdempotency(platform, attempt = {}) {
  const attemptId = getAttemptId(attempt);

  return {
    key: buildIdempotencyKey(platform, attempt),
    boundary: "publishAttempt",
    attemptId,
    retrySafe: Boolean(attemptId),
    warnings: attemptId
      ? []
      : [
          "Missing attemptId; using a fallback key that should not be used for production publishing."
        ],
    guidance: IDEMPOTENCY_GUIDANCE
  };
}
