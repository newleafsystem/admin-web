#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GCLOUD_CANDIDATES = [
  'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
  'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
  'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud',
  'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud',
];
const GCLOUD_ROOT_CANDIDATES = [
  'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk',
  'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk',
];
let cachedGcloudPath;

const SECRET_SPECS = [
  { env: 'HEYGEN_API_KEY', secret: 'NEWLEAF_HEYGEN_API_KEY', services: ['api'] },
  { env: 'HEYGEN_WEBHOOK_SECRET', secret: 'NEWLEAF_HEYGEN_WEBHOOK_SECRET', services: ['api'] },
  { env: 'OPENAI_API_KEY', secret: 'NEWLEAF_OPENAI_API_KEY', services: ['api'] },
  { env: 'AI_API_KEY', secret: 'NEWLEAF_AI_API_KEY', services: ['api'] },
  { env: 'YOUTUBE_CLIENT_SECRET', secret: 'NEWLEAF_YOUTUBE_CLIENT_SECRET', services: ['api'] },
  { env: 'X_CLIENT_SECRET', secret: 'NEWLEAF_X_CLIENT_SECRET', services: ['api'] },
  { env: 'LINKEDIN_CLIENT_SECRET', secret: 'NEWLEAF_LINKEDIN_CLIENT_SECRET', services: ['api'] },
  { env: 'META_APP_SECRET', secret: 'NEWLEAF_META_APP_SECRET', services: ['api'] },
  { env: 'TIKTOK_CLIENT_SECRET', secret: 'NEWLEAF_TIKTOK_CLIENT_SECRET', services: ['api'] },
  { env: 'ALPACA_API_KEY', secret: 'NEWLEAF_ALPACA_API_KEY', services: ['api'] },
  { env: 'ALPACA_SECRET_KEY', secret: 'NEWLEAF_ALPACA_SECRET_KEY', services: ['api'] },
  { env: 'MEDIA_RENDER_HMAC_SECRET', secret: 'NEWLEAF_RENDER_HMAC_SECRET', services: ['api', 'renderer'] },
  { env: 'SERVICE_API_KEY_HASHES', secret: 'NEWLEAF_SERVICE_API_KEY_HASHES', services: ['api'] },
  { env: 'TOKEN_ENCRYPTION_KEY', secret: 'NEWLEAF_TOKEN_ENCRYPTION_KEY', services: ['api'] },
];

