import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const publisherFiles = ['youtubePublisherService.js', 'socialPublisherService.js'];

for (const fileName of publisherFiles) {
  const source = readFileSync(path.join(serviceDir, fileName), 'utf8');

  assert.equal(
    source.includes('Only local dev-memory OAuth secrets'),
    false,
    `${fileName} must not reject non-local OAuth token secret references`,
  );
  assert.equal(
    source.includes('dev-memory:'),
    false,
    `${fileName} must treat tokenSecretRef as an opaque repository secret reference`,
  );
}

console.log('publisherSecretRefs.test.js passed');
