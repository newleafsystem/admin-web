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
