export const PLATFORMS = Object.freeze({
  YOUTUBE: "youtube",
  X: "x",
  LINKEDIN: "linkedin",
  META: "instagram-facebook",
  TIKTOK: "tiktok"
});

export const PLATFORM_ALIASES = Object.freeze({
  facebook: PLATFORMS.META,
  instagram: PLATFORMS.META,
  meta: PLATFORMS.META,
  "instagram-facebook": PLATFORMS.META,
  linkedin: PLATFORMS.LINKEDIN,
  tiktok: PLATFORMS.TIKTOK,
  twitter: PLATFORMS.X,
  x: PLATFORMS.X,
  "x-twitter": PLATFORMS.X,
  youtube: PLATFORMS.YOUTUBE
});

export function normalizePlatform(platform) {
  if (typeof platform !== "string") {
    return "";
  }

  const key = platform.trim().toLowerCase();
  return PLATFORM_ALIASES[key] ?? key;
}
