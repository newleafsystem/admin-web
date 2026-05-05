import assert from 'node:assert/strict';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.GCS_BUCKET = 'newleaf-test-bucket';

const {
  assertSafeObjectKey,
  buildObjectStorageKey,
  isObjectStorageProvider,
  sanitizeFilename,
  shouldUseObjectStorage,
  uploadFileToObjectStorage,
} = await import('./assetStorage.js');

assert.equal(isObjectStorageProvider('gcs'), true);
assert.equal(isObjectStorageProvider('local-disk'), false);
assert.equal(shouldUseObjectStorage(), true);
assert.equal(sanitizeFilename('../Bad Name?.mp4'), 'Bad Name_.mp4');

const key = buildObjectStorageKey({
  jobId: 'job one',
  kind: 'video',
  filename: '../Bad Name?.mp4',
  timestamp: 123,
});
assert.equal(key, 'uploads/job_one/video/123-Bad Name_.mp4');
assert.equal(assertSafeObjectKey(key), key);
assert.throws(() => assertSafeObjectKey('../secret.mp4'), /Invalid object storage key/);
assert.throws(() => assertSafeObjectKey('/uploads/file.mp4'), /Invalid object storage key/);
assert.equal(typeof uploadFileToObjectStorage, 'function');

console.log('Asset storage tests passed.');
