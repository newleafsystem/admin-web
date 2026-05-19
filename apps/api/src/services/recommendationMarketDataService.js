import { config } from '../config.js';

const DEFAULT_OPTION_FEED = 'indicative';
const DEFAULT_EXPIRY_DAYS = 30;
const SUPPORTED_STRATEGIES = [
  {
    key: 'iron-condor',
    label: 'Iron Condor',
    direction: 'NEUTRAL',
    patterns: [/iron\s+condor/i, /\bcondor\b/i],
  },
  {
    key: 'iron-butterfly',
    label: 'Iron Butterfly',
    direction: 'NEUTRAL',
    patterns: [/iron\s+butterfly/i, /\biron\s+fly\b/i, /\bfly\b/i],
  },
  {
    key: 'bull-put-spread',
    label: 'Bull Put Spread',
    direction: 'BULLISH',
    patterns: [/bull\s+put/i, /put\s+credit\s+spread/i],
  },
  {
    key: 'bear-call-spread',
    label: 'Bear Call Spread',
    direction: 'BEARISH',
    patterns: [/bear\s+call/i, /call\s+credit\s+spread/i],
  },
];

const SYMBOL_STOP_WORDS = new Set([
  'A',
  'AI',
  'API',
  'BULL',
  'BEAR',
  'CALL',
  'CLI',
  'CREDIT',
  'DTE',
  'ETF',
  'EXPIRY',
  'FOR',
  'FROM',
  'GAMMA',
  'GENERATE',
  'IDEA',
  'IRON',
  'JSON',
  'LLM',
  'MAX',
  'NEWLEAF',
  'OPTION',
  'OPTIONS',
  'PICK',
  'POP',
  'PRICE',
  'PUT',
  'RISK',
  'RATIO',
  'REWARD',
  'R2',
  'SPREAD',
  'STOCK',
  'STRATEGY',
  'THE',
  'TRADE',
  'WITH',
]);

