import assert from 'node:assert/strict';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.REQUIRE_AUTH = 'false';

const { createApp } = await import('../app.js');
const { createInMemoryRepository } = await import('../lib/repository.js');

const repository = createInMemoryRepository();
const queuedAttempts = [];
const app = createApp({
  repository,
  autoSyncPublications: false,
  autoResumeQueuedUploads: false,
  publisherService: {
    enabledPlatforms: ['youtube', 'x'],
    enqueueAttempt(attempt) {
      queuedAttempts.push(attempt);
      return { queued: true };
    },
  },
});
const server = await listen(app);
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  await repository.upsertSocialAccount({
    id: 'youtube-channel',
    platform: 'youtube',
    accountName: 'YouTube Channel',
    ownerUid: 'admin',
    status: 'connected',
  });
  await repository.upsertSocialAccount({
    id: 'x-channel',
    platform: 'x',
    accountName: 'X Channel',
    ownerUid: 'admin',
    status: 'connected',
  });
  await repository.createJob({
    id: 'external_youtube_video_1',
    title: 'Imported YouTube Video',
    type: 'external_video',
    status: 'published',
    sourceType: 'external_youtube',
    ownerUid: 'admin',
    metadata: {
      youtubeUrl: 'https://www.youtube.com/watch?v=video_1',
    },
  });
  const sourcePlan = await repository.createPublishPlan({
    jobId: 'external_youtube_video_1',
    platforms: ['youtube'],
    status: 'published',
    metadata: {
      title: 'Imported YouTube Video',
      description: 'Original description',
    },
  });
  const sourceAttempt = await repository.createPublishAttempt({
    planId: sourcePlan.id,
    jobId: 'external_youtube_video_1',
    platform: 'youtube',
    connectedAccountId: 'youtube-channel',
    status: 'published',
    providerPostId: 'video_1',
    providerUrl: 'https://www.youtube.com/watch?v=video_1',
    metadata: {
      title: 'Imported YouTube Video',
      description: 'Original description',
    },
  });
  const previousXPlan = await repository.createPublishPlan({
    jobId: 'external_youtube_video_1',
    platforms: ['x'],
    status: 'published',
    metadata: {
      title: 'Earlier X Post',
      description: 'Earlier description',
    },
  });
  await repository.createPublishAttempt({
    planId: previousXPlan.id,
    jobId: 'external_youtube_video_1',
    platform: 'x',
    connectedAccountId: 'x-channel',
    status: 'published',
    providerPostId: 'tweet_1',
    providerUrl: 'https://x.com/i/web/status/tweet_1',
    metadata: {
      title: 'Earlier X Post',
      description: 'Earlier description',
    },
  });

  const normalDuplicate = await postJson(`${baseUrl}/api/v1/publish-plans`, {
    jobId: 'external_youtube_video_1',
    platforms: ['youtube'],
    metadata: {
      title: 'Duplicate',
      description: 'Duplicate description',
    },
  });
  assert.equal(normalDuplicate.status, 409);

  const republishResponse = await postJson(`${baseUrl}/api/v1/publish-plans`, {
    jobId: 'external_youtube_video_1',
    platforms: ['youtube', 'x'],
    republishOfPublicationId: sourceAttempt.id,
    metadata: {
      title: 'Republished title',
      description: 'Republished description',
      hashtags: ['newleaf'],
      tags: ['education'],
      privacyStatus: 'public',
    },
  });
  assert.equal(republishResponse.status, 201);
  assert.equal(republishResponse.body.plan.metadata.republishSourceAttemptId, sourceAttempt.id);
  assert.equal(republishResponse.body.plan.metadata.republishSourceProviderPostId, 'video_1');
  assert.equal(republishResponse.body.plan.metadata.categoryId, '27');
  assert.equal(republishResponse.body.plan.metadata.videoLanguage, 'en');
  assert.equal(republishResponse.body.plan.metadata.titleDescriptionLanguage, 'en');
  assert.equal(republishResponse.body.plan.metadata.shortsRemixing, 'allow_video_audio');
  assert.equal(republishResponse.body.plan.metadata.educationApplicationType, 'real_life_application');
  assert.equal(republishResponse.body.plan.metadata.academicSystem, 'united_states');
  assert.equal(republishResponse.body.plan.metadata.educationLevel, 'professional_training');
  assert.deepEqual(republishResponse.body.plan.platforms, ['youtube', 'x']);

  const approveResponse = await fetch(`${baseUrl}/api/v1/publish-plans/${republishResponse.body.plan.id}/approve`, {
    method: 'POST',
  });
  assert.equal(approveResponse.status, 200);

  const publishResponse = await fetch(`${baseUrl}/api/v1/publish-plans/${republishResponse.body.plan.id}/publish`, {
    method: 'POST',
  });
  const publishBody = await publishResponse.json();
  assert.equal(publishResponse.status, 202);
  assert.equal(publishBody.attempts.length, 2);
  assert.deepEqual(
    publishBody.attempts.map((attempt) => attempt.platform).sort(),
    ['x', 'youtube'],
  );
  const youtubeAttempt = publishBody.attempts.find((attempt) => attempt.platform === 'youtube');
  assert.equal(youtubeAttempt.metadata.categoryId, '27');
  assert.equal(youtubeAttempt.metadata.videoLanguage, 'en');
  assert.equal(youtubeAttempt.metadata.titleDescriptionLanguage, 'en');
  assert.equal(queuedAttempts.length, 2);

  console.log('Publishing republish tests passed.');
} finally {
  await close(server);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
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
