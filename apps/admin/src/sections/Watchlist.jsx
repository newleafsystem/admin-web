import { useEffect, useMemo, useState } from "react";
import { ModalShell } from "../components/common.jsx";

const MARKET_PROVIDERS = [
  { value: "alpaca", label: "Alpaca" },
  { value: "yahoo", label: "Yahoo" },
  { value: "manual", label: "Manual" }
];

const PAGE_SIZE = 24;

const emptyMarket = {
  id: "",
  label: "",
  country: "",
  timezone: "",
  currency: "",
  provider: "manual",
  enabled: true,
  scanEnabled: false,
  maxSymbolsPerRun: 150,
  notes: ""
};

const styles = {
  kpis: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: 12,
    marginTop: 18
  },
  notice: {
    background: "#f6f8fa",
    border: "1px solid #d9e2ea",
    borderRadius: 8,
    color: "#42526a",
    display: "grid",
    gap: 4,
    marginTop: 14,
    padding: "12px 14px"
  },
  marketGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
    gap: 10
  },
  marketCard: {
    alignItems: "start",
    background: "#fbfcfd",
    border: "1px solid #d9e2ea",
    borderRadius: 8,
    display: "grid",
    gap: 10,
    minHeight: 118,
    padding: 14,
    textAlign: "left"
  },
  marketCardActive: {
    background: "#edf7f3",
    borderColor: "rgba(39, 116, 92, 0.5)",
    boxShadow: "0 0 0 2px rgba(39, 116, 92, 0.12)"
  },
  marketTop: {
    alignItems: "start",
    display: "flex",
    justifyContent: "space-between",
    gap: 12
  },
  marketTitle: {
    display: "grid",
    gap: 3
  },
  symbolToolbar: {
    alignItems: "end",
    display: "grid",
    gridTemplateColumns: "minmax(220px, 1fr) auto",
    gap: 12
  },
  searchField: {
    display: "grid",
    gap: 6
  },
  searchInput: {
    minHeight: 40,
    width: "100%"
  },
  symbolGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
    gap: 10,
    marginTop: 16
  },
  symbolCard: {
    background: "#ffffff",
    border: "1px solid #d9e2ea",
    borderRadius: 8,
    display: "grid",
    gap: 10,
    minHeight: 126,
    padding: 12
  },
  symbolHeader: {
    alignItems: "start",
    display: "flex",
    justifyContent: "space-between",
    gap: 10
  },
  symbolMeta: {
    color: "#667085",
    display: "grid",
    fontSize: 12,
    gap: 3,
    lineHeight: 1.35
  },
  symbolActions: {
    display: "flex",
    justifyContent: "flex-end"
  },
  badgeRow: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: 6
  },
  pager: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: "space-between",
    marginTop: 14
  },
  formGrid: {
    display: "grid",
    gap: 14,
    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))"
  },
  field: {
    display: "grid",
    gap: 6
  },
  input: {
    minHeight: 40,
    width: "100%"
  },
  checkboxRow: {
    alignItems: "center",
    border: "1px solid #d9e2ea",
    borderRadius: 8,
    display: "flex",
    gap: 9,
    minHeight: 40,
    padding: "8px 10px"
  },
  checkbox: {
    flex: "0 0 auto",
    height: 16,
    margin: 0,
    minHeight: 16,
    width: 16
  },
  dialogCopy: {
    color: "#5b6678",
    fontSize: 13,
    lineHeight: 1.45,
    margin: 0
  }
};

