import { useMemo, useState } from "react";
import { StatusBadge } from "../components/common.jsx";

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

const emptyDraft = () => ({
  id: null,
  tradeDate: new Date().toISOString().slice(0, 10),
  title: "Daily Picks",
  theme: "",
  dateRange: "",
  recommendations: Array.from({ length: 5 }, (_, index) => emptyRecommendation(index)),
  error: null,
  message: null,
  isSaving: false
});

const channelLabels = {
  liveSite: "Live site",
  email: "Email",
  pdf: "PDF",
  script: "Script",
  video: "Video"
};

export function Recommendations({ batches = [], onApprove, onCreate, onPublish, onSave }) {
  const [draft, setDraft] = useState(emptyDraft);
  const sortedBatches = useMemo(
    () => [...batches].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))),
    [batches]
  );

  function updateDraftField(field, value) {
    setDraft((current) => ({
      ...current,
      [field]: value,
      error: null,
      message: null
    }));
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
    window.scrollTo({ top: 0, behavior: "smooth" });
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
          <button type="button" onClick={() => setDraft(emptyDraft())}>New batch</button>
        </div>

        <form className="form-grid" onSubmit={submitBatch}>
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

          <div className="recommendation-editor-grid">
            {draft.recommendations.map((item, index) => (
              <article className="recommendation-editor-card" key={`recommendation-${index}`}>
                <div className="section-title-row">
                  <h4>Pick {index + 1}</h4>
                  <span className="muted">Sort {item.sortOrder}</span>
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
            <button type="button" onClick={() => setDraft(emptyDraft())}>Clear</button>
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
                  <p className="muted">Video script job: {batch.scriptJobId}</p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
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
  const items = recommendations.map((item, index) => ({
    ...emptyRecommendation(index),
    ...item,
    price: valueToInput(item.price),
    rewardRisk: valueToInput(item.rewardRisk),
    oddsOfProfit: valueToInput(item.oddsOfProfit),
    maxProfit: valueToInput(item.maxProfit)
  }));
  while (items.length < 5) {
    items.push(emptyRecommendation(items.length));
  }
  return items.slice(0, 5);
}

function draftToPayload(draft) {
  return {
    tradeDate: draft.tradeDate,
    title: draft.title,
    theme: draft.theme,
    dateRange: draft.dateRange || draft.tradeDate,
    recommendations: draft.recommendations
      .filter((item) => item.symbol.trim() || item.strategy.trim() || item.thesis.trim())
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

function numericOrUndefined(value) {
  const text = String(value ?? "").trim();
  return text ? Number(text) : undefined;
}

function valueToInput(value) {
  return value === null || value === undefined ? "" : String(value);
}
