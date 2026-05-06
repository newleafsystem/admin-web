import assert from 'node:assert/strict';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.REQUIRE_AUTH = 'false';

const { createApp } = await import('../app.js');
const { createInMemoryRepository } = await import('../lib/repository.js');

const repository = createInMemoryRepository();
const deletedStorageArtifacts = [];
const deletedStoragePrefixes = [];
const app = createApp({
  repository,
  autoResumeQueuedUploads: false,
  artifactStorageService: {
    shouldUseObjectStorage() {
      return true;
    },
    async deleteObjectStorageArtifact(artifact) {
      deletedStorageArtifacts.push(artifact);
      return {
        deleted: true,
        artifactId: artifact.id,
        storageProvider: artifact.storageProvider,
        storageKey: artifact.storageKey,
      };
    },
    async deleteObjectStoragePrefix(prefix) {
      deletedStoragePrefixes.push(prefix);
      return {
        deleted: true,
        prefix,
      };
    },
  },
});
const server = await listen(app);
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const stuckJob = await repository.createJob({
    id: 'job_stuck_partial_failed',
    title: 'Stuck publish job',
    type: 'trade_video',
    status: 'partial_failed',
    sourceType: 'text_to_heygen',
    ownerUid: 'test-admin',
    metadata: {},
  });
  const plan = await repository.createPublishPlan({
    jobId: stuckJob.id,
    platforms: ['youtube'],
    status: 'partial_failed',
    metadata: {
      title: 'Stuck publish job',
      description: 'Failed before provider upload.',
    },
  });
  const attempt = await repository.createPublishAttempt({
    planId: plan.id,
    jobId: stuckJob.id,
    platform: 'youtube',
    status: 'failed',
    errorCode: 'youtube_publish_failed',
    errorMessage: 'Temporary failure',
    metadata: {
      publisherStatus: 'Temporary failure',
    },
  });
  const artifact = await repository.createArtifact({
    jobId: stuckJob.id,
    kind: 'video',
    storageProvider: 'gcs',
    storageKey: `uploads/${stuckJob.id}/video/final.mp4`,
    mimeType: 'video/mp4',
    sizeBytes: 1234,
    metadata: {
      filename: 'final.mp4',
    },
  });

  const deleteResponse = await fetch(`${baseUrl}/api/v1/jobs/${stuckJob.id}`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ reason: 'test_queue_cleanup' }),
  });
  const deleteBody = await deleteResponse.json();
  assert.equal(deleteResponse.status, 200);
  assert.equal(deleteBody.deleted.job.id, stuckJob.id);
  assert.equal(deleteBody.deleted.publishPlans.length, 1);
  assert.equal(deleteBody.deleted.publishPlans[0].status, 'deleted');
  assert.equal(deleteBody.deleted.publishAttempts.length, 1);
  assert.equal(deleteBody.deleted.publishAttempts[0].status, 'deleted');
  assert.equal(deleteBody.deleted.publishAttempts[0].metadata.previousStatus, 'failed');
  assert.equal(deleteBody.deleted.storageCleanup.artifactCount, 1);
  assert.equal(deleteBody.deleted.storageCleanup.objectStorageCount, 1);
  assert.equal(deleteBody.deleted.storageCleanup.deletedObjectCount, 1);
  assert.equal(deleteBody.deleted.storageCleanup.prefix.storagePrefix, `uploads/${stuckJob.id}/`);
  assert.equal(deleteBody.deleted.storageCleanup.prefix.deleted, true);
  assert.equal(deleteBody.deleted.storageCleanup.objects[0].artifactId, artifact.id);
  assert.equal(deletedStorageArtifacts.length, 1);
  assert.equal(deletedStorageArtifacts[0].storageKey, artifact.storageKey);
  assert.deepEqual(deletedStoragePrefixes, [`uploads/${stuckJob.id}/`]);
  assert.equal(await repository.getJob(stuckJob.id), undefined);
  assert.equal((await repository.getPublishPlan(plan.id)).status, 'deleted');
  assert.equal((await repository.getPublishAttempt(attempt.id)).status, 'deleted');

  const liveJob = await repository.createJob({
    id: 'job_live_provider_publication',
    title: 'Live provider job',
    type: 'trade_video',
    status: 'partial_failed',
    sourceType: 'text_to_heygen',
    ownerUid: 'test-admin',
    metadata: {},
  });
  const livePlan = await repository.createPublishPlan({
    jobId: liveJob.id,
    platforms: ['youtube'],
    status: 'partial_failed',
    metadata: {
      title: 'Live provider job',
      description: 'Has provider video.',
    },
  });
  await repository.createPublishAttempt({
    planId: livePlan.id,
    jobId: liveJob.id,
    platform: 'youtube',
    status: 'published',
    providerPostId: 'youtube_video_id',
    providerUrl: 'https://www.youtube.com/watch?v=youtube_video_id',
    metadata: {},
  });

  const liveDeleteResponse = await fetch(`${baseUrl}/api/v1/jobs/${liveJob.id}`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ reason: 'test_queue_cleanup' }),
  });
  const liveDeleteBody = await liveDeleteResponse.json();
  assert.equal(liveDeleteResponse.status, 409);
  assert.match(liveDeleteBody.error.message, /Delete published videos first/);
  assert.equal((await repository.getJob(liveJob.id)).id, liveJob.id);

  console.log('Jobs delete tests passed.');
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