export function Watchlist({ config, onRefresh, onSave }) {
  const [draft, setDraft] = useState(config);
  const [selectedMarketId, setSelectedMarketId] = useState(config?.markets?.[0]?.id ?? "US");
  const [marketDialog, setMarketDialog] = useState(null);
  const [symbolDialog, setSymbolDialog] = useState(null);
  const [deleteMarket, setDeleteMarket] = useState(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    setDraft(config);
    setSelectedMarketId((current) => config?.markets?.some((market) => market.id === current)
      ? current
      : config?.markets?.[0]?.id ?? "US");
    setPage(1);
  }, [config]);

  useEffect(() => {
    setPage(1);
  }, [query, selectedMarketId]);

  const summary = useMemo(() => summarizeWatchlist(draft), [draft]);
  const universe = useMemo(() => normalizedUniverse(draft), [draft]);
  const marketSymbols = useMemo(
    () => (draft?.symbols ?? []).filter((symbol) => symbol.market === selectedMarketId),
    [draft, selectedMarketId]
  );
  const filteredSymbols = useMemo(() => filterSymbols(marketSymbols, query), [marketSymbols, query]);
  const totalPages = Math.max(1, Math.ceil(filteredSymbols.length / PAGE_SIZE));
  const visibleSymbols = filteredSymbols.slice((Math.min(page, totalPages) - 1) * PAGE_SIZE, Math.min(page, totalPages) * PAGE_SIZE);
  const selectedMarket = draft?.markets?.find((market) => market.id === selectedMarketId) ?? null;
  const selectedMarketListings = universe.filter((symbol) => symbol.market === selectedMarketId);
  const dirty = Boolean(draft && config && JSON.stringify(draft) !== JSON.stringify(config));

  function openAddMarket() {
    setMarketDialog({ mode: "add", market: { ...emptyMarket } });
  }

  function openEditMarket(market) {
    setMarketDialog({ mode: "edit", market: { ...emptyMarket, ...market } });
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
    const remainingMarkets = (draft?.markets ?? []).filter((market) => market.id !== deleteMarket.id);
    setDraft((current) => {
      return {
        ...current,
        markets: remainingMarkets,
        symbols: current.symbols.filter((symbol) => symbol.market !== deleteMarket.id),
        universeSymbols: (current.universeSymbols ?? []).filter((symbol) => symbol.market !== deleteMarket.id)
      };
    });
    if (selectedMarketId === deleteMarket.id) {
      setSelectedMarketId(remainingMarkets[0]?.id ?? "US");
    }
    setDeleteMarket(null);
  }

  function openAddSymbol() {
    const candidates = availableSymbolsForMarket(draft, selectedMarketId);
    setSymbolDialog({
      marketId: selectedMarketId,
      selectedId: candidates[0]?.id ?? "",
      candidates
    });
  }

  function saveSymbolDialog() {
    const candidate = symbolDialog.candidates.find((symbol) => symbol.id === symbolDialog.selectedId);
    if (!candidate) return;
    const symbol = normalizeSymbolDraft({ ...candidate, enabled: true });
    setDraft((current) => {
      const symbols = current.symbols.filter((item) => item.id !== symbol.id);
      return {
        ...current,
        symbols: [...symbols, symbol].sort((left, right) => `${left.market}:${left.symbol}`.localeCompare(`${right.market}:${right.symbol}`))
      };
    });
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
              {summary.totalSymbols} watchlist symbols, {summary.activeScanSymbols} active scan symbols, {summary.totalListings} available listings
            </span>
          </div>
          <div className="button-row">
            <button type="button" onClick={refresh}>Refresh</button>
            <button className="primary" disabled={!dirty || saving} type="button" onClick={saveChanges}>
              {saving ? "Saving..." : "Save watchlist"}
            </button>
          </div>
        </div>

        <div style={styles.kpis}>
          <Metric label="Markets" value={summary.totalMarkets} />
          <Metric label="Listings" value={summary.totalListings} />
          <Metric label="Watchlist symbols" value={summary.totalSymbols} />
          <Metric label="Scan markets" value={summary.scanMarkets} />
        </div>

        <div style={styles.notice}>
          <strong>Scheduler batching is runtime configuration.</strong>
          <span>
            This screen manages markets and watchlist membership. Provider batch size, request delay, and concurrency stay in backend configuration so large markets can run in consecutive batches without blocking watchlist edits.
          </span>
          {draft.universeSync?.updatedAt && (
            <span>
              Listing universe last synced {draft.universeSync.updatedAt}. Yahoo live calls are capped at {draft.universeSync.yahooDailyCallLimit || 250} per day and cached by the scheduler worker.
            </span>
          )}
        </div>

        {message && <div className="form-success">{message}</div>}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Markets</h2>
            <span className="muted">Markets without listings stay disabled for add-symbol lookup and scheduler scans.</span>
          </div>
          <button type="button" onClick={openAddMarket}>Add market</button>
        </div>

        <div style={styles.marketGrid}>
          {draft.markets.map((market) => {
            const listingCount = universe.filter((symbol) => symbol.market === market.id).length;
            const symbolCount = draft.symbols.filter((symbol) => symbol.market === market.id).length;
            const syncStatus = draft.universeSync?.markets?.[market.id];
            return (
              <button
                key={market.id}
                style={{
                  ...styles.marketCard,
                  ...(market.id === selectedMarketId ? styles.marketCardActive : {})
                }}
                type="button"
                onClick={() => setSelectedMarketId(market.id)}
              >
                <span style={styles.marketTop}>
                  <span style={styles.marketTitle}>
                    <strong>{market.id} - {market.label}</strong>
                    <small className="muted">{[market.currency, providerLabel(market.provider)].filter(Boolean).join(" / ")}</small>
                  </span>
                  <MarketStateBadge market={market} listingCount={listingCount} />
                </span>
                <span style={styles.badgeRow}>
                  <Badge>{symbolCount} selected</Badge>
                  <Badge>{listingCount} listings</Badge>
                  <Badge>{market.scanEnabled && listingCount > 0 ? "Scheduler on" : "Scheduler off"}</Badge>
                  {syncStatus?.syncedAt && <Badge>{syncStatus.status}: {syncStatus.syncedAt}</Badge>}
                </span>
              </button>
            );
          })}
        </div>

        {selectedMarket && (
          <div className="market-detail">
            <div>
              <h3>{selectedMarket.label}</h3>
              <p>{[selectedMarket.id, selectedMarket.currency, providerLabel(selectedMarket.provider)].filter(Boolean).join(" / ")}</p>
            </div>
            <div className="button-row">
              <MarketStateBadge market={selectedMarket} listingCount={selectedMarketListings.length} />
              <StatusPill active={selectedMarket.scanEnabled && selectedMarketListings.length > 0}>
                {selectedMarket.scanEnabled && selectedMarketListings.length > 0 ? "Scheduler on" : "Scheduler off"}
              </StatusPill>
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
            <span className="muted">
              {marketSymbols.length} selected from {selectedMarketListings.length} available listing{selectedMarketListings.length === 1 ? "" : "s"}
            </span>
          </div>
          <button disabled={selectedMarketListings.length === 0 || availableSymbolsForMarket(draft, selectedMarketId).length === 0} type="button" onClick={openAddSymbol}>
            Add stock
          </button>
        </div>

        {selectedMarketListings.length === 0 ? (
          <div className="empty-state">
            <h3>Listings disabled for this market</h3>
            <p>Add a listing universe for {selectedMarketId} before adding stocks or enabling scheduler scans.</p>
          </div>
        ) : (
          <>
            <div style={styles.symbolToolbar}>
              <label style={styles.searchField}>
                <span className="muted">Search selected stocks</span>
                <input
                  placeholder="Search symbol, name, sector, or group"
                  style={styles.searchInput}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <span className="muted">
                Showing {visibleSymbols.length} of {filteredSymbols.length}
              </span>
            </div>

            <div style={styles.symbolGrid}>
              {visibleSymbols.length === 0 ? (
                <div className="empty-inline">No symbols match this search.</div>
              ) : (
                visibleSymbols.map((symbol) => (
                  <SymbolCard key={symbol.id} symbol={symbol} onRemove={() => removeSymbol(symbol)} />
                ))
              )}
            </div>

            <div style={styles.pager}>
              <span className="muted">Page {Math.min(page, totalPages)} of {totalPages}</span>
              <div className="button-row">
                <button disabled={page <= 1} type="button" onClick={() => setPage((current) => Math.max(1, current - 1))}>
                  Previous
                </button>
                <button disabled={page >= totalPages} type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>
                  Next
                </button>
              </div>
            </div>
          </>
        )}
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
          onCancel={() => setSymbolDialog(null)}
          onChange={(selectedId) => setSymbolDialog((current) => ({ ...current, selectedId }))}
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

function SymbolCard({ onRemove, symbol }) {
  return (
    <article style={styles.symbolCard}>
      <div style={styles.symbolHeader}>
        <div>
          <strong>{symbol.symbol}</strong>
          <div className="muted">{symbol.name || "Name not set"}</div>
        </div>
        <Badge>{symbol.marketCapTier || "unknown"}</Badge>
      </div>
      <div style={styles.symbolMeta}>
        <span>{symbol.group || "Group not set"}</span>
        <span>{symbol.sector || "Sector not set"}</span>
        <span>{[symbol.exchange, symbol.providerSymbol].filter(Boolean).join(" / ") || "Provider symbol not set"}</span>
        {symbol.notes && <span>{symbol.notes}</span>}
      </div>
      <div style={styles.symbolActions}>
        <button className="danger" type="button" onClick={onRemove}>Remove</button>
      </div>
    </article>
  );
}

function Field({ children, label }) {
  return (
    <label style={styles.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Badge({ children }) {
  return <span className="status status-unknown">{children}</span>;
}

function StatusPill({ active, children }) {
  return <span className={active ? "status status-active" : "status status-unknown"}>{children}</span>;
}

function MarketStateBadge({ listingCount, market }) {
  if (listingCount === 0) {
    return <StatusPill active={false}>Disabled</StatusPill>;
  }
  return <StatusPill active={market.enabled}>{market.enabled ? "Enabled" : "Disabled"}</StatusPill>;
}

function MarketDialog({ dialog, existingMarkets, onCancel, onChange, onSave }) {
  const market = dialog.market;
  const normalizedId = market.id.trim().toUpperCase();
  const duplicate = dialog.mode === "add" && existingMarkets.some((item) => item.id === normalizedId);
  const invalid = !/^[A-Z][A-Z0-9_-]{1,11}$/.test(normalizedId) || duplicate || !market.label.trim() || !market.currency.trim();

  return (
    <ModalShell className="confirm-dialog wide-dialog" labelledBy="market-dialog-title" onClose={onCancel}>
      <DialogHeader titleId="market-dialog-title" title={dialog.mode === "add" ? "Add Market" : "Edit Market"} subtitle={market.id || "New market"} onClose={onCancel} />
      <div className="modal-body">
        <div style={styles.formGrid}>
          <Field label="Market id">
            <input disabled={dialog.mode === "edit"} style={styles.input} value={market.id} onChange={(event) => onChange({ ...market, id: event.target.value.toUpperCase() })} />
          </Field>
          <Field label="Label">
            <input style={styles.input} value={market.label} onChange={(event) => onChange({ ...market, label: event.target.value })} />
          </Field>
          <Field label="Currency">
            <input style={styles.input} value={market.currency} onChange={(event) => onChange({ ...market, currency: event.target.value.toUpperCase() })} />
          </Field>
          <Field label="Provider">
            <select style={styles.input} value={market.provider} onChange={(event) => onChange({ ...market, provider: event.target.value })}>
              {MARKET_PROVIDERS.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}
            </select>
          </Field>
          <label style={styles.checkboxRow}>
            <input style={styles.checkbox} type="checkbox" checked={market.enabled} onChange={(event) => onChange({ ...market, enabled: event.target.checked })} />
            Enabled in watchlist
          </label>
          <label style={styles.checkboxRow}>
            <input style={styles.checkbox} type="checkbox" checked={market.scanEnabled} onChange={(event) => onChange({ ...market, scanEnabled: event.target.checked })} />
            Include in scheduler scan
          </label>
        </div>
      </div>
      {duplicate && <div className="form-error">A market with this id already exists.</div>}
      <div className="modal-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={invalid} type="button" onClick={onSave}>Save market</button>
      </div>
    </ModalShell>
  );
}

function SymbolDialog({ dialog, onCancel, onChange, onSave }) {
  const selected = dialog.candidates.find((symbol) => symbol.id === dialog.selectedId);

  return (
    <ModalShell className="confirm-dialog wide-dialog" labelledBy="symbol-dialog-title" onClose={onCancel}>
      <DialogHeader titleId="symbol-dialog-title" title="Add Stock" subtitle={dialog.marketId} onClose={onCancel} />
      <div className="modal-body" style={{ display: "grid", gap: 14 }}>
        {dialog.candidates.length === 0 ? (
          <p style={styles.dialogCopy}>No available listings remain for this market.</p>
        ) : (
          <>
            <Field label="Stock lookup">
              <select style={styles.input} value={dialog.selectedId} onChange={(event) => onChange(event.target.value)}>
                {dialog.candidates.map((symbol) => (
                  <option key={symbol.id} value={symbol.id}>
                    {symbol.symbol} - {symbol.name || symbol.sector || symbol.group || symbol.exchange || "Listing"}
                  </option>
                ))}
              </select>
            </Field>
            {selected && (
              <p style={styles.dialogCopy}>
                {selected.name || selected.symbol} - {[selected.exchange, selected.providerSymbol, selected.group, selected.sector, selected.marketCapTier].filter(Boolean).join(" / ")}
              </p>
            )}
          </>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!selected} type="button" onClick={onSave}>Add stock</button>
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
  const universe = normalizedUniverse(config);
  const activeScanSymbols = (config?.symbols ?? []).filter((symbol) => {
    const market = marketById.get(symbol.market);
    return symbol.enabled && market?.enabled && market.scanEnabled;
  }).length;
  return {
    totalMarkets: config?.markets?.length ?? 0,
    scanMarkets: (config?.markets ?? []).filter((market) => {
      const listings = universe.filter((symbol) => symbol.market === market.id).length;
      return market.enabled && market.scanEnabled && listings > 0;
    }).length,
    totalSymbols: config?.symbols?.length ?? 0,
    totalListings: universe.length,
    activeScanSymbols
  };
}

function availableSymbolsForMarket(config, marketId) {
  const existingIds = new Set((config?.symbols ?? []).map((symbol) => symbol.id));
  return normalizedUniverse(config)
    .filter((symbol) => symbol.market === marketId && !existingIds.has(symbol.id))
    .sort(compareSymbols);
}

function normalizedUniverse(config) {
  const source = config?.universeSymbols?.length ? config.universeSymbols : config?.symbols ?? [];
  const seen = new Set();
  return source.map(normalizeSymbolDraft).filter((symbol) => {
    if (!symbol.symbol || seen.has(symbol.id)) return false;
    seen.add(symbol.id);
    return true;
  }).sort(compareSymbols);
}

function filterSymbols(symbols, value) {
  const query = value.trim().toLowerCase();
  if (!query) return symbols.sort(compareSymbols);
  return symbols.filter((symbol) =>
    [symbol.symbol, symbol.providerSymbol, symbol.name, symbol.exchange, symbol.group, symbol.sector, symbol.marketCapTier]
      .join(" ")
      .toLowerCase()
      .includes(query)
  ).sort(compareSymbols);
}

function compareSymbols(left, right) {
  return `${left.market}:${left.symbol}`.localeCompare(`${right.market}:${right.symbol}`);
}

function providerLabel(provider) {
  return MARKET_PROVIDERS.find((item) => item.value === provider)?.label ?? provider;
}

function normalizeMarketDraft(market) {
  return {
    ...market,
    id: market.id.trim().toUpperCase(),
    label: market.label.trim(),
    currency: market.currency.trim().toUpperCase(),
    provider: market.provider || "manual",
    maxSymbolsPerRun: Number(market.maxSymbolsPerRun) || 150
  };
}

function normalizeSymbolDraft(symbol) {
  const normalizedSymbol = String(symbol.symbol ?? "").trim().toUpperCase();
  const market = String(symbol.market ?? "US").trim().toUpperCase();
  return {
    ...symbol,
    id: `${market}:${normalizedSymbol}`,
    symbol: normalizedSymbol,
    market,
    name: String(symbol.name ?? "").trim(),
    providerSymbol: String(symbol.providerSymbol ?? normalizedSymbol).trim().toUpperCase(),
    exchange: String(symbol.exchange ?? "").trim(),
    assetClass: String(symbol.assetClass ?? "").trim(),
    listingSource: String(symbol.listingSource ?? symbol.source ?? "").trim(),
    active: symbol.active !== false,
    group: String(symbol.group ?? "").trim(),
    sector: String(symbol.sector ?? "").trim(),
    marketCapTier: String(symbol.marketCapTier ?? "unknown").trim() || "unknown",
    enabled: symbol.enabled !== false,
    notes: String(symbol.notes ?? "").trim()
  };
}
