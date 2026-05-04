export {
  REQUIRED_PUBLISHER_MEMBERS,
  assertPublisherShape,
  inspectPublisherShape
} from "./interface.js";
export { IDEMPOTENCY_GUIDANCE, buildIdempotencyKey, describeIdempotency } from "./idempotency.js";
export { COMMON_TEXT_LIMITS, COMMON_VIDEO_LIMITS, PROVIDER_LIMITS, getProviderLimits } from "./limits.js";
export { PLATFORM_ALIASES, PLATFORMS, normalizePlatform } from "./platforms.js";
export {
  getVideoAspectRatio,
  isAspectRatioAllowed,
  mergeValidationResults,
  parseAspectRatio,
  ratioLabel,
  validateCaption,
  validatePublishPlan,
  validateTags,
  validateTextLength,
  validateVideo
} from "./validation.js";
export {
  linkedinPublisher,
  linkedinTodos,
  metaPublisher,
  metaTodos,
  tiktokPublisher,
  tiktokTodos,
  xTwitterPublisher,
  xTwitterTodos,
  youtubePublisher,
  youtubeTodos
} from "./adapters/index.js";

import { linkedinPublisher } from "./adapters/linkedin.js";
import { metaPublisher } from "./adapters/meta.js";
import { tiktokPublisher } from "./adapters/tiktok.js";
import { xTwitterPublisher } from "./adapters/x-twitter.js";
import { youtubePublisher } from "./adapters/youtube.js";
import { normalizePlatform, PLATFORMS } from "./platforms.js";

export const publishers = Object.freeze({
  [PLATFORMS.YOUTUBE]: youtubePublisher,
  [PLATFORMS.X]: xTwitterPublisher,
  [PLATFORMS.LINKEDIN]: linkedinPublisher,
  [PLATFORMS.META]: metaPublisher,
  [PLATFORMS.TIKTOK]: tiktokPublisher
});

export function getPublisher(platform) {
  const normalized = normalizePlatform(platform);
  const publisher = publishers[normalized];

  if (!publisher) {
    throw new RangeError(`Unsupported publisher platform: ${platform}`);
  }

  return publisher;
}
