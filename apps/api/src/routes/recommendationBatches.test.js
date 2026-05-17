import assert from 'node:assert/strict';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.REQUIRE_AUTH = 'false';

const { createApp } = await import('../app.js');
const { createInMemoryRepository } = await import('../lib/repository.js');

const repository = createInMemoryRepository();
const app = createApp({
  repository,
  autoResumeQueuedUploads: false,
  autoSyncPublications: false,
});
const server = await listen(app);
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const payload = {
    tradeDate: '2026-05-17',
    title: 'Daily Picks',
    theme: 'Defined-risk premium ideas',
    dateRange: 'May 17, 2026',
    recommendations: [
      {
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
      },
    ],
  };

  const created = await json({
    method: 'POST',
    path: '/api/v1/recommendation-batches',
    body: payload,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.recommendationBatch.status, 'draft');
  assert.equal(created.body.recommendationBatch.recommendations[0].symbol, 'ADBE');
  const batchId = created.body.recommendationBatch.id;

  const earlyPublish = await json({
    method: 'POST',
    path: `/api/v1/recommendation-batches/${encodeURIComponent(batchId)}/publish`,
  });
  assert.equal(earlyPublish.status, 409);

  const approved = await json({
    method: 'POST',
    path: `/api/v1/recommendation-batches/${encodeURIComponent(batchId)}/approve`,
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.recommendationBatch.status, 'approved');

  const published = await json({
    method: 'POST',
    path: `/api/v1/recommendation-batches/${encodeURIComponent(batchId)}/publish`,
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.recommendationBatch.status, 'published');
  assert.equal(published.body.recommendationBatch.publicData.recommendationBatchId, batchId);
  assert.equal(published.body.recommendationBatch.publicData.picks[0].symbol, 'ADBE');
  assert.ok(published.body.recommendationBatch.scriptJobId);
  assert.equal(published.body.recommendationBatch.channels.liveSite.status, 'published');
  assert.equal(published.body.recommendationBatch.channels.video.status, 'script_ready');

  const scriptJob = await repository.getJob(published.body.recommendationBatch.scriptJobId);
  assert.equal(scriptJob.status, 'script_ready');
  assert.equal(scriptJob.sourceType, 'text_to_heygen');
  assert.equal(scriptJob.metadata.recommendationBatchId, batchId);

  const latest = await json({
    method: 'GET',
    path: '/api/v1/public/recommendations/latest',
  });
  assert.equal(latest.status, 200);
  assert.equal(latest.body.recommendationBatch.recommendationBatchId, batchId);
  assert.equal(latest.body.recommendationBatch.recommendations.length, 1);

  const list = await json({
    method: 'GET',
    path: '/api/v1/recommendation-batches',
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.recommendationBatches.length, 1);

  console.log('Recommendation batch route tests passed.');
} finally {
  await close(server);
}

async function json({ method, path, body = undefined }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