const API_ENV_NAMES = [
  'REQUIRE_AUTH',
  'AUTH_SESSION_COOKIE_NAME',
  'AUTH_SESSION_HINT_COOKIE_NAME',
  'AUTH_SESSION_COOKIE_DOMAIN',
  'AUTH_SESSION_COOKIE_PATH',
  'AUTH_SESSION_COOKIE_MAX_AGE_SEC',
  'AUTH_SESSION_COOKIE_SAME_SITE',
  'AUTH_SESSION_COOKIE_SECURE',
  'PUBLIC_BASE_URL',
  'ADMIN_BASE_URL',
  'SOCIAL_CALLBACK_BASE_URL',
  'CORS_ALLOWED_ORIGINS',
  'SOCIAL_PUBLISH_ENABLED_PLATFORMS',
  'SOCIAL_AUTO_RESUME_QUEUED_UPLOADS',
  'SOCIAL_PUBLISH_STATUS_MAX_POLLS',
  'SERVICE_API_RATE_LIMIT_PER_MINUTE',
  'SERVICE_API_SIGNATURE_TOLERANCE_SEC',
  'FIREBASE_PROJECT_ID',
  'FIRESTORE_DATABASE_ID',
  'CLOUD_TASKS_LOCATION',
  'CLOUD_TASKS_QUEUE',
  'GCS_BUCKET',
  'PUBLIC_DATA_ORIGIN_URL',
  'PUBLIC_MEDIA_ORIGIN_URL',
  'PUBLIC_ASSET_CACHE_MAX_AGE_SEC',
  'ALPACA_DATA_BASE_URL',
  'MEDIA_RENDERER_URL',
  'FIRESTORE_COLLECTION_PREFIX',
  'AI_PROVIDER',
  'AI_MODEL',
  'AI_BASE_URL',
  'AI_TRANSCRIPTION_MODEL',
  'AI_TRANSCRIPTION_BASE_URL',
  'AI_MAX_TRANSCRIPTION_BYTES',
  'HEYGEN_API_BASE_URL',
  'HEYGEN_CALLBACK_URL',
  'HEYGEN_WEBHOOK_ENDPOINT_ID',
  'HEYGEN_SIGNATURE_HEADER',
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_REDIRECT_URI',
  'YOUTUBE_SCOPES',
  'YOUTUBE_DEFAULT_PRIVACY_STATUS',
  'YOUTUBE_DEFAULT_CATEGORY_ID',
  'YOUTUBE_UPLOAD_CHUNK_BYTES',
  'YOUTUBE_AUTO_RESUME_QUEUED_UPLOADS',
  'X_CLIENT_ID',
  'X_REDIRECT_URI',
  'X_SCOPES',
  'X_UPLOAD_CHUNK_BYTES',
  'LINKEDIN_CLIENT_ID',
  'LINKEDIN_REDIRECT_URI',
  'LINKEDIN_SCOPES',
  'LINKEDIN_API_VERSION',
  'META_APP_ID',
  'META_REDIRECT_URI',
  'META_GRAPH_VERSION',
  'META_FACEBOOK_SCOPES',
  'META_INSTAGRAM_SCOPES',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_REDIRECT_URI',
];

const SKIPPED_ENV_NAMES = new Set([
  'PORT',
  'VITE_API_BASE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'FFMPEG_PATH',
  'FFPROBE_PATH',
  'FFMPEG_FONT_FILE',
]);

