import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.GCS_BUCKET = '';

const { createInMemoryRepository } = await import('../lib/repository.js');
const { createRecommendationOutputService } = await import('./recommendationOutputService.js');
const { buildInstitutionalRecommendationReportData } = await import('./recommendationReportRenderer.js');

const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'newleaf-recommendation-output-'));
const repository = createInMemoryRepository();
const service = createRecommendationOutputService({
  repository,
  serviceConfig: {
    localDataDir: tempDir,
    pdf: {
      recommendationRenderer: 'legacy-custom',
    },
  },
  clock: () => '2026-05-18T12:00:00.000Z',
});

try {
  const batch = {
    id: 'recommendationBatch_test',
    outputArtifacts: {},
  };
  const publicData = {
    recommendationBatchId: batch.id,
    tradeDate: '2026-05-18',
    weekId: '2026-05-18',
    title: 'Daily Picks',
    theme: 'Defined-risk premium ideas',
    recommendations: [
      {
        id: 'pick_10_adbe',
        tileId: 'pick_10_adbe',
        symbol: 'ADBE',
        strategy: 'Iron condor',
        direction: 'NEUTRAL',
        price: 482.15,
        expiry: '2026-06-19',
        rewardRisk: 0.42,
        oddsOfProfit: 68,
        maxProfit: 240,
        thesis: 'Range-bound setup with model-estimated premium support.',
        riskNotes: 'Momentum breakout through the short strikes would invalidate the setup.',
        entry: 'Enter only if spreads remain liquid.',
        exit: 'Exit on breakout or target profit.',
        ivContext: {},
        sentiment: {},
        lifecycle: {
          marketData: {
            spotPrice: 482.15,
            priceChange: 3.25,
            priceChangePercent: 0.68,
          },
          gammaContext: {
            put_wall: 460,
            call_wall: 505,
            oiByStrike: [{ strike: 480, totalOI: 400 }],
          },
          technicalIndicators: {
            rsi14: 54,
            sma20: 478,
            sma50: 471,
            sma100: 455,
            bollingerUpper: 500,
            bollingerLower: 450,
            bollingerWidth: 10.5,
            smaTrend: 'mixed',
          },
          strategyAdvisor: {
            score: 82,
            marketRead: 'ADBE is range-bound between strong gamma walls.',
            rationale: 'Range-bound technicals and gamma walls favor a defined-risk iron condor.',
          },
        },
        legs: [
          { action: 'BUY', type: 'PUT', strike: 450, premium: 1.15, bid: 1.1, ask: 1.2, iv: 0.31 },
          { action: 'SELL', type: 'PUT', strike: 460, premium: 2.35, bid: 2.3, ask: 2.4, iv: 0.32 },
          { action: 'SELL', type: 'CALL', strike: 505, premium: 2.1, bid: 2.05, ask: 2.15, iv: 0.3 },
          { action: 'BUY', type: 'CALL', strike: 515, premium: 1.05, bid: 1, ask: 1.1, iv: 0.29 },
        ],
      },
    ],
  };
  const scriptJob = {
    id: 'job_recommendation_script',
  };

  const first = await service.ensureOutputs({
    batch,
    publicData,
    scriptJob,
    actorUid: 'admin-test',
  });
  assert.ok(first.pdf.artifactId);
  assert.ok(first.socialCopy.artifactId);
  assert.equal(first.pdf.mimeType, 'application/pdf');
  assert.equal(first.socialCopy.mimeType, 'application/json');

  const pdfArtifact = await repository.getArtifact(first.pdf.artifactId);
  const pdfPath = path.resolve(tempDir, pdfArtifact.storageKey);
  const pdfBytes = await fsp.readFile(pdfPath);
  assert.equal(pdfBytes.subarray(0, 8).toString('utf8'), '%PDF-1.4');
  const pdfText = pdfBytes.toString('latin1');
  assert.match(pdfText, /Report Summary/);
  assert.match(pdfText, /Reference Price/);
  assert.match(pdfText, /Risk Framing/);

  const second = await service.ensureOutputs({
    batch: {
      ...batch,
      outputArtifacts: first,
    },
    publicData,
    scriptJob,
    actorUid: 'admin-test',
  });
  assert.equal(second.pdf.artifactId, first.pdf.artifactId);
  assert.equal(second.socialCopy.artifactId, first.socialCopy.artifactId);

  const reportData = buildInstitutionalRecommendationReportData(publicData, '2026-05-18T12:00:00.000Z');
  assert.equal(reportData.SYMBOL, 'ADBE');
  assert.equal(reportData.STRATEGY_NAME, 'Iron condor');
  assert.equal(reportData.CURRENT_PRICE, '$482.15');
  assert.equal(reportData.MAX_PROFIT, '$240');
  assert.equal(reportData.PUT_GAMMA_WALL, '$460');
  assert.equal(reportData.CALL_GAMMA_WALL, '$505');
  assert.match(reportData.EXECUTION_TABLE_ROWS, /Short Put/);
  assert.match(reportData.GAMMA_CHART_SVG, /svg/);

  console.log('Recommendation output service tests passed.');
} finally {
  await fsp.rm(tempDir, { recursive: true, force: true });
}
