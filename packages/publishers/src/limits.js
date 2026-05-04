import { PLATFORMS, normalizePlatform } from "./platforms.js";

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

// Scaffold defaults are project policy, not provider guarantees. Replace these
// with provider-audited values when an adapter starts making real API calls.
export const COMMON_VIDEO_LIMITS = Object.freeze({
  minSizeBytes: 1,
  maxSizeBytes: 2 * GIB,
  minDurationSec: 1,
  maxDurationSec: 15 * 60,
  minWidth: 360,
  minHeight: 360,
  aspectRatios: Object.freeze(["16:9", "9:16", "1:1"]),
  aspectRatioTolerance: 0.04
});

export const COMMON_TEXT_LIMITS = Object.freeze({
  titleMaxLength: 100,
  captionMaxLength: 2200,
  descriptionMaxLength: 5000,
  tagMaxCount: 30,
  tagMaxLength: 50
});

export const PROVIDER_LIMITS = Object.freeze({
  [PLATFORMS.YOUTUBE]: Object.freeze({
    video: Object.freeze({
      ...COMMON_VIDEO_LIMITS,
      maxSizeBytes: 8 * GIB,
      maxDurationSec: 12 * 60 * 60,
      aspectRatios: Object.freeze(["16:9", "9:16"])
    }),
    text: Object.freeze({
      ...COMMON_TEXT_LIMITS,
      captionMaxLength: 5000
    })
  }),
  [PLATFORMS.X]: Object.freeze({
    video: Object.freeze({
      ...COMMON_VIDEO_LIMITS,
      maxSizeBytes: 512 * MIB,
      maxDurationSec: 140,
      aspectRatios: Object.freeze(["16:9", "9:16", "1:1"])
    }),
    text: Object.freeze({
      ...COMMON_TEXT_LIMITS,
      captionMaxLength: 280,
      descriptionMaxLength: 280,
      tagMaxCount: 0
    })
  }),
  [PLATFORMS.LINKEDIN]: Object.freeze({
    video: Object.freeze({
      ...COMMON_VIDEO_LIMITS,
      maxSizeBytes: 1 * GIB,
      maxDurationSec: 10 * 60,
      aspectRatios: Object.freeze(["16:9", "9:16", "1:1"])
    }),
    text: Object.freeze({
      ...COMMON_TEXT_LIMITS,
      captionMaxLength: 3000
    })
  }),
  [PLATFORMS.META]: Object.freeze({
    video: Object.freeze({
      ...COMMON_VIDEO_LIMITS,
      maxSizeBytes: 1 * GIB,
      maxDurationSec: 15 * 60,
      aspectRatios: Object.freeze(["9:16", "1:1", "4:5", "16:9"])
    }),
    text: Object.freeze({
      ...COMMON_TEXT_LIMITS,
      captionMaxLength: 2200
    })
  }),
  [PLATFORMS.TIKTOK]: Object.freeze({
    video: Object.freeze({
      ...COMMON_VIDEO_LIMITS,
      maxSizeBytes: 1 * GIB,
      maxDurationSec: 10 * 60,
      aspectRatios: Object.freeze(["9:16", "1:1", "16:9"])
    }),
    text: Object.freeze({
      ...COMMON_TEXT_LIMITS,
      captionMaxLength: 2200
    })
  })
});

export function getProviderLimits(platform) {
  const normalized = normalizePlatform(platform);

  return (
    PROVIDER_LIMITS[normalized] ??
    Object.freeze({
      video: COMMON_VIDEO_LIMITS,
      text: COMMON_TEXT_LIMITS
    })
  );
}