function parseArgs(argv) {
  const args = {
    envFile: '.env',
    dryRun: false,
    updateCloudRun: false,
    skipSecrets: false,
    allowLocalValues: false,
    enableApis: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--env-file') {
      args.envFile = argv[index + 1];
      index += 1;
    } else if (arg === '--project') {
      args.projectId = argv[index + 1];
      index += 1;
    } else if (arg === '--region') {
      args.region = argv[index + 1];
      index += 1;
    } else if (arg === '--api-service') {
      args.apiService = argv[index + 1];
      index += 1;
    } else if (arg === '--renderer-service') {
      args.rendererService = argv[index + 1];
      index += 1;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--update-cloud-run') {
      args.updateCloudRun = true;
    } else if (arg === '--skip-secrets') {
      args.skipSecrets = true;
    } else if (arg === '--allow-local-values') {
      args.allowLocalValues = true;
    } else if (arg === '--skip-enable-apis') {
      args.enableApis = false;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  npm run gcp:sync-env -- [options]

Options:
  --env-file <path>          Env file to read. Defaults to .env. Use .env.production for deployment.
  --project <id>             Google Cloud project id. Defaults to GCP_PROJECT_ID, FIREBASE_PROJECT_ID, or .firebaserc.
  --region <region>          Cloud Run region. Defaults to GOOGLE_CLOUD_RUN_REGION or us-central1.
  --api-service <name>       API Cloud Run service. Defaults to GOOGLE_CLOUD_RUN_API_SERVICE or newleaf-api.
  --renderer-service <name>  Renderer Cloud Run service. Defaults to GOOGLE_CLOUD_RUN_RENDERER_SERVICE or newleaf-ffmpeg-renderer.
  --dry-run                  Print planned secret/env names without writing values.
  --update-cloud-run         Update existing Cloud Run services with env vars and secret bindings.
  --skip-secrets             Do not write Secret Manager secrets.
  --allow-local-values       Allow localhost values to be pushed to Cloud Run.
  --skip-enable-apis         Do not enable Secret Manager/Cloud Run APIs.

The script never prints secret values.`);
}

function readFirebaseProjectId() {
  const filePath = path.join(ROOT_DIR, '.firebaserc');
  if (!existsSync(filePath)) {
    return '';
  }

  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return data.projects?.default ?? '';
  } catch {
    return '';
  }
}

function parseEnv(content) {
  const result = {};
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    result[key] = parseEnvValue(rawValue);
  }

  return result;
}

function parseEnvValue(rawValue) {
  let value = rawValue.trim();
  if (!value) {
    return '';
  }

  if (value.startsWith('"')) {
    const end = findClosingQuote(value, '"');
    value = end >= 0 ? value.slice(1, end) : value.slice(1);
    return value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  if (value.startsWith("'")) {
    const end = findClosingQuote(value, "'");
    return end >= 0 ? value.slice(1, end) : value.slice(1);
  }

  return value.replace(/\s+#.*$/, '').trim();
}

function findClosingQuote(value, quote) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === quote && value[index - 1] !== '\\') {
      return index;
    }
  }
  return -1;
}

function findExecutable(name, candidates = []) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(probe, [name], {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status === 0) {
    const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (process.platform === 'win32') {
      const cmdMatch = matches.find((line) => /\.(cmd|exe)$/i.test(line));
      if (cmdMatch) return cmdMatch;
      const cmdSibling = matches.map((line) => `${line}.cmd`).find((line) => existsSync(line));
      if (cmdSibling) return cmdSibling;
    }
    if (matches[0]) return matches[0];
  }

  return candidates.find((candidate) => existsSync(candidate)) || '';
}

function getGcloudPath() {
  if (cachedGcloudPath !== undefined) {
    return cachedGcloudPath;
  }
  cachedGcloudPath = process.env.GCLOUD_BIN || findExecutable('gcloud', GCLOUD_CANDIDATES);
  return cachedGcloudPath;
}

function getGcloudDisplayPath() {
  const gcloudPath = getGcloudPath();
  return getWindowsGcloudPythonInvocation(gcloudPath)?.display || gcloudPath;
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (!/[()\s"&^<>|]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function wrapWindowsCommandLine(commandLine) {
  return commandLine.startsWith('"') ? `"${commandLine}"` : commandLine;
}

function getWindowsGcloudPythonInvocation(gcloudPath) {
  if (process.platform !== 'win32') {
    return null;
  }

  const roots = [];
  if (gcloudPath && gcloudPath !== 'gcloud') {
    const binDir = path.dirname(gcloudPath);
    roots.push(path.resolve(binDir, '..'));
  }
  roots.push(...GCLOUD_ROOT_CANDIDATES);

  for (const root of roots) {
    const pythonPath = path.join(root, 'platform', 'bundledpython', 'python.exe');
    const gcloudPyPath = path.join(root, 'lib', 'gcloud.py');
    if (existsSync(pythonPath) && existsSync(gcloudPyPath)) {
      return {
        command: pythonPath,
        argsPrefix: [gcloudPyPath],
        display: gcloudPyPath,
      };
    }
  }

  return null;
}

function spawnGcloud(args, options = {}) {
  const gcloudPath = getGcloudPath();
  if (!gcloudPath) {
    return {
      status: null,
      error: new Error('Google Cloud CLI was not found.'),
      stdout: '',
      stderr: '',
    };
  }

  const stdio = options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'];
  const pythonInvocation = getWindowsGcloudPythonInvocation(gcloudPath);
  if (pythonInvocation) {
    return spawnSync(pythonInvocation.command, [...pythonInvocation.argsPrefix, ...args], {
      input: options.input,
      encoding: 'utf8',
      stdio,
    });
  }

  if (process.platform === 'win32' && /\.cmd$/i.test(gcloudPath)) {
    const commandLine = wrapWindowsCommandLine([gcloudPath, ...args].map(quoteWindowsArg).join(' '));
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', commandLine], {
      input: options.input,
      encoding: 'utf8',
      stdio,
    });
  }

  return spawnSync(gcloudPath, args, {
    input: options.input,
    encoding: 'utf8',
    stdio,
  });
}

function runGcloud(args, options = {}) {
  const command = ['gcloud', ...args].join(' ');
  const result = spawnGcloud(args, options);

  if (result.error) {
    throw new Error(`Unable to run gcloud at ${getGcloudDisplayPath() || 'gcloud'}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(`gcloud command failed: ${command}${stderr ? `\n${stderr}` : ''}`);
  }

  return result.stdout?.trim() ?? '';
}

