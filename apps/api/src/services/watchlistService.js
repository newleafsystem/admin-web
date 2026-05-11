import { badRequest } from '../lib/httpErrors.js';

export const WATCHLIST_CONFIG_ID = 'default';
export const MARKET_PROVIDER_IDS = Object.freeze(['alpaca', 'yahoo', 'manual']);

export const DEFAULT_WATCHLIST_LIMITS = Object.freeze({
  maxSymbolsPerRun: 150,
  maxSymbolsPerMarket: 150,
  intradayConcurrency: 5,
  dailyConcurrency: 1,
  yahooRequestDelayMs: 350,
});

const DEFAULT_MARKETS = Object.freeze([
  {
    id: 'US',
    label: 'United States',
    country: 'United States',
    timezone: 'America/New_York',
    currency: 'USD',
    provider: 'alpaca',
    enabled: true,
    scanEnabled: true,
    maxSymbolsPerRun: 150,
  },
  {
    id: 'IN',
    label: 'India',
    country: 'India',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    provider: 'yahoo',
    enabled: false,
    scanEnabled: false,
    maxSymbolsPerRun: 80,
  },
  {
    id: 'CN',
    label: 'China',
    country: 'China',
    timezone: 'Asia/Shanghai',
    currency: 'CNY',
    provider: 'yahoo',
    enabled: false,
    scanEnabled: false,
    maxSymbolsPerRun: 80,
  },
]);

export function createWatchlistService({ repository, clock = () => new Date().toISOString() } = {}) {
  if (!repository) {
    throw new Error('watchlistService requires repository');
  }

  async function getWatchlistConfig() {
    const existing = await repository.getMarketWatchlist(WATCHLIST_CONFIG_ID);
    return normalizeWatchlistConfig(existing ?? defaultWatchlistConfig(clock()));
  }

  async function updateWatchlistConfig(input, { actorUid = null } = {}) {
    const normalized = normalizeWatchlistConfig({
      ...input,
      id: WATCHLIST_CONFIG_ID,
      updatedBy: actorUid,
      updatedAt: clock(),
    });
    validateScanLimits(normalized);
    return normalizeWatchlistConfig(await repository.upsertMarketWatchlist(WATCHLIST_CONFIG_ID, normalized));
  }

  return {
    getWatchlistConfig,
    updateWatchlistConfig,
  };
}

export function defaultWatchlistConfig(timestamp = new Date().toISOString()) {
  return {
    id: WATCHLIST_CONFIG_ID,
    version: 1,
    markets: DEFAULT_MARKETS.map((market) => ({ ...market })),
    symbols: [],
    limits: { ...DEFAULT_WATCHLIST_LIMITS },
    notes: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    updatedBy: null,
  };
}

export function normalizeWatchlistConfig(input = {}) {
  const limits = normalizeLimits(input.limits);
  const markets = normalizeMarkets(input.markets);
  const marketIds = new Set(markets.map((market) => market.id));
  const seenSymbols = new Set();
  const symbols = [];

  for (const raw of Array.isArray(input.symbols) ? input.symbols : []) {
    const symbol = normalizeSymbol(raw, marketIds);
    const key = `${symbol.market}:${symbol.symbol}`;
    if (seenSymbols.has(key)) {
      throw badRequest('Duplicate watchlist symbol', { symbol: symbol.symbol, market: symbol.market });
    }
    seenSymbols.add(key);
    symbols.push(symbol);
  }

  return {
    id: WATCHLIST_CONFIG_ID,
    version: 1,
    markets,
    symbols,
    limits,
    notes: cleanString(input.notes, 1000) ?? '',
    createdAt: cleanString(input.createdAt, 80) ?? null,
    updatedAt: cleanString(input.updatedAt, 80) ?? new Date().toISOString(),
    updatedBy: cleanString(input.updatedBy, 120) ?? null,
  };
}

