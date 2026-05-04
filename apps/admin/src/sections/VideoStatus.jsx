import { useState } from "react";
import { statusText } from "../constants.js";
import { ProgressMeter, StatusBadge } from "../components/common.jsx";
import { isArchivedPublishPlan } from "../utils.js";

export function VideoStatus({
  jobs,
  publications,
  publishPlans,
  pollAssemblySegment = null,
  setActiveView,
  showPublishingButton = true,
  uploadAssemblySegmentClip = null
}) {
  const [uploadingSegment, setUploadingSegment] = useState(null);
  const [pollingSegment, setPollingSegment] = useState(null);
  const jobTitleById = new Map(jobs.map((job) => [job.id, job.title]));
  const publicationById = new Map(publications.map((publication) => [publication.id, publication]));
  const assemblyJobs = jobs.filter((job) => job.metadata?.videoAssembly);
  const publishRows = publishPlans.filter(isActivePublishPlan).flatMap((plan) => {
    const activeAttempts = plan.attempts.filter(isActivePublishAttempt);
    if (activeAttempts.length === 0) {
      return [
        {
          id: `${plan.id}:pending`,
          plan,
          attempt: null,
          publication: null
        }
      ];
    }

    return activeAttempts.map((attempt) => ({
      id: attempt.id ?? `${plan.id}:${attempt.platform}`,
      plan,
      attempt,
      publication: publicationById.get(attempt.id)
    }));
  });

  async function handleAssemblyUpload(job, segment, file) {
    if (!file || !uploadAssemblySegmentClip) {
      return;
    }

    const uploadKey = `${job.id}:${segment.heygenVideoId}`;
    setUploadingSegment(uploadKey);
    try {
      await uploadAssemblySegmentClip(job.id, segment.heygenVideoId, file);
    } finally {
      setUploadingSegment(null);
    }
  }

  async function handleAssemblyPoll(job, segment) {
    if (!pollAssemblySegment) {
      return;
    }

    const providerJob = findProviderJobForSegment(job, segment);
    if (!providerJob?.id) {
      return;
    }

    const pollKey = `${job.id}:${segment.heygenVideoId}`;
    setPollingSegment(pollKey);
    try {
      await pollAssemblySegment(job.id, providerJob.id);
    } finally {
      setPollingSegment(null);
    }
  }

  return (
    <div className="view-stack">
      <section className="panel">
        <div className="panel-heading">
          <h2>Media Readiness</h2>
          <span className="muted">Source asset and HeyGen render state</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Content job</th>
                <th>Source</th>
                <th>Asset status</th>
                <th>Generation job</th>
                <th>Last event</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 ? (
                <tr>
                  <td className="table-empty" colSpan="5">
                    No video assets yet.
                  </td>
                </tr>
              ) : (
                jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <strong>{job.title}</strong>
                      <small>{job.id}</small>
                    </td>
                    <td>{sourceLabelForJob(job)}</td>
                    <td>
                      <StatusBadge status={job.video.status} />
                    </td>
                    <td>{providerJobLabel(job)}</td>
                    <td>{mediaLastEventLabel(job)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {assemblyJobs.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Segment Assembly</h2>
              <span className="muted">Manifest ordered clips for final video stitching</span>
            </div>
          </div>
          <div className="assembly-status-list">
            {assemblyJobs.map((job) => (
              <AssemblyStatusCard
                handleAssemblyUpload={handleAssemblyUpload}
                handleAssemblyPoll={handleAssemblyPoll}
                job={job}
                key={job.id}
                pollAssemblySegment={pollAssemblySegment}
                pollingSegment={pollingSegment}
                uploadAssemblySegmentClip={uploadAssemblySegmentClip}
                uploadingSegment={uploadingSegment}
              />
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Channel Upload Progress</h2>
            <span className="muted">Per-destination upload and provider processing state</span>
          </div>
          {showPublishingButton && (
            <button type="button" onClick={() => setActiveView("Content Queue")}>
              Open queue
            </button>
          )}
        </div>

        {publishRows.length === 0 ? (
          <div className="empty-inline">No publishing activity yet.</div>
        ) : (
          <div className="channel-progress-list">
            {publishRows.map(({ id, plan, attempt, publication }) => {
              const progress = channelProgressForRow(plan, attempt, publication);
              return (
                <article className="channel-progress-row" key={id}>
                  <div className="channel-progress-top">
                    <span>
                      <strong>{jobTitleById.get(plan.jobId) ?? plan.title}</strong>
                      <small>{attempt?.platform ?? plan.platforms.join(", ")}</small>
                    </span>
                    <StatusBadge status={publication?.status ?? attempt?.status ?? plan.status} />
                  </div>
                  <ProgressMeter progress={progress} />
                  <dl className="channel-progress-meta">
                    <div>
                      <dt>Plan</dt>
                      <dd>{plan.id}</dd>
                    </div>
                    <div>
                      <dt>Attempt</dt>
                      <dd>{attempt?.id ?? "Not created"}</dd>
                    </div>
                    <div>
                      <dt>Account</dt>
                      <dd>{publication?.account ?? attempt?.account ?? "Not assigned"}</dd>
                    </div>
                    <div>
                      <dt>Provider response</dt>
                      <dd>{publication?.providerUrl ?? publication?.providerPostId ?? attempt?.providerUrl ?? "Pending"}</dd>
                    </div>
                  </dl>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function sourceLabelForJob(job) {
  if (job.metadata?.assemblyMode === "segmented_hybrid") {
    return "Segmented / hybrid";
  }
  const labels = {
    video_upload: "Local upload",
    youtube_embed: "YouTube embed",
    text_to_heygen: "Text to HeyGen"
  };
  return labels[job.sourceType] ?? job.sourceType;
}

function isActivePublishPlan(plan) {
  return !isArchivedPublishPlan(plan);
}

function isActivePublishAttempt(attempt) {
  return attempt.status !== "deleted";
}

function providerJobLabel(job) {
  const assembly = job.metadata?.videoAssembly;
  if (assembly) {
    return `${assembly.completedSegments ?? 0}/${assembly.requiredSegments ?? 0} clips ready`;
  }
  if (job.video.externalId) {
    return job.video.externalId;
  }
  if (["video_upload", "youtube_embed"].includes(job.sourceType)) {
    return "Provider not required";
  }
  return "Not requested";
}

function mediaLastEventLabel(job) {
  if (job.metadata?.videoAssembly?.updatedAt) {
    return job.metadata.videoAssembly.updatedAt;
  }
  if (job.video.lastPolledAt) {
    return job.video.lastPolledAt;
  }
  if (job.video.webhook === "not applicable") {
    return "No polling needed";
  }
  return "Not polled yet";
}

function AssemblyStatusCard({
  job,
  handleAssemblyUpload,
  handleAssemblyPoll,
  pollAssemblySegment,
  pollingSegment,
  uploadAssemblySegmentClip,
  uploadingSegment
}) {
  const assembly = job.metadata.videoAssembly;
  const requiredSegments = Number(assembly.requiredSegments ?? 0);
  const completedSegments = Number(assembly.completedSegments ?? 0);
  const percent = requiredSegments > 0 ? Math.round((completedSegments / requiredSegments) * 100) : 0;
  const pendingSegments = assembly.pendingSegments ?? [];

  return (
    <article className="assembly-status-card">
      <div className="channel-progress-top">
        <span>
          <strong>{job.title}</strong>
          <small>{assembly.projectId}</small>
        </span>
        <StatusBadge status={assembly.status ?? job.status} />
      </div>
      <ProgressMeter
        progress={{
          stage: assembly.status ?? job.status,
          percent,
          label:
            pendingSegments.length === 0
              ? "All required clips are ready."
              : `${completedSegments}/${requiredSegments} required clips ready.`,
          uploadedBytes: null,
          totalBytes: null,
          lastProgressAt: assembly.updatedAt
        }}
      />
      {pendingSegments.length === 0 ? (
        <div className="empty-inline">No pending clips.</div>
      ) : (
        <div className="assembly-segment-list">
          {pendingSegments.map((segment) => {
            const uploadKey = `${job.id}:${segment.heygenVideoId}`;
            const isUploading = uploadingSegment === uploadKey;
            const isPolling = pollingSegment === uploadKey;
            const providerJob = findProviderJobForSegment(job, segment);
            return (
              <div className="assembly-segment-row" key={`${job.id}:${segment.sequence}:${segment.segmentKey}`}>
                <span>
                  <strong>
                    {segment.sequence} - {segment.segmentKey}
                  </strong>
                  <small>{segment.heygenVideoId}</small>
                </span>
                <StatusBadge status={segment.status} />
                {pollAssemblySegment && providerJob?.id && (
                  <button type="button" disabled={isPolling} onClick={() => handleAssemblyPoll(job, segment)}>
                    {isPolling ? "Polling..." : "Poll HeyGen"}
                  </button>
                )}
                {uploadAssemblySegmentClip && (
                  <label className="assembly-upload-control">
                    {isUploading ? "Uploading..." : "Upload clip"}
                    <input
                      accept="video/*"
                      disabled={isUploading}
                      type="file"
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null;
                        event.target.value = "";
                        handleAssemblyUpload(job, segment, file);
                      }}
                    />
                  </label>
                )}
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

function findProviderJobForSegment(job, segment) {
  return (job.providerJobs ?? []).find((providerJob) => providerJob.externalId === segment.heygenVideoId);
}

function publishingProgressLabel(plan, attempt, publication) {
  if (publication?.publisherStatus) {
    return publication.publisherStatus;
  }
  if (attempt?.publisherStatus) {
    return attempt.publisherStatus;
  }
  if (!attempt) {
    return plan.status === "approved"
      ? "Approved and waiting for Publish."
      : "Publish attempts have not started.";
  }
  if (attempt.status === "queued") {
    return "Queued for publisher worker.";
  }
  if (attempt.status === "failed") {
    return "Publish attempt failed.";
  }
  if (attempt.status === "published") {
    return "Published on platform.";
  }
  return statusText[attempt.status] ?? attempt.status;
}

function channelProgressForRow(plan, attempt, publication) {
  if (publication?.progress) {
    return publication.progress;
  }
  if (attempt?.progress) {
    return attempt.progress;
  }
  if (!attempt) {
    return {
      stage: plan.status,
      percent: plan.status === "approved" ? 5 : 0,
      label: publishingProgressLabel(plan, attempt, publication),
      uploadedBytes: null,
      totalBytes: null,
      lastProgressAt: null
    };
  }
  return {
    stage: attempt.status,
    percent: attempt.status === "published" ? 100 : attempt.status === "queued" ? 10 : 0,
    label: publishingProgressLabel(plan, attempt, publication),
    uploadedBytes: null,
    totalBytes: null,
    lastProgressAt: null
  };
}
