import {
  intakeModes,
  REVIEWABLE_STATUSES,
  routeByView,
  socialPlatforms,
  viewByRoute
} from "./constants.js";

export function buildPublicationDrafts(publications) {
  return Object.fromEntries(
    publications.map((publication) => [
      publication.id,
      {
        title: publication.title,
        description: publication.description,
        privacyStatus: publication.privacyStatus,
        tagsText: publication.tags.join(", "),
        hashtagsText: publication.hashtags?.join(", ") ?? "",
        isSaving: false,
        error: null
      }
    ])
  );
}

export function getPlatformConfig(platform) {
  const normalized = String(platform ?? "").toLowerCase();
  return (
    socialPlatforms.find((candidate) => candidate.id === normalized || candidate.label.toLowerCase() === normalized) ??
    socialPlatforms[0]
  );
}

export function getIntakeMode(mode) {
  return intakeModes.find((candidate) => candidate.id === mode) ?? intakeModes[0];
}

export function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export function isReviewableJob(job) {
  return Boolean(job && REVIEWABLE_STATUSES.has(job.status));
}

export function isConnectedAccount(account) {
  const status = String(account?.status ?? "").toLowerCase();
  const tokenHealth = String(account?.tokenHealth ?? "").toLowerCase();
  return ["connected", "configured"].includes(status) && !["refresh failed", "disconnected"].includes(tokenHealth);
}

export function getIntegratedPlatforms(accounts, platforms) {
  const integratedIds = new Set(
    accounts.filter(isConnectedAccount).map((account) => platformIdFromLabel(account.platform))
  );
  return platforms.filter((platform) => platform.publisherEnabled && integratedIds.has(platform.id));
}

export function buildUnavailablePublishMap({ publishPlans, publications }) {
  const unavailableByJob = new Map();
  const markUnavailable = (jobId, platform, reason) => {
    if (!jobId || !platform) {
      return;
    }
    const platformId = platformIdFromLabel(platform);
    const current = unavailableByJob.get(jobId) ?? new Map();
    current.set(platformId, reason);
    unavailableByJob.set(jobId, current);
  };

  for (const publication of publications) {
    if (["queued", "retrying", "uploading", "processing", "published", "delete_requested"].includes(publication.status)) {
      markUnavailable(
        publication.jobId,
        publication.platform,
        publication.status === "published" ? "Already published" : "Publishing in progress"
      );
    }
  }

  for (const plan of publishPlans) {
    if (!["draft", "approved", "publishing"].includes(plan.status)) {
      continue;
    }
    for (const platform of plan.platforms ?? []) {
      markUnavailable(plan.jobId, platform, "Already planned");
    }
    for (const attempt of plan.attempts ?? []) {
      if (["queued", "retrying", "uploading", "processing", "published", "delete_requested"].includes(attempt.status)) {
        markUnavailable(
          plan.jobId,
          attempt.platform,
          attempt.status === "published" ? "Already published" : "Publishing in progress"
        );
      }
    }
  }

  return unavailableByJob;
}

export function getRemainingPublishPlatforms(jobId, integratedPlatforms, unavailableByJob) {
  const unavailable = unavailableByJob.get(jobId) ?? new Map();
  return integratedPlatforms.filter((platform) => !unavailable.has(platform.id));
}

export function isArchivedPublishPlan(plan) {
  const attempts = plan?.attempts ?? [];
  if (plan?.status === "deleted" || plan?.status === "published") {
    return true;
  }
  if (String(plan?.metadata?.externalSource ?? "").includes("_channel_import")) {
    return true;
  }
  if (attempts.some((attempt) => String(attempt.id ?? "").startsWith("external_"))) {
    return true;
  }
  if (attempts.some((attempt) => String(attempt.metadata?.externalSource ?? "").includes("_channel_import"))) {
    return true;
  }
  if (attempts.length === 0) {
    return false;
  }
  if (attempts.every((attempt) => attempt.status === "deleted")) {
    return true;
  }
  return (
    attempts.some((attempt) => attempt.status === "deleted") &&
    attempts.every((attempt) => attempt.status === "deleted" || (attempt.status === "failed" && !attempt.postId))
  );
}

