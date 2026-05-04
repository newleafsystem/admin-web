/**
 * @typedef {Object} VideoAsset
 * @property {string} [storageKey]
 * @property {string} [mimeType]
 * @property {number} sizeBytes
 * @property {number} durationSec
 * @property {number} width
 * @property {number} height
 * @property {string} [checksum]
 */

/**
 * @typedef {Object} PublishMetadata
 * @property {string} [title]
 * @property {string} [caption]
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {string} [privacy]
 * @property {string} [scheduledAt]
 */

/**
 * @typedef {Object} PublishPlan
 * @property {string} [planId]
 * @property {string} [jobId]
 * @property {string} [platform]
 * @property {VideoAsset} [video]
 * @property {PublishMetadata} [metadata]
 */

/**
 * @typedef {Object} PublishAttempt
 * @property {string} [attemptId]
 * @property {string} [id]
 * @property {string} [planId]
 * @property {string} [jobId]
 * @property {string} platform
 * @property {string} [connectedAccountId]
 * @property {number} [attemptNo]
 * @property {PublishPlan} [plan]
 */

/**
 * @typedef {Object} ValidationMessage
 * @property {string} code
 * @property {string} field
 * @property {string} message
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} ok
 * @property {ValidationMessage[]} errors
 * @property {ValidationMessage[]} warnings
 * @property {Object} [details]
 */

/**
 * Publisher interface by convention:
 *
 * @typedef {Object} Publisher
 * @property {string} platform
 * @property {(plan: PublishPlan) => Promise<ValidationResult>} validate
 * @property {(attempt: PublishAttempt) => Promise<Object>} publish
 * @property {(attempt: PublishAttempt) => Promise<Object>} [refreshStatus]
 */

export const REQUIRED_PUBLISHER_MEMBERS = Object.freeze([
  "platform",
  "validate",
  "publish"
]);

export function inspectPublisherShape(publisher) {
  const errors = [];

  if (!publisher || typeof publisher !== "object") {
    errors.push({
      code: "invalid_publisher",
      field: "publisher",
      message: "Publisher must be an object."
    });
    return { ok: false, errors };
  }

  if (typeof publisher.platform !== "string" || publisher.platform.length === 0) {
    errors.push({
      code: "missing_platform",
      field: "publisher.platform",
      message: "Publisher must define a platform string."
    });
  }

  for (const method of ["validate", "publish"]) {
    if (typeof publisher[method] !== "function") {
      errors.push({
        code: "missing_method",
        field: `publisher.${method}`,
        message: `Publisher must define ${method}().`
      });
    }
  }

  if (
    publisher.refreshStatus !== undefined &&
    typeof publisher.refreshStatus !== "function"
  ) {
    errors.push({
      code: "invalid_method",
      field: "publisher.refreshStatus",
      message: "refreshStatus must be a function when provided."
    });
  }

  return { ok: errors.length === 0, errors };
}

export function assertPublisherShape(publisher) {
  const result = inspectPublisherShape(publisher);

  if (!result.ok) {
    throw new TypeError(result.errors.map((error) => error.message).join(" "));
  }

  return publisher;
}
