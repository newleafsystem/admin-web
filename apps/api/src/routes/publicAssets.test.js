import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.REQUIRE_AUTH = 'false';
process.env.PUBLIC_ASSET_CACHE_MAX_AGE_SEC = '60';

const upstream = await listen(
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const reports = {
      '/reports/ADBE/latest.json': { meta: { symbol: 'ADBE' }, snapshot: { price: 401.25 } },
      '/reports/BABA/latest.json': { meta: { symbol: 'BABA' }, snapshot: { price: 77.5 } },
    };
    const report = reports[url.pathname];
    if (!report) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(report));
  }),
);

process.env.PUBLIC_DATA_ORIGIN_URL = `http://127.0.0.1:${upstream.address().port}`;

const { createApp } = await import('../app.js');
const { createInMemoryRepository } = await import('../lib/repository.js');

const app = createApp({
  repository: createInMemoryRepository(),
  autoResumeQueuedUploads: false,
});
const server = await listen(app);
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const batchResponse = await fetch(`${baseUrl}/api/v1/public/data/reports/latest?symbols=ADBE,BABA,RTX`);
  assert.equal(batchResponse.status, 200);
  assert.match(batchResponse.headers.get('cache-control') ?? '', /public, max-age=60/);

  const batch = await batchResponse.json();
  assert.deepEqual(batch.symbols, ['ADBE', 'BABA', 'RTX']);
  assert.equal(batch.count, 2);
  assert.equal(batch.reports.ADBE.snapshot.price, 401.25);
  assert.equal(batch.reports.BABA.meta.symbol, 'BABA');
  assert.equal(batch.errors.RTX.status, 404);

  const postResponse = await fetch(`${baseUrl}/api/v1/public/data/reports/latest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbols: ['ADBE', 'BABA'] }),
  });
  assert.equal(postResponse.status, 200);
  const postBatch = await postResponse.json();
  assert.equal(postBatch.count, 2);

  const invalidResponse = await fetch(`${baseUrl}/api/v1/public/data/reports/latest?symbols=ADBE,../BAD`);
  assert.equal(invalidResponse.status, 400);

  console.log('Public asset report batch tests passed.');
} finally {
  await close(server);
  await close(upstream);
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