export function createRecommendationMarketDataService({
  serviceConfig = config,
  fetchImpl = fetch,
  clock = () => new Date(),
} = {}) {
  async function buildRecommendationDraft({ prompt, promptId, batch } = {}) {
    const warnings = [];
    const intent = parseRecommendationPromptIntent(prompt, {
      promptId,
      tradeDate: batch?.tradeDate,
    });

    if (!intent.symbol) {
      return { recommendation: null, intent, warnings: ['No ticker symbol could be parsed from the prompt.'] };
    }
    if (!hasAlpacaConfig(serviceConfig)) {
      return {
        recommendation: null,
        intent,
        warnings: ['Alpaca market data is not configured, so calculated recommendation metrics were skipped.'],
      };
    }

    if (intent.expiryWasAssumed) {
      warnings.push(`No expiry was provided; assumed ${intent.expiry} from the trade date.`);
    }

    const snapshot = await fetchStockSnapshot(intent.symbol);
    const calculatedAt = timestampFromClock(clock);
    const [gammaContext, sentimentContext] = await Promise.all([
      fetchGammaContext(intent.symbol),
      fetchSentimentContext(intent.symbol),
    ]);

    if (!intent.strategyKey) {
      warnings.push(`No supported options strategy could be parsed for ${intent.symbol}.`);
      return {
        recommendation: buildSpotPriceDraft({
          intent,
          prompt,
          snapshot,
          gammaContext,
          sentimentContext,
          warnings,
          calculatedAt,
        }),
        intent,
        warnings,
      };
    }

    const chain = await fetchOptionChain(intent.symbol, intent.expiry);
    const calls = chain.filter((contract) => contract.type === 'call').sort(sortByStrike);
    const puts = chain.filter((contract) => contract.type === 'put').sort(sortByStrike);
    if (calls.length < 2 || puts.length < 2) {
      warnings.push(`Not enough option contracts were returned for ${intent.symbol} ${intent.expiry}.`);
      return {
        recommendation: buildSpotPriceDraft({
          intent,
          prompt,
          snapshot,
          gammaContext,
          sentimentContext,
          warnings,
          calculatedAt,
        }),
        intent,
        warnings,
      };
    }

    let strategy = null;
    try {
      strategy = buildStrategyFromMarketData({
        strategyKey: intent.strategyKey,
        spot: snapshot.price,
        calls,
        puts,
        expiry: intent.expiry,
        asOfDate: clock(),
      });
    } catch (error) {
      warnings.push(error.message ?? `Could not calculate ${intent.strategy} metrics for ${intent.symbol}.`);
      return {
        recommendation: buildSpotPriceDraft({
          intent,
          prompt,
          snapshot,
          gammaContext,
          sentimentContext,
          warnings,
          calculatedAt,
        }),
        intent,
        warnings,
      };
    }

    const recommendation = buildRecommendationFromStrategy({
      intent,
      prompt,
      snapshot,
      strategy,
      gammaContext,
      sentimentContext,
      warnings,
      calculatedAt,
    });

    return { recommendation, intent, warnings };
  }

  async function fetchStockSnapshot(symbol) {
    const data = await alpacaGet(`/v2/stocks/${encodeURIComponent(symbol)}/snapshot`);
    const latestTrade = data.latestTrade ?? {};
    const latestQuote = data.latestQuote ?? {};
    const minuteBar = data.minuteBar ?? {};
    const dailyBar = data.dailyBar ?? {};
    const prevDailyBar = data.prevDailyBar ?? {};
    const price = firstFiniteNumber(
      latestTrade.p,
      latestTrade.price,
      latestQuote.ap,
      latestQuote.askPrice,
      minuteBar.c,
      dailyBar.c,
      prevDailyBar.c,
    );

    if (!price || price <= 0) {
      throw new Error(`Alpaca did not return a usable spot price for ${symbol}.`);
    }

    const previousClose = firstFiniteNumber(prevDailyBar.c, dailyBar.o);
    return {
      price: roundNumber(price, 2),
      change: previousClose ? roundNumber(price - previousClose, 2) : null,
      changePercent: previousClose ? roundNumber(((price - previousClose) / previousClose) * 100, 2) : null,
    };
  }

  async function fetchOptionChain(symbol, expiry) {
    const data = await alpacaGet(`/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`, {
      expiration_date_gte: expiry,
      expiration_date_lte: expiry,
      feed: DEFAULT_OPTION_FEED,
      limit: '1000',
    }).catch(() => ({ snapshots: {} }));

    return parseOptionSnapshots(data.snapshots ?? {});
  }

  async function fetchGammaContext(symbol) {
    const report = await fetchPublicReport(symbol, 'latest.json');
    return normalizeGammaContext(report);
  }

  async function fetchSentimentContext(symbol) {
    const report = await fetchPublicReport(symbol, 'sentiment.json');
    return normalizeSentimentContext(report);
  }

  async function fetchPublicReport(symbol, filename) {
    const origin = String(serviceConfig.publicAssets?.dataOriginUrl ?? '').trim().replace(/\/+$/, '');
    if (!origin) return null;

    try {
      const response = await fetchImpl(`${origin}/reports/${encodeURIComponent(symbol)}/${filename}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return null;
      return response.json().catch(() => null);
    } catch {
      return null;
    }
  }

  async function alpacaGet(pathname, query = {}) {
    const url = new URL(pathname, normalizeAlpacaBaseUrl(serviceConfig));
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetchImpl(url, {
        headers: {
          'APCA-API-KEY-ID': serviceConfig.alpaca.apiKey,
          'APCA-API-SECRET-KEY': serviceConfig.alpaca.secretKey,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      }).catch((error) => {
        lastError = error;
        return null;
      });

      if (!response) {
        await wait((attempt + 1) * 250);
        continue;
      }
      if (response.ok) {
        return response.json();
      }
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`Alpaca market data request failed with HTTP ${response.status}.`);
      }
      lastError = new Error(`Alpaca market data request failed with HTTP ${response.status}.`);
      await wait((attempt + 1) * 500);
    }

    throw lastError ?? new Error('Alpaca market data request failed.');
  }

  return {
    buildRecommendationDraft,
  };
}

export function parseRecommendationPromptIntent(prompt, { promptId = null, tradeDate = null } = {}) {
  const text = String(prompt ?? '');
  const strategy = SUPPORTED_STRATEGIES.find((item) => item.patterns.some((pattern) => pattern.test(text)));
  const explicitExpiry = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] ?? null;
  const expiry = explicitExpiry ?? nextFridayAtLeastDays(tradeDate, DEFAULT_EXPIRY_DAYS);

  return {
    promptId,
    prompt: text,
    symbol: parseSymbol(text),
    strategyKey: strategy?.key ?? null,
    strategy: strategy?.label ?? null,
    direction: strategy?.direction ?? null,
    expiry,
    expiryWasAssumed: !explicitExpiry,
  };
}

export function parseOptionSnapshots(snapshots = {}) {
  const contracts = [];
  for (const [occ, snapshot] of Object.entries(snapshots)) {
    const parsedOcc = parseOccSymbol(occ);
    if (!parsedOcc) continue;
    const latestQuote = snapshot.latestQuote ?? {};
    const greeks = snapshot.greeks ?? {};
    const dailyBar = snapshot.dailyBar ?? {};
    const bid = firstFiniteNumber(latestQuote.bp, latestQuote.bidPrice, latestQuote.b) ?? 0;
    const ask = firstFiniteNumber(latestQuote.ap, latestQuote.askPrice, latestQuote.a) ?? 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : firstFiniteNumber(bid, ask, snapshot.latestTrade?.p);

    if (!Number.isFinite(parsedOcc.strike) || !Number.isFinite(mid) || mid <= 0) {
      continue;
    }

    contracts.push({
      occ,
      expiration: parsedOcc.expiration,
      type: parsedOcc.type,
      strike: parsedOcc.strike,
      delta: nullableNumber(greeks.delta),
      gamma: nullableNumber(greeks.gamma),
      theta: nullableNumber(greeks.theta),
      vega: nullableNumber(greeks.vega),
      iv: nullableNumber(greeks.midIV ?? greeks.iv ?? snapshot.impliedVolatility),
      bid: roundNumber(bid, 4),
      ask: roundNumber(ask, 4),
      mid: roundNumber(mid, 4),
      volume: nullableNumber(dailyBar.v) ?? 0,
      openInterest: nullableNumber(snapshot.openInterest) ?? 0,
    });
  }
  return contracts;
}

export function buildStrategyFromMarketData({ strategyKey, spot, calls, puts, expiry, asOfDate = new Date() } = {}) {
  if (strategyKey === 'iron-condor') {
    return buildIronCondor(spot, calls, puts, expiry, asOfDate);
  }
  if (strategyKey === 'iron-butterfly') {
    return buildIronButterfly(spot, calls, puts, expiry, asOfDate);
  }
  if (strategyKey === 'bull-put-spread') {
    return buildBullPutSpread(spot, puts, expiry, asOfDate);
  }
  if (strategyKey === 'bear-call-spread') {
    return buildBearCallSpread(spot, calls, expiry, asOfDate);
  }
  throw new Error(`Unsupported recommendation strategy: ${strategyKey}`);
}

function buildIronCondor(spot, calls, puts, expiry, asOfDate) {
  const dte = daysToExpiry(expiry, asOfDate);
  const wing = Math.max(5, Math.round(spot * 0.05));
  const shortPut = findClosest(puts, spot * 0.9);
  const shortCall = findClosest(calls, spot * 1.1);
  if (!shortPut || !shortCall) throw new Error('Could not select iron condor short strikes.');

  const longPut = findClosest(puts, shortPut.strike - wing);
  const longCall = findClosest(calls, shortCall.strike + wing);
  if (!longPut || !longCall) throw new Error('Could not select iron condor wing strikes.');
  if (longPut.strike >= shortPut.strike || longCall.strike <= shortCall.strike) {
    throw new Error('Invalid iron condor strike structure.');
  }

  const netCredit = (shortPut.mid - longPut.mid) + (shortCall.mid - longCall.mid);
  if (netCredit <= 0) throw new Error('Iron condor selected strikes do not produce a net credit.');

  const width = Math.max(shortPut.strike - longPut.strike, longCall.strike - shortCall.strike);
  const lower = shortPut.strike - netCredit;
  const upper = shortCall.strike + netCredit;
  const iv = shortPut.iv || shortCall.iv || averageIv([longPut, shortPut, shortCall, longCall]) || 0.3;
  const oddsOfProfit = Math.round(calcPoP(lower, upper, spot, iv, dte) * 100);

  return completeStrategy({
    strategy: 'Iron Condor',
    direction: 'NEUTRAL',
    expiry,
    dte,
    legs: [
      toLeg(longPut, 'BUY', 'PUT'),
      toLeg(shortPut, 'SELL', 'PUT'),
      toLeg(shortCall, 'SELL', 'CALL'),
      toLeg(longCall, 'BUY', 'CALL'),
    ],
    netCredit,
    maxProfit: netCredit * 100,
    maxLoss: (width - netCredit) * 100,
    rewardRisk: netCredit / (width - netCredit),
    oddsOfProfit,
    breakevens: { lower, upper },
  });
}

function buildIronButterfly(spot, calls, puts, expiry, asOfDate) {
  const dte = daysToExpiry(expiry, asOfDate);
  const wing = Math.max(5, Math.round(spot * 0.05));
  const shortPut = findClosest(puts, spot);
  const shortCall = findClosest(calls, spot);
  if (!shortPut || !shortCall) throw new Error('Could not select iron butterfly short strikes.');

  const longPut = findClosest(puts, shortPut.strike - wing);
  const longCall = findClosest(calls, shortCall.strike + wing);
  if (!longPut || !longCall) throw new Error('Could not select iron butterfly wing strikes.');
  if (longPut.strike >= shortPut.strike || longCall.strike <= shortCall.strike) {
    throw new Error('Invalid iron butterfly strike structure.');
  }

  const netCredit = (shortPut.mid - longPut.mid) + (shortCall.mid - longCall.mid);
  if (netCredit <= 0) throw new Error('Iron butterfly selected strikes do not produce a net credit.');

  const width = Math.max(shortPut.strike - longPut.strike, longCall.strike - shortCall.strike);
  const lower = shortPut.strike - netCredit;
  const upper = shortCall.strike + netCredit;
  const iv = shortPut.iv || shortCall.iv || averageIv([longPut, shortPut, shortCall, longCall]) || 0.3;
  const oddsOfProfit = Math.round(calcPoP(lower, upper, spot, iv, dte) * 100);

  return completeStrategy({
    strategy: 'Iron Butterfly',
    direction: 'NEUTRAL',
    expiry,
    dte,
    legs: [
      toLeg(longPut, 'BUY', 'PUT'),
      toLeg(shortPut, 'SELL', 'PUT'),
      toLeg(shortCall, 'SELL', 'CALL'),
      toLeg(longCall, 'BUY', 'CALL'),
    ],
    netCredit,
    maxProfit: netCredit * 100,
    maxLoss: (width - netCredit) * 100,
    rewardRisk: netCredit / (width - netCredit),
    oddsOfProfit,
    breakevens: { lower, upper },
  });
}

function buildBullPutSpread(spot, puts, expiry, asOfDate) {
  const dte = daysToExpiry(expiry, asOfDate);
  const wing = Math.max(5, Math.round(spot * 0.05));
  const shortPut = findClosest(puts, spot * 0.95);
  if (!shortPut) throw new Error('Could not select bull put spread short strike.');
  const longPut = findClosest(puts, shortPut.strike - wing);
  if (!longPut) throw new Error('Could not select bull put spread long strike.');
  if (longPut.strike >= shortPut.strike) throw new Error('Invalid bull put spread strike structure.');

  const netCredit = shortPut.mid - longPut.mid;
  if (netCredit <= 0) throw new Error('Bull put spread selected strikes do not produce a net credit.');

  const width = shortPut.strike - longPut.strike;
  const breakeven = shortPut.strike - netCredit;
  const iv = shortPut.iv || averageIv([shortPut, longPut]) || 0.3;
  const sigma = spot * iv * Math.sqrt(dte / 365);
  const oddsOfProfit = sigma > 0
    ? Math.round(normalCdf((spot - breakeven) / sigma) * 100)
    : 50;

  return completeStrategy({
    strategy: 'Bull Put Spread',
    direction: 'BULLISH',
    expiry,
    dte,
    legs: [
      toLeg(longPut, 'BUY', 'PUT'),
      toLeg(shortPut, 'SELL', 'PUT'),
    ],
    netCredit,
    maxProfit: netCredit * 100,
    maxLoss: (width - netCredit) * 100,
    rewardRisk: netCredit / (width - netCredit),
    oddsOfProfit,
    breakevens: { lower: breakeven, upper: null },
  });
}

function buildBearCallSpread(spot, calls, expiry, asOfDate) {
  const dte = daysToExpiry(expiry, asOfDate);
  const wing = Math.max(5, Math.round(spot * 0.05));
  const shortCall = findClosest(calls, spot * 1.05);
  if (!shortCall) throw new Error('Could not select bear call spread short strike.');
  const longCall = findClosest(calls, shortCall.strike + wing);
  if (!longCall) throw new Error('Could not select bear call spread long strike.');
  if (longCall.strike <= shortCall.strike) throw new Error('Invalid bear call spread strike structure.');

  const netCredit = shortCall.mid - longCall.mid;
  if (netCredit <= 0) throw new Error('Bear call spread selected strikes do not produce a net credit.');

  const width = longCall.strike - shortCall.strike;
  const breakeven = shortCall.strike + netCredit;
  const iv = shortCall.iv || averageIv([shortCall, longCall]) || 0.3;
  const sigma = spot * iv * Math.sqrt(dte / 365);
  const oddsOfProfit = sigma > 0
    ? Math.round(normalCdf((breakeven - spot) / sigma) * 100)
    : 50;

  return completeStrategy({
    strategy: 'Bear Call Spread',
    direction: 'BEARISH',
    expiry,
    dte,
    legs: [
      toLeg(shortCall, 'SELL', 'CALL'),
      toLeg(longCall, 'BUY', 'CALL'),
    ],
    netCredit,
    maxProfit: netCredit * 100,
    maxLoss: (width - netCredit) * 100,
    rewardRisk: netCredit / (width - netCredit),
    oddsOfProfit,
    breakevens: { lower: null, upper: breakeven },
  });
}

function completeStrategy(strategy) {
  const legs = strategy.legs.map((leg) => ({
    ...leg,
    premium: roundNumber(leg.premium, 2),
    mid: roundNumber(leg.mid ?? leg.premium, 2),
  }));
  const greeks = calculateNetGreeks(legs);
  return {
    ...strategy,
    legs,
    netCredit: roundNumber(strategy.netCredit, 2),
    maxProfit: roundNumber(strategy.maxProfit, 2),
    maxLoss: roundNumber(strategy.maxLoss, 2),
    rewardRisk: roundNumber(strategy.rewardRisk, 2),
    oddsOfProfit: clamp(Math.round(strategy.oddsOfProfit), 0, 100),
    breakevens: roundBreakevens(strategy.breakevens),
    greeks,
  };
}

function buildRecommendationFromStrategy({
  intent,
  prompt,
  snapshot,
  strategy,
  gammaContext,
  sentimentContext,
  warnings,
  calculatedAt,
}) {
  const gammaAnalysis = gammaContext?.analysis ?? gammaContext ?? null;
  const shortLegs = strategy.legs.filter((leg) => leg.action === 'SELL');
  const currentIV = averageIv(shortLegs.length ? shortLegs : strategy.legs);
  return {
    sourcePromptId: intent.promptId,
    symbol: intent.symbol,
    strategy: strategy.strategy,
    direction: strategy.direction,
    price: snapshot.price,
    expiry: strategy.expiry,
    dte: strategy.dte,
    rewardRisk: strategy.rewardRisk,
    oddsOfProfit: strategy.oddsOfProfit,
    maxProfit: strategy.maxProfit,
    maxLoss: strategy.maxLoss,
    netCredit: strategy.netCredit,
    thesis: `${intent.symbol} has a calculated ${strategy.strategy} structure using live option-chain mids; use the AI analysis for the final admin-facing thesis.`,
    riskNotes: 'Educational, defined-risk setup. Review liquidity, event risk, assignment risk, and suitability before publishing.',
    entry: 'Review the quoted mid prices and spreads before entry; do not publish if live pricing materially changes.',
    exit: 'Plan exits around profit targets, invalidation through short strikes, or volatility expansion.',
    ivContext: {
      currentIV: currentIV == null ? null : roundNumber(currentIV, 4),
      source: 'alpaca-option-snapshot',
    },
    sentiment: sentimentContext ?? {},
    lifecycle: {
      metricAssumptions: {
        source: 'alpaca-option-chain-r2-gamma-deterministic-calculation',
        structure: describeStructure(strategy),
        probabilityBasis:
          'Probability is model-estimated from spot, selected breakevens, option implied volatility, and days to expiry using a log-normal approximation.',
        confidence: gammaAnalysis ? 'medium' : 'low',
      },
      marketData: {
        ...marketDataSummary(snapshot, calculatedAt),
        optionFeed: DEFAULT_OPTION_FEED,
      },
      gammaContext: gammaAnalysis ?? {},
      sentimentContext: sentimentContext ?? {},
      calculation: {
        dte: strategy.dte,
        netCredit: strategy.netCredit,
        maxLoss: strategy.maxLoss,
        breakevens: strategy.breakevens,
        greeks: strategy.greeks,
      },
      prompt,
      warnings,
    },
    legs: strategy.legs.map((leg) => ({
      action: leg.action,
      type: leg.type,
      quantity: 1,
      strike: leg.strike,
      premium: leg.premium,
      mid: leg.mid,
      delta: leg.delta,
      gamma: leg.gamma,
      theta: leg.theta,
      vega: leg.vega,
      iv: leg.iv,
    })),
    greeks: strategy.greeks,
    breakevens: strategy.breakevens,
  };
}

function buildSpotPriceDraft({
  intent,
  prompt,
  snapshot,
  gammaContext,
  sentimentContext,
  warnings,
  calculatedAt,
}) {
  const gammaAnalysis = gammaContext?.analysis ?? gammaContext ?? null;
  return {
    sourcePromptId: intent.promptId,
    symbol: intent.symbol,
    strategy: intent.strategy,
    direction: intent.direction,
    price: snapshot.price,
    expiry: intent.expiry,
    thesis: `${intent.symbol} live market price was fetched from Alpaca; option structure and final thesis still require AI generation or admin review.`,
    riskNotes: 'Educational only. Live spot price does not validate a strategy, liquidity, event risk, or suitability.',
    sentiment: sentimentContext ?? {},
    lifecycle: {
      marketData: marketDataSummary(snapshot, calculatedAt),
      gammaContext: gammaAnalysis ?? {},
      sentimentContext: sentimentContext ?? {},
      prompt,
      warnings,
    },
  };
}

function marketDataSummary(snapshot, calculatedAt) {
  return {
    source: 'alpaca',
    spotPrice: snapshot.price,
    priceChange: snapshot.change,
    priceChangePercent: snapshot.changePercent,
    calculatedAt,
  };
}

function parseSymbol(text) {
  const cashTag = text.match(/\$([A-Za-z][A-Za-z0-9.\-]{0,7})\b/);
  if (cashTag) return cashTag[1].toUpperCase();

  const explicit = text.match(/\b(?:for|on|ticker|symbol)\s+([A-Za-z][A-Za-z0-9.\-]{0,7})\b/i);
  if (explicit) {
    const candidate = explicit[1].toUpperCase();
    if (!SYMBOL_STOP_WORDS.has(candidate)) return candidate;
  }

  const matches = text.match(/\b[A-Z][A-Z0-9.\-]{0,7}\b/g) ?? [];
  return matches.find((candidate) => !SYMBOL_STOP_WORDS.has(candidate)) ?? null;
}

function parseOccSymbol(occ) {
  const match = String(occ).match(/^([A-Z0-9]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const year = Number(match[2].slice(0, 2)) + 2000;
  const month = match[2].slice(2, 4);
  const day = match[2].slice(4, 6);
  return {
    symbol: match[1],
    expiration: `${year}-${month}-${day}`,
    type: match[3] === 'C' ? 'call' : 'put',
    strike: Number.parseInt(match[4], 10) / 1000,
  };
}

function normalizeGammaContext(report) {
  if (!report || typeof report !== 'object') return null;
  const analysis = report.gammaData?.analysis ?? report.gammaData ?? report.analysis ?? null;
  if (!analysis || typeof analysis !== 'object') return null;
  return {
    analysis: { ...analysis },
    reportDate: report.date ?? report.generatedAt ?? report.lastUpdated ?? null,
  };
}

function normalizeSentimentContext(report) {
  if (!report || typeof report !== 'object') return null;
  const score = nullableNumber(report.composite?.score ?? report.score);
  const confidence = nullableNumber(report.composite?.confidence ?? report.confidence);
  const label = String(report.composite?.label ?? report.label ?? '').trim() || null;
  if (score == null && !label && !report.summary) return null;

  return {
    score,
    label,
    confidence,
    summary: cleanContextString(report.summary, 1000),
    keyDrivers: Array.isArray(report.keyDrivers)
      ? report.keyDrivers.slice(0, 8).map((driver) => ({
          factor: cleanContextString(driver?.factor, 240),
          impact: cleanContextString(driver?.impact, 80),
          source: cleanContextString(driver?.source, 120),
        }))
      : [],
    materialEvents: Array.isArray(report.materialEvents)
      ? report.materialEvents.slice(0, 8).map((event) => cleanContextString(event, 160)).filter(Boolean)
      : [],
    socialSentiment: cleanContextString(report.socialSentiment, 500),
    sectorContext: cleanContextString(report.sectorContext, 500),
    updatedAt: cleanContextString(report.updatedAt, 80),
    source: 'r2-sentiment-cache',
  };
}

function describeStructure(strategy) {
  const legs = strategy.legs
    .map((leg) => `${leg.action} ${leg.type} ${leg.strike} @ ${leg.premium}`)
    .join('; ');
  return [
    `${strategy.strategy} expiring ${strategy.expiry}`,
    `net credit ${strategy.netCredit}`,
    `max profit ${strategy.maxProfit}`,
    `max loss ${strategy.maxLoss}`,
    `legs: ${legs}`,
  ].join(', ');
}

function cleanContextString(value, maxLength) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function toLeg(contract, action, type) {
  return {
    action,
    type,
    strike: contract.strike,
    premium: contract.mid,
    mid: contract.mid,
    delta: contract.delta,
    gamma: contract.gamma,
    theta: contract.theta,
    vega: contract.vega,
    iv: contract.iv,
  };
}

function findClosest(contracts, target) {
  const valid = contracts.filter((contract) =>
    Number.isFinite(contract.strike) && Number.isFinite(contract.mid) && contract.mid > 0);
  if (valid.length === 0) return null;
  return valid.reduce((best, current) =>
    Math.abs(current.strike - target) < Math.abs(best.strike - target) ? current : best);
}

function calculateNetGreeks(legs) {
  const totals = legs.reduce(
    (acc, leg) => {
      const sign = leg.action === 'SELL' ? 1 : -1;
      acc.netDelta += sign * (Number(leg.delta) || 0);
      acc.netTheta += sign * (Number(leg.theta) || 0);
      acc.netVega += sign * (Number(leg.vega) || 0);
      acc.netGamma += sign * (Number(leg.gamma) || 0);
      return acc;
    },
    { netDelta: 0, netTheta: 0, netVega: 0, netGamma: 0 },
  );
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, roundNumber(value, 4)]));
}

function calcPoP(lower, upper, spot, iv, dte) {
  if (!iv || !dte) return 0.5;
  const sigma = spot * iv * Math.sqrt(dte / 365);
  if (!sigma) return 0.5;
  return normalCdf((upper - spot) / sigma) - normalCdf((lower - spot) / sigma);
}

function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.sqrt(2)));
}

function erf(value) {
  const sign = value >= 0 ? 1 : -1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
    t * Math.exp(-x * x);
  return sign * y;
}

function averageIv(contracts) {
  const values = contracts.map((contract) => Number(contract.iv)).filter(Number.isFinite);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function daysToExpiry(expiry, asOfDate) {
  const start = new Date(asOfDate);
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const [year, month, day] = expiry.split('-').map(Number);
  const endUtc = Date.UTC(year, month - 1, day);
  const diff = Math.round((endUtc - startUtc) / 86400000);
  return Math.max(1, diff);
}

function nextFridayAtLeastDays(tradeDate, minDays) {
  const date = tradeDate ? new Date(`${tradeDate}T12:00:00.000Z`) : new Date();
  date.setUTCDate(date.getUTCDate() + minDays);
  while (date.getUTCDay() !== 5) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

function normalizeAlpacaBaseUrl(serviceConfig) {
  const value = String(serviceConfig.alpaca?.dataBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(value)) {
    throw new Error('Alpaca data API base URL must use HTTPS.');
  }
  return value;
}

function hasAlpacaConfig(serviceConfig) {
  return Boolean(
    serviceConfig.alpaca?.apiKey &&
    serviceConfig.alpaca?.secretKey &&
    serviceConfig.alpaca?.dataBaseUrl,
  );
}

function firstFiniteNumber(...values) {
  return values.map(Number).find(Number.isFinite) ?? null;
}

function nullableNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function roundNumber(value, digits = 2) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  const factor = 10 ** digits;
  return Math.round((numberValue + Number.EPSILON) * factor) / factor;
}

function roundBreakevens(breakevens = {}) {
  return Object.fromEntries(Object.entries(breakevens).map(([key, value]) => [key, roundNumber(value, 2)]));
}

function timestampFromClock(clock) {
  const value = clock();
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sortByStrike(left, right) {
  return left.strike - right.strike;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