function normalizeLimits(raw = {}) {
  return {
    maxSymbolsPerRun: cleanNumber(raw.maxSymbolsPerRun, DEFAULT_WATCHLIST_LIMITS.maxSymbolsPerRun, 1, 500),
    maxSymbolsPerMarket: cleanNumber(raw.maxSymbolsPerMarket, DEFAULT_WATCHLIST_LIMITS.maxSymbolsPerMarket, 1, 500),
    intradayConcurrency: cleanNumber(raw.intradayConcurrency, DEFAULT_WATCHLIST_LIMITS.intradayConcurrency, 1, 10),
    dailyConcurrency: cleanNumber(raw.dailyConcurrency, DEFAULT_WATCHLIST_LIMITS.dailyConcurrency, 1, 1),
    yahooRequestDelayMs: cleanNumber(raw.yahooRequestDelayMs, DEFAULT_WATCHLIST_LIMITS.yahooRequestDelayMs, 0, 5000),
  };
}

function normalizeMarkets(rawMarkets = []) {
  const incoming = Array.isArray(rawMarkets) && rawMarkets.length > 0 ? rawMarkets : DEFAULT_MARKETS;
  const markets = [];
  const seen = new Set();

  for (const raw of incoming) {
    const id = normalizeMarketId(raw?.id);
    if (seen.has(id)) {
      throw badRequest('Duplicate market id', { market: id });
    }
    seen.add(id);
    const provider = cleanString(raw?.provider, 40) ?? 'manual';
    if (!MARKET_PROVIDER_IDS.includes(provider)) {
      throw badRequest('Market provider is not supported', { provider, allowed: MARKET_PROVIDER_IDS });
    }
    markets.push({
      id,
      label: cleanString(raw?.label, 80) ?? id,
      country: cleanString(raw?.country, 80) ?? '',
      timezone: cleanString(raw?.timezone, 80) ?? '',
      currency: cleanString(raw?.currency, 12) ?? '',
      provider,
      enabled: raw?.enabled !== false,
      scanEnabled: raw?.scanEnabled === true,
      maxSymbolsPerRun: cleanNumber(raw?.maxSymbolsPerRun, DEFAULT_WATCHLIST_LIMITS.maxSymbolsPerMarket, 1, 500),
      notes: cleanString(raw?.notes, 500) ?? '',
    });
  }

  return markets;
}

function normalizeSymbol(raw, marketIds) {
  const symbol = String(raw?.symbol ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9^][A-Z0-9.\-^=]{0,23}$/.test(symbol)) {
    throw badRequest('Symbol is not valid for the watchlist', { symbol });
  }
  const market = normalizeMarketId(raw?.market ?? 'US');
  if (!marketIds.has(market)) {
    throw badRequest('Symbol references a market that does not exist', { symbol, market });
  }
  return {
    id: `${market}:${symbol}`,
    symbol,
    market,
    name: cleanString(raw?.name, 120) ?? '',
    group: cleanString(raw?.group, 80) ?? '',
    sector: cleanString(raw?.sector, 80) ?? '',
    marketCapTier: cleanString(raw?.marketCapTier, 40) ?? 'unknown',
    enabled: raw?.enabled !== false,
    notes: cleanString(raw?.notes, 500) ?? '',
  };
}

function validateScanLimits(config) {
  const marketById = new Map(config.markets.map((market) => [market.id, market]));
  const activeByMarket = new Map();
  let activeScanCount = 0;

  for (const symbol of config.symbols) {
    const market = marketById.get(symbol.market);
    if (!symbol.enabled || !market?.enabled || !market.scanEnabled) continue;
    activeScanCount += 1;
    activeByMarket.set(symbol.market, (activeByMarket.get(symbol.market) ?? 0) + 1);
  }

  if (activeScanCount > config.limits.maxSymbolsPerRun) {
    throw badRequest('Active scan watchlist exceeds the configured run limit', {
      activeScanCount,
      maxSymbolsPerRun: config.limits.maxSymbolsPerRun,
    });
  }

  for (const market of config.markets) {
    const count = activeByMarket.get(market.id) ?? 0;
    const max = Math.min(market.maxSymbolsPerRun, config.limits.maxSymbolsPerMarket);
    if (count > max) {
      throw badRequest('Active market watchlist exceeds the configured market limit', {
        market: market.id,
        activeScanCount: count,
        maxSymbolsPerMarket: max,
      });
    }
  }
}

function normalizeMarketId(value) {
  const id = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,11}$/.test(id)) {
    throw badRequest('Market id is not valid', { market: id });
  }
  return id;
}

function cleanString(value, maxLength) {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function cleanNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