function commandExists(command) {
  const executable = command === 'gcloud' ? getGcloudPath() : findExecutable(command);
  if (!executable) {
    return false;
  }

  if (command === 'gcloud') {
    return true;
  }

  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32' && /\.cmd$/i.test(executable),
  });
  return !result.error && result.status === 0;
}

function hasValue(value) {
  if (value === undefined || value === null) {
    return false;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return false;
  }

  return !/^(<.*>|your-|changeme|todo|undefined|null)$/i.test(normalized);
}

function assertNoLocalValues(envMap, allowLocalValues) {
  if (allowLocalValues) {
    return;
  }

  const localEntries = Object.entries(envMap).filter(([, value]) => /localhost|127\.0\.0\.1/i.test(value));
  if (localEntries.length === 0) {
    return;
  }

  const names = localEntries.map(([name]) => name).join(', ');
  throw new Error(
    `Refusing to push localhost values to Cloud Run: ${names}. ` +
    'Set production URLs in .env or rerun with --allow-local-values for a local test service.',
  );
}

function assertNoPlatformHostedDomains(envMap) {
  const namesToCheck = new Set([
    'PUBLIC_BASE_URL',
    'ADMIN_BASE_URL',
    'SOCIAL_CALLBACK_BASE_URL',
    'CORS_ALLOWED_ORIGINS',
    'HEYGEN_CALLBACK_URL',
    'YOUTUBE_REDIRECT_URI',
    'X_REDIRECT_URI',
    'LINKEDIN_REDIRECT_URI',
    'META_REDIRECT_URI',
    'TIKTOK_REDIRECT_URI',
  ]);
  const platformEntries = Object.entries(envMap).filter(
    ([name, value]) => namesToCheck.has(name) && /(?:firebaseapp\.com|web\.app|run\.app)/i.test(String(value)),
  );
  if (platformEntries.length === 0) {
    return;
  }

  const names = platformEntries.map(([name]) => name).join(', ');
  throw new Error(
    `Refusing to push Firebase/Google platform-hosted public domains to Cloud Run: ${names}. ` +
    'Use admin.newleafsystem.com or another approved newleafsystem.com custom domain.',
  );
}

function createSecretEnvSpecs(serviceName, envValues) {
  return SECRET_SPECS
    .filter((spec) => spec.services.includes(serviceName) && hasValue(envValues[spec.env]))
    .map((spec) => `${spec.env}=${spec.secret}:latest`);
}

function createApiEnvMap(envValues, projectId) {
  const envMap = {
    NODE_ENV: 'production',
    NEWLEAF_SKIP_DOTENV: '1',
    FIREBASE_USE_APPLICATION_DEFAULT: 'true',
    FIREBASE_ADMIN_DISABLED: 'false',
    REPOSITORY_PROVIDER: 'firestore',
    LOCAL_DATA_DIR: '/tmp/newleaf-api',
    VIDEO_STORAGE_DIR: '/tmp/newleaf-video-assembler',
  };

  for (const name of API_ENV_NAMES) {
    if (SKIPPED_ENV_NAMES.has(name)) {
      continue;
    }
    if (hasValue(envValues[name])) {
      envMap[name] = envValues[name];
    }
  }

  if (!hasValue(envMap.FIREBASE_PROJECT_ID)) {
    envMap.FIREBASE_PROJECT_ID = projectId;
  }

  if (!hasValue(envMap.FIRESTORE_DATABASE_ID)) {
    envMap.FIRESTORE_DATABASE_ID = 'newleafdb';
  }

  const storageBucket = hasValue(envValues.GCS_BUCKET)
    ? envValues.GCS_BUCKET
    : `${projectId}.firebasestorage.app`;

  if (hasValue(storageBucket)) {
    envMap.GCS_BUCKET = storageBucket;
  }

  return envMap;
}

