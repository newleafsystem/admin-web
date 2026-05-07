import React, { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  approveJob,
  approvePublishPlan,
  createContentJob,
  createPublishPlan,
  createServiceClient,
  deleteUser,
  deleteJobPublications,
  deletePublication,
  deleteReviewJob,
  deleteSocialAccount,
  fetchJobs,
  fetchOperationsSnapshot,
  fetchPublishPlans,
  fetchPublications,
  fetchUsers,
  generateJobScript,
  generateJobThumbnail,
  generateVideoSummary,
  generateYouTubeTags,
  hypePublication,
  importPlatformPublications,
  pollHeyGenProviderJob,
  reconnectSocialAccount,
  regenerateJobVideo,
  revokeServiceClient,
  requestVideoGeneration,
  publishPlan,
  rotateServiceClient,
  retryPublishAttempt,
  startSocialOAuth,
  updateContentJob,
  updateUserRole,
  updatePublication,
  uploadLocalVideo,
  uploadJobThumbnail,
  uploadVideoAssemblySegment
} from "./api.js";
import {
  initialContentDraft,
  initialPublishDraft,
  intakeModes,
  navItems,
  routeByView,
  socialPlatforms
} from "./constants.js";
import {
  addAuditEvent,
  buildContentJobPayload,
  buildPublicationDrafts,
  buildVideoGenerationScript,
  buildUnavailablePublishMap,
  getSegmentClipUploads,
  getIntegratedPlatforms,
  getPlatformConfig,
  getRemainingPublishPlatforms,
  getViewFromLocation,
  hasActivePublishingWork,
  isArchivedContentQueueJob,
  isArchivedPublishPlan,
  isReviewableJob,
  mergeJob,
  updateBrowserRoute,
  validateContentDraft
} from "./utils.js";
import { LeafLoader } from "./components/LeafLoader.jsx";

const AuditLog = lazy(() => import("./sections/AuditLog.jsx").then((module) => ({ default: module.AuditLog })));
const ConnectedAccounts = lazy(() =>
  import("./sections/ConnectedAccounts.jsx").then((module) => ({ default: module.ConnectedAccounts }))
);
const ContentQueue = lazy(() =>
  import("./sections/ContentQueue.jsx").then((module) => ({ default: module.ContentQueue }))
);
const CreateContent = lazy(() =>
  import("./sections/CreateContent.jsx").then((module) => ({ default: module.CreateContent }))
);
const Dashboard = lazy(() =>
  import("./sections/Dashboard.jsx").then((module) => ({ default: module.Dashboard }))
);
const PublishedVideos = lazy(() =>
  import("./sections/PublishedVideos.jsx").then((module) => ({ default: module.PublishedVideos }))
);
const Users = lazy(() =>
  import("./sections/Users.jsx").then((module) => ({ default: module.Users }))
);
const ReviewWorkspace = lazy(() =>
  import("./sections/ReviewWorkspace.jsx").then((module) => ({ default: module.ReviewWorkspace }))
);
const Vendors = lazy(() =>
  import("./sections/Vendors.jsx").then((module) => ({ default: module.Vendors }))
);
const VideoStudio = lazy(() =>
  import("./sections/VideoStudio.jsx").then((module) => ({ default: module.VideoStudio }))
);

