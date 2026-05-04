import { useEffect, useMemo } from "react";
import { StatusBadge } from "../components/common.jsx";
import {
  buildUnavailablePublishMap,
  getIntegratedPlatforms,
  getRemainingPublishPlatforms,
  isArchivedPublishPlan
} from "../utils.js";

export function PublishingPlans({
  approvePlan,
  connectedAccounts,
  jobs,
  publications,
  publishDraft,
  publishPlans,
  retryAttempt,
  requestYouTubeTagGeneration,
  socialPlatforms,
  startPublishing,
  submitPublishDraft,
  togglePublishPlatform,
  updatePublishDraft
}) {
  const jobTitleById = new Map(jobs.map((job) => [job.id, job.title]));
  const integratedPlatforms = useMemo(
    () => getIntegratedPlatforms(connectedAccounts, socialPlatforms),
    [connectedAccounts, socialPlatforms]
  );
  const unavailableByJob = useMemo(
    () => buildUnavailablePublishMap({ publishPlans, publications }),
    [publishPlans, publications]
  );
  const activePublishPlans = publishPlans.filter(isActivePublishPlan);
  const publishableJobs = jobs.filter((job) =>
    ["approved", "partial_failed", "publishing"].includes(job.status)
  );
  const jobsWithRemainingDestinations = publishableJobs.filter(
    (job) => getRemainingPublishPlatforms(job.id, integratedPlatforms, unavailableByJob).length > 0
  );
  const publishableJobIds = jobsWithRemainingDestinations.map((job) => job.id);
  const readyJobs = jobsWithRemainingDestinations.filter((job) => job.status === "approved");
  const selectedDestinationPlatforms = publishDraft.jobId
    ? getRemainingPublishPlatforms(publishDraft.jobId, integratedPlatforms, unavailableByJob)
    : integratedPlatforms;
  const selectedDestinationIds = selectedDestinationPlatforms.map((platform) => platform.id);
  const includesYouTube = publishDraft.platforms.includes("youtube") && selectedDestinationIds.includes("youtube");

  useEffect(() => {
    if (publishDraft.jobId && !publishableJobIds.includes(publishDraft.jobId)) {
      updatePublishDraft({
        jobId: "",
        platforms: integratedPlatforms.length === 1 ? [integratedPlatforms[0].id] : []
      });
    }
  }, [integratedPlatforms, publishDraft.jobId, publishableJobIds, updatePublishDraft]);

  useEffect(() => {
    const cleanedPlatforms = publishDraft.platforms.filter((platform) => selectedDestinationIds.includes(platform));
    const nextPlatforms =
      cleanedPlatforms.length === 0 && selectedDestinationIds.length === 1
        ? selectedDestinationIds
        : cleanedPlatforms;
    const changed =
      nextPlatforms.length !== publishDraft.platforms.length ||
      nextPlatforms.some((platform, index) => platform !== publishDraft.platforms[index]);

    if (changed) {
      updatePublishDraft({ platforms: nextPlatforms });
    }
  }, [publishDraft.platforms, selectedDestinationIds, updatePublishDraft]);

  const destinationHelp =
    integratedPlatforms.length === 0
      ? "Connect at least one publishing account before creating a publish plan."
      : publishDraft.jobId && selectedDestinationPlatforms.length === 0
        ? "This job is already published, planned, or publishing to every connected platform."
        : null;

  const canCreatePlan = Boolean(
    !publishDraft.isSubmitting &&
      publishDraft.jobId &&
      publishDraft.platforms.length > 0 &&
      publishDraft.title.trim() &&
      publishDraft.description.trim() &&
      selectedDestinationPlatforms.length > 0
  );

  return (
    <div className="view-stack">
      {readyJobs.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <h2>Ready For Publishing</h2>
            <span className="muted">{readyJobs.length} approved job{readyJobs.length === 1 ? "" : "s"}</span>
          </div>
          <div className="compact-list">
            {readyJobs.map((job) => (
              <button
                className="compact-row"
                key={job.id}
                type="button"
                onClick={() => updatePublishDraft({ jobId: job.id })}
              >
                <span>
                  <strong>{job.title}</strong>
                  <small>{job.sourceArtifact}</small>
                </span>
                <StatusBadge status={job.status} />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <form className="publish-form" onSubmit={submitPublishDraft}>
          <div className="panel-heading">
            <h2>New Publish Plan</h2>
            <button className="primary" type="submit" disabled={!canCreatePlan}>
              {publishDraft.isSubmitting ? "Creating..." : "Create plan"}
            </button>
          </div>
          <div className="publish-form-grid">
            <label>
              Job
              <select
                value={publishDraft.jobId}
                onChange={(event) => updatePublishDraft({ jobId: event.target.value })}
              >
                <option value="">Select job</option>
                {jobsWithRemainingDestinations.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Schedule
              <input
                type="datetime-local"
                value={publishDraft.scheduledAt}
                onChange={(event) => updatePublishDraft({ scheduledAt: event.target.value })}
              />
            </label>
          </div>
          <div className="publish-metadata-grid">
            <label>
              Title
              <input
                required
                value={publishDraft.title}
                onChange={(event) => updatePublishDraft({ title: event.target.value })}
                placeholder="Public video or post title"
              />
            </label>
            <label className="publish-description-field">
              Description
              <textarea
                required
                value={publishDraft.description}
                onChange={(event) => updatePublishDraft({ description: event.target.value })}
                placeholder="Description or post copy"
              />
            </label>
            <label>
              Hashtags
              <input
                value={publishDraft.hashtagsText}
                onChange={(event) => updatePublishDraft({ hashtagsText: event.target.value })}
                placeholder="#newleaf, #markets"
              />
            </label>
            {includesYouTube && (
              <label>
                YouTube tags
                <span className="inline-control">
                  <input
                    value={publishDraft.youtubeTagsText}
                    onChange={(event) => updatePublishDraft({ youtubeTagsText: event.target.value })}
                    placeholder="search tags for YouTube metadata"
                  />
                  <button
                    type="button"
                    disabled={
                      publishDraft.isGeneratingYoutubeTags ||
                      !publishDraft.jobId ||
                      !publishDraft.title.trim() ||
                      !publishDraft.description.trim()
                    }
                    onClick={requestYouTubeTagGeneration}
                  >
                    {publishDraft.isGeneratingYoutubeTags ? "Generating..." : "Generate AI tags"}
                  </button>
                </span>
              </label>
            )}
          </div>
          <div className="destination-grid" aria-label="Publish destinations">
            {selectedDestinationPlatforms.length === 0 ? (
              <div className="empty-inline destination-empty">{destinationHelp}</div>
            ) : (
              selectedDestinationPlatforms.map((platform) => (
                <label className="check-row" key={platform.id}>
                  <input
                    checked={publishDraft.platforms.includes(platform.id)}
                    type="checkbox"
                    onChange={() => togglePublishPlatform(platform.id)}
                  />
                  <span>{platform.label}</span>
                </label>
              ))
            )}
          </div>
          {destinationHelp && selectedDestinationPlatforms.length > 0 && (
            <p className="muted">{destinationHelp}</p>
          )}
          {publishDraft.error && <p className="form-error">{publishDraft.error}</p>}
        </form>
      </section>

      <div className="publish-grid">
        {activePublishPlans.length === 0 ? (
          <section className="empty-state">No publishing plans yet.</section>
        ) : (
          activePublishPlans.map((plan) => {
            const activeAttempts = plan.attempts.filter((attempt) => attempt.status !== "deleted");
            return (
            <section className="panel" key={plan.id}>
              <div className="panel-heading">
                <div>
                  <h2>{plan.title}</h2>
                  <span className="muted">{jobTitleById.get(plan.jobId)}</span>
                </div>
                <span className="attempt-actions">
                  <StatusBadge status={plan.status} />
                  {plan.status === "draft" && (
                    <button type="button" onClick={() => approvePlan(plan.id)}>
                      Approve
                    </button>
                  )}
                  {plan.status === "approved" && (
                    <button type="button" onClick={() => startPublishing(plan.id)}>
                      Publish
                    </button>
                  )}
                </span>
              </div>
              <dl className="detail-list compact-details">
                <div>
                  <dt>Schedule</dt>
                  <dd>{plan.scheduledAt}</dd>
                </div>
                <div>
                  <dt>Approved by</dt>
                  <dd>{plan.approvedBy}</dd>
                </div>
              </dl>
              <div className="attempt-list">
                {activeAttempts.length === 0 ? (
                  <div className="empty-inline">No publish attempts yet.</div>
                ) : (
                  activeAttempts.map((attempt) => (
                    <div className="attempt-row" key={attempt.id ?? attempt.platform}>
                      <span>
                        <strong>{attempt.platform}</strong>
                        <small>{attempt.account}</small>
                        {attempt.publisherStatus && <small>{attempt.publisherStatus}</small>}
                      </span>
                      <span className="attempt-actions">
                        <StatusBadge status={attempt.status} />
                        {attempt.status === "failed" && (
                          <button
                            type="button"
                            onClick={() => retryAttempt(plan.id, attempt)}
                          >
                            Retry
                          </button>
                        )}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
            );
          })
        )}
      </div>
    </div>
  );
}

function isActivePublishPlan(plan) {
  return !isArchivedPublishPlan(plan);
}
