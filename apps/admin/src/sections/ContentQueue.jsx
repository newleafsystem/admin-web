import { useEffect, useMemo, useState } from "react";
import { StatusBadge } from "../components/common.jsx";
import { ThumbnailManager } from "../components/ThumbnailManager.jsx";
import { formatDuration, isReviewableJob } from "../utils.js";
import { PublishingPlans } from "./PublishingPlans.jsx";
import { VideoStatus } from "./VideoStatus.jsx";

export function ContentQueue({
  approvePlan,
  connectedAccounts,
  filteredJobs,
  jobs,
  publications,
  publishDraft,
  publishPlans,
  query,
  pollAssemblySegment,
  retryAttempt,
  requestYouTubeTagGeneration,
  requestQueueJobDelete,
  selectedJob,
  setActiveView,
  setQuery,
  setSelectedJobId,
  setStatusFilter,
  socialPlatforms,
  startPublishing,
  statusFilter,
  submitPublishDraft,
  togglePublishPlatform,
  updatePublishDraft,
  uploadAssemblySegmentClip,
  uploadThumbnail,
  generateThumbnail
}) {
  const [detailJobId, setDetailJobId] = useState(null);
  const detailJob = useMemo(
    () => jobs.find((job) => job.id === detailJobId) ?? null,
    [detailJobId, jobs]
  );
  const scopedJobs = selectedJob ? [selectedJob] : jobs;
  const scopedPublishPlans = selectedJob
    ? publishPlans.filter((plan) => plan.jobId === selectedJob.id)
    : publishPlans;
  const scopedPublications = selectedJob
    ? publications.filter((publication) => publication.jobId === selectedJob.id)
    : publications;

  useEffect(() => {
    if (!detailJobId) {
      return undefined;
    }

    function closeOnEscape(event) {
      if (event.key === "Escape") {
        setDetailJobId(null);
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [detailJobId]);

  function openJobDetails(jobId) {
    setSelectedJobId(jobId);
    setDetailJobId(jobId);
  }

  return (
    <div className="view-stack">
      <section className="panel">
        <div className="queue-toolbar">
          <label>
            Search
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Title, owner, artifact"
            />
          </label>
          <label>
            Status
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="draft">Draft</option>
              <option value="source_ingested">Source ingested</option>
              <option value="content_extracted">Content extracted</option>
              <option value="script_ready">Script ready</option>
              <option value="video_requested">Video requested</option>
              <option value="video_ready">Video ready</option>
              <option value="review_required">Review required</option>
              <option value="approved">Approved</option>
              <option value="publishing">Publishing</option>
              <option value="published">Published</option>
              <option value="partial_failed">Partial failed</option>
              <option value="failed">Failed</option>
            </select>
          </label>
        </div>

        <div className="queue-layout">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Updated</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.length === 0 ? (
                  <tr>
                    <td className="table-empty" colSpan="6">
                      No content jobs yet.
                    </td>
                  </tr>
                ) : (
                  filteredJobs.map((job) => (
                    <tr
                      className={selectedJob?.id === job.id ? "selected" : ""}
                      key={job.id}
                      onClick={() => openJobDetails(job.id)}
                    >
                      <td>
                        <strong>{job.title}</strong>
                        <small>{job.topic}</small>
                      </td>
                      <td>{job.owner}</td>
                      <td>
                        <StatusBadge status={job.status} />
                      </td>
                      <td>{job.sourceType}</td>
                      <td>{job.updatedAt ?? "Unknown"}</td>
                      <td>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openJobDetails(job.id);
                          }}
                        >
                          View details
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {detailJob && (
        <ContentJobDetailsModal
          job={detailJob}
          onClose={() => setDetailJobId(null)}
          openReview={() => {
            setSelectedJobId(detailJob.id);
            setDetailJobId(null);
            setActiveView("Review");
          }}
          requestQueueJobDelete={async () => {
            await requestQueueJobDelete(detailJob.id);
            setDetailJobId(null);
          }}
          uploadThumbnail={uploadThumbnail}
          generateThumbnail={generateThumbnail}
        />
      )}

      <div className="operations-accordion">
        <details className="operations-details">
          <summary>
            <span>
              <strong>Publishing Controls</strong>
              <small>Create plans, approve destinations, publish, or retry failed attempts.</small>
            </span>
          </summary>
          <PublishingPlans
            approvePlan={approvePlan}
            connectedAccounts={connectedAccounts}
            jobs={jobs}
            publications={publications}
            publishDraft={publishDraft}
            publishPlans={publishPlans}
            retryAttempt={retryAttempt}
            requestYouTubeTagGeneration={requestYouTubeTagGeneration}
            socialPlatforms={socialPlatforms}
            startPublishing={startPublishing}
            submitPublishDraft={submitPublishDraft}
            togglePublishPlatform={togglePublishPlatform}
            updatePublishDraft={updatePublishDraft}
          />
        </details>

        <details className="operations-details">
          <summary>
            <span>
              <strong>Media And Upload Status</strong>
              <small>{selectedJob ? `Scoped to ${selectedJob.title}` : "All jobs"}</small>
            </span>
          </summary>
          <VideoStatus
            jobs={scopedJobs}
            publications={scopedPublications}
            publishPlans={scopedPublishPlans}
            pollAssemblySegment={pollAssemblySegment}
            setActiveView={setActiveView}
            showPublishingButton={false}
            uploadAssemblySegmentClip={uploadAssemblySegmentClip}
          />
        </details>
      </div>
    </div>
  );
}

function ContentJobDetailsModal({
  job,
  onClose,
  openReview,
  requestQueueJobDelete,
  uploadThumbnail,
  generateThumbnail
}) {
  const canOpenReview = isReviewableJob(job);
  const canDelete = [
    "draft",
    "source_ingested",
    "content_extracted",
    "script_ready",
    "video_requested",
    "video_ready",
    "review_required",
    "approved",
    "publishing",
    "partial_failed",
    "failed"
  ].includes(job.status);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-labelledby="content-job-details-title"
        aria-modal="true"
        className="modal-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <p className="eyebrow">Content job</p>
            <h2 id="content-job-details-title">{job.title}</h2>
          </div>
          <div className="modal-header-actions">
            <StatusBadge status={job.status} />
            <button aria-label="Close job details" className="modal-close" type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <dl className="detail-list modal-detail-list">
          <div>
            <dt>Job ID</dt>
            <dd>{job.id}</dd>
          </div>
          <div>
            <dt>Source artifact</dt>
            <dd>{job.sourceArtifact}</dd>
          </div>
          <div>
            <dt>Target duration</dt>
            <dd>{formatDuration(job.targetDurationSec)}</dd>
          </div>
          <div>
            <dt>Script scenes</dt>
            <dd>{job.script.scenes}</dd>
          </div>
          <div>
            <dt>Video state</dt>
            <dd>{job.video.status}</dd>
          </div>
        </dl>

        <div className="modal-section">
          <div className="section-subheading thumbnail-subheading">
            <h3>Thumbnail</h3>
            <span className="muted">Manage the image used for review and publishing metadata.</span>
          </div>
          <ThumbnailManager
            generateThumbnail={generateThumbnail}
            job={job}
            uploadThumbnail={uploadThumbnail}
          />
        </div>

        <div className="modal-actions">
          {canDelete && (
            <button className="danger" type="button" onClick={requestQueueJobDelete}>
              Delete from queue
            </button>
          )}
          <button type="button" onClick={onClose}>
            Done
          </button>
          {canOpenReview && (
            <button className="primary" type="button" onClick={openReview}>
              Open review workspace
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
