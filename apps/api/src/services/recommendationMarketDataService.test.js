import assert from 'node:assert/strict';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';

const {
  buildStrategyFromMarketData,
  createRecommendationMarketDataService,
  parseRecommendationPromptIntent,
  parseOptionSnapshots,
} = await import('./recommendationMarketDataService.js');

const optionSnapshots = {
  AAPL260619P00170000: snapshot({ bid: 0.95, ask: 1.05, delta: -0.12, gamma: 0.01, theta: -0.02, vega: 0.05, iv: 0.31 }),
  AAPL260619P00180000: snapshot({ bid: 2.9, ask: 3.1, delta: -0.22, gamma: 0.02, theta: -0.04, vega: 0.08, iv: 0.32 }),
  AAPL260619P00190000: snapshot({ bid: 6.2, ask: 6.6, delta: -0.38, gamma: 0.03, theta: -0.05, vega: 0.1, iv: 0.33 }),
  AAPL260619C00210000: snapshot({ bid: 4.8, ask: 5.2, delta: 0.35, gamma: 0.03, theta: -0.05, vega: 0.11, iv: 0.3 }),
  AAPL260619C00220000: snapshot({ bid: 2.4, ask: 2.6, delta: 0.21, gamma: 0.02, theta: -0.04, vega: 0.08, iv: 0.3 }),
  AAPL260619C00230000: snapshot({ bid: 0.7, ask: 0.8, delta: 0.1, gamma: 0.01, theta: -0.02, vega: 0.05, iv: 0.29 }),
};

const fetches = [];
const service = createRecommendationMarketDataService({
  serviceConfig: {
    alpaca: {
      apiKey: 'alpaca-key',
      secretKey: 'alpaca-secret',
      dataBaseUrl: 'https://data.alpaca.test',
    },
    publicAssets: {
      dataOriginUrl: 'https://r2.newleaf.test',
    },
  },
  fetchImpl: async (url, options = {}) => {
    const href = String(url);
    fetches.push(href);

    if (href.includes('/v2/stocks/AAPL/snapshot')) {
      assert.equal(options.headers?.['APCA-API-KEY-ID'], 'alpaca-key');
      assert.equal(options.headers?.['APCA-API-SECRET-KEY'], 'alpaca-secret');
      return jsonResponse({
        latestTrade: { p: 200 },
        prevDailyBar: { c: 198 },
      });
    }

    if (href.includes('/v1beta1/options/snapshots/AAPL')) {
      assert.equal(options.headers?.['APCA-API-KEY-ID'], 'alpaca-key');
      assert.equal(options.headers?.['APCA-API-SECRET-KEY'], 'alpaca-secret');
      assert.match(href, /expiration_date_gte=2026-06-19/);
      return jsonResponse({ snapshots: optionSnapshots });
    }

    if (href === 'https://r2.newleaf.test/reports/AAPL/latest.json') {
      return jsonResponse({
        gammaData: {
          analysis: {
            put_wall: 180,
            call_wall: 225,
            gamma_flip: 198,
            confidence_score: 0.72,
          },
        },
      });
    }

    if (href === 'https://r2.newleaf.test/reports/AAPL/sentiment.json') {
      return jsonResponse({
        score: 62,
        label: 'bullish',
        confidence: 0.68,
        summary: 'Constructive sentiment with event risk still present.',
        keyDrivers: [{ factor: 'Analyst target revision', impact: 'positive', source: 'test' }],
      });
    }

    throw new Error(`Unexpected fetch ${href}`);
  },
  clock: () => new Date('2026-05-19T12:00:00.000Z'),
});

const intent = parseRecommendationPromptIntent(
  'Generate an AAPL iron condor expiring 2026-06-19 with risk-aware context.',
  { promptId: 'prompt_aapl', tradeDate: '2026-05-19' },
);
assert.equal(intent.symbol, 'AAPL');
assert.equal(intent.strategyKey, 'iron-condor');
assert.equal(intent.expiry, '2026-06-19');

