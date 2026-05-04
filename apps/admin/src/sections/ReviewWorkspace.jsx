import { useEffect, useState } from "react";
import { SummaryBlock, VideoPlayer } from "../components/common.jsx";
import { ThumbnailManager } from "../components/ThumbnailManager.jsx";

export function ReviewWorkspace({
  approveSelectedJob,
  generateSelectedSummary,
  openPublishing,
  requestReviewJobDelete,
  requestRegeneration,
  saveReviewScript,
  selectedJob,
  summaryWorkflow,
  uploadThumbnail,
  generateThumbnail
}) {
  const [deleteConfirmation, setDeleteConfirmation] = useState(null);
  const [deleteWorkflow, setDeleteWorkflow] = useState({ jobId: null, isDeleting: false, error: null });
  const scriptSeed = getEditableScriptText(selectedJob);
  const [scriptText, setScriptText] = useState(scriptSeed);
  const [scriptWorkflow, setScriptWorkflow] = useState({
    isSaving: false,
    isRegenerating: false,
    error: null,
    message: null
  });

  useEffect(() => {
    setScriptText(scriptSeed);
    setScriptWorkflow({ isSaving: false, isRegenerating: false, error: null, message: null });
  }, [selectedJob?.id]);

  if (!selectedJob) {
    return (
      <section className="empty-state">
        <div className="empty-stack">
          <strong>No videos are waiting for review.</strong>
          <span>Approved, publishing, and published videos are managed from Content Queue or Published Videos.</span>
          <button type="button" onClick={openPublishing}>
            Open content queue
          </button>
        </div>
      </section>
    );
  }
  const summary = selectedJob.reviewSummary;
  const isGeneratingSummary =
    summaryWorkflow.isGenerating && summaryWorkflow.jobId === selectedJob.id;
  const summaryError = summaryWorkflow.jobId === selectedJob.id ? summaryWorkflow.error : null;
  const canApprove = ["review_required", "video_ready"].includes(selectedJob.status);
  const canDeleteReview = canApprove;
  const isApprovedForPublishing = ["approved", "publishing", "published"].includes(selectedJob.status);
  const showScriptPanel =
    selectedJob.sourceType === "text_to_heygen" && selectedJob.script.preview.length > 0;
  const canRegenerateHeyGen = showScriptPanel;
  const isDeleting = deleteWorkflow.isDeleting && deleteWorkflow.jobId === selectedJob.id;
  const isScriptBusy = scriptWorkflow.isSaving || scriptWorkflow.isRegenerating;
  const scriptHasChanges = scriptText.trim() !== scriptSeed.trim();

  async function confirmReviewDelete() {
    if (!deleteConfirmation) {
      return;
    }

    setDeleteWorkflow({ jobId: deleteConfirmation.jobId, isDeleting: true, error: null });
    try {
      await requestReviewJobDelete(deleteConfirmation.jobId);
      setDeleteConfirmation(null);
      setDeleteWorkflow({ jobId: null, isDeleting: false, error: null });
    } catch (error) {
      setDeleteWorkflow({ jobId: deleteConfirmation.jobId, isDeleting: false, error: error.message });
    }
  }

  async function saveScriptEdits() {
    setScriptWorkflow({ isSaving: true, isRegenerating: false, error: null, message: null });
    try {
      await saveReviewScript(selectedJob.id, scriptText);
      setScriptWorkflow({
        isSaving: false,
        isRegenerating: false,
        error: null,
        message: "Script saved."
      });
    } catch (error) {
      setScriptWorkflow({
        isSaving: false,
        isRegenerating: false,
        error: error.message,
        message: null
      });
    }
  }

  async function regenerateVideoFromScript() {
    setScriptWorkflow({ isSaving: false, isRegenerating: true, error: null, message: null });
    try {
      await saveReviewScript(selectedJob.id, scriptText);
      await requestRegeneration("video", selectedJob.id, { scriptText, throwOnError: true });
      setScriptWorkflow({
        isSaving: false,
        isRegenerating: false,
        error: null,
        message: "Video regeneration requested from the edited script."
      });
    } catch (error) {
      setScriptWorkflow({
        isSaving: false,
        isRegenerating: false,
        error: error.message,
        message: null
      });
    }
  }

  return (
    <div className="view-stack">
      <section className="review-header panel">
        <div>
          <p className="eyebrow">Review job</p>
          <h2>{selectedJob.title}</h2>
          {selectedJob.script.disclaimer && <p>{selectedJob.script.disclaimer}</p>}
        </div>
        <div className="action-row">
          {canRegenerateHeyGen && (
            <>
              <button type="button" onClick={() => requestRegeneration("script", selectedJob.id)}>
                Regenerate script
              </button>
              <button type="button" disabled={isScriptBusy} onClick={regenerateVideoFromScript}>
                {scriptWorkflow.isRegenerating ? "Requesting..." : "Regenerate video"}
              </button>
            </>
          )}
          <button type="button" onClick={() => generateSelectedSummary(selectedJob.id)} disabled={isGeneratingSummary}>
            {isGeneratingSummary ? "Generating..." : "Generate summary"}
          </button>
          {canDeleteReview && (
            <button
              className="danger"
              type="button"
              disabled={isDeleting}
              onClick={() =>
                setDeleteConfirmation({
                  jobId: selectedJob.id,
                  title: selectedJob.title,
                  sourceArtifact: selectedJob.sourceArtifact
                })
              }
            >
              {isDeleting ? "Deleting..." : "Delete review"}
            </button>
          )}
          {canApprove ? (
            <button className="primary" type="button" onClick={() => approveSelectedJob(selectedJob.id)}>
              Approve
            </button>
          ) : isApprovedForPublishing ? (
            <button className="primary" type="button" onClick={openPublishing}>
              Open publishing
            </button>
          ) : (
            <button className="primary" type="button" disabled>
              Approve
            </button>
          )}
        </div>
      </section>
      {deleteWorkflow.error && <section className="form-error">{deleteWorkflow.error}</section>}

      <section className={showScriptPanel ? "review-grid" : "review-grid review-grid-compact"}>
        <div className="panel source-panel">
          <h3>Source</h3>
          <dl className="detail-list">
            <div>
              <dt>Artifact</dt>
              <dd>{selectedJob.sourceArtifact}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{selectedJob.sourceType}</dd>
            </div>
            <div>
              <dt>Topic</dt>
              <dd>{selectedJob.topic}</dd>
            </div>
          </dl>
        </div>

        {showScriptPanel && (
          <div className="panel script-panel">
            <div className="panel-heading compact-heading">
              <div>
                <h3>Script</h3>
                <span className="muted">{scriptHasChanges ? "Unsaved edits" : "Saved script"}</span>
              </div>
              <div className="action-row">
                <button type="button" disabled={isScriptBusy || !scriptHasChanges} onClick={saveScriptEdits}>
                  {scriptWorkflow.isSaving ? "Saving..." : "Save script"}
                </button>
                <button className="primary" type="button" disabled={isScriptBusy} onClick={regenerateVideoFromScript}>
                  {scriptWorkflow.isRegenerating ? "Requesting..." : "Regenerate video"}
                </button>
              </div>
            </div>
            <label className="script-editor-field">
              Editable script
              <textarea
                aria-label="Editable review script"
                className="script-editor"
                value={scriptText}
                onChange={(event) => {
                  setScriptText(event.target.value);
                  setScriptWorkflow((current) => ({ ...current, error: null, message: null }));
                }}
              />
            </label>
            {scriptWorkflow.error && <p className="form-error">{scriptWorkflow.error}</p>}
            {scriptWorkflow.message && <p className="form-success">{scriptWorkflow.message}</p>}
            <div className="inline-fields">
              <label>
                Scenes
                <input readOnly value={selectedJob.script.scenes} />
              </label>
              <label>
                Quality
                <input readOnly value={selectedJob.script.quality} />
              </label>
            </div>
          </div>
        )}

        <div className="panel video-panel">
          <h3>Video</h3>
          <VideoPlayer job={selectedJob} />
          <div className="section-subheading thumbnail-subheading">
            <h3>Thumbnail</h3>
            <span className="muted">Upload an image or generate one from the current video.</span>
          </div>
          <ThumbnailManager
            generateThumbnail={generateThumbnail}
            job={selectedJob}
            uploadThumbnail={uploadThumbnail}
          />
          <dl className="detail-list">
            <div>
              <dt>Provider</dt>
              <dd>{selectedJob.video.provider}</dd>
            </div>
            <div>
              <dt>Webhook</dt>
              <dd>{selectedJob.video.webhook}</dd>
            </div>
            <div>
              <dt>External ID</dt>
              <dd>{selectedJob.video.externalId ?? "Pending"}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="panel summary-panel">
        <div className="panel-heading">
          <div>
            <h2>Review Summary</h2>
            <span className="muted">{summary?.provider ? `${summary.provider} / ${summary.model}` : "Not generated"}</span>
          </div>
          <button type="button" onClick={() => generateSelectedSummary(selectedJob.id)} disabled={isGeneratingSummary}>
            {isGeneratingSummary ? "Generating..." : "Generate summary"}
          </button>
        </div>
        {summaryError && <p className="form-error">{summaryError}</p>}
        {!summary ? (
          <div className="empty-inline">No AI review summary yet.</div>
        ) : (
          <div className="summary-grid">
            <SummaryBlock label="Summary" value={summary.summary} />
            <SummaryBlock label="Intent" value={summary.intent} />
            <SummaryBlock label="Delivery" value={summary.deliveryAssessment} />
            <SummaryBlock label="Decision" value={summary.recommendedDecision} />
            <SummaryBlock label="Tags" value={(summary.suggestedTags ?? []).join(", ")} />
            <SummaryBlock label="Risks" value={(summary.risks ?? []).join("; ")} />
            <SummaryBlock label="Coverage" value={summary.sourceCoverage} />
            <SummaryBlock label="Evidence" value={(summary.evidence ?? []).join("; ")} />
          </div>
        )}
      </section>

      {deleteConfirmation && (
        <DeleteReviewConfirmationDialog
          confirmation={deleteConfirmation}
          isDeleting={isDeleting}
          onCancel={() => setDeleteConfirmation(null)}
          onConfirm={confirmReviewDelete}
        />
      )}
    </div>
  );
}

