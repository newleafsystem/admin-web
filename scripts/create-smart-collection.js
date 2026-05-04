import fs from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));

process.env.NEWLEAF_SKIP_DOTENV = args.useDotenv ? '0' : '1';
process.env.REPOSITORY_PROVIDER = 'firestore';
process.env.FIRESTORE_DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'newleafdb';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || readFirebaseProjectId();
process.env.FIREBASE_USE_APPLICATION_DEFAULT = process.env.FIREBASE_USE_APPLICATION_DEFAULT || 'true';

const { createRepository } = await import('../apps/api/src/lib/repositoryFactory.js');

const repository = createRepository();
const smartCollection = await repository.createSmartCollection({
  id: args.id,
  name: args.name ?? 'Ready for Review',
  description: args.description ?? 'Content jobs waiting for reviewer action.',
  type: args.type ?? 'content_jobs',
  status: args.status ?? 'active',
  visibility: args.visibility ?? 'team',
  ownerUid: args.ownerUid ?? null,
  criteria: args.criteria ?? { status: ['review_required'] },
  sort: args.sort ?? { field: 'updatedAt', direction: 'desc' },
  columns: args.columns ?? ['title', 'status', 'updatedAt'],
  metadata: args.metadata ?? { seededBy: 'scripts/create-smart-collection.js' },
  createdBy: args.createdBy ?? 'system',
});

console.log(JSON.stringify({ smartCollection }, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[index + 1]?.startsWith('--') ? undefined : argv[index + 1];
    if (value !== undefined) index += 1;
    if (key === 'use-dotenv') {
      parsed.useDotenv = true;
    } else if (['criteria', 'sort', 'metadata'].includes(key)) {
      parsed[key] = value ? JSON.parse(value) : {};
    } else if (key === 'columns') {
      parsed.columns = value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}

function readFirebaseProjectId() {
  const rcPath = path.resolve('.firebaserc');
  if (!fs.existsSync(rcPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(rcPath, 'utf8'));
    return parsed.projects?.default ?? null;
  } catch {
    return null;
  }
}
