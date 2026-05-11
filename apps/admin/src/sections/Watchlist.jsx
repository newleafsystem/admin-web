import { useEffect, useMemo, useState } from "react";
import { ModalShell } from "../components/common.jsx";

const MARKET_PROVIDERS = [
  { value: "alpaca", label: "Alpaca" },
  { value: "yahoo", label: "Yahoo" },
  { value: "manual", label: "Manual" }
];

const MARKET_CAP_TIERS = ["etf", "mega", "large", "mid", "small", "unknown"];

const emptyMarket = {
  id: "",
  label: "",
  country: "",
  timezone: "",
  currency: "",
  provider: "manual",
  enabled: true,
  scanEnabled: false,
  maxSymbolsPerRun: 80,
  notes: ""
};

const emptySymbol = {
  id: "",
  symbol: "",
  market: "US",
  name: "",
  group: "",
  sector: "",
  marketCapTier: "unknown",
  enabled: true,
  notes: ""
};

export function Watchlist({ config, onRefresh, onSave }) {
  const [draft, setDraft] = useState(config);
  const [selectedMarketId, setSelectedMarketId] = useState(config?.markets?.[0]?.id ?? "US");
  const [marketDialog, setMarketDialog] = useState(null);
  const [symbolDialog, setSymbolDialog] = useState(null);
  const [deleteMarket, setDeleteMarket] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    setDraft(config);
    setSelectedMarketId((current) => config?.markets?.some((market) => market.id === current)
      ? current
      : config?.markets?.[0]?.id ?? "US");
  }, [config]);

  const summary = useMemo(() => summarizeWatchlist(draft), [draft]);
  const marketSymbols = useMemo(
    () => (draft?.symbols ?? []).filter((symbol) => symbol.market === selectedMarketId),
    [draft, selectedMarketId]
  );
  const selectedMarket = draft?.markets?.find((market) => market.id === selectedMarketId) ?? null;
  const dirty = Boolean(draft && config && JSON.stringify(draft) !== JSON.stringify(config));
  const overLimit = summary.activeScanSymbols > Number(draft?.limits?.maxSymbolsPerRun ?? 0);

  function updateLimits(field, value) {
    setDraft((current) => ({
      ...current,
      limits: {
        ...current.limits,
        [field]: Number(value)
      }
    }));
  }

  function openAddMarket() {
    setMarketDialog({ mode: "add", market: { ...emptyMarket } });
  }

  function openEditMarket(market) {
    setMarketDialog({ mode: "edit", market: { ...market } });
  }

  function saveMarketDialog() {
    const market = normalizeMarketDraft(marketDialog.market);
    setDraft((current) => {
      const existing = current.markets.filter((candidate) => candidate.id !== market.id);
      return {
        ...current,
        markets: [...existing, market].sort((left, right) => left.id.localeCompare(right.id))
      };
    });
    setSelectedMarketId(market.id);
    setMarketDialog(null);
  }

  function confirmDeleteMarket() {
    if (!deleteMarket) return;
    setDraft((current) => ({
      ...current,
      markets: current.markets.filter((market) => market.id !== deleteMarket.id),
      symbols: current.symbols.filter((symbol) => symbol.market !== deleteMarket.id)
    }));
    setDeleteMarket(null);
    setSelectedMarketId((current) => current === deleteMarket.id ? draft.markets.find((m) => m.id !== deleteMarket.id)?.id ?? "US" : current);
  }

  function openAddSymbol() {
    setSymbolDialog({
      mode: "add",
      originalId: null,
      symbol: {
        ...emptySymbol,
        market: selectedMarketId
      }
    });
  }

  function openEditSymbol(symbol) {
    setSymbolDialog({ mode: "edit", originalId: symbol.id, symbol: { ...symbol } });
  }

  function saveSymbolDialog() {
    const symbol = normalizeSymbolDraft(symbolDialog.symbol);
    setDraft((current) => {
      const symbols = current.symbols.filter((candidate) => candidate.id !== symbolDialog.originalId && candidate.id !== symbol.id);
      return {
        ...current,
        symbols: [...symbols, symbol].sort((left, right) => `${left.market}:${left.symbol}`.localeCompare(`${right.market}:${right.symbol}`))
      };
    });
    setSelectedMarketId(symbol.market);
    setSymbolDialog(null);
  }

  function removeSymbol(symbol) {
    setDraft((current) => ({
      ...current,
      symbols: current.symbols.filter((candidate) => candidate.id !== symbol.id)
    }));
  }

  async function saveChanges() {
    setSaving(true);
    setMessage(null);
    try {
      const updated = await onSave(draft);
      setDraft(updated);
      setMessage("Watchlist saved. Scheduler will pick it up on the next run.");
    } finally {
      setSaving(false);
    }
  }

  async function refresh() {
    setMessage(null);
    const refreshed = await onRefresh();
    setDraft(refreshed);
  }

  if (!draft) {
    return (
      <div className="view-stack">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Market Watchlist</h2>
              <span className="muted">No managed watchlist has been loaded yet.</span>
            </div>
            <button type="button" onClick={refresh}>Refresh</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="view-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Market Watchlist</h2>
            <span className="muted">
              {summary.totalSymbols} symbols, {summary.activeScanSymbols} active scan symbols, {summary.scanMarkets} scan markets
            </span>
          </div>
          <div className="button-row">
            <button type="button" onClick={refresh}>Refresh</button>
            <button className="primary" disabled={!dirty || saving || overLimit} type="button" onClick={saveChanges}>
              {saving ? "Saving..." : "Save watchlist"}
            </button>
          </div>
        </div>

        <div className="watchlist-kpis">
          <Metric label="Markets" value={summary.totalMarkets} />
          <Metric label="Enabled symbols" value={summary.enabledSymbols} />
          <Metric label="Run cap" value={draft.limits.maxSymbolsPerRun} />
          <Metric label="Daily concurrency" value={draft.limits.dailyConcurrency} />
        </div>

        <div className="watchlist-notice">
          <strong>Rate-limit guard</strong>
          <span>
            The scheduler only scans enabled symbols in enabled scan markets. Daily Yahoo OI runs stay at concurrency 1, and active scan symbols must stay within the configured run cap.
          </span>
        </div>

        {overLimit && (
          <div className="form-error">
            Active scan symbols exceed the run cap. Disable some symbols or raise the cap before saving.
          </div>
        )}
        {message && <div className="form-success">{message}</div>}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Rate Limits</h2>
            <span className="muted">Keep large watchlists stored, but only scan a controlled active set.</span>
          </div>
        </div>
        <div className="form-grid compact-grid">
          <Field label="Max symbols per run">
            <input min="1" max="500" type="number" value={draft.limits.maxSymbolsPerRun} onChange={(event) => updateLimits("maxSymbolsPerRun", event.target.value)} />
          </Field>
          <Field label="Max symbols per market">
            <input min="1" max="500" type="number" value={draft.limits.maxSymbolsPerMarket} onChange={(event) => updateLimits("maxSymbolsPerMarket", event.target.value)} />
          </Field>
          <Field label="Intraday concurrency">
            <input min="1" max="10" type="number" value={draft.limits.intradayConcurrency} onChange={(event) => updateLimits("intradayConcurrency", event.target.value)} />
          </Field>
          <Field label="Yahoo delay ms">
            <input min="0" max="5000" type="number" value={draft.limits.yahooRequestDelayMs} onChange={(event) => updateLimits("yahooRequestDelayMs", event.target.value)} />
          </Field>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Markets</h2>
            <span className="muted">Add markets now; enable scan only after provider support is ready.</span>
          </div>
          <button type="button" onClick={openAddMarket}>Add market</button>
        </div>
        <div className="market-tabs">
          {draft.markets.map((market) => (
            <button
              className={market.id === selectedMarketId ? "market-tab active" : "market-tab"}
              key={market.id}
              type="button"
              onClick={() => setSelectedMarketId(market.id)}
            >
              <strong>{market.id}</strong>
              <span>{market.label}</span>
            </button>
          ))}
        </div>

        {selectedMarket && (
          <div className="market-detail">
            <div>
              <h3>{selectedMarket.label}</h3>
              <p>{[selectedMarket.country, selectedMarket.currency, selectedMarket.timezone].filter(Boolean).join(" / ")}</p>
            </div>
            <div className="button-row">
              <StatusPill active={selectedMarket.enabled}>Enabled</StatusPill>
              <StatusPill active={selectedMarket.scanEnabled}>Scanned</StatusPill>
              <button type="button" onClick={() => openEditMarket(selectedMarket)}>Edit market</button>
              <button className="danger" type="button" onClick={() => setDeleteMarket(selectedMarket)}>Remove market</button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{selectedMarket?.label ?? selectedMarketId} Symbols</h2>
            <span className="muted">{marketSymbols.length} configured, {marketSymbols.filter((symbol) => symbol.enabled).length} enabled</span>
          </div>
          <button type="button" onClick={openAddSymbol}>Add symbol</button>
        </div>

        <div className="table-wrap">
          <table className="accounts-table watchlist-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Name</th>
                <th>Group</th>
                <th>Sector</th>
                <th>Tier</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {marketSymbols.length === 0 ? (
                <tr>
                  <td className="table-empty" colSpan="7">No symbols in this market.</td>
                </tr>
              ) : (
                marketSymbols.map((symbol) => (
                  <tr key={symbol.id}>
                    <td><strong>{symbol.symbol}</strong></td>
                    <td>{symbol.name || "Not set"}</td>
                    <td>{symbol.group || "Not set"}</td>
                    <td>{symbol.sector || "Not set"}</td>
                    <td>{symbol.marketCapTier}</td>
                    <td><StatusPill active={symbol.enabled}>Enabled</StatusPill></td>
                    <td>
                      <div className="button-row">
                        <button type="button" onClick={() => openEditSymbol(symbol)}>Edit</button>
                        <button className="danger" type="button" onClick={() => removeSymbol(symbol)}>Remove</button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {marketDialog && (
        <MarketDialog
          dialog={marketDialog}
          existingMarkets={draft.markets}
          onCancel={() => setMarketDialog(null)}
          onChange={(market) => setMarketDialog((current) => ({ ...current, market }))}
          onSave={saveMarketDialog}
        />
      )}

      {symbolDialog && (
        <SymbolDialog
          dialog={symbolDialog}
          markets={draft.markets}
          onCancel={() => setSymbolDialog(null)}
          onChange={(symbol) => setSymbolDialog((current) => ({ ...current, symbol }))}
          onSave={saveSymbolDialog}
        />
      )}

      {deleteMarket && (
        <DeleteMarketDialog
          market={deleteMarket}
          symbolCount={draft.symbols.filter((symbol) => symbol.market === deleteMarket.id).length}
          onCancel={() => setDeleteMarket(null)}
          onConfirm={confirmDeleteMarket}
        />
      )}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="summary-block">
      <span>{label}</span>
      <p>{value}</p>
    </div>
  );
}

function Field({ children, label }) {
  return (
    <label>
      <span>{label}</span>
      {children}
    </label>
  );
}

function StatusPill({ active, children }) {
  return <span className={active ? "status status-active" : "status status-blocked"}>{children}</span>;
}

function MarketDialog({ dialog, existingMarkets, onCancel, onChange, onSave }) {
  const market = dialog.market;
  const normalizedId = market.id.trim().toUpperCase();
  const duplicate = dialog.mode === "add" && existingMarkets.some((item) => item.id === normalizedId);
  const invalid = !/^[A-Z][A-Z0-9_-]{1,11}$/.test(normalizedId) || duplicate || !market.label.trim();

  return (
    <ModalShell className="confirm-dialog wide-dialog" labelledBy="market-dialog-title" onClose={onCancel}>
      <DialogHeader titleId="market-dialog-title" title={dialog.mode === "add" ? "Add Market" : "Edit Market"} subtitle={market.id || "New market"} onClose={onCancel} />
      <div className="modal-body form-grid compact-grid">
        <Field label="Market id">
          <input disabled={dialog.mode === "edit"} value={market.id} onChange={(event) => onChange({ ...market, id: event.target.value.toUpperCase() })} />
        </Field>
        <Field label="Label">
          <input value={market.label} onChange={(event) => onChange({ ...market, label: event.target.value })} />
        </Field>
        <Field label="Country">
          <input value={market.country} onChange={(event) => onChange({ ...market, country: event.target.value })} />
        </Field>
        <Field label="Timezone">
          <input value={market.timezone} onChange={(event) => onChange({ ...market, timezone: event.target.value })} />
        </Field>
        <Field label="Currency">
          <input value={market.currency} onChange={(event) => onChange({ ...market, currency: event.target.value.toUpperCase() })} />
        </Field>
        <Field label="Provider">
          <select value={market.provider} onChange={(event) => onChange({ ...market, provider: event.target.value })}>
            {MARKET_PROVIDERS.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}
          </select>
        </Field>
        <Field label="Market run cap">
          <input min="1" max="500" type="number" value={market.maxSymbolsPerRun} onChange={(event) => onChange({ ...market, maxSymbolsPerRun: Number(event.target.value) })} />
        </Field>
        <label className="check-row">
          <input type="checkbox" checked={market.enabled} onChange={(event) => onChange({ ...market, enabled: event.target.checked })} />
          Enabled in watchlist
        </label>
        <label className="check-row">
          <input type="checkbox" checked={market.scanEnabled} onChange={(event) => onChange({ ...market, scanEnabled: event.target.checked })} />
          Include in scheduler scan
        </label>
      </div>
      {duplicate && <div className="form-error">A market with this id already exists.</div>}
      <div className="modal-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={invalid} type="button" onClick={onSave}>Save market</button>
      </div>
    </ModalShell>
  );
}

function SymbolDialog({ dialog, markets, onCancel, onChange, onSave }) {
  const symbol = dialog.symbol;
  const normalizedSymbol = symbol.symbol.trim().toUpperCase();
  const invalid = !/^[A-Z0-9^][A-Z0-9.\-^=]{0,23}$/.test(normalizedSymbol);

  return (
    <ModalShell className="confirm-dialog wide-dialog" labelledBy="symbol-dialog-title" onClose={onCancel}>
      <DialogHeader titleId="symbol-dialog-title" title={dialog.mode === "add" ? "Add Symbol" : "Edit Symbol"} subtitle={symbol.symbol || "New symbol"} onClose={onCancel} />
      <div className="modal-body form-grid compact-grid">
        <Field label="Symbol">
          <input value={symbol.symbol} onChange={(event) => onChange({ ...symbol, symbol: event.target.value.toUpperCase() })} />
        </Field>
        <Field label="Market">
          <select value={symbol.market} onChange={(event) => onChange({ ...symbol, market: event.target.value })}>
            {markets.map((market) => <option key={market.id} value={market.id}>{market.id} - {market.label}</option>)}
          </select>
        </Field>
        <Field label="Name">
          <input value={symbol.name} onChange={(event) => onChange({ ...symbol, name: event.target.value })} />
        </Field>
        <Field label="Group">
          <input value={symbol.group} onChange={(event) => onChange({ ...symbol, group: event.target.value })} />
        </Field>
        <Field label="Sector">
          <input value={symbol.sector} onChange={(event) => onChange({ ...symbol, sector: event.target.value })} />
        </Field>
        <Field label="Market cap tier">
          <select value={symbol.marketCapTier} onChange={(event) => onChange({ ...symbol, marketCapTier: event.target.value })}>
            {MARKET_CAP_TIERS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
          </select>
        </Field>
        <label className="check-row">
          <input type="checkbox" checked={symbol.enabled} onChange={(event) => onChange({ ...symbol, enabled: event.target.checked })} />
          Enabled
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={invalid} type="button" onClick={onSave}>Save symbol</button>
      </div>
    </ModalShell>
  );
}

function DeleteMarketDialog({ market, onCancel, onConfirm, symbolCount }) {
  return (
    <ModalShell className="confirm-dialog" labelledBy="delete-market-title" onClose={onCancel}>
      <DialogHeader titleId="delete-market-title" title="Remove Market" subtitle={market.label} onClose={onCancel} />
      <div className="modal-body">
        <p className="confirm-copy">
          This removes {market.id} and {symbolCount} symbol{symbolCount === 1 ? "" : "s"} from the draft watchlist.
        </p>
      </div>
      <div className="modal-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="danger" type="button" onClick={onConfirm}>Remove market</button>
      </div>
    </ModalShell>
  );
}

function DialogHeader({ onClose, subtitle, title, titleId }) {
  return (
    <div className="modal-header">
      <div>
        <h2 id={titleId}>{title}</h2>
        <span className="muted">{subtitle}</span>
      </div>
      <button aria-label="Close dialog" className="modal-close" type="button" onClick={onClose}>x</button>
    </div>
  );
}

function summarizeWatchlist(config) {
  const marketById = new Map((config?.markets ?? []).map((market) => [market.id, market]));
  const activeScanSymbols = (config?.symbols ?? []).filter((symbol) => {
    const market = marketById.get(symbol.market);
    return symbol.enabled && market?.enabled && market.scanEnabled;
  }).length;
  return {
    totalMarkets: config?.markets?.length ?? 0,
    scanMarkets: (config?.markets ?? []).filter((market) => market.enabled && market.scanEnabled).length,
    totalSymbols: config?.symbols?.length ?? 0,
    enabledSymbols: (config?.symbols ?? []).filter((symbol) => symbol.enabled).length,
    activeScanSymbols
  };
}

function normalizeMarketDraft(market) {
  return {
    ...market,
    id: market.id.trim().toUpperCase(),
    label: market.label.trim(),
    country: market.country.trim(),
    timezone: market.timezone.trim(),
    currency: market.currency.trim().toUpperCase(),
    maxSymbolsPerRun: Number(market.maxSymbolsPerRun) || 80
  };
}

function normalizeSymbolDraft(symbol) {
  const normalizedSymbol = symbol.symbol.trim().toUpperCase();
  const market = symbol.market.trim().toUpperCase();
  return {
    ...symbol,
    id: `${market}:${normalizedSymbol}`,
    symbol: normalizedSymbol,
    market,
    name: symbol.name.trim(),
    group: symbol.group.trim(),
    sector: symbol.sector.trim(),
    marketCapTier: symbol.marketCapTier || "unknown"
  };
}
