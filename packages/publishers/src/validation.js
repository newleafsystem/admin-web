import { COMMON_TEXT_LIMITS, COMMON_VIDEO_LIMITS } from "./limits.js";

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validationResult(errors, warnings, details = {}) {
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    details
  };
}

function message(code, field, text) {
  return { code, field, message: text };
}

function splitLimits(limits) {
  if (limits?.video || limits?.text) {
    return {
      video: limits.video ?? COMMON_VIDEO_LIMITS,
      text: limits.text ?? COMMON_TEXT_LIMITS
    };
  }

  return {
    video: limits ?? COMMON_VIDEO_LIMITS,
    text: COMMON_TEXT_LIMITS
  };
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);

  while (b > 0) {
    const next = a % b;
    a = b;
    b = next;
  }

  return a || 1;
}

export function ratioLabel(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || height === 0) {
    return "";
  }

  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

export function parseAspectRatio(value) {
  if (isFiniteNumber(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const [width, height] = value.split(":").map((part) => Number(part.trim()));

    if (isFiniteNumber(width) && isFiniteNumber(height) && height > 0) {
      return width / height;
    }
  }

  if (isPlainObject(value)) {
    return parseAspectRatio(`${value.width}:${value.height}`);
  }

  return null;
}

export function getVideoAspectRatio(video = {}) {
  if (video.aspectRatio !== undefined) {
    return parseAspectRatio(video.aspectRatio);
  }

  if (isFiniteNumber(video.width) && isFiniteNumber(video.height) && video.height > 0) {
    return video.width / video.height;
  }

  return null;
}

export function isAspectRatioAllowed(actualRatio, allowedRatios, tolerance = 0.04) {
  if (!isFiniteNumber(actualRatio) || actualRatio <= 0) {
    return false;
  }

  return allowedRatios.some((allowedRatio) => {
    const parsed = parseAspectRatio(allowedRatio);

    if (!parsed) {
      return false;
    }

    return Math.abs(actualRatio - parsed) / parsed <= tolerance;
  });
}

export function validateVideo(video = {}, limits = COMMON_VIDEO_LIMITS) {
  const errors = [];
  const warnings = [];
  const actualRatio = getVideoAspectRatio(video);
  const allowedRatios = limits.aspectRatios ?? COMMON_VIDEO_LIMITS.aspectRatios;
  const tolerance =
    limits.aspectRatioTolerance ?? COMMON_VIDEO_LIMITS.aspectRatioTolerance;

  if (!isPlainObject(video)) {
    return validationResult(
      [message("invalid_video", "video", "Video metadata must be an object.")],
      warnings
    );
  }

  if (!isFiniteNumber(video.sizeBytes)) {
    errors.push(
      message("required", "video.sizeBytes", "Video sizeBytes is required.")
    );
  } else {
    if (video.sizeBytes < (limits.minSizeBytes ?? 1)) {
      errors.push(
        message("too_small", "video.sizeBytes", "Video file size is too small.")
      );
    }

    if (video.sizeBytes > limits.maxSizeBytes) {
      errors.push(
        message(
          "too_large",
          "video.sizeBytes",
          `Video exceeds max size of ${limits.maxSizeBytes} bytes.`
        )
      );
    }
  }

  if (!isFiniteNumber(video.durationSec)) {
    errors.push(
      message("required", "video.durationSec", "Video durationSec is required.")
    );
  } else {
    if (video.durationSec < (limits.minDurationSec ?? 1)) {
      errors.push(
        message(
          "too_short",
          "video.durationSec",
          `Video duration must be at least ${limits.minDurationSec} seconds.`
        )
      );
    }

    if (video.durationSec > limits.maxDurationSec) {
      errors.push(
        message(
          "too_long",
          "video.durationSec",
          `Video duration exceeds ${limits.maxDurationSec} seconds.`
        )
      );
    }
  }

  if (!isFiniteNumber(video.width)) {
    errors.push(message("required", "video.width", "Video width is required."));
  } else if (video.width < limits.minWidth) {
    errors.push(
      message(
        "too_narrow",
        "video.width",
        `Video width must be at least ${limits.minWidth}px.`
      )
    );
  }

  if (!isFiniteNumber(video.height)) {
    errors.push(message("required", "video.height", "Video height is required."));
  } else if (video.height < limits.minHeight) {
    errors.push(
      message(
        "too_short",
        "video.height",
        `Video height must be at least ${limits.minHeight}px.`
      )
    );
  }

  if (!actualRatio) {
    errors.push(
      message(
        "required",
        "video.aspectRatio",
        "Video aspect ratio requires width and height or aspectRatio."
      )
    );
  } else if (!isAspectRatioAllowed(actualRatio, allowedRatios, tolerance)) {
    errors.push(
      message(
        "unsupported_aspect_ratio",
        "video.aspectRatio",
        `Video aspect ratio must match one of: ${allowedRatios.join(", ")}.`
      )
    );
  }

  if (video.mimeType && video.mimeType !== "video/mp4") {
    warnings.push(
      message(
        "mime_type_review",
        "video.mimeType",
        "Provider adapters should confirm whether this MIME type is supported."
      )
    );
  }

  return validationResult(errors, warnings, {
    actualAspectRatio: actualRatio,
    actualAspectRatioLabel:
      isFiniteNumber(video.width) && isFiniteNumber(video.height)
        ? ratioLabel(video.width, video.height)
        : null,
    allowedAspectRatios: allowedRatios
  });
}

export function validateTextLength(value, field, maxLength) {
  const errors = [];
  const warnings = [];

  if (value === undefined || value === null || value === "") {
    warnings.push(
      message("missing_text", field, `${field} is empty and may be required.`)
    );
    return validationResult(errors, warnings, { length: 0, maxLength });
  }

  if (typeof value !== "string") {
    errors.push(message("invalid_text", field, `${field} must be a string.`));
    return validationResult(errors, warnings, { length: 0, maxLength });
  }

  if (value.length > maxLength) {
    errors.push(
      message(
        "text_too_long",
        field,
        `${field} exceeds max length of ${maxLength} characters.`
      )
    );
  }

  return validationResult(errors, warnings, {
    length: typeof value === "string" ? value.length : 0,
    maxLength
  });
}

export function validateCaption(caption, limits = COMMON_TEXT_LIMITS) {
  const textLimits = limits.text ?? limits;
  return validateTextLength(
    caption,
    "metadata.caption",
    textLimits.captionMaxLength
  );
}

export function validateTags(tags, limits = COMMON_TEXT_LIMITS) {
  const textLimits = limits.text ?? limits;
  const errors = [];
  const warnings = [];

  if (tags === undefined || tags === null) {
    return validationResult(errors, warnings, {
      count: 0,
      maxCount: textLimits.tagMaxCount
    });
  }

  if (!Array.isArray(tags)) {
    errors.push(message("invalid_tags", "metadata.tags", "Tags must be an array."));
    return validationResult(errors, warnings);
  }

  if (tags.length > textLimits.tagMaxCount) {
    errors.push(
      message(
        "too_many_tags",
        "metadata.tags",
        `Tag count exceeds ${textLimits.tagMaxCount}.`
      )
    );
  }

  tags.forEach((tag, index) => {
    if (typeof tag !== "string") {
      errors.push(
        message("invalid_tag", `metadata.tags.${index}`, "Tag must be a string.")
      );
      return;
    }

    if (tag.length > textLimits.tagMaxLength) {
      errors.push(
        message(
          "tag_too_long",
          `metadata.tags.${index}`,
          `Tag exceeds ${textLimits.tagMaxLength} characters.`
        )
      );
    }
  });

  return validationResult(errors, warnings, {
    count: tags.length,
    maxCount: textLimits.tagMaxCount
  });
}

export function mergeValidationResults(...results) {
  const errors = [];
  const warnings = [];
  const details = {};

  for (const result of results) {
    errors.push(...(result?.errors ?? []));
    warnings.push(...(result?.warnings ?? []));
    Object.assign(details, result?.details ?? {});
  }

  return validationResult(errors, warnings, details);
}

export function validatePublishPlan(plan = {}, limits = {}) {
  const { video: videoLimits, text: textLimits } = splitLimits(limits);
  const errors = [];
  const warnings = [];

  if (!isPlainObject(plan)) {
    return validationResult(
      [message("invalid_plan", "plan", "Publish plan must be an object.")],
      warnings
    );
  }

  const video = plan.video ?? plan.videoAsset ?? plan.artifacts?.video;
  const metadata = plan.metadata ?? {};

  if (!video) {
    errors.push(
      message(
        "missing_video",
        "video",
        "Publish plan must include video metadata before publishing."
      )
    );
  }

  if (!metadata.title) {
    warnings.push(
      message("missing_title", "metadata.title", "Title is empty and may be required.")
    );
  }

  const results = [
    validationResult(errors, warnings),
    video ? validateVideo(video, videoLimits) : null,
    validateTextLength(metadata.title, "metadata.title", textLimits.titleMaxLength),
    validateCaption(metadata.caption ?? metadata.description, textLimits),
    validateTextLength(
      metadata.description,
      "metadata.description",
      textLimits.descriptionMaxLength
    ),
    validateTags(metadata.tags, textLimits)
  ].filter(Boolean);

  return mergeValidationResults(...results);
}
