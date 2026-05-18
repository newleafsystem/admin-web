import assert from 'node:assert/strict';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.REQUIRE_AUTH = 'false';

const { createApp } = await import('../app.js');
const { createInMemoryRepository } = await import('../lib/repository.js');

const repository = createInMemoryRepository();
const generationCalls = [];
const outputCalls = [];
const recommendationGenerationService = {
  async generateRecommendations({ prompts, batch, existingRecommendations }) {
    generationCalls.push({
      prompts,
      batch,
      existingRecommendations,
    });
    return {
      provider: 'test',
      model: 'stub-recommendation-model',
      recommendations: prompts.map((prompt, index) => {
        const symbol = prompt.prompt.match(/\b[A-Z]{2,6}\b/)?.[0] ?? `AI${index + 1}`;
        return {
          sourcePromptId: prompt.id,
          symbol,
          strategy: 'Defined-risk call spread',
          direction: 'BULLISH',
          price: 100 + index,
          expiry: '2026-06-19',
          rewardRisk: 1.4,
          oddsOfProfit: 58,
          maxProfit: 320,
          thesis: `${symbol} may act as a data-supported bullish setup based on the submitted prompt.`,
          riskNotes: 'A close below support or a volatility crush would invalidate the setup.',
          entry: 'Enter only if liquidity and spread width remain acceptable.',
          exit: 'Trim into strength or exit if the setup breaks support.',
        };
      }),
    };
  },
};
const recommendationOutputService = {
  async ensureOutputs({ batch, publicData, scriptJob }) {
    outputCalls.push({
      batchId: batch.id,
      scriptJobId: scriptJob.id,
      existingPdfArtifactId: batch.outputArtifacts?.pdf?.artifactId ?? null,
    });
    const suffix = batch.outputArtifacts?.pdf?.artifactId ? 'reused' : 'created';
    return {
      archive: batch.outputArtifacts?.archive ?? artifactSummary(`archive-${suffix}`, 'recommendation_archive'),
      videoScript: batch.outputArtifacts?.videoScript ?? artifactSummary(`script-${suffix}`, 'recommendation_video_script'),
      pdf: batch.outputArtifacts?.pdf ?? artifactSummary(`pdf-${suffix}`, 'recommendation_pdf'),
      socialCopy: batch.outputArtifacts?.socialCopy ?? artifactSummary(`social-${suffix}`, 'recommendation_social_copy'),
      generatedAt: '2026-05-18T00:00:00.000Z',
    };
  },
};
const app = createApp({
  repository,
  recommendationGenerationService,
  recommendationOutputService,
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
  assert.equal(published.body.recommendationBatch.channels.pdf.status, 'ready');
  assert.equal(published.body.recommendationBatch.channels.social.status, 'ready');
  assert.equal(published.body.recommendationBatch.channels.archive.status, 'ready');
  assert.equal(published.body.recommendationBatch.channels.video.status, 'script_ready');
  assert.equal(published.body.recommendationBatch.outputArtifacts.pdf.artifactId, 'pdf-created');
  assert.equal(published.body.recommendationBatch.outputArtifacts.socialCopy.artifactId, 'social-created');
  assert.equal(outputCalls.length, 1);

  const republished = await json({
    method: 'POST',
    path: `/api/v1/recommendation-batches/${encodeURIComponent(batchId)}/publish`,
  });
  assert.equal(republished.status, 200);
  assert.equal(republished.body.recommendationBatch.outputArtifacts.pdf.artifactId, 'pdf-created');
  assert.equal(outputCalls.length, 2);
  assert.equal(outputCalls[1].existingPdfArtifactId, 'pdf-created');

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

  const generated = await json({
    method: 'POST',
    path: '/api/v1/recommendation-batches/generate',
    body: {
      tradeDate: '2026-05-18',
      title: 'Daily Picks',
      theme: 'AI-assisted defined-risk ideas',
      prompts: [
        { id: 'prompt_msft', prompt: 'Generate a MSFT defined-risk idea.' },
        { id: 'prompt_tsla', prompt: 'Generate a TSLA defined-risk idea.' },
      ],
    },
  });
  assert.equal(generated.status, 200);
  assert.equal(generated.body.recommendationBatch.status, 'draft');
  assert.equal(generated.body.recommendationBatch.recommendations.length, 2);
  assert.equal(generated.body.recommendationBatch.recommendations[0].symbol, 'MSFT');
  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0].existingRecommendations.length, 0);
  const generatedBatchId = generated.body.recommendationBatch.id;

  const appended = await json({
    method: 'POST',
    path: '/api/v1/recommendation-batches/generate',
    body: {
      tradeDate: '2026-05-18',
      prompts: [
        { id: 'prompt_nvda', prompt: 'Generate a NVDA defined-risk idea.' },
      ],
    },
  });
  assert.equal(appended.status, 200);
  assert.equal(appended.body.recommendationBatch.id, generatedBatchId);
  assert.equal(appended.body.recommendationBatch.recommendations.length, 3);
  assert.equal(appended.body.recommendationBatch.recommendations[2].symbol, 'NVDA');
  assert.equal(generationCalls.length, 2);
  assert.equal(generationCalls[1].existingRecommendations.length, 2);

  const listAfterGeneration = await json({
    method: 'GET',
    path: '/api/v1/recommendation-batches',
  });
  assert.equal(listAfterGeneration.status, 200);
  assert.equal(listAfterGeneration.body.recommendationBatches.length, 2);

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

function artifactSummary(artifactId, kind) {
  return {
    artifactId,
    kind,
    mimeType: kind === 'recommendation_pdf' ? 'application/pdf' : 'application/json',
    sizeBytes: 256,
    storageProvider: 'test',
    storageKey: `test/${artifactId}`,
    filename: `${artifactId}.bin`,
  };
}