function getEditableScriptText(job) {
  if (!job) {
    return "";
  }
  if (typeof job.metadata?.reviewScriptText === "string" && job.metadata.reviewScriptText.trim()) {
    return job.metadata.reviewScriptText;
  }
  if (Array.isArray(job.script?.preview) && job.script.preview.length > 0) {
    return job.script.preview.join("\n\n");
  }
  return typeof job.metadata?.prompt === "string" ? job.metadata.prompt : "";
}

function DeleteReviewConfirmationDialog({ confirmation, isDeleting, onCancel, onConfirm }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={isDeleting ? undefined : onCancel}>
      <section
        aria-labelledby="delete-review-title"
        aria-modal="true"
        className="modal-dialog confirm-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="delete-review-title">Delete Review Job</h2>
            <span className="muted">{confirmation.title}</span>
          </div>
          <button aria-label="Close confirmation" className="modal-close" type="button" disabled={isDeleting} onClick={onCancel}>
            Close
          </button>
        </div>

        <p className="confirm-copy">
          This removes the job from review and deletes its local job, artifact, and provider-job records. Published or publishing jobs cannot be deleted here.
        </p>
        <dl className="detail-list compact-details">
          <div>
            <dt>Job ID</dt>
            <dd>{confirmation.jobId}</dd>
          </div>
          <div>
            <dt>Artifact</dt>
            <dd>{confirmation.sourceArtifact}</dd>
          </div>
        </dl>

        <div className="modal-actions">
          <button type="button" disabled={isDeleting} onClick={onCancel}>
            Cancel
          </button>
          <button className="danger" type="button" disabled={isDeleting} onClick={onConfirm}>
            {isDeleting ? "Deleting..." : "Delete review"}
          </button>
        </div>
      </section>
    </div>
  );
}
