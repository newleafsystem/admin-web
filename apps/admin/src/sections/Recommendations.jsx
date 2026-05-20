import { useMemo, useState } from "react";
import { ModalShell, StatusBadge } from "../components/common.jsx";
import { downloadArtifactFile } from "../api.js";

const MAX_PROMPT_ROWS = 25;

const emptyRecommendation = (index = 0) => ({
  id: "",
  symbol: "",
  strategy: "",
  direction: "NEUTRAL",
  price: "",
  expiry: "",
  rewardRisk: "",
  oddsOfProfit: "",
  maxProfit: "",
  thesis: "",
  riskNotes: "",
  entry: "",
  exit: "",
  sortOrder: (index + 1) * 10
});

const emptyPromptRow = (index = 0) => ({
  id: `prompt_${index + 1}_${Math.random().toString(36).slice(2, 8)}`,
  prompt: ""
});

const emptyPromptRows = () => Array.from({ length: 5 }, (_, index) => emptyPromptRow(index));

const emptyDraft = () => ({
  id: null,
  tradeDate: new Date().toISOString().slice(0, 10),
  title: "Daily Picks",
  theme: "",
  dateRange: "",
  recommendations: [emptyRecommendation(0)],
  error: null,
  message: null,
  isSaving: false
});

const emptyGenerationState = () => ({
  rows: emptyPromptRows(),
  error: null,
  message: null,
  isGenerating: false
});

const channelLabels = {
  liveSite: "Live site",
  email: "Email",
  pdf: "PDF",
  script: "Script",
  social: "Social",
  archive: "Archive",
  video: "Video"
};

const cleanupPlatforms = [
  { id: "youtube", label: "Remove from YouTube" },
  { id: "x", label: "Remove related tweets" },
  { id: "linkedin", label: "Remove LinkedIn posts" },
  { id: "facebook", label: "Remove Facebook posts" },
  { id: "instagram", label: "Remove Instagram posts" }
];

