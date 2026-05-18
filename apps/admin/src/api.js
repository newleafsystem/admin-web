import { API_BASE_URL } from "./config.js";
import { youtubeMetadataDefaults } from "./constants.js";
import { getAuthToken } from "./firebaseClient.js";

export async function fetchOperationsSnapshot() {
  const [
    jobs,
    publishPlans,
    connectedAccounts,
    publications,
    serviceClients,
    users,
    watchlistConfig,
    recommendationBatches
  ] = await Promise.all([
    fetchJobs(),
    fetchPublishPlans(),
    fetchSocialAccounts(),
    fetchPublications(),
    fetchServiceClients().catch(() => []),
    fetchUsers().catch(() => []),
    fetchWatchlistConfig().catch(() => null),
    fetchRecommendationBatches().catch(() => [])
  ]);

  return {
    jobs,
    publishPlans,
    connectedAccounts,
    publications,
    serviceClients,
    users,
    watchlistConfig,
    recommendationBatches,
    auditEvents: []
  };
}

export async function fetchCurrentSession() {
  const response = await apiFetch(`${API_BASE_URL}/session`);
  const body = await readJson(response);
  assertOk(response, body, "Unable to load user session");
  return {
    user: normalizeAppUser(body.user),
    roles: body.roles ?? body.user?.roles ?? []
  };
}

export async function clearCurrentSessionCookie() {
  const response = await apiFetch(`${API_BASE_URL}/session/cookie`, {
    method: "DELETE"
  });
  if (response.status === 204) {
    return true;
  }
  const body = await readJson(response);
  assertOk(response, body, "Unable to clear server session");
  return true;
}

export async function fetchJobs() {
  const response = await apiFetch(`${API_BASE_URL}/jobs`);
  const body = await readJson(response);
  assertOk(response, body, "Unable to load jobs");

  const details = await Promise.all(
    (body.jobs ?? []).map(async (job) => {
      try {
        return await fetchJobDetail(job.id);
      } catch {
        return { job, artifacts: [], providerJobs: [] };
      }
    })
  );
  return details.map(({ job, artifacts, providerJobs }) => normalizeJob(job, artifacts, providerJobs));
}

export async function fetchJobDetail(jobId) {
  const response = await apiFetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}`);
  const body = await readJson(response);
  assertOk(response, body, "Unable to load job detail");
  return body;
}

export async function createContentJob(payload) {
  const response = await apiFetch(`${API_BASE_URL}/jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to create content job");
  return normalizeJob(body.job, [], []);
}

export async function updateContentJob(jobId, payload) {
  const response = await apiFetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to update content job");
  return normalizeJob(body.job, [], []);
}

export async function uploadLocalVideo(jobId, file) {
  const params = new URLSearchParams({
    jobId,
    kind: "video",
    filename: file.name,
    mimeType: file.type || "application/octet-stream"
  });
  const response = await apiFetch(`${API_BASE_URL}/assets/local-upload?${params.toString()}`, {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream"
    },
    body: file
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to upload local video");
  return body.artifact;
}

export async function uploadVideoAssemblySegment(jobId, heygenVideoId, file) {
  const params = new URLSearchParams({
    filename: file.name,
    mimeType: file.type || "application/octet-stream"
  });
  const response = await apiFetch(
    `${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/video-assembly/segments/${encodeURIComponent(heygenVideoId)}/upload?${params.toString()}`,
    {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream"
      },
      body: file
    }
  );
  const body = await readJson(response);
  assertOk(response, body, "Unable to upload assembly segment");
  return normalizeJob(body.job, body.artifacts ?? [], body.providerJobs ?? []);
}

export async function uploadJobThumbnail(jobId, file) {
  const params = new URLSearchParams({
    filename: file.name,
    mimeType: file.type || "application/octet-stream"
  });
  const response = await apiFetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/thumbnail/upload?${params.toString()}`, {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream"
    },
    body: file
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to upload thumbnail");
  return {
    job: normalizeJob(body.job, body.artifacts ?? [], body.providerJobs ?? []),
    artifact: body.artifact ?? null
  };
}

export async function generateJobThumbnail(jobId, atSeconds = 2) {
  const response = await apiFetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/thumbnail/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ atSeconds })
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to generate thumbnail");
  return {
    job: normalizeJob(body.job, body.artifacts ?? [], body.providerJobs ?? []),
    artifact: body.artifact ?? null
  };
}

export async function createVideoStudioProject(payload) {
  const response = await apiFetch(`${API_BASE_URL}/video-projects`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to create video studio project");
  return normalizeVideoStudioProject(body);
}

export async function fetchVideoStudioProject(projectId) {
  const response = await apiFetch(`${API_BASE_URL}/video-projects/${encodeURIComponent(projectId)}/timeline`);
  const body = await readJson(response);
  assertOk(response, body, "Unable to load video studio project");
  return normalizeVideoStudioProject(body);
}

export async function updateVideoStudioTimeline(projectId, timeline) {
  const response = await apiFetch(`${API_BASE_URL}/video-projects/${encodeURIComponent(projectId)}/timeline`, {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(timeline)
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to update video studio timeline");
  return normalizeVideoStudioProject(body);
}

export async function uploadVideoStudioAsset(projectId, type, file) {
  const params = new URLSearchParams({
    type,
    filename: file.name,
    mimeType: file.type || "application/octet-stream"
  });
  const response = await apiFetch(`${API_BASE_URL}/video-projects/${encodeURIComponent(projectId)}/assets?${params.toString()}`, {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream"
    },
    body: file
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to upload video studio asset");
  return normalizeVideoStudioProject(body);
}

export async function deleteVideoStudioAsset(projectId, trackId) {
  const response = await apiFetch(
    `${API_BASE_URL}/video-projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(trackId)}`,
    {
      method: "DELETE"
    }
  );
  const body = await readJson(response);
  assertOk(response, body, "Unable to delete video studio asset");
  return normalizeVideoStudioProject(body);
}

export async function deleteVideoStudioProject(projectId) {
  const response = await apiFetch(`${API_BASE_URL}/video-projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to delete video studio project");
  return body;
}