function createRendererEnvMap(envValues) {
  const envMap = {};
  if (hasValue(envValues.GCS_BUCKET)) {
    envMap.GCS_BUCKET = envValues.GCS_BUCKET;
  }
  return envMap;
}

function serializeEnvVars(envMap) {
  const entries = Object.entries(envMap).map(([key, value]) => `${key}=${value}`);
  return `^@^${entries.join('@')}`;
}

async function getGoogleAuthClient() {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  return auth.getClient();
}

async function ensureSecretWithRest(projectId, secretName, value) {
  const client = await getGoogleAuthClient();
  const encodedName = encodeURIComponent(secretName);
  const baseUrl = `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets`;
  const secretUrl = `${baseUrl}/${encodedName}`;

  let exists = false;
  try {
    await client.request({ url: secretUrl, method: 'GET' });
    exists = true;
  } catch (error) {
    if (error.response?.status !== 404) {
      throw error;
    }
  }

  if (!exists) {
    await client.request({
      url: `${baseUrl}?secretId=${encodedName}`,
      method: 'POST',
      data: {
        replication: {
          automatic: {},
        },
      },
    });
    console.log(`Created Secret Manager secret ${secretName}`);
  }

  await client.request({
    url: `${secretUrl}:addVersion`,
    method: 'POST',
    data: {
      payload: {
        data: Buffer.from(value, 'utf8').toString('base64'),
      },
    },
  });

  if (exists) {
    console.log(`Updated Secret Manager secret ${secretName}`);
  }
}

async function ensureSecret(projectId, secretName, value, dryRun, gcloudAvailable) {
  if (dryRun) {
    console.log(`DRY RUN: would upsert Secret Manager secret ${secretName}`);
    return;
  }

  if (!gcloudAvailable) {
    await ensureSecretWithRest(projectId, secretName, value);
    return;
  }

  const describe = spawnGcloud(['secrets', 'describe', secretName, '--project', projectId]);

  if (describe.error) {
    throw new Error(`Unable to run gcloud at ${getGcloudDisplayPath() || 'gcloud'}: ${describe.error.message}`);
  }

  if (describe.status === 0) {
    runGcloud(['secrets', 'versions', 'add', secretName, '--project', projectId, '--data-file=-'], { input: value });
    console.log(`Updated Secret Manager secret ${secretName}`);
    return;
  }

  runGcloud([
    'secrets',
    'create',
    secretName,
    '--project',
    projectId,
    '--replication-policy=automatic',
    '--data-file=-',
  ], { input: value });
  console.log(`Created Secret Manager secret ${secretName}`);
}

