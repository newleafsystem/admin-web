import assert from 'node:assert/strict';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.REQUIRE_AUTH = 'true';
process.env.SERVICE_API_KEY_HASHES = '';

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
  const health = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(health.status, 200);

  const protectedRoutes = [
    { method: 'GET', path: '/api/v1/users' },
    { method: 'GET', path: '/api/v1/jobs' },
    { method: 'GET', path: '/api/v1/recommendation-batches' },
    { method: 'GET', path: '/api/v1/service-clients' },
    { method: 'GET', path: '/api/v1/market/options/snapshots?symbols=AAPL' },
    { method: 'POST', path: '/api/v1/firestore/get', body: { path: 'marketState/current' } },
  ];

  for (const route of protectedRoutes) {
    const response = await json(route);
    assert.equal(response.status, 401, `${route.method} ${route.path}`);
    assert.match(response.body.error.message, /Missing bearer token or NewLeaf session cookie/);
  }

  const serviceResponse = await json({
    method: 'POST',
    path: '/api/v1/service/text-to-heygen/jobs',
    body: {
      title: 'Anonymous service request',
      script: 'This request should require service credentials.',
    },
  });
  assert.equal(serviceResponse.status, 401);
  assert.match(serviceResponse.body.error.message, /Missing service API credentials/);

  console.log('API auth boundary tests passed.');
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