export function Recommendations({
  batches = [],
  onApprove,
  onCreate,
  onDelete,
  onGenerate,
  onOpenScriptJob,
  onPublish,
  onSave
}) {
  const [draft, setDraft] = useState(emptyDraft);
  const [generation, setGeneration] = useState(emptyGenerationState);
  const [artifactDownloads, setArtifactDownloads] = useState({});
  const [artifactDownloadError, setArtifactDownloadError] = useState(null);
  const [deleteDialog, setDeleteDialog] = useState(null);
  const sortedBatches = useMemo(
    () => [...batches].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))),
    [batches]
  );

  function resetDraft() {
    setDraft(emptyDraft());
    setGeneration(emptyGenerationState());
  }

  function updateDraftField(field, value) {
    setDraft((current) => ({
      ...current,
      [field]: value,
      error: null,
      message: null
    }));
  }

  function updatePromptRow(rowId, value) {
    setGeneration((current) => ({
      ...current,
      error: null,
      message: null,
      rows: current.rows.map((row) => (row.id === rowId ? { ...row, prompt: value } : row))
    }));
  }

  function addPromptRow() {
    setGeneration((current) => {
      if (current.rows.length >= MAX_PROMPT_ROWS) {
        return current;
      }
      return {
        ...current,
        error: null,
        rows: [...current.rows, emptyPromptRow(current.rows.length)]
      };
    });
  }

  function removePromptRow(rowId) {
    setGeneration((current) => {
      const rows = current.rows.filter((row) => row.id !== rowId);
      return {
        ...current,
        error: null,
        message: null,
        rows: rows.length > 0 ? rows : [emptyPromptRow(0)]
      };
    });
  }

  function updateRecommendation(index, field, value) {
    setDraft((current) => ({
      ...current,
      error: null,
      message: null,
      recommendations: current.recommendations.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item
      )
    }));
  }

  function addRecommendation() {
    setDraft((current) => ({
      ...current,
      error: null,
      message: null,
      recommendations: reindexRecommendations([...current.recommendations, emptyRecommendation(current.recommendations.length)])
    }));
  }

  function removeRecommendation(index) {
    setDraft((current) => {
      const recommendations = current.recommendations.filter((_, itemIndex) => itemIndex !== index);
      return {
        ...current,
        error: null,
        message: null,
        recommendations: reindexRecommendations(recommendations.length > 0 ? recommendations : [emptyRecommendation(0)])
      };
    });
  }

  function editBatch(batch) {
    setDraft({
      id: batch.id,
      tradeDate: batch.tradeDate,
      title: batch.title,
      theme: batch.theme,
      dateRange: batch.dateRange,
      recommendations: normalizeDraftRecommendations(batch.recommendations),
      error: null,
      message: null,
      isSaving: false
    });
    setGeneration(emptyGenerationState());
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function generateFromPrompts(event) {
    event.preventDefault();
    const prompts = generation.rows
      .map((row) => ({
        id: row.id,
        prompt: row.prompt.trim()
      }))
      .filter((row) => row.prompt);

    if (!draft.tradeDate) {
      setGeneration((current) => ({ ...current, error: "Choose a trade date before generating picks." }));
      return;
    }
    if (prompts.length === 0) {
      setGeneration((current) => ({ ...current, error: "Add at least one prompt before generating picks." }));
      return;
    }

    setGeneration((current) => ({ ...current, isGenerating: true, error: null, message: null }));
    try {
      const saved = await onGenerate({
        batchId: draft.id || undefined,
        tradeDate: draft.tradeDate,
        title: draft.title,
        theme: draft.theme,
        dateRange: draft.dateRange || draft.tradeDate,
        prompts
      });
      setDraft({
        ...draftFromBatch(saved),
        message: `${saved.recommendations.length} picks are in ${saved.title}.`,
        error: null,
        isSaving: false
      });
      setGeneration({
        ...emptyGenerationState(),
        message: "Generated picks were appended."
      });
    } catch (error) {
      setGeneration((current) => ({ ...current, isGenerating: false, error: error.message, message: null }));
    }
  }

  async function submitBatch(event) {
    event.preventDefault();
    const payload = draftToPayload(draft);
    if (payload.recommendations.length === 0) {
      setDraft((current) => ({ ...current, error: "Add at least one complete recommendation before saving." }));
      return;
    }

    setDraft((current) => ({ ...current, isSaving: true, error: null, message: null }));
    try {
      const saved = draft.id ? await onSave(draft.id, payload) : await onCreate(payload);
      setDraft({
        ...draftFromBatch(saved),
        error: null,
        message: `${saved.title} was saved.`,
        isSaving: false
      });
    } catch (error) {
      setDraft((current) => ({ ...current, isSaving: false, error: error.message, message: null }));
    }
  }

  async function runBatchAction(action, batchId) {
    setDraft((current) => ({ ...current, error: null, message: null }));
    try {
      const updated = await action(batchId);
      setDraft((current) => ({
        ...current,
        message: `${updated.title} is now ${updated.status}.`
      }));
    } catch (error) {
      setDraft((current) => ({ ...current, error: error.message, message: null }));
    }
  }

  function requestBatchDelete(batch) {
    setDeleteDialog({
      batch,
      options: defaultDeleteOptions(batch),
      error: null,
      isDeleting: false
    });
  }

  function cancelBatchDelete() {
    setDeleteDialog(null);
  }

  function toggleDeleteOption(option) {
    setDeleteDialog((current) => {
      if (!current) return current;
      const nextOptions = {
        ...current.options,
        [option]: !current.options[option]
      };
      if (option === "removeVideoJob" && nextOptions.removeVideoJob) {
        nextOptions.removeOutputArtifacts = true;
      }
      if (option === "removeOutputArtifacts" && current.options.removeVideoJob) {
        nextOptions.removeOutputArtifacts = true;
      }
      return {
        ...current,
        error: null,
        options: nextOptions
      };
    });
  }

  function toggleDeletePlatform(platformId) {
    setDeleteDialog((current) => {
      if (!current) return current;
      const platforms = current.options.platforms.includes(platformId)
        ? current.options.platforms.filter((id) => id !== platformId)
        : [...current.options.platforms, platformId];
      return {
        ...current,
        error: null,
        options: {
          ...current.options,
          platforms
        }
      };
    });
  }

  async function confirmBatchDelete() {
    if (!deleteDialog) return;
    setDeleteDialog((current) => current ? { ...current, isDeleting: true, error: null } : current);
    try {
      const result = await onDelete(deleteDialog.batch.id, {
        reason: "admin_deleted_recommendation_batch",
        removeRecommendation: deleteDialog.options.removeRecommendation,
        removeVideoJob: deleteDialog.options.removeVideoJob,
        removeOutputArtifacts: deleteDialog.options.removeOutputArtifacts,
        platforms: deleteDialog.options.platforms
      });
      setDeleteDialog(null);
      setDraft((current) => ({
        ...current,
        message: result.recommendationBatch
          ? `${result.recommendationBatch.title} was archived.`
          : `${deleteDialog.batch.title || deleteDialog.batch.tradeDate} was removed.`,
        error: null
      }));
    } catch (error) {
      setDeleteDialog((current) => current ? { ...current, isDeleting: false, error: error.message } : current);
    }
  }

  async function downloadOutputArtifact(artifact, label) {
    const artifactId = artifact?.artifactId ?? artifact?.id;
    if (!artifactId) return;

    setArtifactDownloadError(null);
    setArtifactDownloads((current) => ({ ...current, [artifactId]: true }));
    try {
      await downloadArtifactFile(artifact);
    } catch (error) {
      setArtifactDownloadError(error.message || `Unable to download ${label}.`);
    } finally {
      setArtifactDownloads((current) => {
        const next = { ...current };
        delete next[artifactId];
        return next;
      });
    }
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Daily picks</p>
            <h2>{draft.id ? "Edit recommendation batch" : "Create recommendation batch"}</h2>
          </div>
          <button type="button" onClick={resetDraft}>New batch</button>
        </div>

        <div className="form-grid compact-grid">
          <label>
            <span>Trade date</span>
            <input
              type="date"
              value={draft.tradeDate}
              onChange={(event) => updateDraftField("tradeDate", event.target.value)}
            />
          </label>
          <label>
            <span>Title</span>
            <input
              value={draft.title}
              onChange={(event) => updateDraftField("title", event.target.value)}
              placeholder="Daily Picks"
            />
          </label>
          <label>
            <span>Date range</span>
            <input
              value={draft.dateRange}
              onChange={(event) => updateDraftField("dateRange", event.target.value)}
              placeholder="May 17, 2026"
            />
          </label>
          <label>
            <span>Theme</span>
            <input
              value={draft.theme}
              onChange={(event) => updateDraftField("theme", event.target.value)}
              placeholder="Defined-risk premium ideas"
            />
          </label>
        </div>

        <form className="recommendation-generator-block" onSubmit={generateFromPrompts}>
          <div className="section-title-row">
            <div>
              <p className="eyebrow">Prompt generator</p>
              <h3>Generate picks</h3>
            </div>
            <button type="button" onClick={addPromptRow} disabled={generation.rows.length >= MAX_PROMPT_ROWS}>
              Add prompt
            </button>
          </div>

          <div className="recommendation-prompt-grid">
            {generation.rows.map((row, index) => (
              <article className="recommendation-prompt-card" key={row.id}>
                <div className="section-title-row">
                  <h4>Prompt {index + 1}</h4>
                  <button type="button" onClick={() => removePromptRow(row.id)}>Remove</button>
                </div>
                <label>
                  <span>Prompt</span>
                  <textarea
                    value={row.prompt}
                    onChange={(event) => updatePromptRow(row.id, event.target.value)}
                    placeholder="Generate one defined-risk options idea for AAPL with a risk-aware thesis."
                  />
                </label>
              </article>
            ))}
          </div>

          {generation.error && <section className="form-error">{generation.error}</section>}
          {generation.message && <section className="form-success">{generation.message}</section>}

          <div className="button-row">
            <button disabled={generation.isGenerating} type="submit">
              {generation.isGenerating ? "Generating..." : "Generate picks"}
            </button>
          </div>
        </form>

        <form className="form-grid" onSubmit={submitBatch}>
          <div className="section-title-row">
            <div>
              <p className="eyebrow">Review</p>
              <h3>{draft.recommendations.filter(hasRecommendationContent).length} editable picks</h3>
            </div>
            <button type="button" onClick={addRecommendation}>Add manual pick</button>
          </div>

          <div className="recommendation-editor-grid">
            {draft.recommendations.map((item, index) => (
              <article className="recommendation-editor-card" key={item.id || `recommendation-${index}`}>
                <div className="section-title-row">
                  <div>
                    <h4>Pick {index + 1}</h4>
                    <span className="muted">Sort {(index + 1) * 10}</span>
                  </div>
                  <button type="button" onClick={() => removeRecommendation(index)}>Remove</button>
                </div>
                <div className="form-grid compact-grid">
                  <label>
                    <span>Symbol</span>
                    <input
                      value={item.symbol}
                      onChange={(event) => updateRecommendation(index, "symbol", event.target.value)}
                      placeholder="ADBE"
                    />
                  </label>
                  <label>
                    <span>Strategy</span>
                    <input
                      value={item.strategy}
                      onChange={(event) => updateRecommendation(index, "strategy", event.target.value)}
                      placeholder="Iron condor"
                    />
                  </label>
                  <label>
                    <span>Direction</span>
                    <select
                      value={item.direction}
                      onChange={(event) => updateRecommendation(index, "direction", event.target.value)}
                    >
                      <option value="NEUTRAL">Neutral</option>
                      <option value="BULLISH">Bullish</option>
                      <option value="BEARISH">Bearish</option>
                    </select>
                  </label>
                  <label>
                    <span>Price</span>
                    <input
                      inputMode="decimal"
                      value={item.price}
                      onChange={(event) => updateRecommendation(index, "price", event.target.value)}
                      placeholder="482.15"
                    />
                  </label>
                  <label>
                    <span>Expiry</span>
                    <input
                      type="date"
                      value={item.expiry}
                      onChange={(event) => updateRecommendation(index, "expiry", event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Reward/risk</span>
                    <input
                      inputMode="decimal"
                      value={item.rewardRisk}
                      onChange={(event) => updateRecommendation(index, "rewardRisk", event.target.value)}
                      placeholder="0.42"
                    />
                  </label>
                  <label>
                    <span>Probability</span>
                    <input
                      inputMode="numeric"
                      value={item.oddsOfProfit}
                      onChange={(event) => updateRecommendation(index, "oddsOfProfit", event.target.value)}
                      placeholder="68"
                    />
                  </label>
                  <label>
                    <span>Max profit</span>
                    <input
                      inputMode="decimal"
                      value={item.maxProfit}
                      onChange={(event) => updateRecommendation(index, "maxProfit", event.target.value)}
                      placeholder="240"
                    />
                  </label>
                </div>
                <div className="form-grid">
                  <label>
                    <span>Thesis</span>
                    <textarea
                      value={item.thesis}
                      onChange={(event) => updateRecommendation(index, "thesis", event.target.value)}
                      placeholder="Why this setup may act as a good defined-risk opportunity."
                    />
                  </label>
                  <label>
                    <span>Risk notes</span>
                    <textarea
                      value={item.riskNotes}
                      onChange={(event) => updateRecommendation(index, "riskNotes", event.target.value)}
                      placeholder="What would invalidate or stress this setup."
                    />
                  </label>
                  <label>
                    <span>Entry</span>
                    <textarea
                      value={item.entry}
                      onChange={(event) => updateRecommendation(index, "entry", event.target.value)}
                      placeholder="Entry guidance for admin review."
                    />
                  </label>
                  <label>
                    <span>Exit</span>
                    <textarea
                      value={item.exit}
                      onChange={(event) => updateRecommendation(index, "exit", event.target.value)}
                      placeholder="Exit, stop, or invalidation guidance."
                    />
                  </label>
                </div>
              </article>
            ))}
          </div>

          {draft.error && <section className="form-error">{draft.error}</section>}
          {draft.message && <section className="form-success">{draft.message}</section>}

          <div className="button-row">
            <button disabled={draft.isSaving} type="submit">
              {draft.isSaving ? "Saving..." : draft.id ? "Save batch" : "Create batch"}
            </button>
            <button type="button" onClick={resetDraft}>Clear</button>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Queue</p>
            <h2>Recommendation batches</h2>
          </div>
          <span className="muted">{sortedBatches.length} batches</span>
        </div>
        {artifactDownloadError && <section className="form-error">{artifactDownloadError}</section>}

        {sortedBatches.length === 0 ? (
          <div className="empty-inline">No recommendation batches have been created yet.</div>
        ) : (
          <div className="recommendation-batch-list">
            {sortedBatches.map((batch) => (
              <article className="recommendation-batch-card" key={batch.id}>
                <div className="recommendation-batch-top">
                  <div>
                    <div className="button-row">
                      <h3>{batch.title || batch.tradeDate}</h3>
                      <StatusBadge status={batch.status} />
                    </div>
                    <p className="muted">
                      {batch.tradeDate} {batch.theme ? `- ${batch.theme}` : ""}
                    </p>
                  </div>
                  <div className="button-row">
                    {batch.status !== "published" && (
                      <button type="button" onClick={() => editBatch(batch)}>Edit</button>
                    )}
                    {batch.status === "draft" && (
                      <button type="button" onClick={() => runBatchAction(onApprove, batch.id)}>Approve</button>
                    )}
                    {batch.status === "approved" && (
                      <button type="button" onClick={() => runBatchAction(onPublish, batch.id)}>Publish</button>
                    )}
                    {(batch.status === "published" || batch.status === "approved" || hasScriptJobs(batch)) && onDelete && (
                      <button className="danger" type="button" onClick={() => requestBatchDelete(batch)}>
                        {batch.status === "published" ? "Unpublish / delete" : "Delete"}
                      </button>
                    )}
                  </div>
                </div>

                <div className="recommendation-symbol-strip">
                  {batch.recommendations.map((item) => (
                    <span key={item.id || item.symbol}>{item.symbol}</span>
                  ))}
                </div>

                <div className="recommendation-channel-grid">
                  {Object.entries(channelLabels).map(([key, label]) => (
                    <div key={key}>
                      <span>{label}</span>
                      <StatusBadge status={batch.channels?.[key]?.status ?? "not_requested"} />
                    </div>
                  ))}
                </div>

                {hasScriptJobs(batch) && (
                  <div className="recommendation-script-job-list">
                    {getScriptJobRows(batch).map((job) => (
                      <div className="recommendation-script-job-row" key={job.jobId}>
                        <p className="muted">
                          {job.symbol ? `${job.symbol} video workflow` : "Video workflow"}: {job.jobId}
                        </p>
                        <button type="button" onClick={() => onOpenScriptJob?.(job.jobId)}>
                          Open workflow
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {getOutputGroups(batch).length > 0 && (
                  <div className="recommendation-pick-output-list">
                    {getOutputGroups(batch).map((group) => (
                      <div className="recommendation-pick-output-row" key={group.id}>
                        {group.label && <p className="muted">{group.label}</p>}
                        <div className="recommendation-output-row">
                          {Object.entries(outputLabels).map(([key, label]) => {
                            const artifact = group.outputs?.[key];
                            const artifactId = artifact?.artifactId ?? artifact?.id;
                            const isDownloading = Boolean(artifactId && artifactDownloads[artifactId]);
                            return artifactId ? (
                              <button
                                disabled={isDownloading}
                                key={key}
                                type="button"
                                onClick={() => downloadOutputArtifact(artifact, `${group.label || "Recommendation"} ${label}`)}
                              >
                                {isDownloading ? "Downloading..." : label}
                              </button>
                            ) : null;
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {deleteDialog && (
        <RecommendationDeleteDialog
          dialog={deleteDialog}
          onCancel={cancelBatchDelete}
          onConfirm={confirmBatchDelete}
          onToggleOption={toggleDeleteOption}
          onTogglePlatform={toggleDeletePlatform}
        />
      )}
    </div>
  );
}

const outputLabels = {
  pdf: "PDF report",
  socialCopy: "Social copy",
  archive: "Picks JSON",
  videoScript: "Video script"
};

function hasOutputArtifacts(outputArtifacts = {}) {
  return Object.values(outputArtifacts ?? {}).some((artifact) => artifact?.artifactId);
}

function hasScriptJobs(batch = {}) {
  return getScriptJobRows(batch).length > 0;
}

function getScriptJobRows(batch = {}) {
  if (Array.isArray(batch.pickJobs) && batch.pickJobs.length > 0) {
    return batch.pickJobs.filter((item) => item.jobId);
  }
  if (Array.isArray(batch.scriptJobIds) && batch.scriptJobIds.length > 0) {
    return batch.scriptJobIds.map((jobId, index) => ({
      jobId,
      symbol: batch.recommendations?.[index]?.symbol ?? ""
    }));
  }
  return batch.scriptJobId ? [{ jobId: batch.scriptJobId, symbol: batch.recommendations?.[0]?.symbol ?? "" }] : [];
}

function getOutputGroups(batch = {}) {
  const pickOutputs = Object.entries(batch.pickOutputArtifacts ?? {})
    .map(([pickId, outputs]) => {
      const pick = batch.recommendations?.find((item) => item.id === pickId);
      return {
        id: pickId,
        label: pick?.symbol ? `${pick.symbol} outputs` : `Pick outputs`,
        outputs
      };
    })
    .filter((group) => hasOutputArtifacts(group.outputs));

  if (pickOutputs.length > 0) {
    return pickOutputs;
  }
  return hasOutputArtifacts(batch.outputArtifacts)
    ? [{ id: "batch", label: "", outputs: batch.outputArtifacts }]
    : [];
}

function defaultDeleteOptions(batch) {
  return {
    removeRecommendation: true,
    removeVideoJob: hasScriptJobs(batch),
    removeOutputArtifacts: hasScriptJobs(batch) || getOutputGroups(batch).length > 0,
    platforms: cleanupPlatforms.map((platform) => platform.id)
  };
}

function RecommendationDeleteDialog({
  dialog,
  onCancel,
  onConfirm,
  onToggleOption,
  onTogglePlatform
}) {
  const { batch, options, error, isDeleting } = dialog;
  return (
    <ModalShell
      className="confirm-dialog wide-dialog"
      closeOnBackdrop={!isDeleting}
      closeOnEscape={!isDeleting}
      labelledBy="delete-recommendation-title"
      onClose={isDeleting ? undefined : onCancel}
    >
      <div className="modal-header">
        <div>
          <p className="eyebrow">Cleanup</p>
          <h2 id="delete-recommendation-title">Unpublish Recommendation</h2>
        </div>
        <button aria-label="Close cleanup dialog" className="modal-close" disabled={isDeleting} type="button" onClick={onCancel}>
          x
        </button>
      </div>
      <div className="modal-body">
        <p className="confirm-copy">
          Choose what should be removed for {batch.title || batch.tradeDate}. Live provider removals use stored publication records, then the recommendation can be removed from Firebase.
        </p>
        <div className="recommendation-delete-options">
          <label className="checkbox-line">
            <input
              checked={options.removeRecommendation}
              disabled={isDeleting}
              type="checkbox"
              onChange={() => onToggleOption("removeRecommendation")}
            />
            <span>
              Delete recommendation record from Firebase
              <small>Removes it from the preview site and the admin batch list.</small>
            </span>
          </label>
          <label className="checkbox-line">
            <input
              checked={options.removeVideoJob}
              disabled={isDeleting || !hasScriptJobs(batch)}
              type="checkbox"
              onChange={() => onToggleOption("removeVideoJob")}
            />
            <span>
              Delete generated video workflow
              <small>Removes the script-ready job, provider job records, publish plans, and generated artifacts tied to that workflow.</small>
            </span>
          </label>
          <label className="checkbox-line">
            <input
              checked={options.removeOutputArtifacts}
              disabled={isDeleting || options.removeVideoJob}
              type="checkbox"
              onChange={() => onToggleOption("removeOutputArtifacts")}
            />
            <span>
              Delete generated reports and social output
              <small>Removes PDF, script, social-copy, and archive artifact records when the video workflow is kept.</small>
            </span>
          </label>
        </div>
        <div className="recommendation-delete-options">
          {cleanupPlatforms.map((platform) => (
            <label className="checkbox-line" key={platform.id}>
              <input
                checked={options.platforms.includes(platform.id)}
                disabled={isDeleting}
                type="checkbox"
                onChange={() => onTogglePlatform(platform.id)}
              />
              <span>
                {platform.label}
                <small>Only matching NewLeaf publication records for this recommendation video are touched.</small>
              </span>
            </label>
          ))}
        </div>
        {error && <section className="form-error">{error}</section>}
      </div>
      <div className="modal-actions">
        <button disabled={isDeleting} type="button" onClick={onCancel}>Cancel</button>
        <button className="danger" disabled={isDeleting} type="button" onClick={onConfirm}>
          {isDeleting ? "Removing..." : "Remove selected items"}
        </button>
      </div>
    </ModalShell>
  );
}

function draftFromBatch(batch) {
  return {
    id: batch.id,
    tradeDate: batch.tradeDate,
    title: batch.title,
    theme: batch.theme,
    dateRange: batch.dateRange,
    recommendations: normalizeDraftRecommendations(batch.recommendations),
    error: null,
    message: null,
    isSaving: false
  };
}

function normalizeDraftRecommendations(recommendations = []) {
  const sourceItems = [...recommendations].sort((left, right) => Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0));
  const items = sourceItems.map((item, index) => ({
    ...emptyRecommendation(index),
    ...item,
    price: valueToInput(item.price),
    rewardRisk: valueToInput(item.rewardRisk),
    oddsOfProfit: valueToInput(item.oddsOfProfit),
    maxProfit: valueToInput(item.maxProfit)
  }));
  return items.length > 0 ? reindexRecommendations(items) : [emptyRecommendation(0)];
}

function draftToPayload(draft) {
  return {
    tradeDate: draft.tradeDate,
    title: draft.title,
    theme: draft.theme,
    dateRange: draft.dateRange || draft.tradeDate,
    recommendations: reindexRecommendations(draft.recommendations.filter(hasRecommendationContent))
      .map((item, index) => ({
        id: item.id || undefined,
        symbol: item.symbol.trim().toUpperCase(),
        strategy: item.strategy.trim(),
        direction: item.direction,
        price: numericOrUndefined(item.price),
        expiry: item.expiry || undefined,
        rewardRisk: numericOrUndefined(item.rewardRisk),
        oddsOfProfit: numericOrUndefined(item.oddsOfProfit),
        maxProfit: numericOrUndefined(item.maxProfit),
        thesis: item.thesis.trim(),
        riskNotes: item.riskNotes.trim(),
        entry: item.entry?.trim() || undefined,
        exit: item.exit?.trim() || undefined,
        sortOrder: (index + 1) * 10
      }))
  };
}

function reindexRecommendations(recommendations) {
  return recommendations.map((item, index) => ({
    ...item,
    sortOrder: (index + 1) * 10
  }));
}

function hasRecommendationContent(item) {
  return Boolean(
    String(item.symbol ?? "").trim() ||
    String(item.strategy ?? "").trim() ||
    String(item.thesis ?? "").trim() ||
    String(item.riskNotes ?? "").trim()
  );
}

function numericOrUndefined(value) {
  const text = String(value ?? "").trim();
  return text ? Number(text) : undefined;
}

function valueToInput(value) {
  return value === null || value === undefined ? "" : String(value);
}