const contracts = parseOptionSnapshots(optionSnapshots);
assert.equal(contracts.length, 6);
assert.equal(contracts.find((contract) => contract.occ === 'AAPL260619P00180000')?.mid, 3);

const strategy = buildStrategyFromMarketData({
  strategyKey: 'iron-condor',
  spot: 200,
  calls: contracts.filter((contract) => contract.type === 'call'),
  puts: contracts.filter((contract) => contract.type === 'put'),
  expiry: '2026-06-19',
  asOfDate: new Date('2026-05-19T12:00:00.000Z'),
});
assert.equal(strategy.strategy, 'Iron Condor');
assert.equal(strategy.maxProfit, 375);
assert.equal(strategy.maxLoss, 625);
assert.equal(strategy.rewardRisk, 0.6);
assert.equal(strategy.breakevens.lower, 176.25);
assert.equal(strategy.breakevens.upper, 223.75);

const draft = await service.buildRecommendationDraft({
  promptId: 'prompt_aapl',
  prompt: 'Generate an AAPL iron condor expiring 2026-06-19 with gamma context.',
  batch: { tradeDate: '2026-05-19' },
});

assert.equal(draft.recommendation.symbol, 'AAPL');
assert.equal(draft.recommendation.strategy, 'Iron Condor');
assert.equal(draft.recommendation.price, 200);
assert.equal(draft.recommendation.maxProfit, 375);
assert.equal(draft.recommendation.maxLoss, 625);
assert.equal(draft.recommendation.legs.length, 4);
assert.equal(draft.recommendation.lifecycle.metricAssumptions.source, 'alpaca-option-chain-r2-gamma-deterministic-calculation');
assert.equal(draft.recommendation.lifecycle.gammaContext.put_wall, 180);
assert.equal(draft.recommendation.sentiment.source, 'r2-sentiment-cache');
assert.equal(draft.recommendation.sentiment.score, 62);
assert.equal(draft.recommendation.lifecycle.marketData.source, 'alpaca');

const spotOnly = await service.buildRecommendationDraft({
  promptId: 'prompt_aapl_spot',
  prompt: 'Generate a recommendation for AAPL with market context.',
  batch: { tradeDate: '2026-05-19' },
});

assert.equal(spotOnly.recommendation.symbol, 'AAPL');
assert.equal(spotOnly.recommendation.price, 200);
assert.equal(spotOnly.recommendation.strategy, null);
assert.equal(spotOnly.recommendation.lifecycle.marketData.source, 'alpaca');
assert.equal(spotOnly.recommendation.lifecycle.marketData.spotPrice, 200);
assert.equal(spotOnly.recommendation.lifecycle.gammaContext.put_wall, 180);
assert.match(spotOnly.warnings.join(' '), /No supported options strategy/);
assert.equal(fetches.filter((href) => href.includes('/v1beta1/options/snapshots/AAPL')).length, 1);