export function hasActivePublishingWork({ publishPlans = [], publications = [] } = {}) {
  const activeStatuses = new Set(["queued", "retrying", "uploading", "processing", "delete_requested"]);

  return (
    publishPlans.some((plan) => {
      if (isArchivedPublishPlan(plan)) {
        return false;
      }
      return (
        plan.status === "publishing" ||
        (plan.attempts ?? []).some((attempt) => activeStatuses.has(attempt.status))
      );
    }) ||
    publications.some((publication) => activeStatuses.has(publication.status))
  );
}

export function isArchivedContentQueueJob(job, { publishPlans = [], publications = [] } = {}) {
  if (!job) {
    return false;
  }
  if (job.type === "external_video" || String(job.sourceType ?? "").startsWith("external_")) {
    return true;
  }

  const relatedPlans = publishPlans.filter((plan) => plan.jobId === job.id);
  const relatedPublications = publications.filter((publication) => publication.jobId === job.id);
  if (relatedPlans.length === 0 && relatedPublications.length === 0) {
    return false;
  }

  const hasArchivedPlan = relatedPlans.some(isArchivedPublishPlan);
  const hasActivePlan = relatedPlans.some((plan) => !isArchivedPublishPlan(plan));
  const hasDeletedPublication = relatedPublications.some((publication) => publication.status === "deleted");
  const hasActivePublication = relatedPublications.some((publication) =>
    ["queued", "retrying", "uploading", "processing", "published", "delete_requested"].includes(publication.status)
  );

  if (hasActivePlan || hasActivePublication) {
    return false;
  }

  return (
    hasArchivedPlan ||
    (hasDeletedPublication && ["published", "partial_failed", "publishing", "failed"].includes(job.status))
  );
}

export function addAuditEvent(current, action, resource, actor = "local-admin", details = {}) {
  const eventActor = typeof actor === "object" ? actor.actor ?? "local-admin" : actor;
  const eventDetails = typeof actor === "object" ? actor.details ?? {} : details;
  return [
    {
      id: `audit_${Date.now()}`,
      actor: eventActor,
      action,
      resource,
      createdAt: "just now",
      details: eventDetails
    },
    ...current
  ];
}

export function normalizeDraftSegments(segments = []) {
  return segments.map((segment, index) => ({
    sequence: Number(segment.sequence) || (index + 1) * 10,
    segmentKey: String(segment.segmentKey ?? `segment_${index + 1}`)
      .trim()
      .replace(/\s+/g, "_")
      .toLowerCase(),
    title: String(segment.title ?? `Segment ${index + 1}`).trim(),
    prompt: String(segment.prompt ?? "").trim(),
    required: segment.required !== false
  }));
}

export function buildVideoGenerationScript(draft) {
  if (draft.mode === "segmented_video") {
    return {
      segments: normalizeDraftSegments(draft.segments)
    };
  }

  return {
    prompt: draft.prompt.trim(),
    thumbnail: draft.thumbnailLabel.trim() || "Auto placeholder thumbnail"
  };
}

export function getSegmentClipUploads(draft) {
  if (draft.mode !== "segmented_video") {
    return [];
  }

  const normalizedSegments = normalizeDraftSegments(draft.segments);
  return (draft.segments ?? [])
    .map((segment, index) => ({
      ...normalizedSegments[index],
      draftIndex: index,
      file: segment.clipFile ?? null
    }))
    .filter((segment) => segment.file);
}

