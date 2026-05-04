import assert from 'node:assert/strict';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.REQUIRE_AUTH = 'false';
process.env.SERVICE_API_KEY_HASHES = '';
process.env.SERVICE_API_SIGNATURE_TOLERANCE_SEC = '300';

const { createApp } = await import('../app.js');
const { createInMemoryRepository } = await import('../lib/repository.js');
const { signServiceRequest } = await import('../middleware/serviceApiAuth.js');

const repository = createInMemoryRepository();
const app = createApp({
  repository,
  autoResumeQueuedUploads: false,
});
const server = await listen(app);
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const firstClient = await createClient({ name: 'Vendor A' });
  const secondClient = await createClient({ name: 'Vendor B' });

  const payload = {
    title: 'Vendor Script',
    script: 'Create a short NewLeaf market education video.',
    idempotencyKey: 'vendor-script-001',
    autoStart: false,
  };
  const firstSubmission = await signedJson({
    method: 'POST',
    path: '/api/v1/service/text-to-heygen/jobs',
    keyId: firstClient.credentials.keyId,
    signingSecret: firstClient.credentials.signingSecret,
    body: payload,
  });

  assert.equal(firstSubmission.status, 201);
  assert.equal(firstSubmission.body.job.status, 'script_ready');
  assert.equal(firstSubmission.body.job.sourceType, 'text_to_heygen');
  assert.equal(firstSubmission.body.idempotentReplay, false);
  assert.equal(firstSubmission.body.providerJobs.length, 0);

  const replaySubmission = await signedJson({
    method: 'POST',
    path: '/api/v1/service/text-to-heygen/jobs',
    keyId: firstClient.credentials.keyId,
    signingSecret: firstClient.credentials.signingSecret,
    body: payload,
  });

  assert.equal(replaySubmission.status, 200);
  assert.equal(replaySubmission.body.job.id, firstSubmission.body.job.id);
  assert.equal(replaySubmission.body.idempotentReplay, true);

  const markdownScript = [
    '# BABA Video',
    '',
    '## Slide 1: Intro',
    '*Duration: ~5s*',
    '',
    'Introduce the BABA iron condor setup.',
    '',
    '## Slide 2: Risk',
    '*Duration: ~5s*',
    '',
    'Explain the defined risk and educational disclaimer.',
  ].join('\n');
  const encodedSubmission = await signedJson({
    method: 'POST',
    path: '/api/v1/service/text-to-heygen/jobs',
    keyId: firstClient.credentials.keyId,
    signingSecret: firstClient.credentials.signingSecret,
    body: {
      title: 'BABA Encoded Script',
      scriptBase64: Buffer.from(markdownScript, 'utf8').toString('base64'),
      segmentMode: 'slides',
      idempotencyKey: 'baba-encoded-script-001',
      autoStart: false,
    },
  });
  assert.equal(encodedSubmission.status, 201);
  const encodedJob = await repository.getJob(encodedSubmission.body.job.id);
  assert.equal(encodedJob.metadata.prompt, markdownScript);
  assert.equal(encodedJob.metadata.videoSegments.length, 2);
  assert.equal(encodedJob.metadata.videoSegments[0].sequence, 10);
  assert.equal(encodedJob.metadata.videoSegments[1].segmentKey, 'risk');

  const deniedLookup = await signedJson({
    method: 'GET',
    path: `/api/v1/service/jobs/${firstSubmission.body.job.id}`,
    keyId: secondClient.credentials.keyId,
    signingSecret: secondClient.credentials.signingSecret,
  });
  assert.equal(deniedLookup.status, 403);

  const goodLookup = await signedJson({
    method: 'GET',
    path: `/api/v1/service/jobs/${firstSubmission.body.job.id}`,
    keyId: firstClient.credentials.keyId,
    signingSecret: firstClient.credentials.signingSecret,
  });
  assert.equal(goodLookup.status, 200);
  assert.equal(goodLookup.body.job.id, firstSubmission.body.job.id);

  await postAdmin(`/api/v1/service-clients/${firstClient.client.id}/revoke`);
  const revokedLookup = await signedJson({
    method: 'GET',
    path: `/api/v1/service/jobs/${firstSubmission.body.job.id}`,
    keyId: firstClient.credentials.keyId,
    signingSecret: firstClient.credentials.signingSecret,
  });
  assert.equal(revokedLookup.status, 403);

  console.log('Service API auth and idempotency tests passed.');
} finally {
  await close(server);
}

async function createClient(payload) {
  const result = await postAdmin('/api/v1/service-clients', payload);
  assert.equal(result.status, 201);
  assert.ok(result.body.credentials.keyId);
  assert.ok(result.body.credentials.signingSecret);
  return result.body;
}

async function postAdmin(path, body = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function signedJson({ method, path, keyId, signingSecret, body = undefined }) {
  const rawBody = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signServiceRequest({
    method,
    originalUrl: path,
    timestamp,
    rawBody,
    secret: signingSecret,
  });
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-newleaf-key-id': keyId,
      'x-newleaf-timestamp': timestamp,
      'x-newleaf-signature': `sha256=${signature}`,
    },
    body: body === undefined ? undefined : rawBody,
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
