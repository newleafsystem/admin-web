import assert from 'node:assert/strict';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.REQUIRE_AUTH = 'false';

const { createApp } = await import('../app.js');
const { createInMemoryRepository } = await import('../lib/repository.js');

const repository = createInMemoryRepository();
const generationCalls = [];
const marketDataCalls = [];
const outputCalls = [];
const deletedPublicationAttempts = [];
const deletedStorageArtifacts = [];
const deletedStoragePrefixes = [];
const recommendationGenerationService = {
  async generateRecommendations({ prompts, batch, existingRecommendations, marketDrafts = [] }) {
    generationCalls.push({
      prompts,
      batch,
      existingRecommendations,
      marketDrafts,
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
const recommendationMarketDataService = {
  async buildRecommendationDraft({ prompt, promptId }) {
    marketDataCalls.push({ prompt, promptId });
    if (prompt.includes('AAPL')) {
      return {
        recommendation: {
          sourcePromptId: promptId,
          symbol: 'AAPL',
          price: 206.45,
          lifecycle: {
            marketData: {
              source: 'alpaca',
              spotPrice: 206.45,
              priceChange: 1.25,
              priceChangePercent: 0.61,
              calculatedAt: '2026-05-18T00:00:00.000Z',
            },
            warnings: ['No supported options strategy could be parsed for AAPL.'],
          },
        },
        intent: { symbol: 'AAPL' },
        warnings: ['No supported options strategy could be parsed for AAPL.'],
      };
    }
    if (!prompt.includes('NVDA')) {
      return {
        recommendation: null,
        intent: { symbol: prompt.match(/\b[A-Z]{2,6}\b/)?.[0] ?? null },
        warnings: ['No calculated market draft for this test prompt.'],
      };
    }
    return {
      recommendation: {
        sourcePromptId: promptId,
        symbol: 'NVDA',
        strategy: 'Iron Condor',
        direction: 'NEUTRAL',
        price: 910,
        expiry: '2026-06-19',
        dte: 32,
        rewardRisk: 0.6,
        oddsOfProfit: 63,
        maxProfit: 375,
        maxLoss: 625,
        netCredit: 3.75,
        thesis: 'NVDA has calculated option-chain metrics.',
        riskNotes: 'Breakouts through the short strikes would pressure the setup.',
        legs: [
          { action: 'BUY', type: 'PUT', strike: 820, premium: 1 },
          { action: 'SELL', type: 'PUT', strike: 830, premium: 3 },
        ],
        lifecycle: {
          metricAssumptions: {
            source: 'alpaca-option-chain-r2-gamma-deterministic-calculation',
            structure: 'Calculated test iron condor',
            probabilityBasis: 'Computed test probability',
            confidence: 'medium',
          },
          gammaContext: { call_wall: 950 },
          technicalIndicators: { rsi14: 54, smaTrend: 'neutral' },
          strategyAdvisor: { modelMode: 'budget-qwq', score: 82 },
          calculation: { maxLoss: 625 },
        },
      },
      intent: { symbol: 'NVDA' },
      warnings: [],
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
  recommendationMarketDataService,
  recommendationOutputService,
  publisherService: {
    async deletePublication(attemptId, context = {}) {
      const attempt = await repository.getPublishAttempt(attemptId);
      deletedPublicationAttempts.push({ attemptId, platform: attempt.platform, reason: context.reason });
      const publication = await repository.updatePublishAttempt(attemptId, {
        status: 'deleted',
        providerUrl: null,
        metadata: {
          ...(attempt.metadata ?? {}),
          deletedAt: '2026-05-18T00:00:00.000Z',
          deletedBy: context.actorUid ?? null,
          deleteReason: context.reason,
          providerDeleted: true,
        },
      });
      return {
        publication,
        providerDeleted: true,
      };
    },
  },
  artifactStorageService: {
    shouldUseObjectStorage() {
      return true;
    },
    async deleteObjectStorageArtifact(artifact) {
      deletedStorageArtifacts.push(artifact);
      return { deleted: true };
    },
    async deleteObjectStoragePrefix(prefix) {
      deletedStoragePrefixes.push(prefix);
      return { deleted: true };
    },
  },
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
  assert.equal(generated.body.recommendationBatch.recommendations[0].price, null);
  assert.equal(generated.body.recommendationBatch.recommendations[0].rewardRisk, null);
  assert.equal(generated.body.recommendationBatch.recommendations[0].oddsOfProfit, null);
  assert.equal(generated.body.recommendationBatch.recommendations[0].maxProfit, null);
  assert.match(
    generated.body.recommendationBatch.recommendations[0].lifecycle.metricWarning,
    /without per-prompt assumptions/,
  );
  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0].existingRecommendations.length, 0);
  assert.equal(generationCalls[0].marketDrafts.length, 0);
  const generatedBatchId = generated.body.recommendationBatch.id;

  const appended = await json({
    method: 'POST',
    path: '/api/v1/recommendation-batches/generate',
    body: {
      tradeDate: '2026-05-18',
      prompts: [
        { id: 'prompt_nvda', prompt: 'Generate a NVDA iron condor expiring 2026-06-19.' },
      ],
    },
  });
  assert.equal(appended.status, 200);
  assert.equal(appended.body.recommendationBatch.id, generatedBatchId);
  assert.equal(appended.body.recommendationBatch.recommendations.length, 3);
  assert.equal(appended.body.recommendationBatch.recommendations[2].symbol, 'NVDA');
  assert.equal(appended.body.recommendationBatch.recommendations[2].strategy, 'Iron Condor');
  assert.equal(appended.body.recommendationBatch.recommendations[2].rewardRisk, 0.6);
  assert.equal(appended.body.recommendationBatch.recommendations[2].maxProfit, 375);
  assert.equal(appended.body.recommendationBatch.recommendations[2].maxLoss, 625);
  assert.equal(appended.body.recommendationBatch.recommendations[2].lifecycle.metricAssumptions.source, 'alpaca-option-chain-r2-gamma-deterministic-calculation');
  assert.equal(appended.body.recommendationBatch.recommendations[2].lifecycle.technicalIndicators.rsi14, 54);
  assert.equal(appended.body.recommendationBatch.recommendations[2].lifecycle.strategyAdvisor.score, 82);
  assert.equal(generationCalls.length, 2);
  assert.equal(generationCalls[1].existingRecommendations.length, 2);
  assert.equal(generationCalls[1].marketDrafts.length, 1);
  assert.equal(marketDataCalls.length, 3);

  const appendedSpotPrice = await json({
    method: 'POST',
    path: '/api/v1/recommendation-batches/generate',
    body: {
      tradeDate: '2026-05-18',
      prompts: [
        { id: 'prompt_aapl', prompt: 'Generate an AAPL defined-risk idea.' },
      ],
    },
  });
  assert.equal(appendedSpotPrice.status, 200);
  assert.equal(appendedSpotPrice.body.recommendationBatch.id, generatedBatchId);
  assert.equal(appendedSpotPrice.body.recommendationBatch.recommendations.length, 4);
  assert.equal(appendedSpotPrice.body.recommendationBatch.recommendations[3].symbol, 'AAPL');
  assert.equal(appendedSpotPrice.body.recommendationBatch.recommendations[3].price, 206.45);
  assert.equal(appendedSpotPrice.body.recommendationBatch.recommendations[3].rewardRisk, null);
  assert.equal(
    appendedSpotPrice.body.recommendationBatch.recommendations[3].lifecycle.marketDataDraft.source,
    'newleaf-market-data-service',
  );
  assert.equal(appendedSpotPrice.body.recommendationBatch.recommendations[3].lifecycle.marketData.source, 'alpaca');
  assert.equal(generationCalls.length, 3);
  assert.equal(generationCalls[2].existingRecommendations.length, 3);
  assert.equal(generationCalls[2].marketDrafts.length, 1);
  assert.equal(marketDataCalls.length, 4);

  const listAfterGeneration = await json({
    method: 'GET',
    path: '/api/v1/recommendation-batches',
  });
  assert.equal(listAfterGeneration.status, 200);
  assert.equal(listAfterGeneration.body.recommendationBatches.length, 2);

  const livePlan = await repository.createPublishPlan({
    jobId: published.body.recommendationBatch.scriptJobId,
    platforms: ['youtube', 'x', 'linkedin'],
    status: 'published',
    metadata: {
      title: 'Daily Picks',
    },
  });
  const youtubeAttempt = await repository.createPublishAttempt({
    planId: livePlan.id,
    jobId: published.body.recommendationBatch.scriptJobId,
    platform: 'youtube',
    status: 'published',
    providerPostId: 'youtube-video-123',
    providerUrl: 'https://www.youtube.com/watch?v=youtube-video-123',
    metadata: {},
  });
  const xAttempt = await repository.createPublishAttempt({
    planId: livePlan.id,
    jobId: published.body.recommendationBatch.scriptJobId,
    platform: 'x',
    status: 'published',
    providerPostId: 'tweet-123',
    providerUrl: 'https://x.com/newleaf/status/tweet-123',
    metadata: {},
  });
  const linkedinAttempt = await repository.createPublishAttempt({
    planId: livePlan.id,
    jobId: published.body.recommendationBatch.scriptJobId,
    platform: 'linkedin',
    status: 'failed',
    metadata: {},
  });
  await repository.createArtifact({
    id: 'pdf-created',
    jobId: published.body.recommendationBatch.scriptJobId,
    kind: 'recommendation_pdf',
    storageProvider: 'gcs',
    storageKey: `uploads/${published.body.recommendationBatch.scriptJobId}/recommendation_pdf/report.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 512,
    metadata: { filename: 'report.pdf' },
  });

  const deletedBatch = await json({
    method: 'POST',
    path: `/api/v1/recommendation-batches/${encodeURIComponent(batchId)}/delete`,
    body: {
      reason: 'test_recommendation_cleanup',
      removeRecommendation: true,
      removeVideoJob: true,
      removeOutputArtifacts: true,
      platforms: ['youtube', 'x', 'linkedin'],
    },
  });
  assert.equal(deletedBatch.status, 200);
  assert.equal(deletedBatch.body.recommendationBatch, null);
  assert.equal(deletedBatch.body.cleanup.recommendationRecord.deleted, true);
  assert.equal(deletedBatch.body.cleanup.publications.length, 3);
  assert.equal(deletedBatch.body.cleanup.videoJob.job.id, published.body.recommendationBatch.scriptJobId);
  assert.equal(deletedBatch.body.cleanup.videoJob.storageCleanup.artifactCount, 1);
  assert.equal(deletedBatch.body.cleanup.videoJob.storageCleanup.deletedObjectCount, 1);
  assert.equal(deletedBatch.body.cleanup.videoJob.storageCleanup.prefix.storagePrefix, `uploads/${published.body.recommendationBatch.scriptJobId}/`);
  assert.deepEqual(deletedPublicationAttempts.map((item) => item.attemptId).sort(), [xAttempt.id, youtubeAttempt.id].sort());
  assert.equal(deletedStorageArtifacts.length, 1);
  assert.deepEqual(deletedStoragePrefixes, [`uploads/${published.body.recommendationBatch.scriptJobId}/`]);
  assert.equal(await repository.getRecommendationBatch(batchId), undefined);
  assert.equal(await repository.getJob(published.body.recommendationBatch.scriptJobId), undefined);
  assert.equal(await repository.getArtifact('pdf-created'), undefined);
  assert.equal((await repository.getPublishPlan(livePlan.id)).status, 'deleted');
  assert.equal((await repository.getPublishAttempt(youtubeAttempt.id)).status, 'deleted');
  assert.equal((await repository.getPublishAttempt(xAttempt.id)).status, 'deleted');
  assert.equal((await repository.getPublishAttempt(linkedinAttempt.id)).status, 'deleted');

  const latestAfterDelete = await json({
    method: 'GET',
    path: '/api/v1/public/recommendations/latest',
  });
  assert.equal(latestAfterDelete.status, 404);

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