function updateCloudRunService({ projectId, region, serviceName, envMap, secretSpecs, dryRun }) {
  const args = [
    'run',
    'services',
    'update',
    serviceName,
    '--project',
    projectId,
    '--region',
    region,
  ];

  if (Object.keys(envMap).length > 0) {
    args.push('--set-env-vars', serializeEnvVars(envMap));
  }

  if (secretSpecs.length > 0) {
    args.push('--set-secrets', secretSpecs.join(','));
  }

  if (dryRun) {
    console.log(`DRY RUN: would update Cloud Run service ${serviceName}`);
    console.log(`  env vars: ${Object.keys(envMap).sort().join(', ') || 'none'}`);
    console.log(`  secrets: ${secretSpecs.map((spec) => spec.split('=')[0]).join(', ') || 'none'}`);
    return;
  }

  runGcloud(args);
  console.log(`Updated Cloud Run service ${serviceName}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFilePath = path.resolve(ROOT_DIR, args.envFile);

  if (!existsSync(envFilePath)) {
    throw new Error(`Env file not found: ${envFilePath}`);
  }

  const fileEnv = parseEnv(readFileSync(envFilePath, 'utf8'));
  const envValues = { ...fileEnv, ...process.env };
  const projectId = args.projectId || envValues.GCP_PROJECT_ID || envValues.FIREBASE_PROJECT_ID || readFirebaseProjectId();
  const region = args.region || envValues.GOOGLE_CLOUD_RUN_REGION || envValues.GCP_REGION || 'us-central1';
  const apiService = args.apiService || envValues.GOOGLE_CLOUD_RUN_API_SERVICE || 'newleaf-api';
  const rendererService = args.rendererService || envValues.GOOGLE_CLOUD_RUN_RENDERER_SERVICE || 'newleaf-ffmpeg-renderer';

  if (!projectId) {
    throw new Error('Google Cloud project id is required. Set GCP_PROJECT_ID, FIREBASE_PROJECT_ID, or .firebaserc default.');
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && hasValue(envValues.GOOGLE_APPLICATION_CREDENTIALS)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = envValues.GOOGLE_APPLICATION_CREDENTIALS;
  }

  const gcloudAvailable = commandExists('gcloud');

  console.log(`Using env file: ${path.relative(ROOT_DIR, envFilePath)}`);
  console.log(`Using project: ${projectId}`);
  console.log(`Using region: ${region}`);

  if (!args.dryRun) {
    if (gcloudAvailable) {
      console.log(`Using gcloud: ${getGcloudDisplayPath()}`);
      runGcloud(['config', 'set', 'project', projectId]);
    } else {
      console.log('gcloud is not in PATH. Secret sync will use Google Auth / Secret Manager REST.');
    }

    if (args.enableApis && gcloudAvailable) {
      runGcloud([
        'services',
        'enable',
        'secretmanager.googleapis.com',
        'run.googleapis.com',
        '--project',
        projectId,
      ]);
    } else if (args.enableApis && !gcloudAvailable) {
      console.log('Skipping API enablement because gcloud is not available.');
    }
  }

  if (!args.skipSecrets) {
    const presentSecrets = SECRET_SPECS.filter((spec) => hasValue(envValues[spec.env]));
    if (presentSecrets.length === 0) {
      console.log('No populated secret env values found to sync.');
    }

    for (const spec of presentSecrets) {
      await ensureSecret(projectId, spec.secret, envValues[spec.env], args.dryRun, gcloudAvailable);
    }
  }

  if (args.updateCloudRun) {
    if (!gcloudAvailable && !args.dryRun) {
      throw new Error('Updating Cloud Run services requires gcloud in PATH. Secret Manager sync can run without gcloud.');
    }

    const apiEnvMap = createApiEnvMap(envValues, projectId);
    const rendererEnvMap = createRendererEnvMap(envValues);

    assertNoLocalValues(apiEnvMap, args.allowLocalValues);
    assertNoLocalValues(rendererEnvMap, args.allowLocalValues);
    assertNoPlatformHostedDomains(apiEnvMap);

    updateCloudRunService({
      projectId,
      region,
      serviceName: apiService,
      envMap: apiEnvMap,
      secretSpecs: createSecretEnvSpecs('api', envValues),
      dryRun: args.dryRun,
    });

    updateCloudRunService({
      projectId,
      region,
      serviceName: rendererService,
      envMap: rendererEnvMap,
      secretSpecs: createSecretEnvSpecs('renderer', envValues),
      dryRun: args.dryRun,
    });
  }

  console.log('Google Cloud env sync complete.');
}

try {
  await main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