export async function renderVideoStudioProject(projectId) {
  const response = await apiFetch(`${API_BASE_URL}/video-projects/${encodeURIComponent(projectId)}/render`, {
    method: "POST"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to render video studio project");
  return normalizeVideoStudioProject(body);
}

export async function requestVideoGeneration(jobId, script) {
  return requestVideoGenerationWithRecovery({
    jobId,
    path: `${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/generate-video`,
    body: { script },
    fallbackMessage: "Unable to request HeyGen video"
  });
}

export async function regenerateJobVideo(jobId, script = null) {
  return requestVideoGenerationWithRecovery({
    jobId,
    path: `${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/regenerate-video`,
    body: { script },
    fallbackMessage: "Unable to regenerate video"
  });
}

export async function pollHeyGenProviderJob(jobId, providerJobId) {
  try {
    const response = await apiFetch(
      `${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/provider-jobs/${encodeURIComponent(providerJobId)}/poll`,
      {
        method: "POST"
      }
    );
    const body = await readJson(response);
    assertOk(response, body, "Unable to poll HeyGen provider job");
    return {
      action: body.action,
      pollResult: body.pollResult,
      job: normalizeJob(body.job, body.artifacts ?? [], body.providerJobs ?? [])
    };
  } catch (error) {
    if (!isRecoverableLongRunningError(error)) {
      throw error;
    }
    const recovered = await recoverLongRunningJob(jobId);
    if (!recovered) {
      throw error;
    }
    return {
      action: "poll_recovered_after_timeout",
      pollResult: {
        status: recovered.video.status,
        recovered: true,
        note: "The HeyGen poll took longer than the gateway allowed, so the video state was refreshed from storage."
      },
      job: recovered
    };
  }
}

export async function generateJobScript(jobId) {
  const response = await apiFetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/generate-script`, {
    method: "POST"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to regenerate script");
  return normalizeJob(body.job, [], []);
}

export async function approveJob(jobId) {
  const response = await apiFetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/approve`, {
    method: "POST"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to approve job");
  return normalizeJob(body.job, [], []);
}

export async function deleteReviewJob(jobId, reason = "admin_deleted_review") {
  const response = await apiFetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ reason })
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to delete review job");
  return {
    job: normalizeJob(body.deleted?.job, [], []),
    artifactCount: body.deleted?.artifacts?.length ?? 0,
    providerJobCount: body.deleted?.providerJobs?.length ?? 0,
    publishPlanCount: body.deleted?.publishPlans?.length ?? 0,
    publishAttemptCount: body.deleted?.publishAttempts?.length ?? 0
  };
}

export async function generateVideoSummary(jobId) {
  const response = await apiFetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/generate-summary`, {
    method: "POST"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to generate video summary");
  return {
    job: normalizeJob(body.job, [], []),
    summary: body.summary
  };
}

export async function fetchPublishPlans() {
  const response = await apiFetch(`${API_BASE_URL}/publish-plans`);
  const body = await readJson(response);
  assertOk(response, body, "Unable to load publish plans");
  return (body.plans ?? []).map(normalizePublishPlan);
}

export async function generateYouTubeTags(jobId, payload) {
  const response = await apiFetch(`${API_BASE_URL}/publish-plans/generate-youtube-tags`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jobId,
      title: payload.title,
      description: payload.description,
      hashtags: payload.hashtags ?? []
    })
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to generate YouTube tags");
  return {
    tags: Array.isArray(body.tags) ? body.tags : [],
    provider: body.provider ?? null,
    model: body.model ?? null
  };
}

export async function fetchPublications() {
  const response = await apiFetch(`${API_BASE_URL}/publications`);
  const body = await readJson(response);
  assertOk(response, body, "Unable to load publications");
  return (body.publications ?? []).map(normalizePublication);
}

export async function importYouTubePublications({ accountId = null, maxResults = null } = {}) {
  return importPlatformPublications("youtube", { accountId, maxResults });
}

export async function importPlatformPublications(platform, { accountId = null, maxResults = null } = {}) {
  const payload = {};
  if (accountId) {
    payload.accountId = accountId;
  }
  if (maxResults !== null && maxResults !== undefined && maxResults !== "") {
    const numericMaxResults = Number(maxResults);
    if (Number.isFinite(numericMaxResults)) {
      payload.maxResults = numericMaxResults;
    }
  }
  const response = await apiFetch(`${API_BASE_URL}/publications/import/${encodeURIComponent(platform)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await readJson(response);
  assertOk(response, body, `Unable to sync ${platform} videos`);
  return {
    publications: (body.publications ?? []).map(normalizePublication),
    imported: body.imported ?? 0,
    updated: body.updated ?? 0,
    scanned: body.scanned ?? 0,
    accountId: body.accountId ?? null,
    platform: body.platform ?? platform
  };
}

export async function updatePublication(publicationId, payload) {
  const response = await apiFetch(`${API_BASE_URL}/publications/${encodeURIComponent(publicationId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to update publication");
  return normalizePublication(body.publication);
}

export async function deletePublication(publicationId, reason = "") {
  const response = await apiFetch(`${API_BASE_URL}/publications/${encodeURIComponent(publicationId)}/delete`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ reason })
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to request publication delete");
  return normalizePublication(body.publication);
}

export async function deleteJobPublications(jobId, reason = "", platforms = []) {
  const response = await apiFetch(`${API_BASE_URL}/publications/delete`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ jobId, reason, platforms })
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to delete job publications");
  return {
    publications: (body.publications ?? []).map(normalizePublication),
    failed: body.failed ?? [],
    task: body.task ?? null
  };
}

export async function hypePublication(publicationId, strategy = "boost_visibility") {
  const response = await apiFetch(`${API_BASE_URL}/publications/${encodeURIComponent(publicationId)}/hype`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ strategy })
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to request hype workflow");
  return normalizePublication(body.publication);
}

export async function createPublishPlan(payload) {
  const response = await apiFetch(`${API_BASE_URL}/publish-plans`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to create publish plan");
  return normalizePublishPlan({ ...body.plan, attempts: [] });
}

export async function approvePublishPlan(planId) {
  const response = await apiFetch(`${API_BASE_URL}/publish-plans/${encodeURIComponent(planId)}/approve`, {
    method: "POST"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to approve publish plan");
  return normalizePublishPlan({ ...body.plan, attempts: [] });
}

export async function publishPlan(planId) {
  const response = await apiFetch(`${API_BASE_URL}/publish-plans/${encodeURIComponent(planId)}/publish`, {
    method: "POST"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to publish plan");
  return {
    plan: normalizePublishPlan({ ...body.plan, attempts: body.attempts ?? [] }),
    attempts: body.attempts ?? []
  };
}

export async function retryPublishAttempt(attemptId) {
  const response = await apiFetch(`${API_BASE_URL}/publish-attempts/${encodeURIComponent(attemptId)}/retry`, {
    method: "POST"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to retry publish attempt");
  return body.attempt;
}

export async function fetchSocialAccounts() {
  const response = await apiFetch(`${API_BASE_URL}/social/accounts`);
  const body = await readJson(response);
  assertOk(response, body, "Unable to load connected accounts");
  return (body.accounts ?? []).map(normalizeSocialAccount);
}

export async function startSocialOAuth(platform, payload = {}) {
  const response = await apiFetch(`${API_BASE_URL}/social/${platform}/oauth/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await readJson(response);
  assertOk(response, body, `Unable to start ${platform} OAuth`);
  return body;
}

export async function reconnectSocialAccount(accountId) {
  const response = await apiFetch(`${API_BASE_URL}/social/accounts/${accountId}/reconnect`, {
    method: "POST"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to reconnect account");
  return body;
}

export async function deleteSocialAccount(accountId) {
  const response = await apiFetch(`${API_BASE_URL}/social/accounts/${encodeURIComponent(accountId)}`, {
    method: "DELETE"
  });
  if (response.status === 204) {
    return true;
  }
  const body = await readJson(response);
  assertOk(response, body, "Unable to remove account");
  return true;
}

export async function fetchServiceClients() {
  const response = await apiFetch(`${API_BASE_URL}/service-clients`);
  const body = await readJson(response);
  assertOk(response, body, "Unable to load vendor API clients");
  return (body.clients ?? []).map(normalizeServiceClient);
}

export async function createServiceClient(payload) {
  const response = await apiFetch(`${API_BASE_URL}/service-clients`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to create vendor API client");
  return {
    client: normalizeServiceClient(body.client),
    credentials: body.credentials ?? null
  };
}

export async function rotateServiceClient(clientId) {
  const response = await apiFetch(`${API_BASE_URL}/service-clients/${encodeURIComponent(clientId)}/rotate`, {
    method: "POST"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to rotate vendor API client");
  return {
    client: normalizeServiceClient(body.client),
    credentials: body.credentials ?? null
  };
}

export async function revokeServiceClient(clientId) {
  const response = await apiFetch(`${API_BASE_URL}/service-clients/${encodeURIComponent(clientId)}/revoke`, {
    method: "POST"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to revoke vendor API client");
  return normalizeServiceClient(body.client);
}

export async function fetchUsers() {
  const response = await apiFetch(`${API_BASE_URL}/users`);
  const body = await readJson(response);
  assertOk(response, body, "Unable to load users");
  return (body.users ?? []).map(normalizeAppUser);
}

export async function updateUserRole(userId, role, appAccess) {
  const normalizedUserId = requireUserId(userId, "update user role");
  const payload = {
    ...(role !== undefined ? { role } : {}),
    ...(appAccess !== undefined ? { appAccess } : {})
  };
  const response = await apiFetch(`${API_BASE_URL}/users/${encodeURIComponent(normalizedUserId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to update user role");
  return normalizeAppUser(body.user);
}

export async function updateUserNotifications(userId, notificationPreferences) {
  const normalizedUserId = requireUserId(userId, "update user notifications");
  const response = await apiFetch(`${API_BASE_URL}/users/${encodeURIComponent(normalizedUserId)}/notifications`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(notificationPreferences)
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to update user notifications");
  return normalizeAppUser(body.user);
}

export async function deleteUser(userId) {
  const normalizedUserId = requireUserId(userId, "delete user");
  const response = await apiFetch(`${API_BASE_URL}/users/${encodeURIComponent(normalizedUserId)}`, {
    method: "DELETE"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to delete user");
  return normalizeAppUser(body.user);
}

export async function fetchWatchlistConfig() {
  const response = await apiFetch(`${API_BASE_URL}/watchlists/default`);
  const body = await readJson(response);
  assertOk(response, body, "Unable to load watchlist");
  return normalizeWatchlistConfig(body.watchlist);
}

export async function updateWatchlistConfig(config) {
  const response = await apiFetch(`${API_BASE_URL}/watchlists/default`, {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(config)
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to update watchlist");
  return normalizeWatchlistConfig(body.watchlist);
}

export async function fetchRecommendationBatches() {
  const response = await apiFetch(`${API_BASE_URL}/recommendation-batches`);
  const body = await readJson(response);
  assertOk(response, body, "Unable to load recommendation batches");
  return (body.recommendationBatches ?? []).map(normalizeRecommendationBatch);
}

export async function createRecommendationBatch(payload) {
  const response = await apiFetch(`${API_BASE_URL}/recommendation-batches`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to create recommendation batch");
  return normalizeRecommendationBatch(body.recommendationBatch);
}

export async function updateRecommendationBatch(batchId, payload) {
  const response = await apiFetch(`${API_BASE_URL}/recommendation-batches/${encodeURIComponent(batchId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to update recommendation batch");
  return normalizeRecommendationBatch(body.recommendationBatch);
}

export async function generateRecommendationBatch(payload) {
  const response = await apiFetch(`${API_BASE_URL}/recommendation-batches/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to generate recommendations");
  return normalizeRecommendationBatch(body.recommendationBatch);
}

export async function approveRecommendationBatch(batchId) {
  const response = await apiFetch(`${API_BASE_URL}/recommendation-batches/${encodeURIComponent(batchId)}/approve`, {
    method: "POST"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to approve recommendation batch");
  return normalizeRecommendationBatch(body.recommendationBatch);
}

export async function publishRecommendationBatch(batchId) {
  const response = await apiFetch(`${API_BASE_URL}/recommendation-batches/${encodeURIComponent(batchId)}/publish`, {
    method: "POST"
  });
  const body = await readJson(response);
  assertOk(response, body, "Unable to publish recommendation batch");
  return normalizeRecommendationBatch(body.recommendationBatch);
}

async function requestVideoGenerationWithRecovery({ jobId, path, body, fallbackMessage }) {
  try {
    const response = await apiFetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const responseBody = await readJson(response);
    assertOk(response, responseBody, fallbackMessage);
    return normalizeJob(
      responseBody.job,
      responseBody.artifacts ?? [],
      responseBody.providerJobs ?? (responseBody.providerJob ? [responseBody.providerJob] : [])
    );
  } catch (error) {
    if (!isRecoverableLongRunningError(error)) {
      throw error;
    }
    const recovered = await recoverLongRunningJob(jobId);
    if (recovered?.metadata?.videoAssembly || recovered?.providerJobs?.length > 0) {
      return recovered;
    }
    throw error;
  }
}

async function recoverLongRunningJob(jobId) {
  for (const delayMs of [2500, 5000, 10000]) {
    await delay(delayMs);
    try {
      const details = await fetchJobDetail(jobId);
      return normalizeJob(details.job, details.artifacts ?? [], details.providerJobs ?? []);
    } catch {
      // Keep retrying; the original long-running request may still be committing state.
    }
  }
  return null;
}

function isRecoverableLongRunningError(error) {
  const status = Number(error?.status);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("networkerror") ||
    message.includes("failed to fetch") ||
    message.includes("unable to reach api")
  );
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function requireUserId(userId, action) {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) {
    throw new Error(`Unable to ${action}: user id is missing.`);
  }
  return normalizedUserId;
}

async function apiFetch(url, options) {
  try {
    const token = await getAuthToken();
    const headers = new Headers(options?.headers ?? {});
    if (token && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return await fetch(url, { ...(options ?? {}), credentials: "include", headers });
  } catch (error) {
    throw new Error(
      `Unable to reach API at ${API_BASE_URL}. Restart the API server and confirm CORS_ALLOWED_ORIGINS includes this admin origin. ${error.message}`
    );
  }
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

function assertOk(response, body, fallbackMessage) {
  if (response.ok) {
    return;
  }
  const error = new Error(body.error?.message ?? body.setup ?? body.message ?? fallbackMessage);
  error.status = response.status;
  error.details = body;
  throw error;
}

function normalizeSocialAccount(account) {
  return {
    id: account.id,
    platform: account.platform,
    accountName: account.accountName,
    status: account.status ?? "connected",
    scopes: account.scopes ?? [],
    tokenHealth: account.tokenHealth ?? (account.tokenSecretRef ? "healthy" : "unknown"),
    tokenSource: account.tokenSecretRef ? "secret-ref" : account.source,
    updatedAt: formatDate(account.updatedAt ?? account.createdAt),
    providerAccountId: account.providerAccountId ?? null
  };
}

function normalizeServiceClient(client) {
  return {
    id: client.id,
    name: client.name,
    contactEmail: client.contactEmail ?? "",
    status: client.status ?? "active",
    keyId: client.keyId,
    scopes: client.scopes ?? [],
    rateLimitPerMinute: client.rateLimitPerMinute ?? null,
    requireSignedRequests: client.requireSignedRequests !== false,
    createdBy: client.createdBy ?? null,
    createdAt: formatDate(client.createdAt),
    updatedAt: formatDate(client.updatedAt),
    rotatedAt: formatDate(client.rotatedAt),
    revokedAt: formatDate(client.revokedAt)
  };
}

function normalizeAppUser(user = {}) {
  const id = String(user.id ?? user.uid ?? "").trim();
  const uid = String(user.uid ?? user.id ?? "").trim();
  return {
    id,
    uid,
    email: user.email ?? "",
    displayName: user.displayName || user.email || uid || id || "Unknown user",
    photoUrl: user.photoUrl ?? null,
    role: user.role ?? (user.roles?.includes("admin") ? "admin" : "anonymous"),
    roles: user.roles ?? [],
    appAccess: normalizeAppAccess(user.appAccess),
    status: user.status ?? "active",
    immutable: Boolean(user.immutable),
    firstSeenAt: formatDate(user.firstSeenAt ?? user.createdAt),
    lastLoginAt: formatDate(user.lastLoginAt),
    lastLoginContext: normalizeLoginContext(user.lastLoginContext),
    updatedAt: formatDate(user.updatedAt),
    accessUpdatedAt: formatDate(user.accessUpdatedAt),
    notificationPreferences: normalizeNotificationPreferences(user.notificationPreferences, user),
    notificationsUpdatedAt: formatDate(user.notificationsUpdatedAt),
    authMode: user.authMode ?? null
  };
}

function normalizeAppAccess(appAccess = {}) {
  return {
    admin: Boolean(appAccess.admin),
    invest: Boolean(appAccess.invest),
    picks: Boolean(appAccess.picks),
    workbench: Boolean(appAccess.workbench),
    quant: Boolean(appAccess.quant),
    desk: Boolean(appAccess.desk)
  };
}

export const notificationTopicOptions = Object.freeze([
  {
    id: "weeklyPicks",
    label: "Weekly picks",
    description: "Weekly picks newsletter and recommendation summaries."
  },
  {
    id: "scannerAlerts",
    label: "Scanner alerts",
    description: "Scanner, watchlist, and market-data pipeline notices."
  },
  {
    id: "publishingAlerts",
    label: "Publishing alerts",
    description: "Publishing workflow success, retry, and failure notices."
  },
  {
    id: "accountAccess",
    label: "Account access",
    description: "Sign-in, role, and application access changes."
  },
  {
    id: "systemAlerts",
    label: "System alerts",
    description: "Service health and operational incident notices."
  }
]);

function normalizeNotificationPreferences(preferences = {}, user = {}) {
  const email = preferences?.email && typeof preferences.email === "object" ? preferences.email : {};
  const address = email.address ?? user.communicationEmail ?? user.email ?? "";
  return {
    email: {
      enabled: Boolean(address) && email.enabled !== false,
      address,
      topics: normalizeNotificationTopics(email.topics),
      updatedAt: formatDate(email.updatedAt),
      updatedBy: email.updatedBy ?? null
    }
  };
}

function normalizeNotificationTopics(topics = {}) {
  const defaults = {
    weeklyPicks: true,
    scannerAlerts: false,
    publishingAlerts: false,
    accountAccess: true,
    systemAlerts: false
  };
  return Object.fromEntries(
    notificationTopicOptions.map((topic) => [
      topic.id,
      Object.prototype.hasOwnProperty.call(topics, topic.id) ? Boolean(topics[topic.id]) : defaults[topic.id]
    ])
  );
}

export function normalizeWatchlistConfig(config = null) {
  if (!config) return null;
  const markets = Array.isArray(config.markets) ? config.markets.map(normalizeWatchlistMarket) : [];
  const symbols = Array.isArray(config.symbols) ? config.symbols.map(normalizeWatchlistSymbol) : [];
  const universeSymbols = Array.isArray(config.universeSymbols)
    ? config.universeSymbols.map(normalizeWatchlistSymbol)
    : symbols;
  return {
    id: config.id ?? "default",
    version: Number(config.version ?? 1),
    markets,
    symbols,
    universeSymbols,
    limits: {
      maxSymbolsPerRun: Number(config.limits?.maxSymbolsPerRun ?? 150),
      maxSymbolsPerMarket: Number(config.limits?.maxSymbolsPerMarket ?? 150),
      yahooBatchSize: Number(config.limits?.yahooBatchSize ?? config.limits?.maxSymbolsPerRun ?? 150),
      yahooMaxOiExpiries: Number(config.limits?.yahooMaxOiExpiries ?? 1),
      intradayConcurrency: Number(config.limits?.intradayConcurrency ?? 5),
      dailyConcurrency: Number(config.limits?.dailyConcurrency ?? 1),
      yahooRequestDelayMs: Number(config.limits?.yahooRequestDelayMs ?? 350),
      yahooBatchDelayMs: Number(config.limits?.yahooBatchDelayMs ?? 60000)
    },
    universeSync: normalizeUniverseSync(config.universeSync),
    notes: config.notes ?? "",
    createdAt: formatDate(config.createdAt),
    updatedAt: formatDate(config.updatedAt),
    updatedBy: config.updatedBy ?? null
  };
}

export function normalizeRecommendationBatch(batch = {}) {
  return {
    id: batch.id ?? "",
    tradeDate: batch.tradeDate ?? "",
    weekId: batch.weekId ?? "",
    title: batch.title ?? "",
    theme: batch.theme ?? "",
    dateRange: batch.dateRange ?? "",
    status: batch.status ?? "draft",
    recommendations: Array.isArray(batch.recommendations)
      ? batch.recommendations.map(normalizeRecommendationItem)
      : [],
    channels: normalizeRecommendationChannels(batch.channels),
    publicData: batch.publicData ?? null,
    scriptJobId: batch.scriptJobId ?? null,
    createdBy: batch.createdBy ?? null,
    approvedBy: batch.approvedBy ?? null,
    approvedAt: formatDate(batch.approvedAt),
    publishedBy: batch.publishedBy ?? null,
    publishedAt: formatDate(batch.publishedAt),
    createdAt: formatDate(batch.createdAt),
    updatedAt: formatDate(batch.updatedAt),
    metadata: batch.metadata ?? {}
  };
}

function normalizeRecommendationItem(item = {}) {
  return {
    id: item.id ?? "",
    tileId: item.tileId ?? item.id ?? "",
    symbol: String(item.symbol ?? "").toUpperCase(),
    strategy: item.strategy ?? "",
    direction: item.direction ?? "NEUTRAL",
    price: item.price ?? "",
    expiry: item.expiry ?? "",
    rewardRisk: item.rewardRisk ?? "",
    oddsOfProfit: item.oddsOfProfit ?? "",
    maxProfit: item.maxProfit ?? "",
    thesis: item.thesis ?? "",
    riskNotes: item.riskNotes ?? "",
    entry: item.entry ?? "",
    exit: item.exit ?? "",
    ivContext: item.ivContext ?? {},
    sentiment: item.sentiment ?? {},
    lifecycle: item.lifecycle ?? {},
    legs: item.legs ?? [],
    sortOrder: Number(item.sortOrder ?? 0)
  };
}

function normalizeRecommendationChannels(channels = {}) {
  const fallback = {
    liveSite: { status: "not_requested" },
    email: { status: "not_requested" },
    pdf: { status: "not_requested" },
    script: { status: "not_requested" },
    video: { status: "not_requested" }
  };
  return Object.fromEntries(
    Object.entries({ ...fallback, ...channels }).map(([key, value]) => [
      key,
      {
        status: value?.status ?? "unknown",
        updatedAt: formatDate(value?.updatedAt),
        jobId: value?.jobId ?? null,
        artifact: value?.artifact ?? null
      }
    ])
  );
}

function normalizeWatchlistMarket(market = {}) {
  return {
    id: String(market.id ?? "").toUpperCase(),
    label: market.label ?? market.id ?? "",
    country: market.country ?? "",
    timezone: market.timezone ?? "",
    currency: market.currency ?? "",
    provider: market.provider ?? "manual",
    enabled: market.enabled !== false,
    scanEnabled: market.scanEnabled === true,
    maxSymbolsPerRun: Number(market.maxSymbolsPerRun ?? 150),
    notes: market.notes ?? ""
  };
}

function normalizeWatchlistSymbol(symbol = {}) {
  const market = String(symbol.market ?? "US").toUpperCase();
  const ticker = String(symbol.symbol ?? "").toUpperCase();
  return {
    id: symbol.id ?? `${market}:${ticker}`,
    symbol: ticker,
    market,
    name: symbol.name ?? "",
    providerSymbol: symbol.providerSymbol ?? ticker,
    exchange: symbol.exchange ?? "",
    assetClass: symbol.assetClass ?? "",
    listingSource: symbol.listingSource ?? symbol.source ?? "",
    active: symbol.active !== false,
    group: symbol.group ?? "",
    sector: symbol.sector ?? "",
    marketCapTier: symbol.marketCapTier ?? "unknown",
    enabled: symbol.enabled !== false,
    notes: symbol.notes ?? ""
  };
}

function normalizeUniverseSync(sync = null) {
  if (!sync || typeof sync !== "object" || Array.isArray(sync)) {
    return null;
  }
  const markets = sync.markets && typeof sync.markets === "object" && !Array.isArray(sync.markets)
    ? sync.markets
    : {};
  return {
    updatedAt: formatDate(sync.updatedAt),
    updatedBy: sync.updatedBy ?? null,
    cacheTtlHours: Number(sync.cacheTtlHours ?? 24),
    yahooDailyCallLimit: Number(sync.yahooDailyCallLimit ?? 250),
    markets: Object.fromEntries(Object.entries(markets).map(([marketId, status]) => [
      marketId,
      {
        status: status?.status ?? "unknown",
        source: status?.source ?? "",
        syncedAt: formatDate(status?.syncedAt),
        count: Number(status?.count ?? 0),
        error: status?.error ?? ""
      }
    ]))
  };
}

function normalizeLoginContext(context = null) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return null;
  }
  return {
    ipAddress: context.ipAddress ?? null,
    country: context.country ?? null,
    city: context.city ?? null,
    region: context.region ?? null,
    regionCode: context.regionCode ?? null,
    continent: context.continent ?? null,
    timezone: context.timezone ?? null,
    latitude: context.latitude ?? null,
    longitude: context.longitude ?? null,
    source: context.source ?? null,
    capturedAt: formatDate(context.capturedAt)
  };
}

function normalizeJob(job, artifacts = [], providerJobs = []) {
  const metadata = job.metadata ?? {};
  const providerJob = latestByDate(providerJobs, "updatedAt");
  const sourceArtifact = getSourceArtifact(metadata, artifacts);
  const sourceType = job.sourceType ?? metadata.sourceType ?? "unknown";
  const status = job.status ?? "draft";
  const playback = getPlayback(metadata, artifacts);
  const thumbnail = getJobThumbnail(metadata, artifacts);

  return {
    id: job.id,
    title: job.title,
    type: job.type ?? "video_job",
    sourceType,
    status,
    owner: metadata.owner ?? job.ownerUid ?? "Unknown operator",
    topic: metadata.topic ?? metadata.intakeModeLabel ?? sourceType,
    targetDurationSec: Number(job.targetDurationSec ?? metadata.targetDurationSec ?? 0),
    updatedAt: formatDate(job.updatedAt ?? job.createdAt),
    stage: metadata.stage ?? stageForStatus(status),
    risk: metadata.risk ?? "low",
    sourceArtifact,
    metadata,
    artifacts,
    providerJobs,
    thumbnail,
    reviewSummary: metadata.reviewSummary ?? null,
    video: {
      provider: providerJob?.provider ?? metadata.provider ?? providerForSource(sourceType),
      externalId: providerJob?.externalId ?? metadata.externalId ?? null,
      status: providerJob?.status ?? videoStatusForJob(status, sourceType),
      duration: metadata.duration ?? "pending",
      webhook: providerJob?.lastProviderEventAt ? "received" : providerJob ? "waiting" : "not applicable",
      lastPolledAt: formatDate(providerJob?.lastPolledAt),
      playbackKind: playback.kind,
      playbackUrl: playback.url
    },
    script: {
      scenes: Number(metadata.scenes ?? 0),
      disclaimer: metadata.disclaimer ?? "",
      quality: metadata.scriptQuality ?? scriptQualityForStatus(status),
      preview: buildScriptPreview(metadata)
    }
  };
}

function normalizeVideoStudioProject(body) {
  const projectId = body.project?.projectId ?? body.timeline?.projectId ?? "";
  const timeline = {
    ...(body.timeline ?? {}),
    tracks: (body.timeline?.tracks ?? []).map((track) => ({
      ...track,
      sourceUrl: track.sourceUrl
        ? normalizeInternalAssetUrl(track.sourceUrl) ?? track.sourceUrl
        : track.source
          ? videoStudioAssetUrl(projectId, track.source)
          : null
    }))
  };
  return {
    project: body.project ?? { projectId, title: timeline.title ?? "" },
    timeline,
    status: body.status ?? { status: "draft", message: "Timeline is editable." },
    assets: (body.assets ?? []).map((asset) => ({
      ...asset,
      url: asset.url ? normalizeInternalAssetUrl(asset.url) ?? `${API_BASE_URL.replace(/\/api\/v1$/, "")}${asset.url}` : null
    })),
    output: {
      ...(body.output ?? {}),
      url: body.output?.url ? `${API_BASE_URL.replace(/\/api\/v1$/, "")}${body.output.url}` : null
    },
    uploaded: body.uploaded ?? null
  };
}

function videoStudioAssetUrl(projectId, source) {
  if (!projectId || !source) return null;
  const encodedSource = String(source)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${API_BASE_URL}/video-projects/${encodeURIComponent(projectId)}/assets/${encodedSource}`;
}

function getJobThumbnail(metadata, artifacts) {
  const thumbnailArtifact =
    artifacts.find((artifact) => artifact.id === metadata.thumbnailArtifactId && artifact.kind === "thumbnail") ??
    latestByDate(artifacts.filter((artifact) => artifact.kind === "thumbnail"), "updatedAt");
  const artifactUrl = thumbnailArtifact ? `${API_BASE_URL}/assets/${encodeURIComponent(thumbnailArtifact.id)}/content` : null;
  const metadataUrl = normalizeInternalAssetUrl(metadata.thumbnailUrl);
  const externalUrl = /^https?:\/\//i.test(metadata.thumbnailUrl ?? "") ? metadata.thumbnailUrl : null;
  const url = artifactUrl ?? metadataUrl ?? externalUrl ?? null;
  return {
    url,
    artifactId: thumbnailArtifact?.id ?? metadata.thumbnailArtifactId ?? null,
    source: metadata.thumbnailSource ?? thumbnailArtifact?.metadata?.source ?? (url ? "metadata" : null),
    updatedAt: formatDate(metadata.thumbnailUpdatedAt ?? thumbnailArtifact?.updatedAt ?? thumbnailArtifact?.createdAt)
  };
}

function normalizeInternalAssetUrl(value) {
  if (typeof value !== "string" || !value.startsWith("/api/")) {
    return null;
  }
  return `${API_BASE_URL.replace(/\/api\/v1$/, "")}${value}`;
}

function getPlayback(metadata, artifacts) {
  if (metadata.youtubeUrl) {
    return {
      kind: "youtube",
      url: toYouTubeEmbedUrl(metadata.youtubeUrl)
    };
  }
  if (metadata.videoUrl) {
    return {
      kind: "direct",
      url: metadata.videoUrl
    };
  }

  const videoArtifact = artifacts.find((artifact) => artifact.kind === "video");
  if (!videoArtifact) {
    return { kind: "none", url: null };
  }
  if (videoArtifact.storageProvider === "provider-url" && /^https?:\/\//i.test(videoArtifact.storageKey)) {
    return { kind: "direct", url: videoArtifact.storageKey };
  }
  return {
    kind: "direct",
    url: `${API_BASE_URL}/assets/${encodeURIComponent(videoArtifact.id)}/content`
  };
}

function toYouTubeEmbedUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      return `https://www.youtube.com/embed/${url.pathname.replace("/", "")}`;
    }
    const videoId = url.searchParams.get("v");
    if (videoId) {
      return `https://www.youtube.com/embed/${videoId}`;
    }
    if (url.pathname.includes("/embed/")) {
      return value;
    }
  } catch {
    return value;
  }
  return value;
}

function normalizePublishPlan(plan) {
  return {
    id: plan.id,
    jobId: plan.jobId,
    status: plan.status ?? "draft",
    scheduledAt: formatDate(plan.scheduledAt) ?? "Not scheduled",
    createdAt: formatDate(plan.createdAt),
    approvedBy: plan.approvedBy ?? "Not approved",
    updatedAt: formatDate(plan.updatedAt ?? plan.createdAt),
    title: plan.metadata?.title ?? plan.id,
    description: plan.metadata?.description ?? "",
    hashtags: Array.isArray(plan.metadata?.hashtags) ? plan.metadata.hashtags : [],
    tags: Array.isArray(plan.metadata?.tags) ? plan.metadata.tags : [],
    metadata: plan.metadata ?? {},
    platforms: (plan.platforms ?? []).map(labelPlatform),
    attempts: (plan.attempts ?? []).map((attempt) => ({
      id: attempt.id,
      platform: labelPlatform(attempt.platform),
      account: attempt.metadata?.accountName ?? attempt.connectedAccountId ?? "Not assigned",
      status: attempt.status ?? "queued",
      postId: attempt.providerPostId ?? null,
      providerPostId: attempt.providerPostId ?? null,
      privacyStatus: normalizePrivacyStatus(attempt.metadata),
      publisherStatus: attempt.metadata?.publisherStatus ?? attempt.errorMessage ?? null,
      providerUrl: attempt.providerUrl ?? null,
      connectedAccountId: attempt.connectedAccountId ?? null,
      errorCode: attempt.errorCode ?? null,
      errorMessage: attempt.errorMessage ?? null,
      createdAt: formatDate(attempt.createdAt),
      updatedAt: formatDate(attempt.updatedAt ?? attempt.createdAt),
      metadata: attempt.metadata ?? {},
      progress: normalizePublishProgress(attempt)
    }))
  };
}

function normalizePublication(publication) {
  const metadata = publication.metadata ?? {};
  const youtubeSnippet = metadata.youtube?.response?.snippet ?? {};
  return {
    id: publication.id,
    planId: publication.planId,
    jobId: publication.jobId,
    platform: labelPlatform(publication.platform),
    connectedAccountId: publication.connectedAccountId ?? null,
    account: metadata.accountName ?? publication.connectedAccountId ?? "Not assigned",
    status: publication.status ?? "queued",
    title: metadata.title ?? "",
    description: metadata.description ?? "",
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    hashtags: Array.isArray(metadata.hashtags) ? metadata.hashtags : [],
    privacyStatus: normalizePrivacyStatus(metadata),
    categoryId: metadata.categoryId ?? youtubeSnippet.categoryId ?? youtubeMetadataDefaults.categoryId,
    videoLanguage:
      metadata.videoLanguage ??
      metadata.defaultAudioLanguage ??
      youtubeSnippet.defaultAudioLanguage ??
      youtubeMetadataDefaults.videoLanguage,
    defaultAudioLanguage:
      metadata.defaultAudioLanguage ?? youtubeSnippet.defaultAudioLanguage ?? youtubeMetadataDefaults.videoLanguage,
    shortsRemixing: metadata.shortsRemixing ?? youtubeMetadataDefaults.shortsRemixing,
    titleDescriptionLanguage:
      metadata.titleDescriptionLanguage ??
      metadata.defaultLanguage ??
      youtubeSnippet.defaultLanguage ??
      youtubeMetadataDefaults.titleDescriptionLanguage,
    defaultLanguage:
      metadata.defaultLanguage ?? youtubeSnippet.defaultLanguage ?? youtubeMetadataDefaults.titleDescriptionLanguage,
    educationApplicationType:
      metadata.educationApplicationType ?? youtubeMetadataDefaults.educationApplicationType,
    academicSystem: metadata.academicSystem ?? youtubeMetadataDefaults.academicSystem,
    educationLevel: metadata.educationLevel ?? youtubeMetadataDefaults.educationLevel,
    thumbnailUrl: getPublicationThumbnailUrl(metadata),
    publishedAt: formatDate(metadata.publishedAt ?? metadata.youtube?.publishedAt ?? metadata.youtube?.response?.snippet?.publishedAt),
    viewCount: normalizeCount(metadata.statistics?.viewCount ?? metadata.youtube?.response?.statistics?.viewCount),
    likeCount: normalizeCount(metadata.statistics?.likeCount ?? metadata.youtube?.response?.statistics?.likeCount),
    externalSource: metadata.externalSource ?? null,
    providerPostId: publication.providerPostId ?? null,
    providerUrl: publication.providerUrl ?? null,
    publisherStatus: metadata.publisherStatus ?? publication.errorMessage ?? null,
    progress: normalizePublishProgress(publication),
    updatedAt: formatDate(publication.updatedAt ?? publication.createdAt),
    metadata
  };
}

function getPublicationThumbnailUrl(metadata = {}) {
  return (
    metadata.thumbnailUrl ??
    metadata.youtube?.thumbnailUrl ??
    bestThumbnailUrl(metadata.youtube?.response?.snippet?.thumbnails) ??
    null
  );
}

function bestThumbnailUrl(thumbnails = {}) {
  return (
    thumbnails.maxres?.url ??
    thumbnails.standard?.url ??
    thumbnails.high?.url ??
    thumbnails.medium?.url ??
    thumbnails.default?.url ??
    null
  );
}

function normalizeCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return new Intl.NumberFormat(undefined, { notation: numeric >= 10000 ? "compact" : "standard" }).format(numeric);
}

function normalizePrivacyStatus(metadata = {}) {
  return (
    metadata.privacyStatus ??
    metadata.youtube?.privacyStatus ??
    metadata.youtube?.response?.status?.privacyStatus ??
    "unknown"
  );
}

function normalizePublishProgress(record) {
  const metadata = record.metadata ?? {};
  const status = record.status ?? "queued";
  return {
    stage: metadata.progressStage ?? progressStageForStatus(status),
    percent: clampPercent(metadata.progressPercent ?? progressPercentForStatus(status)),
    label: metadata.progressLabel ?? metadata.publisherStatus ?? record.errorMessage ?? progressLabelForStatus(status),
    uploadedBytes: Number.isFinite(Number(metadata.uploadedBytes)) ? Number(metadata.uploadedBytes) : null,
    totalBytes: Number.isFinite(Number(metadata.totalBytes)) ? Number(metadata.totalBytes) : null,
    lastProgressAt: formatDate(metadata.lastProgressAt ?? record.updatedAt ?? record.createdAt)
  };
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

function progressStageForStatus(status) {
  const stages = {
    draft: "draft",
    approved: "approved",
    queued: "queued",
    retrying: "queued",
    uploading: "uploading",
    processing: "provider_processing",
    published: "published",
    failed: "failed",
    delete_requested: "deleting",
    deleted: "deleted"
  };
  return stages[status] ?? status;
}

function progressPercentForStatus(status) {
  const percentages = {
    draft: 0,
    approved: 5,
    queued: 10,
    retrying: 10,
    uploading: 45,
    processing: 80,
    published: 100,
    failed: 0,
    delete_requested: 45,
    deleted: 100
  };
  return percentages[status] ?? 0;
}

function progressLabelForStatus(status) {
  const labels = {
    draft: "Publishing is still being prepared.",
    approved: "Approved and waiting to publish.",
    queued: "Queued for publisher worker.",
    retrying: "Queued for retry.",
    uploading: "Uploading video to channel.",
    processing: "Channel is processing the uploaded video.",
    published: "Published on platform.",
    failed: "Publish attempt failed.",
    delete_requested: "Deleting video from channel.",
    deleted: "Deleted from platform."
  };
  return labels[status] ?? status;
}

function latestByDate(records, field) {
  return [...records].sort((left, right) => {
    const leftTime = Date.parse(left?.[field] ?? left?.createdAt ?? 0);
    const rightTime = Date.parse(right?.[field] ?? right?.createdAt ?? 0);
    return rightTime - leftTime;
  })[0];
}

function getSourceArtifact(metadata, artifacts) {
  if (metadata.sourceArtifact) return metadata.sourceArtifact;
  if (metadata.youtubeUrl) return metadata.youtubeUrl;
  if (metadata.fileName) return metadata.fileName;
  if (metadata.prompt) return "Text prompt";

  const artifact = artifacts[0];
  return artifact?.metadata?.filename ?? artifact?.storageKey ?? "Not attached";
}

function providerForSource(sourceType) {
  if (sourceType === "text_to_heygen") return "HeyGen";
  if (sourceType === "youtube_embed") return "YouTube";
  if (sourceType === "video_upload") return "Local upload";
  return "manual";
}

function videoStatusForJob(status, sourceType) {
  if (status === "video_requested") return "processing";
  if (["video_ready", "review_required", "approved", "publishing", "published"].includes(status)) return "ready";
  if (sourceType === "video_upload" || sourceType === "youtube_embed") return "ready";
  return "not_requested";
}

function scriptQualityForStatus(status) {
  if (status === "approved") return "Approved";
  if (status === "review_required") return "Needs reviewer signoff";
  if (status === "script_ready") return "Ready for editor";
  return "Draft";
}

function stageForStatus(status) {
  const labels = {
    draft: "Draft",
    source_ingested: "Source ingested",
    content_extracted: "Content extracted",
    script_ready: "Script ready",
    video_requested: "Rendering video",
    video_ready: "Video ready",
    review_required: "Review required",
    approved: "Approved for publishing",
    publishing: "Publishing",
    published: "Published",
    partial_failed: "Publishing retry needed",
    failed: "Failed"
  };
  return labels[status] ?? status;
}

function buildScriptPreview(metadata) {
  if (Array.isArray(metadata.scriptPreview)) {
    return metadata.scriptPreview.filter(Boolean);
  }
  if (typeof metadata.reviewScriptText === "string" && metadata.reviewScriptText.trim()) {
    return metadata.reviewScriptText
      .split(/\n{2,}/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
  if (metadata.prompt) {
    return [metadata.prompt];
  }
  return [];
}

function formatDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function labelPlatform(platform) {
  const labels = {
    youtube: "YouTube",
    x: "X",
    linkedin: "LinkedIn",
    instagram: "Instagram",
    facebook: "Facebook",
    tiktok: "TikTok"
  };
  return labels[String(platform ?? "").toLowerCase()] ?? platform;
}
