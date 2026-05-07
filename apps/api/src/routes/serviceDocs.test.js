import assert from 'node:assert/strict';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.REQUIRE_AUTH = 'true';
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
  const anonymousDocs = await fetch(`${baseUrl}/api/v1/service/docs`);
  assert.equal(anonymousDocs.status, 401);
  const anonymousBody = await anonymousDocs.json();
  assert.match(anonymousBody.error.message, /Missing login or service API credentials/);

  const client = await createClient();

  const docsResponse = await signedGet({
    path: '/api/v1/service/docs',
    keyId: client.keyId,
    signingSecret: client.signingSecret,
  });
  assert.equal(docsResponse.status, 200);
  assert.match(docsResponse.headers.get('content-type') ?? '', /text\/html/);
  const docsHtml = await docsResponse.text();
  assert.match(docsHtml, /SwaggerUIBundle/);
  assert.match(docsHtml, /data:application\/yaml;base64/);
  assert.match(docsHtml, /Service API documentation is protected/);

  const anonymousYaml = await fetch(`${baseUrl}/api/v1/service/openapi.yaml`);
  assert.equal(anonymousYaml.status, 401);

  const yamlResponse = await signedGet({
    path: '/api/v1/service/openapi.yaml',
    keyId: client.keyId,
    signingSecret: client.signingSecret,
  });
  assert.equal(yamlResponse.status, 200);
  assert.match(yamlResponse.headers.get('content-type') ?? '', /application\/yaml/);
  const yaml = await yamlResponse.text();
  assert.match(yaml, /NewLeaf Service API/);
  assert.match(yaml, /\/service\/text-to-heygen\/jobs/);

  console.log('Service API Swagger docs tests passed.');
} finally {
  await close(server);
}

async function createClient() {
  const keyId = 'svc_docs_test';
  const signingSecret = 'nlsec_docs_test_secret';
  const secretRecord = await repository.putSecret({
    provider: 'newleaf',
    kind: 'service_api_signing_secret',
    value: signingSecret,
    metadata: { keyId },
  });
  await repository.createServiceClient({
    name: 'Docs Test Vendor',
    keyId,
    secretRef: secretRecord.secretRef,
    scopes: ['text_to_heygen'],
    rateLimitPerMinute: 60,
    requireSignedRequests: true,
    createdBy: 'test',
  });
  return { keyId, signingSecret };
}

async function signedGet({ path, keyId, signingSecret }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signServiceRequest({
    method: 'GET',
    originalUrl: path,
    timestamp,
    rawBody: Buffer.alloc(0),
    secret: signingSecret,
  });
  return fetch(`${baseUrl}${path}`, {
    headers: {
      'x-newleaf-key-id': keyId,
      'x-newleaf-timestamp': timestamp,
      'x-newleaf-signature': `sha256=${signature}`,
    },
  });
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
