import { useMemo, useState } from "react";
import { StatusBadge } from "../components/common.jsx";
import { API_BASE_URL } from "../config.js";

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

export function Recommendations({
  batches = [],
  onApprove,
  onCreate,
  onGenerate,
  onOpenScriptJob,
  onPublish,
  onSave
}) {
  const [draft, setDraft] = useState(emptyDraft);
  const [generation, setGeneration] = useState(emptyGenerationState);
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

                {batch.scriptJobId && (
                  <div className="recommendation-script-job-row">
                    <p className="muted">Video script job: {batch.scriptJobId}</p>
                    <button type="button" onClick={() => onOpenScriptJob?.(batch.scriptJobId)}>
                      Open video workflow
                    </button>
                  </div>
                )}

                {hasOutputArtifacts(batch.outputArtifacts) && (
                  <div className="recommendation-output-row">
                    {Object.entries(outputLabels).map(([key, label]) => {
                      const artifact = batch.outputArtifacts?.[key];
                      return artifact?.artifactId ? (
                        <a
                          href={`${API_BASE_URL}/assets/${encodeURIComponent(artifact.artifactId)}/content`}
                          key={key}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {label}
                        </a>
                      ) : null;
                    })}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
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