export default function App({ session }) {
  const [activeView, setActiveViewState] = useState(getViewFromLocation);
  const [jobs, setJobs] = useState([]);
  const [publishPlans, setPublishPlans] = useState([]);
  const [publications, setPublications] = useState([]);
  const [serviceClients, setServiceClients] = useState([]);
  const [users, setUsers] = useState([]);
  const [publicationDrafts, setPublicationDrafts] = useState({});
  const [connectedAccounts, setConnectedAccounts] = useState([]);
  const [auditEvents, setAuditEvents] = useState([]);
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [sectionLoaders, setSectionLoaders] = useState({});
  const [contentDraft, setContentDraft] = useState(initialContentDraft);
  const [publishDraft, setPublishDraft] = useState(initialPublishDraft);
  const [summaryWorkflow, setSummaryWorkflow] = useState({ jobId: null, isGenerating: false, error: null });
  const [publicationImportWorkflow, setPublicationImportWorkflow] = useState({
    platform: null,
    isImporting: false,
    error: null
  });
  const [vendorCredentialResult, setVendorCredentialResult] = useState(null);
  const [accountWorkflow, setAccountWorkflow] = useState({
    isOpen: false,
    platform: "youtube",
    accountName: socialPlatforms[0].defaultAccountName,
    error: null,
    isSubmitting: false
  });

  function setActiveView(view, options = {}) {
    const nextView = routeByView[view] ? view : "Dashboard";
    clearTransientErrors();
    updateBrowserRoute(nextView, options.replace);
    setActiveViewState(nextView);
  }

  function clearTransientErrors() {
    setActionError(null);
    setPublicationImportWorkflow((current) => ({ ...current, error: null }));
    setSummaryWorkflow((current) => ({ ...current, error: null }));
    setContentDraft((current) => ({ ...current, error: null }));
    setPublishDraft((current) => ({ ...current, error: null }));
    setAccountWorkflow((current) => ({ ...current, error: null }));
    setVendorCredentialResult(null);
  }

  function setSectionLoading(view, label) {
    setSectionLoaders((current) => ({
      ...current,
      [view]: label
    }));
  }

  function clearSectionLoading(view) {
    setSectionLoaders((current) => {
      const next = { ...current };
      delete next[view];
      return next;
    });
  }

  async function withSectionLoader(view, label, task) {
    setSectionLoading(view, label);
    try {
      return await task();
    } finally {
      clearSectionLoading(view);
    }
  }

  useEffect(() => {
    let isMounted = true;

    fetchOperationsSnapshot()
      .then((snapshot) => {
        if (!isMounted) {
          return;
        }

        const snapshotContentQueueJobs = snapshot.jobs.filter(
          (job) => !isArchivedContentQueueJob(job, {
            publishPlans: snapshot.publishPlans,
            publications: snapshot.publications
          })
        );

        setJobs(snapshot.jobs);
        setPublishPlans(snapshot.publishPlans);
        setPublications(snapshot.publications);
        setServiceClients(snapshot.serviceClients);
        setUsers(snapshot.users);
        setPublicationDrafts(buildPublicationDrafts(snapshot.publications));
        setConnectedAccounts(snapshot.connectedAccounts);
        setAuditEvents(snapshot.auditEvents);
        setSelectedJobId(snapshotContentQueueJobs[0]?.id ?? snapshot.jobs[0]?.id ?? null);
        setPublishDraft((current) => {
          const jobId =
            current.jobId ||
            snapshotContentQueueJobs.find((job) => ["approved", "partial_failed", "publishing"].includes(job.status))?.id ||
            snapshotContentQueueJobs[0]?.id ||
            "";
          return {
            ...current,
            ...hydratePublishDraftForJobChange(current, { jobId }, snapshotContentQueueJobs)
          };
        });
        setIsLoading(false);
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }

        setLoadError(error);
        setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      clearTransientErrors();
      setActiveViewState(getViewFromLocation());
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const shouldPoll = !isLoading && hasActivePublishingWork({ publishPlans, publications });
    if (!shouldPoll) {
      return undefined;
    }

    let isMounted = true;
    const refreshPublishingState = async () => {
      try {
        const [nextJobs, nextPublishPlans, nextPublications] = await Promise.all([
          fetchJobs(),
          fetchPublishPlans(),
          fetchPublications()
        ]);
        if (!isMounted) {
          return;
        }
        setJobs(nextJobs);
        setPublishPlans(nextPublishPlans);
        setPublications(nextPublications);
        setPublicationDrafts((current) => ({
          ...buildPublicationDrafts(nextPublications),
          ...Object.fromEntries(
            Object.entries(current).filter(([, draft]) => draft.isSaving || draft.error)
          )
        }));
      } catch (error) {
        if (isMounted) {
          setActionError(error.message);
        }
      }
    };

    const intervalId = window.setInterval(refreshPublishingState, 2500);
    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, [isLoading, publishPlans, publications]);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? jobs[0],
    [jobs, selectedJobId]
  );
  const contentQueueJobs = useMemo(
    () => jobs.filter((job) => !isArchivedContentQueueJob(job, { publishPlans, publications })),
    [jobs, publishPlans, publications]
  );
  const selectedContentQueueJob = useMemo(
    () => contentQueueJobs.find((job) => job.id === selectedJobId) ?? contentQueueJobs[0] ?? null,
    [contentQueueJobs, selectedJobId]
  );
  const reviewableJobs = useMemo(() => jobs.filter(isReviewableJob), [jobs]);
  const selectedReviewJob = useMemo(() => {
    if (isReviewableJob(selectedJob)) {
      return selectedJob;
    }
    return reviewableJobs[0] ?? null;
  }, [reviewableJobs, selectedJob]);

  const filteredJobs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return contentQueueJobs.filter((job) => {
      const matchesStatus = statusFilter === "all" || job.status === statusFilter;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [job.title, job.owner, job.topic, job.sourceArtifact]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);

      return matchesStatus && matchesQuery;
    });
  }, [contentQueueJobs, query, statusFilter]);

  const metrics = useMemo(() => {
    const activePublishPlans = publishPlans.filter((plan) => !isArchivedPublishPlan(plan));
    const failedAttempts = activePublishPlans.flatMap((plan) =>
      plan.attempts.filter((attempt) => attempt.status === "failed")
    ).length;
    const activeAttempts = activePublishPlans.flatMap((plan) =>
      plan.attempts.filter((attempt) => ["queued", "retrying"].includes(attempt.status))
    ).length;

    return [
      {
        label: "Waiting review",
        value: jobs.filter((job) => job.status === "review_required").length,
        tone: "amber"
      },
      {
        label: "Ready to publish",
        value: jobs.filter((job) => job.status === "approved").length,
        tone: "green"
      },
      {
        label: "Publishing active",
        value: activePublishPlans.filter((plan) => plan.status === "publishing").length + activeAttempts,
        tone: "blue"
      },
      {
        label: "Failed attempts",
        value: failedAttempts,
        tone: failedAttempts > 0 ? "red" : "green"
      }
    ];
  }, [jobs, publishPlans]);

  function updateContentDraft(patch) {
    setContentDraft((current) => ({
      ...current,
      ...patch,
      error: null,
      message: null
    }));
  }

  async function submitContentDraft(event) {
    event.preventDefault();
    const validationError = validateContentDraft(contentDraft);
    if (validationError) {
      setContentDraft((current) => ({ ...current, error: validationError, message: null }));
      return;
    }

    setContentDraft((current) => ({ ...current, isSubmitting: true, error: null, message: null }));
    setActionError(null);
    setSectionLoading("Create Content", "Preparing video...");

    try {
      const createdJob = await createContentJob(buildContentJobPayload(contentDraft, session?.user));
      let nextView = "Review";

      if (contentDraft.mode === "video_upload" && contentDraft.videoFile) {
        setSectionLoading("Create Content", "Uploading video for review...");
        await uploadLocalVideo(createdJob.id, contentDraft.videoFile);
      }

      if (contentDraft.mode === "text_to_heygen" || contentDraft.mode === "segmented_video") {
        setSectionLoading("Create Content", "Requesting HeyGen video...");
        const generatedJob = await requestVideoGeneration(createdJob.id, buildVideoGenerationScript(contentDraft));
        if (contentDraft.mode === "segmented_video") {
          setSectionLoading("Create Content", "Uploading segment clips...");
          await uploadInitialSegmentClips(createdJob.id, generatedJob.providerJobs, getSegmentClipUploads(contentDraft));
        }
        nextView = "Content Queue";
      }

      clearSectionLoading("Create Content");
      const refreshedJobs = await withSectionLoader("Content Queue", "Refreshing content queue...", fetchJobs);
      setJobs(refreshedJobs);
      setSelectedJobId(createdJob.id);
      setPublishDraft((current) => ({ ...current, jobId: createdJob.id }));
      setAuditEvents((current) =>
        addAuditEvent(current, "create_content_job", createdJob.id, currentActor(session), {
          title: createdJob.title,
          mode: contentDraft.mode,
          sourceType: createdJob.sourceType
        })
      );
      setContentDraft({
        ...initialContentDraft,
        message: `${createdJob.title} is ready for the next step.`
      });
      setActiveView(nextView);
    } catch (error) {
      setContentDraft((current) => ({
        ...current,
        isSubmitting: false,
        error: error.message,
        message: null
      }));
    } finally {
      clearSectionLoading("Create Content");
    }
  }

  async function uploadInitialSegmentClips(jobId, providerJobs, segmentUploads) {
    for (const segment of segmentUploads) {
      const providerJob = findProviderJobForSegment(providerJobs, segment);
      if (!providerJob?.externalId) {
        throw new Error(`Unable to find provider segment for ${segment.segmentKey}.`);
      }
      await uploadVideoAssemblySegment(jobId, providerJob.externalId, segment.file);
    }
  }

  async function uploadAssemblySegmentClip(jobId, heygenVideoId, file, options = {}) {
    setActionError(null);
    try {
      await uploadVideoAssemblySegment(jobId, heygenVideoId, file);
      const refreshedJobs = await withSectionLoader("Content Queue", "Refreshing content queue...", fetchJobs);
      setJobs(refreshedJobs);
      setSelectedJobId(jobId);
      setAuditEvents((current) =>
        addAuditEvent(current, "upload_video_segment", jobId, currentActor(session), {
          jobId,
          heygenVideoId,
          filename: file.name,
          sizeBytes: file.size
        })
      );
    } catch (error) {
      setActionError(error.message);
      if (options.throwOnError) {
        throw error;
      }
    }
  }

  async function uploadThumbnail(jobId, file) {
    setActionError(null);
    try {
      const result = await uploadJobThumbnail(jobId, file);
      setJobs((current) =>
        current.map((job) => (job.id === jobId ? mergeJob(job, result.job) : job))
      );
      setSelectedJobId(jobId);
      setAuditEvents((current) =>
        addAuditEvent(current, "upload_thumbnail", jobId, currentActor(session), {
          jobId,
          artifactId: result.artifact?.id ?? null,
          filename: file.name,
          sizeBytes: file.size
        })
      );
      return result.job;
    } catch (error) {
      setActionError(error.message);
      throw error;
    }
  }

  async function generateThumbnail(jobId, atSeconds = 2) {
    setActionError(null);
    try {
      const result = await generateJobThumbnail(jobId, atSeconds);
      setJobs((current) =>
        current.map((job) => (job.id === jobId ? mergeJob(job, result.job) : job))
      );
      setSelectedJobId(jobId);
      setAuditEvents((current) =>
        addAuditEvent(current, "generate_thumbnail", jobId, currentActor(session), {
          jobId,
          artifactId: result.artifact?.id ?? null,
          atSeconds
        })
      );
      return result.job;
    } catch (error) {
      setActionError(error.message);
      throw error;
    }
  }

  async function pollAssemblySegment(jobId, providerJobId) {
    setActionError(null);
    try {
      const result = await pollHeyGenProviderJob(jobId, providerJobId);
      const refreshedJobs = await withSectionLoader("Content Queue", "Refreshing content queue...", fetchJobs);
      setJobs(refreshedJobs);
      setSelectedJobId(jobId);
      setAuditEvents((current) =>
        addAuditEvent(current, "poll_heygen_segment", jobId, currentActor(session), {
          jobId,
          providerJobId,
          action: result.action,
          status: result.pollResult?.status ?? result.pollResult?.terminalStatus ?? null
        })
      );
    } catch (error) {
      setActionError(error.message);
      throw error;
    }
  }

  async function approveSelectedJob(jobId = selectedJob?.id) {
    const targetJob = jobs.find((job) => job.id === jobId) ?? selectedJob;
    if (!targetJob) {
      return;
    }

    setActionError(null);
    try {
      const updatedJob = await approveJob(targetJob.id);
      setJobs((current) =>
        current.map((job) => (job.id === targetJob.id ? mergeJob(job, updatedJob) : job))
      );
      setPublishDraft((current) => ({ ...current, jobId: targetJob.id }));
      setAuditEvents((current) =>
        addAuditEvent(current, "approve_job", targetJob.id, currentActor(session), {
          title: targetJob.title,
          previousStatus: targetJob.status,
          nextStatus: updatedJob.status
        })
      );
      setActiveView("Content Queue");
    } catch (error) {
      setActionError(error.message);
    }
  }

  async function requestReviewJobDelete(jobId = selectedJob?.id) {
    const targetJob = jobs.find((job) => job.id === jobId) ?? selectedJob;
    if (!targetJob) {
      return;
    }

    setActionError(null);
    try {
      const result = await deleteReviewJob(targetJob.id, "admin_deleted_review");
      const nextJobs = jobs.filter((job) => job.id !== targetJob.id);
      const nextReviewableJobs = nextJobs.filter(isReviewableJob);
      setJobs(nextJobs);
      setSelectedJobId(nextReviewableJobs[0]?.id ?? nextJobs[0]?.id ?? null);
      setAuditEvents((current) =>
        addAuditEvent(current, "delete_review_job", targetJob.id, currentActor(session), {
          title: targetJob.title,
          status: targetJob.status,
          sourceType: targetJob.sourceType,
          artifactCount: result.artifactCount,
          providerJobCount: result.providerJobCount,
          publishPlanCount: result.publishPlanCount,
          publishAttemptCount: result.publishAttemptCount,
          reason: "admin_deleted_review"
        })
      );
    } catch (error) {
      setActionError(error.message);
      throw error;
    }
  }

  async function saveReviewScript(jobId = selectedJob?.id, scriptText = "") {
    const targetJob = jobs.find((job) => job.id === jobId) ?? selectedJob;
    if (!targetJob) {
      throw new Error("Select a review video before saving the script.");
    }

    const normalizedScript = String(scriptText ?? "").trim();
    if (!normalizedScript) {
      throw new Error("Script cannot be empty.");
    }

    const scriptPreview = splitReviewScript(normalizedScript);
    const metadata = {
      ...(targetJob.metadata ?? {}),
      prompt: normalizedScript,
      reviewScriptText: normalizedScript,
      scriptPreview,
      scenes: scriptPreview.length,
      scriptQuality: "Edited by reviewer",
      stage: "Script edited for regeneration"
    };

    setActionError(null);
    try {
      const updatedJob = await updateContentJob(targetJob.id, { metadata });
      setJobs((current) =>
        current.map((job) => (job.id === targetJob.id ? mergeJob(job, updatedJob) : job))
      );
      setAuditEvents((current) =>
        addAuditEvent(current, "edit_review_script", targetJob.id, currentActor(session), {
          title: targetJob.title,
          previousPreviewCount: targetJob.script.preview.length,
          nextPreviewCount: scriptPreview.length
        })
      );
      return updatedJob;
    } catch (error) {
      setActionError(error.message);
      throw error;
    }
  }

  async function requestRegeneration(scope, jobId = selectedJob?.id, options = {}) {
    const targetJob = jobs.find((job) => job.id === jobId) ?? selectedJob;
    if (!targetJob) {
      return;
    }

    setActionError(null);
    try {
      const editedScriptText = String(options.scriptText ?? targetJob.metadata?.reviewScriptText ?? "").trim();
      const videoScript = buildRegenerationVideoScript(targetJob, editedScriptText);
      const updatedJob =
        scope === "video"
          ? await regenerateJobVideo(targetJob.id, videoScript)
          : await generateJobScript(targetJob.id);
      setJobs((current) =>
        current.map((job) => (job.id === targetJob.id ? mergeJob(job, updatedJob) : job))
      );
      setAuditEvents((current) =>
        addAuditEvent(current, `regenerate_${scope}`, targetJob.id, currentActor(session), {
          title: targetJob.title,
          scope,
          nextStatus: updatedJob.status,
          source: scope === "video" && editedScriptText ? "edited_review_script" : "stored_job_metadata"
        })
      );
    } catch (error) {
      setActionError(error.message);
      throw error;
    }
  }

  async function generateSelectedSummary(jobId = selectedJob?.id) {
    const targetJob = jobs.find((job) => job.id === jobId) ?? selectedJob;
    if (!targetJob) {
      return;
    }

    setActionError(null);
    setSummaryWorkflow({ jobId: targetJob.id, isGenerating: true, error: null });
    try {
      const result = await generateVideoSummary(targetJob.id);
      setJobs((current) =>
        current.map((job) => (job.id === targetJob.id ? mergeJob(job, result.job) : job))
      );
      setSummaryWorkflow({ jobId: targetJob.id, isGenerating: false, error: null });
      setAuditEvents((current) =>
        addAuditEvent(current, "generate_review_summary", targetJob.id, currentActor(session), {
          title: targetJob.title,
          provider: result.summary?.provider ?? result.summary?.model ?? "configured AI provider"
        })
      );
    } catch (error) {
      setSummaryWorkflow({ jobId: targetJob.id, isGenerating: false, error: error.message });
    }
  }

  async function retryAttempt(planId, attempt) {
    if (!attempt?.id) {
      return;
    }

    setActionError(null);
    try {
      await retryPublishAttempt(attempt.id);
      setPublishPlans(await withSectionLoader("Content Queue", "Refreshing publish attempts...", fetchPublishPlans));
      setAuditEvents((current) =>
        addAuditEvent(current, "retry_publish_attempt", `${planId}/${attempt.platform}`, currentActor(session), {
          planId,
          platform: attempt.platform,
          attemptId: attempt.id,
          previousStatus: attempt.status
        })
      );
    } catch (error) {
      setActionError(error.message);
    }
  }

  function updatePublishDraft(patch) {
    setPublishDraft((current) => ({
      ...current,
      ...hydratePublishDraftForJobChange(current, patch, jobs),
      error: null
    }));
  }

  function togglePublishPlatform(platformId) {
    setPublishDraft((current) => {
      const hasPlatform = current.platforms.includes(platformId);
      const platforms = hasPlatform
        ? current.platforms.filter((candidate) => candidate !== platformId)
        : [...current.platforms, platformId];
      return {
        ...current,
        platforms,
        error: null
      };
    });
  }

  async function submitPublishDraft(event) {
    event.preventDefault();
    if (!publishDraft.jobId) {
      setPublishDraft((current) => ({ ...current, error: "Select an approved video before publishing." }));
      return;
    }
    if (publishDraft.platforms.length === 0) {
      setPublishDraft((current) => ({ ...current, error: "Select at least one platform." }));
      return;
    }
    const publishTitle = publishDraft.title.trim();
    const publishDescription = publishDraft.description.trim();
    if (!publishTitle) {
      setPublishDraft((current) => ({ ...current, error: "Enter a title before publishing." }));
      return;
    }
    if (!publishDescription) {
      setPublishDraft((current) => ({ ...current, error: "Enter a description before publishing." }));
      return;
    }

    const job = jobs.find((candidate) => candidate.id === publishDraft.jobId);
    const integratedPlatforms = getIntegratedPlatforms(connectedAccounts, socialPlatforms);
    const unavailableByJob = buildUnavailablePublishMap({ publishPlans, publications });
    const remainingPlatformIds = new Set(
      getRemainingPublishPlatforms(publishDraft.jobId, integratedPlatforms, unavailableByJob).map((platform) => platform.id)
    );
    const platforms = publishDraft.platforms.filter((platform) => remainingPlatformIds.has(platform));
    if (integratedPlatforms.length === 0) {
      setPublishDraft((current) => ({ ...current, error: "Connect at least one publishing account first." }));
      return;
    }
    if (platforms.length === 0) {
      setPublishDraft((current) => ({
        ...current,
        error: "This video has no remaining connected channels available for publishing."
      }));
      return;
    }

    setPublishDraft((current) => ({ ...current, isSubmitting: true, error: null }));
    setActionError(null);
    try {
      const plan = await withSectionLoader("Content Queue", "Preparing publishing...", () => createPublishPlan({
        jobId: publishDraft.jobId,
        platforms,
        scheduledAt: publishDraft.scheduledAt || null,
        metadata: {
          title: publishTitle,
          description: publishDescription,
          hashtags: parseDelimitedTags(publishDraft.hashtagsText),
          tags: parseDelimitedTags(publishDraft.youtubeTagsText),
          thumbnailArtifactId: job?.thumbnail?.artifactId ?? null,
          thumbnailUrl: job?.thumbnail?.url ?? null,
          thumbnailSource: job?.thumbnail?.source ?? null
        }
      }));
      await withSectionLoader("Content Queue", "Approving publishing...", () => approvePublishPlan(plan.id));
      const shouldPublishNow = !isFutureSchedule(publishDraft.scheduledAt);
      let publishResult = null;
      if (shouldPublishNow) {
        publishResult = await withSectionLoader("Content Queue", "Publishing to selected channels...", () =>
          publishPlan(plan.id)
        );
      }
      setPublishPlans(await withSectionLoader("Content Queue", "Refreshing publishing state...", fetchPublishPlans));
      setJobs(await withSectionLoader("Content Queue", "Refreshing video queue...", fetchJobs));
      const refreshedPublications = await withSectionLoader(
        "Published Videos",
        "Refreshing published videos...",
        fetchPublications
      );
      setPublications(refreshedPublications);
      setPublicationDrafts(buildPublicationDrafts(refreshedPublications));
      setPublishDraft((current) => ({
        ...initialPublishDraft,
        jobId: "",
        platforms: integratedPlatforms.length === 1 ? [integratedPlatforms[0].id] : []
      }));
      setAuditEvents((current) =>
        addAuditEvent(current, shouldPublishNow ? "publish_video" : "schedule_publish", publishDraft.jobId, currentActor(session), {
          title: publishTitle,
          platforms,
          scheduledAt: publishDraft.scheduledAt || "Not scheduled",
          hashtags: parseDelimitedTags(publishDraft.hashtagsText),
          tags: parseDelimitedTags(publishDraft.youtubeTagsText),
          planId: plan.id,
          attempts: publishResult?.attempts?.length ?? 0
        })
      );
    } catch (error) {
      setPublishDraft((current) => ({
        ...current,
        isSubmitting: false,
        error: error.message
      }));
    }
  }

  async function requestYouTubeTagGeneration() {
    if (!publishDraft.jobId) {
      setPublishDraft((current) => ({ ...current, error: "Select a video before generating YouTube tags." }));
      return;
    }
    const title = publishDraft.title.trim();
    const description = publishDraft.description.trim();
    if (!title || !description) {
      setPublishDraft((current) => ({
        ...current,
        error: "Enter title and description before generating YouTube tags."
      }));
      return;
    }

    setPublishDraft((current) => ({ ...current, isGeneratingYoutubeTags: true, error: null }));
    setActionError(null);
    try {
      const result = await generateYouTubeTags(publishDraft.jobId, {
        title,
        description,
        hashtags: parseDelimitedTags(publishDraft.hashtagsText)
      });
      setPublishDraft((current) => ({
        ...current,
        youtubeTagsText: result.tags.join(", "),
        isGeneratingYoutubeTags: false,
        error: null
      }));
      setAuditEvents((current) =>
        addAuditEvent(current, "generate_youtube_tags", publishDraft.jobId, currentActor(session), {
          title,
          generatedTags: result.tags,
          model: result.model,
          provider: result.provider
        })
      );
    } catch (error) {
      setPublishDraft((current) => ({
        ...current,
        isGeneratingYoutubeTags: false,
        error: error.message
      }));
    }
  }

  async function approveAndPublishPlan(planId) {
    setActionError(null);
    try {
      await withSectionLoader("Content Queue", "Approving publishing...", () => approvePublishPlan(planId));
      const result = await withSectionLoader("Content Queue", "Publishing to selected channels...", () => publishPlan(planId));
      setPublishPlans(await withSectionLoader("Content Queue", "Refreshing publishing state...", fetchPublishPlans));
      setJobs(await withSectionLoader("Content Queue", "Refreshing video queue...", fetchJobs));
      const refreshedPublications = await withSectionLoader(
        "Published Videos",
        "Refreshing published videos...",
        fetchPublications
      );
      setPublications(refreshedPublications);
      setPublicationDrafts(buildPublicationDrafts(refreshedPublications));
      setAuditEvents((current) =>
        addAuditEvent(current, "approve_and_publish", planId, currentActor(session), {
          planId,
          status: result.plan.status,
          attempts: result.attempts.length
        })
      );
    } catch (error) {
      setActionError(error.message);
    }
  }

  async function startPublishing(planId) {
    setActionError(null);
    try {
      const result = await withSectionLoader("Content Queue", "Starting publishing...", () => publishPlan(planId));
      setPublishPlans(await withSectionLoader("Content Queue", "Refreshing publishing state...", fetchPublishPlans));
      setJobs(await withSectionLoader("Content Queue", "Refreshing video queue...", fetchJobs));
      const refreshedPublications = await withSectionLoader(
        "Published Videos",
        "Refreshing published videos...",
        fetchPublications
      );
      setPublications(refreshedPublications);
      setPublicationDrafts(buildPublicationDrafts(refreshedPublications));
      setAuditEvents((current) =>
        addAuditEvent(current, "publish_plan", planId, currentActor(session), {
          planId,
          status: result.plan.status,
          attempts: result.attempts.map((attempt) => ({
            id: attempt.id,
            platform: attempt.platform,
            status: attempt.status,
            connectedAccountId: attempt.connectedAccountId
          }))
        })
      );
    } catch (error) {
      setActionError(error.message);
    }
  }

  function updatePublicationDraft(publicationId, patch) {
    setPublicationDrafts((current) => ({
      ...current,
      [publicationId]: {
        ...current[publicationId],
        ...patch,
        error: null
      }
    }));
  }

  function applyPublicationUpdate(updatedPublication) {
    setPublications((current) =>
      current.map((publication) =>
        publication.id === updatedPublication.id ? updatedPublication : publication
      )
    );
    setPublicationDrafts((current) => ({
      ...current,
      [updatedPublication.id]: {
        title: updatedPublication.title,
        description: updatedPublication.description,
        privacyStatus: updatedPublication.privacyStatus,
        tagsText: updatedPublication.tags.join(", "),
        hashtagsText: updatedPublication.hashtags.join(", "),
        isSaving: false,
        error: null
      }
    }));
  }

  async function savePublication(publicationId, overrides = null) {
    const draft = publicationDrafts[publicationId];
    if (!draft && !overrides) return;
    updatePublicationDraft(publicationId, { isSaving: true });
    setActionError(null);
    let auditFields = [];
    try {
      const updated = await withSectionLoader("Published Videos", "Saving publication metadata...", async () => {
        const payload =
          overrides ?? {
            title: draft.title,
            description: draft.description,
            tags: draft.tagsText
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean),
            hashtags: parseDelimitedTags(draft.hashtagsText)
          };
        if (!overrides && draft.privacyStatus && draft.privacyStatus !== "unknown") {
          payload.privacyStatus = draft.privacyStatus;
        }
        auditFields = Object.keys(payload);
        return updatePublication(publicationId, payload);
      });
      applyPublicationUpdate(updated);
      setAuditEvents((current) =>
        addAuditEvent(current, "update_publication", publicationId, currentActor(session), {
          publicationId,
          updatedFields: auditFields,
          platform: updated.platform,
          status: updated.status
        })
      );
      return updated;
    } catch (error) {
      updatePublicationDraft(publicationId, { isSaving: false, error: error.message });
      throw error;
    }
  }

  async function requestPublicationRepublish(publication, payload) {
    if (!publication?.id || !publication.jobId) {
      throw new Error("Select a YouTube publication before republishing.");
    }
    const platforms = Array.from(new Set((payload.platforms ?? []).map((platform) => String(platform).toLowerCase())));
    if (platforms.length === 0) {
      throw new Error("Select at least one republish destination.");
    }
    const title = String(payload.title ?? "").trim();
    const description = String(payload.description ?? "").trim();
    if (!title || !description) {
      throw new Error("Enter a title and description before republishing.");
    }

    setActionError(null);
    const metadata = {
      title,
      description,
      tags: payload.tags ?? [],
      hashtags: payload.hashtags ?? []
    };
    if (payload.privacyStatus && payload.privacyStatus !== "unknown") {
      metadata.privacyStatus = payload.privacyStatus;
    }

    const plan = await withSectionLoader("Published Videos", "Preparing republish...", () =>
      createPublishPlan({
        jobId: publication.jobId,
        platforms,
        scheduledAt: payload.scheduledAt || null,
        republishOfPublicationId: publication.id,
        metadata
      })
    );
    await withSectionLoader("Published Videos", "Approving republish...", () => approvePublishPlan(plan.id));
    const shouldPublishNow = !isFutureSchedule(payload.scheduledAt);
    let publishResult = null;
    if (shouldPublishNow) {
      publishResult = await withSectionLoader("Published Videos", "Publishing to selected channels...", () =>
        publishPlan(plan.id)
      );
    }
    setPublishPlans(await withSectionLoader("Published Videos", "Refreshing publishing state...", fetchPublishPlans));
    setJobs(await withSectionLoader("Published Videos", "Refreshing video queue...", fetchJobs));
    const refreshedPublications = await withSectionLoader(
      "Published Videos",
      "Refreshing published videos...",
      fetchPublications
    );
    setPublications(refreshedPublications);
    setPublicationDrafts(buildPublicationDrafts(refreshedPublications));
    setAuditEvents((current) =>
      addAuditEvent(current, shouldPublishNow ? "republish_video" : "schedule_republish", publication.id, currentActor(session), {
        title,
        platforms,
        scheduledAt: payload.scheduledAt || "Not scheduled",
        sourcePlatform: publication.platform,
        sourceProviderPostId: publication.providerPostId ?? null,
        planId: plan.id,
        attempts: publishResult?.attempts?.length ?? 0
      })
    );
    return { plan, publishResult };
  }

  async function requestPublicationDelete(publicationId) {
    setActionError(null);
    markPublicationDeleting((publication) => publication.id === publicationId);
    try {
      const updated = await withSectionLoader("Published Videos", "Deleting publication...", () =>
        deletePublication(publicationId, "admin_requested")
      );
      applyPublicationUpdate(updated);
      setPublishPlans(await withSectionLoader("Content Queue", "Refreshing publishing state...", fetchPublishPlans));
      setAuditEvents((current) =>
        addAuditEvent(current, "delete_publication", publicationId, currentActor(session), {
          publicationId,
          platform: updated.platform,
          providerPostId: updated.providerPostId,
          providerDeleted: updated.metadata?.providerDeleted ?? null,
          reason: "admin_requested"
        })
      );
    } catch (error) {
      const [refreshedPublications, refreshedPlans] = await Promise.all([
        withSectionLoader("Published Videos", "Refreshing published videos...", fetchPublications),
        withSectionLoader("Content Queue", "Refreshing publishing state...", fetchPublishPlans)
      ]);
      setPublications(refreshedPublications);
      setPublishPlans(refreshedPlans);
      setPublicationDrafts(buildPublicationDrafts(refreshedPublications));
      setActionError(error.message);
    }
  }

  async function requestJobPublicationsDelete(jobId) {
    setActionError(null);
    markPublicationDeleting((publication) => publication.jobId === jobId && publication.status !== "deleted");
    try {
      const result = await withSectionLoader("Published Videos", "Deleting channel publications...", () =>
        deleteJobPublications(jobId, "admin_requested_all_channels")
      );
      const [refreshedPublications, refreshedPlans] = await Promise.all([
        withSectionLoader("Published Videos", "Refreshing published videos...", fetchPublications),
        withSectionLoader("Content Queue", "Refreshing publishing state...", fetchPublishPlans)
      ]);
      setPublications(refreshedPublications);
      setPublishPlans(refreshedPlans);
      setPublicationDrafts(buildPublicationDrafts(refreshedPublications));
      setAuditEvents((current) =>
        addAuditEvent(current, "delete_job_publications", jobId, currentActor(session), {
          jobId,
          deleted: result.publications.length,
          failed: result.failed.length,
          failedPlatforms: result.failed.map((failure) => failure.platform)
        })
      );
      if (result.failed.length > 0) {
        setActionError(
          `Deleted ${result.publications.length} channel record(s), ${result.failed.length} failed. ${result.failed
            .map((failure) => `${failure.platform}: ${failure.message}`)
            .join("; ")}`
        );
      }
    } catch (error) {
      const [refreshedPublications, refreshedPlans] = await Promise.all([
        withSectionLoader("Published Videos", "Refreshing published videos...", fetchPublications),
        withSectionLoader("Content Queue", "Refreshing publishing state...", fetchPublishPlans)
      ]);
      setPublications(refreshedPublications);
      setPublishPlans(refreshedPlans);
      setPublicationDrafts(buildPublicationDrafts(refreshedPublications));
      setActionError(error.message);
    }
  }

  function markPublicationDeleting(predicate) {
    setPublications((current) =>
      current.map((publication) =>
        predicate(publication)
          ? {
              ...publication,
              status: "delete_requested",
              publisherStatus: "Deleting video from channel.",
              progress: {
                ...(publication.progress ?? {}),
                stage: "deleting",
                percent: Math.max(45, Number(publication.progress?.percent ?? 0)),
                label: "Deleting video from channel.",
                lastProgressAt: "just now"
              }
            }
          : publication
      )
    );
  }

  async function requestPublicationHype(publicationId) {
    setActionError(null);
    try {
      const updated = await withSectionLoader("Published Videos", "Requesting publication action...", () =>
        hypePublication(publicationId)
      );
      applyPublicationUpdate(updated);
      setAuditEvents((current) =>
        addAuditEvent(current, "hype_publication", publicationId, currentActor(session), {
          publicationId,
          platform: updated.platform,
          status: updated.status
        })
      );
    } catch (error) {
      setActionError(error.message);
    }
  }

  async function importPlatformChannelPublications(platform = "youtube") {
    setActionError(null);
    setPublicationImportWorkflow({ platform, isImporting: true, error: null });
    try {
      const result = await withSectionLoader("Published Videos", `Syncing ${platform} videos...`, () =>
        importPlatformPublications(platform)
      );
      const refreshedPublications = await withSectionLoader(
        "Published Videos",
        "Refreshing published videos...",
        fetchPublications
      );
      setPublications(refreshedPublications);
      setPublicationDrafts(buildPublicationDrafts(refreshedPublications));
      setPublicationImportWorkflow({ platform: null, isImporting: false, error: null });
      setAuditEvents((current) =>
        addAuditEvent(current, `sync_${platform}_channel`, `${result.imported} imported, ${result.updated} updated`, currentActor(session), {
          platform,
          imported: result.imported,
          updated: result.updated,
          scanned: result.scanned,
          accountId: result.accountId
        })
      );
    } catch (error) {
      setPublicationImportWorkflow({ platform: null, isImporting: false, error: error.message });
      setActionError(error.message);
    }
  }

  async function reconnectAccount(accountId) {
    const account = connectedAccounts.find((candidate) => candidate.id === accountId);
    setConnectedAccounts((current) =>
      current.map((candidate) =>
        candidate.id === accountId
          ? {
              ...candidate,
              status: "oauth_pending",
              tokenHealth: "opening oauth",
              updatedAt: "just now"
            }
          : candidate
      )
    );

    try {
      const result = await reconnectSocialAccount(accountId);
      if (result.authorizationUrl) {
        window.location.assign(result.authorizationUrl);
        return;
      }
      if (result.account) {
        setConnectedAccounts((current) =>
          current.map((candidate) =>
            candidate.id === accountId ? { ...candidate, ...result.account } : candidate
          )
        );
      }
      setAuditEvents((current) =>
        addAuditEvent(current, "reconnect_account", accountId, currentActor(session), {
          accountId,
          platform: account?.platform,
          accountName: account?.accountName
        })
      );
    } catch (error) {
      const platform = getPlatformConfig(account?.platform);
      setAccountWorkflow({
        isOpen: true,
        platform: platform.id,
        accountName: account?.accountName ?? platform.defaultAccountName,
        error: error.message,
        isSubmitting: false
      });
    }
  }

  function openConnectAccount(platform = "youtube") {
    const platformConfig = getPlatformConfig(platform);
    setAccountWorkflow({
      isOpen: true,
      platform: platformConfig.id,
      accountName: platformConfig.defaultAccountName,
      error: null,
      isSubmitting: false
    });
  }

  function updateAccountWorkflow(patch) {
    setAccountWorkflow((current) => {
      const nextPlatform = patch.platform ? getPlatformConfig(patch.platform) : null;
      return {
        ...current,
        ...patch,
        error: null,
        accountName:
          patch.platform && current.accountName === getPlatformConfig(current.platform).defaultAccountName
            ? nextPlatform.defaultAccountName
            : patch.accountName ?? current.accountName
      };
    });
  }

  function closeConnectAccount() {
    setAccountWorkflow((current) => ({ ...current, isOpen: false }));
  }

  async function completeAccountConnection(event) {
    event.preventDefault();
    const platformConfig = getPlatformConfig(accountWorkflow.platform);
    const accountName = accountWorkflow.accountName.trim() || platformConfig.defaultAccountName;

    setAccountWorkflow((current) => ({ ...current, error: null, isSubmitting: true }));
    try {
      const result = await startSocialOAuth(platformConfig.id, {
        accountName,
        redirectAfter: window.location.href
      });
      if (result.authorizationUrl) {
        window.location.assign(result.authorizationUrl);
        return;
      }
      setAccountWorkflow((current) => ({
        ...current,
        error: result.TODO ?? `${platformConfig.label} OAuth is not implemented yet.`,
        isSubmitting: false
      }));
    } catch (error) {
      setAccountWorkflow((current) => ({
        ...current,
        error: error.message,
        isSubmitting: false
      }));
    }
  }

  async function disconnectAccount(accountId) {
    const account = connectedAccounts.find((candidate) => candidate.id === accountId);
    setActionError(null);
    try {
      await deleteSocialAccount(accountId);
      setConnectedAccounts((current) => current.filter((candidate) => candidate.id !== accountId));
      setAuditEvents((current) =>
        addAuditEvent(current, "disconnect_social_account", account?.accountName ?? accountId, currentActor(session), {
          accountId,
          platform: account?.platform,
          accountName: account?.accountName
        })
      );
    } catch (error) {
      setActionError(error.message);
    }
  }

  async function createVendorClient(payload) {
    setActionError(null);
    try {
      const result = await createServiceClient(payload);
      setServiceClients((current) => [result.client, ...current]);
      setVendorCredentialResult(result);
      setAuditEvents((current) =>
        addAuditEvent(current, "create_vendor_client", result.client.id, currentActor(session), {
          name: result.client.name,
          keyId: result.client.keyId,
          scopes: result.client.scopes
        })
      );
      return result;
    } catch (error) {
      setActionError(error.message);
      throw error;
    }
  }

  async function rotateVendorClient(clientId) {
    setActionError(null);
    try {
      const result = await rotateServiceClient(clientId);
      setServiceClients((current) =>
        current.map((client) => (client.id === result.client.id ? result.client : client))
      );
      setVendorCredentialResult(result);
      setAuditEvents((current) =>
        addAuditEvent(current, "rotate_vendor_client", result.client.id, currentActor(session), {
          name: result.client.name,
          keyId: result.client.keyId
        })
      );
    } catch (error) {
      setActionError(error.message);
    }
  }

  async function revokeVendorClient(clientId) {
    setActionError(null);
    try {
      const updated = await revokeServiceClient(clientId);
      setServiceClients((current) =>
        current.map((client) => (client.id === updated.id ? updated : client))
      );
      if (vendorCredentialResult?.client.id === clientId) {
        setVendorCredentialResult(null);
      }
      setAuditEvents((current) =>
        addAuditEvent(current, "revoke_vendor_client", updated.id, currentActor(session), {
          name: updated.name,
          keyId: updated.keyId
        })
      );
    } catch (error) {
      setActionError(error.message);
    }
  }

  async function changeUserRole(userId, role) {
    setActionError(null);
    try {
      const updated = await withSectionLoader("Users", "Updating user access...", () =>
        updateUserRole(userId, role)
      );
      setUsers((current) => current.map((user) => (user.id === updated.id ? updated : user)));
      setAuditEvents((current) =>
        addAuditEvent(current, "update_user_role", updated.email, currentActor(session), {
          userId: updated.id,
          role: updated.role
        })
      );
    } catch (error) {
      setActionError(error.message);
      throw error;
    }
  }

  async function removeUser(userId) {
    setActionError(null);
    try {
      const removed = await withSectionLoader("Users", "Removing user access...", () => deleteUser(userId));
      setUsers((current) => current.filter((user) => user.id !== removed.id));
      setAuditEvents((current) =>
        addAuditEvent(current, "delete_user", removed.email, currentActor(session), {
          userId: removed.id,
          role: removed.role
        })
      );
    } catch (error) {
      setActionError(error.message);
      throw error;
    }
  }

  async function refreshUsers() {
    setActionError(null);
    try {
      const refreshed = await withSectionLoader("Users", "Refreshing users...", fetchUsers);
      setUsers(refreshed);
    } catch (error) {
      setActionError(error.message);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">NL</span>
          <div>
            <strong>NewLeaf</strong>
            <span>Admin Console</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Admin sections">
          {navItems.map((item) => (
            <button
              className={item === activeView ? "nav-item active" : "nav-item"}
              key={item}
              type="button"
              onClick={() => setActiveView(item)}
            >
              {item}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">Operations</p>
            <h1>{activeView}</h1>
          </div>
          <div className="operator-strip">
            <span>{currentActor(session)}</span>
          </div>
        </header>

        {Object.keys(sectionLoaders).length > 0 && (
          <section className="section-loader app-loader" aria-live="polite">
            <LeafLoader compact label={Object.values(sectionLoaders)[0]} />
          </section>
        )}

        {loadError ? (
          <section className="empty-state">
            Unable to load operations snapshot: {loadError.message}
          </section>
        ) : isLoading ? (
          <section className="empty-state">
            <LeafLoader label="Loading operations snapshot" />
          </section>
        ) : (
          <Suspense fallback={<section className="empty-state"><LeafLoader label="Loading section" /></section>}>
            {sectionLoaders[activeView] && (
              <section className="section-loader" aria-live="polite">
                <LeafLoader compact label={sectionLoaders[activeView]} />
              </section>
            )}
            {actionError && <section className="form-error">{actionError}</section>}

            {activeView === "Dashboard" && (
              <Dashboard
                connectedAccounts={connectedAccounts}
                jobs={jobs}
                metrics={metrics}
                publications={publications}
                publishPlans={publishPlans}
                setActiveView={setActiveView}
                setSelectedJobId={setSelectedJobId}
                users={users}
              />
            )}

            {activeView === "Create Content" && (
              <CreateContent
                contentDraft={contentDraft}
                intakeModes={intakeModes}
                submitContentDraft={submitContentDraft}
                updateContentDraft={updateContentDraft}
              />
            )}

            {activeView === "Content Queue" && (
              <ContentQueue
                approvePlan={approveAndPublishPlan}
                connectedAccounts={connectedAccounts}
                filteredJobs={filteredJobs}
                jobs={contentQueueJobs}
                publications={publications}
                publishDraft={publishDraft}
                publishPlans={publishPlans}
                query={query}
                pollAssemblySegment={pollAssemblySegment}
                retryAttempt={retryAttempt}
                requestQueueJobDelete={requestReviewJobDelete}
                requestYouTubeTagGeneration={requestYouTubeTagGeneration}
                selectedJob={selectedContentQueueJob}
                setActiveView={setActiveView}
                setQuery={setQuery}
                setSelectedJobId={setSelectedJobId}
                setStatusFilter={setStatusFilter}
                socialPlatforms={socialPlatforms}
                startPublishing={startPublishing}
                statusFilter={statusFilter}
                submitPublishDraft={submitPublishDraft}
                togglePublishPlatform={togglePublishPlatform}
                updatePublishDraft={updatePublishDraft}
                uploadAssemblySegmentClip={uploadAssemblySegmentClip}
                uploadThumbnail={uploadThumbnail}
                generateThumbnail={generateThumbnail}
              />
            )}

            {activeView === "Review" && (
              <ReviewWorkspace
                approveSelectedJob={approveSelectedJob}
                generateSelectedSummary={generateSelectedSummary}
                openPublishing={() => setActiveView("Content Queue")}
                requestReviewJobDelete={requestReviewJobDelete}
                requestRegeneration={requestRegeneration}
                saveReviewScript={saveReviewScript}
                selectedJob={selectedReviewJob}
                summaryWorkflow={summaryWorkflow}
                uploadThumbnail={uploadThumbnail}
                generateThumbnail={generateThumbnail}
              />
            )}

            {activeView === "Published Videos" && (
              <PublishedVideos
                connectedAccounts={connectedAccounts}
                jobs={jobs}
                importPlatformChannelPublications={importPlatformChannelPublications}
                publicationImportWorkflow={publicationImportWorkflow}
                publicationDrafts={publicationDrafts}
                publications={publications}
                requestJobPublicationsDelete={requestJobPublicationsDelete}
                requestPublicationDelete={requestPublicationDelete}
                requestPublicationHype={requestPublicationHype}
                requestPublicationRepublish={requestPublicationRepublish}
                savePublication={savePublication}
                generateThumbnail={generateThumbnail}
                socialPlatforms={socialPlatforms}
                updatePublicationDraft={updatePublicationDraft}
                uploadThumbnail={uploadThumbnail}
              />
            )}

            {activeView === "Video Studio" && <VideoStudio />}

            {activeView === "Accounts" && (
              <ConnectedAccounts
                accountWorkflow={accountWorkflow}
                accounts={connectedAccounts}
                closeConnectAccount={closeConnectAccount}
                completeAccountConnection={completeAccountConnection}
                disconnectAccount={disconnectAccount}
                openConnectAccount={openConnectAccount}
                reconnectAccount={reconnectAccount}
                socialPlatforms={socialPlatforms}
                updateAccountWorkflow={updateAccountWorkflow}
              />
            )}

            {activeView === "Users" && (
              <Users
                currentUserId={session?.user?.id}
                onDeleteUser={removeUser}
                onRefresh={refreshUsers}
                onUpdateRole={changeUserRole}
                users={users}
              />
            )}

            {activeView === "Vendors" && (
              <Vendors
                createVendorClient={createVendorClient}
                credentialResult={vendorCredentialResult}
                revokeVendorClient={revokeVendorClient}
                rotateVendorClient={rotateVendorClient}
                serviceClients={serviceClients}
              />
            )}

            {activeView === "Audit" && (
              <AuditLog auditEvents={auditEvents} publications={publications} publishPlans={publishPlans} />
            )}
          </Suspense>
        )}
      </main>
    </div>
  );
}

function currentActor(session) {
  return session?.user?.email ?? session?.user?.displayName ?? session?.user?.uid ?? "Unknown operator";
}

function hydratePublishDraftForJobChange(current, patch, jobs) {
  const next = {
    ...patch
  };
  if (!Object.prototype.hasOwnProperty.call(patch, "jobId")) {
    return next;
  }

  const job = jobs.find((candidate) => candidate.id === patch.jobId);
  const isSameJob = current.jobId === patch.jobId;
  next.title = isSameJob ? current.title : job?.title ?? "";
  next.description = isSameJob ? current.description : defaultPublishDescription(job);
  next.hashtagsText = isSameJob ? current.hashtagsText : defaultHashtagsText(job);
  next.youtubeTagsText = isSameJob ? current.youtubeTagsText : defaultYouTubeTagsText(job);
  return next;
}

function findProviderJobForSegment(providerJobs, segment) {
  return (providerJobs ?? []).find((providerJob) => {
    const assembly = providerJob.requestPayload?.assembly ?? {};
    return (
      Number(assembly.sequence) === Number(segment.sequence) &&
      String(assembly.segmentKey ?? "").toLowerCase() === String(segment.segmentKey ?? "").toLowerCase()
    );
  });
}

function defaultPublishDescription(job) {
  if (!job) return "";
  const metadata = job.metadata ?? {};
  return (
    metadata.description ??
    metadata.reviewSummary?.descriptionSuggestion ??
    metadata.reviewSummary?.summary ??
    metadata.prompt ??
    ""
  );
}

function splitReviewScript(value) {
  return String(value ?? "")
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildRegenerationVideoScript(job, editedScriptText = "") {
  if (editedScriptText) {
    return { prompt: editedScriptText };
  }
  if (Array.isArray(job?.metadata?.videoSegments) && job.metadata.videoSegments.length > 0) {
    return { segments: job.metadata.videoSegments };
  }
  return { prompt: job?.metadata?.prompt ?? job?.title ?? "" };
}

function defaultHashtagsText(job) {
  const tags = job?.metadata?.reviewSummary?.suggestedTags;
  return Array.isArray(tags) ? tags.map((tag) => `#${normalizeTagText(tag)}`).filter((tag) => tag !== "#").join(", ") : "";
}

function defaultYouTubeTagsText(job) {
  const tags = job?.metadata?.reviewSummary?.suggestedTags;
  return Array.isArray(tags) ? tags.map(normalizeTagText).filter(Boolean).join(", ") : "";
}

function parseDelimitedTags(value) {
  return Array.from(
    new Set(
      String(value ?? "")
        .split(/[,\n]/)
        .map(normalizeTagText)
        .filter(Boolean)
    )
  );
}

function isFutureSchedule(value) {
  if (!value) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now() + 60_000;
}

function normalizeTagText(value) {
  return String(value ?? "")
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, " ")
    .slice(0, 60);
}
