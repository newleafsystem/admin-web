import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';

const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'newleaf-assets-content-'));
process.env.LOCAL_DATA_DIR = tempDir;

const { createInMemoryRepository } = await import('../lib/repository.js');
const { createAssetsRouter } = await import('./assets.js');

const repository = createInMemoryRepository();
const storageKey = path.join('recommendation-artifacts', 'batch_test', 'recommendation_pdf', 'report.pdf');
const filePath = path.resolve(tempDir, storageKey);
await fsp.mkdir(path.dirname(filePath), { recursive: true });
await fsp.writeFile(filePath, Buffer.from('%PDF-1.4\ncontent', 'utf8'));

const artifact = await repository.createArtifact({
  jobId: 'job_report',
  kind: 'recommendation_pdf',
  storageProvider: 'local-disk',
  storageKey,
  mimeType: 'application/pdf',
  sizeBytes: 16,
  metadata: {
    filename: 'report.pdf',
  },
});

const app = express();
app.use((req, res, next) => {
  req.user = { roles: ['admin'] };
  next();
});
app.use('/assets', createAssetsRouter({ repository }));
const server = await listen(app);
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const response = await fetch(`${baseUrl}/assets/${encodeURIComponent(artifact.id)}/content?download=1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="report.pdf"');
  assert.equal(await response.text(), '%PDF-1.4\ncontent');

  console.log('Asset content download tests passed.');
} finally {
  await close(server);
  await fsp.rm(tempDir, { recursive: true, force: true });
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