const marketApiFetches = [];
const marketApiService = createRecommendationMarketDataService({
  serviceConfig: {
    marketApi: {
      baseUrl: 'https://newleaf-api.test',
      apiKey: 'market-api-key',
      modelMode: 'budget-qwq',
    },
    alpaca: {},
    publicAssets: {},
  },
  fetchImpl: async (url, options = {}) => {
    const href = String(url);
    marketApiFetches.push({ href, options });
    assert.equal(options.headers?.['X-API-Key'], 'market-api-key');

    if (href === 'https://newleaf-api.test/api/recommend') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), {
        ticker: 'ADBE',
        expiry: '2026-06-19',
        modelMode: 'budget-qwq',
      });
      return jsonResponse({
        snapshot: { price: 250, change: 2.5, changePct: 1.01 },
        indicators: { rsi14: 54, smaTrend: 'neutral' },
        gammaAnalysis: {
          putWallStrike: 230,
          callWallStrike: 270,
          spotInsideBand: true,
          walls: [{ strike: 230, totalOI: 1200, side: 'put', strength: 0.8 }],
          oiByStrike: [{ strike: 250, callOI: 400, putOI: 350, callVolume: 90, putVolume: 80 }],
        },
        recommendation: {
          marketRead: 'ADBE is range-bound between strong gamma walls.',
          strategies: [
            {
              strategy: 'short_strangle',
              score: 90,
              netCredit: 3.4,
              rationale: 'Higher score but undefined risk; admin integration should prefer defined-risk alternatives.',
              legs: [
                { side: 'short', type: 'put', strike: 220 },
                { side: 'short', type: 'call', strike: 280 },
              ],
            },
            {
              strategy: 'iron_condor',
              score: 82,
              netCredit: 2.2,
              rationale: 'Range-bound technicals and gamma walls favor a defined-risk iron condor.',
              legs: [
                { side: 'long', type: 'put', strike: 220 },
                { side: 'short', type: 'put', strike: 230 },
                { side: 'short', type: 'call', strike: 270 },
                { side: 'long', type: 'call', strike: 280 },
              ],
            },
          ],
        },
      });
    }

    if (href === 'https://newleaf-api.test/api/chain/ADBE/2026-06-19') {
      return jsonResponse({
        strikes: [
          chainStrike(220, { put: contract({ bid: 0.35, ask: 0.45, delta: -0.09, iv: 0.31 }) }),
          chainStrike(230, { put: contract({ bid: 1.45, ask: 1.55, delta: -0.22, iv: 0.32 }) }),
          chainStrike(270, { call: contract({ bid: 1.35, ask: 1.45, delta: 0.19, iv: 0.3 }) }),
          chainStrike(280, { call: contract({ bid: 0.25, ask: 0.35, delta: 0.09, iv: 0.29 }) }),
        ],
      });
    }

    throw new Error(`Unexpected market API fetch ${href}`);
  },
  clock: () => new Date('2026-05-19T12:00:00.000Z'),
});

const marketApiDraft = await marketApiService.buildRecommendationDraft({
  promptId: 'prompt_adbe',
  prompt: 'Generate a recommendation for ADBE with full market analysis.',
  batch: { tradeDate: '2026-05-19' },
});

assert.equal(marketApiDraft.recommendation.symbol, 'ADBE');
assert.equal(marketApiDraft.recommendation.strategy, 'Iron Condor');
assert.equal(marketApiDraft.recommendation.price, 250);
assert.equal(marketApiDraft.recommendation.netCredit, 2.2);
assert.equal(marketApiDraft.recommendation.maxProfit, 220);
assert.equal(marketApiDraft.recommendation.maxLoss, 780);
assert.equal(marketApiDraft.recommendation.rewardRisk, 0.28);
assert.equal(marketApiDraft.recommendation.legs.length, 4);
assert.equal(marketApiDraft.recommendation.lifecycle.marketData.source, 'newleaf-api');
assert.equal(marketApiDraft.recommendation.lifecycle.gammaContext.put_wall, 230);
assert.equal(marketApiDraft.recommendation.lifecycle.technicalIndicators.rsi14, 54);
assert.equal(marketApiDraft.recommendation.lifecycle.strategyAdvisor.score, 82);
assert.equal(marketApiFetches.length, 2);

console.log('Recommendation market data service tests passed.');

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}

function snapshot({ bid, ask, delta, gamma, theta, vega, iv }) {
  return {
    latestQuote: { bp: bid, ap: ask },
    greeks: { delta, gamma, theta, vega, midIV: iv },
    dailyBar: { v: 100 },
  };
}

function chainStrike(strike, { call = null, put = null } = {}) {
  return { strike, ...(call ? { call } : {}), ...(put ? { put } : {}) };
}

function contract({ bid, ask, delta, gamma = 0.01, theta = -0.02, vega = 0.05, iv }) {
  return {
    bid,
    ask,
    mid: (bid + ask) / 2,
    delta,
    gamma,
    theta,
    vega,
    iv,
    volume: 100,
  };
}
