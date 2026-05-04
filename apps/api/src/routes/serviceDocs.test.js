import assert from 'node:assert/strict';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.SERVICE_API_KEY_HASHES = '';

const { createApp } = await import('../app.js');
const { createInMemoryRepository } = await import('../lib/repository.js');

const app = createApp({
  repository: createInMemoryRepository(),
  autoResumeQueuedUploads: false,
});
const server = await listen(app);
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const docsResponse = await fetch(`${baseUrl}/api/v1/service/docs`);
  assert.equal(docsResponse.status, 200);
  assert.match(docsResponse.headers.get('content-type') ?? '', /text\/html/);
  const docsHtml = await docsResponse.text();
  assert.match(docsHtml, /SwaggerUIBundle/);
  assert.match(docsHtml, /\/api\/v1\/service\/openapi\.yaml/);

  const yamlResponse = await fetch(`${baseUrl}/api/v1/service/openapi.yaml`);
  assert.equal(yamlResponse.status, 200);
  assert.match(yamlResponse.headers.get('content-type') ?? '', /application\/yaml/);
  const yaml = await yamlResponse.text();
  assert.match(yaml, /NewLeaf Service API/);
  assert.match(yaml, /\/service\/text-to-heygen\/jobs/);

  console.log('Service API Swagger docs tests passed.');
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
