import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';

const { createInMemoryRepository } = await import('../lib/repository.js');
const { createRecommendationOutputService } = await import('./recommendationOutputService.js');

const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'newleaf-recommendation-output-'));
const repository = createInMemoryRepository();
const service = createRecommendationOutputService({
  repository,
  serviceConfig: {
    localDataDir: tempDir,
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
        lifecycle: {},
        legs: [],
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

  console.log('Recommendation output service tests passed.');
} finally {
  await fsp.rm(tempDir, { recursive: true, force: true });
}
