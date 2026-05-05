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
  autoResumeQueuedUploads: false,
  publisherService: {
    enqueueAttempt(attempt) {
      queuedAttempts.push(attempt);
      return { queued: true };
    },
  },
});
const server = await listen(app);
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const plan = await repository.createPublishPlan({
    jobId: 'job_publish_retry',
    platforms: ['youtube'],
    status: 'approved',
    metadata: {
      title: 'Retry Video',
      description: 'Retry Video',
    },
  });
  const attempt = await repository.createPublishAttempt({
    planId: plan.id,
    jobId: plan.jobId,
    platform: 'youtube',
    connectedAccountId: 'youtube-channel',
    status: 'failed',
    errorCode: 'http_409',
    errorMessage: 'Only local dev-memory OAuth secrets can be used by the local YouTube uploader',
    attemptNo: 3,
    metadata: {
      title: 'Retry Video',
      description: 'Retry Video',
      publisherStatus: 'Only local dev-memory OAuth secrets can be used by the local YouTube uploader',
      progressStage: 'failed',
      progressPercent: 0,
      progressLabel: 'Only local dev-memory OAuth secrets can be used by the local YouTube uploader',
      failureDetails: {
        name: 'HttpError',
        message: 'Only local dev-memory OAuth secrets can be used by the local YouTube uploader',
        status: 409,
      },
    },
  });

  const response = await fetch(`${baseUrl}/api/v1/publish-attempts/${attempt.id}/retry`, { method: 'POST' });
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(body.attempt.status, 'queued');
  assert.equal(body.attempt.errorCode, null);
  assert.equal(body.attempt.errorMessage, null);
  assert.equal(body.attempt.attemptNo, 4);
  assert.equal(body.attempt.metadata.failureDetails, undefined);
  assert.equal(body.attempt.metadata.progressStage, 'queued');
  assert.equal(body.attempt.metadata.progressLabel, 'Queued for publisher worker.');
  assert.equal(body.task.queued, true);
  assert.equal(queuedAttempts.length, 1);
  assert.equal(queuedAttempts[0].metadata.failureDetails, undefined);

  console.log('Publishing retry tests passed.');
} finally {
  await close(server);
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