export function buildContentJobPayload(draft, actor = {}) {
  const mode = getIntakeMode(draft.mode);
  const trimmedTitle = draft.title.trim();
  const prompt = draft.prompt.trim();
  const youtubeUrl = draft.youtubeUrl.trim();
  const normalizedSegments = normalizeDraftSegments(draft.segments);
  const title = trimmedTitle || prompt.slice(0, 80) || draft.videoFile?.name || normalizedSegments[0]?.title || "Untitled video";
  const targetDurationSec = Number(draft.targetDurationSec) || 180;

  const baseMetadata = {
    intakeMode: mode.id,
    intakeModeLabel: mode.label,
    targetDurationSec,
    owner: actor.email ?? actor.displayName ?? actor.uid ?? "Unknown operator",
    risk: "low"
  };

  if (mode.id === "video_upload") {
    return {
      title,
      type: "video_job",
      sourceType: mode.sourceType,
      status: mode.reviewStatus,
      targetDurationSec,
      metadata: {
        ...baseMetadata,
        fileName: draft.videoFile?.name ?? null,
        sourceArtifact: draft.videoFile?.name ?? "Local video upload",
        provider: "Local upload",
        stage: "Awaiting review",
        videoStatus: "ready"
      }
    };
  }

  if (mode.id === "youtube_embed") {
    return {
      title,
      type: "video_job",
      sourceType: mode.sourceType,
      status: mode.reviewStatus,
      targetDurationSec,
      metadata: {
        ...baseMetadata,
        youtubeUrl,
        sourceArtifact: youtubeUrl,
        provider: "YouTube",
        stage: "Awaiting review",
        videoStatus: "ready"
      }
    };
  }

  if (mode.id === "segmented_video") {
    const scriptPreview = normalizedSegments.map((segment) => segment.prompt || segment.title);
    return {
      title,
      type: "video_job",
      sourceType: mode.sourceType,
      status: mode.reviewStatus,
      targetDurationSec,
      metadata: {
        ...baseMetadata,
        prompt: scriptPreview.join("\n\n"),
        sourceArtifact: "Segmented timeline",
        thumbnailLabel: draft.thumbnailLabel.trim() || "Auto placeholder thumbnail",
        provider: "HeyGen",
        stage: "Segmented video assembly queued",
        scriptPreview,
        scriptQuality: "Ready for segmented render",
        scenes: normalizedSegments.length,
        assemblyMode: "segmented_hybrid",
        videoSegments: normalizedSegments
      }
    };
  }

  return {
    title,
    type: "video_job",
    sourceType: mode.sourceType,
    status: mode.reviewStatus,
    targetDurationSec,
    metadata: {
      ...baseMetadata,
      prompt,
      sourceArtifact: "Text prompt",
      thumbnailLabel: draft.thumbnailLabel.trim() || "Auto placeholder thumbnail",
      provider: "HeyGen",
      stage: "HeyGen generation queued",
      scriptPreview: [prompt],
      scriptQuality: "Ready for render",
      scenes: 1
    }
  };
}

export function validateContentDraft(draft) {
  const mode = getIntakeMode(draft.mode);
  if (mode.id === "video_upload" && !draft.videoFile) {
    return "Choose a video file before creating the review job.";
  }
  if (mode.id === "youtube_embed" && !draft.youtubeUrl.trim()) {
    return "Paste a YouTube video URL before creating the review job.";
  }
  if (mode.id === "text_to_heygen" && !draft.prompt.trim()) {
    return "Enter the video prompt before requesting HeyGen generation.";
  }
  if (mode.id === "segmented_video") {
    const segments = normalizeDraftSegments(draft.segments);
    if (segments.length === 0) {
      return "Add at least one timeline segment before creating the video assembly job.";
    }

    const sequences = new Set();
    const segmentKeys = new Set();
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const original = draft.segments[index] ?? {};
      if (!segment.title) {
        return `Enter a title for segment ${index + 1}.`;
      }
      if (!segment.segmentKey) {
        return `Enter a segment key for ${segment.title}.`;
      }
      if (sequences.has(segment.sequence)) {
        return `Segment sequence ${segment.sequence} is duplicated.`;
      }
      if (segmentKeys.has(segment.segmentKey)) {
        return `Segment key ${segment.segmentKey} is duplicated.`;
      }
      if (!segment.prompt && !original.clipFile) {
        return `Add a prompt or upload a clip for segment ${segment.sequence}.`;
      }
      sequences.add(segment.sequence);
      segmentKeys.add(segment.segmentKey);
    }
  }
  return null;
}

export function mergeJob(current, update) {
  return {
    ...current,
    ...update,
    metadata: {
      ...current.metadata,
      ...update.metadata
    },
    video: {
      ...current.video,
      ...update.video
    },
    script: {
      ...current.script,
      ...update.script
    }
  };
}

export function normalizePathname(pathname) {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized.toLowerCase();
}

export function getViewFromLocation() {
  return viewByRoute.get(normalizePathname(window.location.pathname)) ?? "Dashboard";
}

export function updateBrowserRoute(view, replace = false) {
  const path = routeByView[view] ?? "/";
  if (window.location.pathname === path) {
    return;
  }
  const method = replace ? "replaceState" : "pushState";
  window.history[method]({}, "", path);
}

export function platformIdFromLabel(platform) {
  const normalized = String(platform ?? "").toLowerCase();
  if (normalized === "x" || normalized === "twitter") return "x";
  return normalized;
}

export function platformLabel(label) {
  return label === "X" ? "X / Twitter" : label;
}
