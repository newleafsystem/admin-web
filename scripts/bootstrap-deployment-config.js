#!/usr/bin/env node

import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_API_BASE_URL = 'https://api.newleafsystem.com';
const DEFAULT_ADMIN_BASE_URL = 'https://admin.newleafsystem.com';
const DEFAULT_CORS_ALLOWED_ORIGINS = [
  DEFAULT_ADMIN_BASE_URL,
  'https://newleafsystem.com',
  'https://www.newleafsystem.com',
  'https://newleafsystem.web.app',
  'https://newleaf-preview.web.app',
].join(' ');

const REQUIRED_REPO_VARIABLE_NAMES = [
  'GCP_PROJECT_ID',
  'GCP_REGION',
  'GCS_BUCKET',
  'GOOGLE_CLOUD_RUN_API_SERVICE',
  'GOOGLE_CLOUD_RUN_RENDERER_SERVICE',
  'REQUIRE_AUTH',
  'PUBLIC_BASE_URL',
  'ADMIN_BASE_URL',
  'SOCIAL_CALLBACK_BASE_URL',
  'CORS_ALLOWED_ORIGINS',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
];

const REQUIRED_REPO_SECRET_NAMES = [
  'GCP_WORKLOAD_IDENTITY_PROVIDER',
  'GCP_SERVICE_ACCOUNT',
  'MEDIA_RENDER_HMAC_SECRET',
];

const REPO_VARIABLE_NAMES = [
  'GCP_PROJECT_ID',
  'GCP_REGION',
  'GOOGLE_CLOUD_RUN_API_SERVICE',
  'GOOGLE_CLOUD_RUN_RENDERER_SERVICE',
  'GCS_BUCKET',
  'SKIP_ENABLE_APIS',
  'SKIP_PROVISIONING',
  'CLOUD_BUILD_SUPPRESS_LOGS',
  'REQUIRE_AUTH',
  'AUTH_ADMIN_EMAILS',
  'AUTH_SESSION_COOKIE_NAME',
  'AUTH_SESSION_COOKIE_DOMAIN',
  'AUTH_SESSION_COOKIE_PATH',
  'AUTH_SESSION_COOKIE_MAX_AGE_SEC',
  'AUTH_SESSION_COOKIE_SAME_SITE',
  'AUTH_SESSION_COOKIE_SECURE',
  'FIRESTORE_DATABASE_ID',
  'PUBLIC_BASE_URL',
  'ADMIN_BASE_URL',
  'SOCIAL_CALLBACK_BASE_URL',
  'CORS_ALLOWED_ORIGINS',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
  'VITE_FIREBASE_MEASUREMENT_ID',
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_REDIRECT_URI',
  'YOUTUBE_SCOPES',
  'YOUTUBE_DEFAULT_PRIVACY_STATUS',
  'YOUTUBE_DEFAULT_CATEGORY_ID',
];

const REPO_SECRET_NAMES = [
  'GCP_WORKLOAD_IDENTITY_PROVIDER',
  'GCP_SERVICE_ACCOUNT',
  'MEDIA_RENDER_HMAC_SECRET',
  'YOUTUBE_CLIENT_SECRET',
];

function parseArgs(argv) {
  const args = {
    envFile: process.env.ENV_FILE || (existsSync(path.join(ROOT_DIR, '.env.production')) ? '.env.production' : '.env'),
    repo: process.env.GITHUB_REPOSITORY || '',
    dryRun: false,
    skipGithub: false,
    skipGoogle: false,
    skipFirebaseDiscovery: false,
    updateCloudRun: true,
    allowLocalValues: false,
    skipEnableApis: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--env-file') {
      args.envFile = argv[++index];
    } else if (arg === '--repo') {
      args.repo = argv[++index];
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--skip-github') {
      args.skipGithub = true;
    } else if (arg === '--skip-google') {
      args.skipGoogle = true;
    } else if (arg === '--skip-firebase-discovery') {
      args.skipFirebaseDiscovery = true;
    } else if (arg === '--no-update-cloud-run') {
      args.updateCloudRun = false;
    } else if (arg === '--allow-local-values') {
      args.allowLocalValues = true;
    } else if (arg === '--enable-apis') {
      args.skipEnableApis = false;
    } else if (arg === '-h' || arg === '--help') {
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
  npm run deploy:configure -- --repo owner/repo

Options:
  --env-file <path>       Env file to read. Defaults to .env.production if present, otherwise .env.
  --repo <owner/repo>     GitHub repository. Defaults to GITHUB_REPOSITORY or gh repo view.
  --dry-run               Print planned variable/secret names without writing values.
  --skip-github           Do not push GitHub repository variables/secrets.
  --skip-google           Do not sync Google Secret Manager / Cloud Run.
  --skip-firebase-discovery
                          Do not call Firebase CLI to fetch missing web app config.
  --no-update-cloud-run   Sync Google Secret Manager only; do not update existing Cloud Run services.
  --allow-local-values    Allow localhost URLs to be pushed intentionally.
  --enable-apis           Allow Google API enablement during Google sync.

The script never prints secret values.`);
}

function parseEnvFile(filePath) {
  const result = {};
  const content = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const key = normalized.slice(0, normalized.indexOf('=')).trim();
    let value = normalized.slice(normalized.indexOf('=') + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    result[key] = value;
  }
  return result;
}

function hasValue(value) {
  return Boolean(value) && !/^(<.*>|your-|changeme|todo|undefined|null)$/i.test(String(value));
}

function isLocalValue(value) {
  return /localhost|127\.0\.0\.1/i.test(String(value ?? ''));
}

function isPlatformHostedValue(value) {
  return /(?:firebaseapp\.com|web\.app|run\.app)/i.test(String(value ?? ''));
}

function hostnameFromUrl(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

function parseJsonText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const candidates = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let index = 0; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '{') {
        if (depth === 0) start = index;
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(trimmed.slice(start, index + 1));
          start = -1;
        }
      }
    }

    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(candidates[index]);
      } catch {
        // Try the previous JSON-looking block.
      }
    }
    return null;
  }
}

function readJsonFileIfPresent(filePath) {
  if (!hasValue(filePath) || !existsSync(filePath)) return null;
  return parseJsonText(readFileSync(filePath, 'utf8'));
}

function readCredentialJson(env) {
  return (
    parseJsonText(env.FIREBASE_CREDENTIALS_JSON) ||
    readJsonFileIfPresent(env.GOOGLE_APPLICATION_CREDENTIALS)
  );
}

function buildEnvValues(fileEnv) {
  const env = { ...fileEnv, ...process.env };
  const credentials = readCredentialJson(env);
  const projectId = env.GCP_PROJECT_ID || env.FIREBASE_PROJECT_ID || 'newleaf-trading';

  env.GCP_PROJECT_ID ||= credentials?.project_id || projectId;
  env.GCP_REGION ||= env.GOOGLE_CLOUD_RUN_REGION || 'us-central1';
  env.GOOGLE_CLOUD_RUN_API_SERVICE ||= 'newleaf-api';
  env.GOOGLE_CLOUD_RUN_RENDERER_SERVICE ||= 'newleaf-ffmpeg-renderer';
  env.GCS_BUCKET ||= `${env.GCP_PROJECT_ID}.firebasestorage.app`;
  env.SKIP_ENABLE_APIS ||= 'true';
  env.SKIP_PROVISIONING ||= 'true';
  env.CLOUD_BUILD_SUPPRESS_LOGS ||= 'true';
  env.REQUIRE_AUTH ||= 'true';
  env.FIRESTORE_DATABASE_ID ||= 'newleafdb';
  env.GCP_SERVICE_ACCOUNT ||= credentials?.client_email || '';
  env.AUTH_SESSION_COOKIE_NAME ||= 'newleaf_session';
  env.AUTH_SESSION_COOKIE_DOMAIN ||= '.newleafsystem.com';
  env.AUTH_SESSION_COOKIE_PATH ||= '/';
  env.AUTH_SESSION_COOKIE_MAX_AGE_SEC ||= '432000';
  env.AUTH_SESSION_COOKIE_SAME_SITE ||= 'lax';
  env.AUTH_SESSION_COOKIE_SECURE ||= 'true';

  if (!hasValue(env.PUBLIC_BASE_URL) || isLocalValue(env.PUBLIC_BASE_URL)) {
    env.PUBLIC_BASE_URL = DEFAULT_API_BASE_URL;
  }
  if (!hasValue(env.ADMIN_BASE_URL) || isLocalValue(env.ADMIN_BASE_URL)) {
    env.ADMIN_BASE_URL = DEFAULT_ADMIN_BASE_URL;
  }
  if (!hasValue(env.SOCIAL_CALLBACK_BASE_URL) || isLocalValue(env.SOCIAL_CALLBACK_BASE_URL)) {
    env.SOCIAL_CALLBACK_BASE_URL = env.PUBLIC_BASE_URL;
  }
  if (!hasValue(env.CORS_ALLOWED_ORIGINS) || isLocalValue(env.CORS_ALLOWED_ORIGINS)) {
    env.CORS_ALLOWED_ORIGINS = DEFAULT_CORS_ALLOWED_ORIGINS;
  }

  env.VITE_FIREBASE_PROJECT_ID ||= env.FIREBASE_PROJECT_ID || env.GCP_PROJECT_ID;
  env.VITE_FIREBASE_AUTH_DOMAIN ||= hostnameFromUrl(env.ADMIN_BASE_URL);
  env.VITE_FIREBASE_STORAGE_BUCKET ||= env.GCS_BUCKET;
  env.YOUTUBE_REDIRECT_URI =
    !hasValue(env.YOUTUBE_REDIRECT_URI) || isLocalValue(env.YOUTUBE_REDIRECT_URI)
      ? `${env.SOCIAL_CALLBACK_BASE_URL}/api/v1/social/youtube/oauth/callback`
      : env.YOUTUBE_REDIRECT_URI;
  env.YOUTUBE_SCOPES ||=
    'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl';

  const socialRedirects = {
    X_REDIRECT_URI: '/api/v1/social/x/oauth/callback',
    LINKEDIN_REDIRECT_URI: '/api/v1/social/linkedin/oauth/callback',
    META_REDIRECT_URI: '/api/v1/social/meta/oauth/callback',
    TIKTOK_REDIRECT_URI: '/api/v1/social/tiktok/oauth/callback',
  };
  for (const [name, routePath] of Object.entries(socialRedirects)) {
    if (!hasValue(env[name]) || isLocalValue(env[name])) {
      env[name] = `${env.SOCIAL_CALLBACK_BASE_URL}${routePath}`;
    }
  }

  if (!hasValue(env.MEDIA_RENDER_HMAC_SECRET)) {
    env.MEDIA_RENDER_HMAC_SECRET = crypto.randomBytes(32).toString('hex');
    console.log('Generated MEDIA_RENDER_HMAC_SECRET for this configuration run.');
  }

  return env;
}

function runCapture(command, args, options = {}) {
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const commandLine = needsShell ? wrapWindowsCommandLine([command, ...args].map(quoteWindowsArg).join(' ')) : '';
  const result = needsShell
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', commandLine], {
        cwd: ROOT_DIR,
        env: options.env ?? process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawnSync(command, args, {
    cwd: ROOT_DIR,
    env: options.env ?? process.env,
    encoding: 'utf8',
    shell: options.shell ?? needsShell,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    if (options.allowFailure) return result;
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    const stderr = result.stderr?.trim();
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed${stderr ? `\n${stderr}` : ''}`);
  }
  return result;
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

function getPathBasename(value) {
  return String(value ?? '').split('/').filter(Boolean).pop() ?? '';
}

function getNestedValue(object, paths) {
  for (const pathSegments of paths) {
    let cursor = object;
    for (const segment of pathSegments) {
      cursor = cursor?.[segment];
    }
    if (cursor !== undefined && cursor !== null) return cursor;
  }
  return undefined;
}

function normalizeFirebaseSdkConfig(rawConfig) {
  if (!rawConfig) return null;
  return {
    apiKey: rawConfig.apiKey,
    authDomain: rawConfig.authDomain,
    projectId: rawConfig.projectId,
    storageBucket: rawConfig.storageBucket,
    messagingSenderId: rawConfig.messagingSenderId,
    appId: rawConfig.appId,
    measurementId: rawConfig.measurementId,
    projectNumber: rawConfig.projectNumber,
  };
}

function parseFirebaseSdkConfig(output) {
  const parsed = parseJsonText(output);
  const configFromJson =
    parsed?.apiKey
      ? parsed
      : getNestedValue(parsed, [
          ['result', 'sdkConfig'],
          ['result', 'firebaseConfig'],
          ['sdkConfig'],
          ['firebaseConfig'],
          ['result'],
        ]);
  const normalized = normalizeFirebaseSdkConfig(configFromJson);
  if (normalized?.apiKey && normalized?.appId) return normalized;

  const text = String(output ?? '');
  const readField = (field) => {
    const match = text.match(new RegExp(`["']?${field}["']?\\s*[:=]\\s*["']([^"']+)["']`));
    return match?.[1] ?? '';
  };
  const regexConfig = normalizeFirebaseSdkConfig({
    apiKey: readField('apiKey'),
    authDomain: readField('authDomain'),
    projectId: readField('projectId'),
    storageBucket: readField('storageBucket'),
    messagingSenderId: readField('messagingSenderId'),
    appId: readField('appId'),
    measurementId: readField('measurementId'),
  });
  return regexConfig?.apiKey && regexConfig?.appId ? regexConfig : null;
}

function pickFirebaseWebApp(apps) {
  const candidates = Array.isArray(apps) ? apps : [];
  if (candidates.length === 1) return candidates[0];

  return (
    candidates.find((app) => /newleaf|admin/i.test(`${app.displayName ?? ''} ${app.name ?? ''}`)) ||
    candidates.find((app) => app.appId || app.appId === app.name) ||
    null
  );
}

function resolveFirebaseWebConfig(env, args) {
  const requiredNames = [
    'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'VITE_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_STORAGE_BUCKET',
    'VITE_FIREBASE_MESSAGING_SENDER_ID',
    'VITE_FIREBASE_APP_ID',
  ];
  if (requiredNames.every((name) => hasValue(env[name])) || args.skipFirebaseDiscovery) return;

  const firebaseCliBin = findExecutable('npx', [
    'C:\\Program Files\\nodejs\\npx.cmd',
    'C:\\Program Files (x86)\\nodejs\\npx.cmd',
    'C:\\nvm4w\\nodejs\\npx.cmd',
  ]) || findExecutable('npm', [
    'C:\\Program Files\\nodejs\\npm.cmd',
    'C:\\Program Files (x86)\\nodejs\\npm.cmd',
    'C:\\nvm4w\\nodejs\\npm.cmd',
  ]);
  if (!firebaseCliBin) {
    console.log('Firebase web config discovery skipped because npm/npx is not available.');
    return;
  }

  const projectId = env.VITE_FIREBASE_PROJECT_ID || env.FIREBASE_PROJECT_ID || env.GCP_PROJECT_ID;
  if (!hasValue(projectId)) return;

  let appId = env.VITE_FIREBASE_APP_ID || env.FIREBASE_WEB_APP_ID || env.FIREBASE_APP_ID || '';
  const shell = process.platform === 'win32' && /\.cmd$/i.test(firebaseCliBin);
  const isNpm = /(^|\\|\/)npm(\.cmd)?$/i.test(firebaseCliBin);
  const firebaseArgs = (...commandArgs) =>
    isNpm
      ? ['exec', '--yes', 'firebase-tools@latest', '--', ...commandArgs]
      : ['-y', 'firebase-tools@latest', ...commandArgs];

  if (!hasValue(appId)) {
    const listResult = runCapture(
      firebaseCliBin,
      firebaseArgs('apps:list', 'WEB', '--project', projectId, '--json'),
      { allowFailure: true, shell },
    );
    if (listResult.status === 0) {
      const parsed = parseJsonText(listResult.stdout);
      const apps = parsed?.result ?? parsed?.apps ?? [];
      const app = pickFirebaseWebApp(apps);
      appId = app?.appId || app?.name || '';
    }
  }

  if (!hasValue(appId)) {
    console.log('Firebase web config discovery skipped because no Firebase web app id could be found.');
    return;
  }

  const sdkResult = runCapture(
    firebaseCliBin,
    firebaseArgs('apps:sdkconfig', 'WEB', appId, '--project', projectId),
    { allowFailure: true, shell },
  );
  if (sdkResult.status !== 0) {
    console.log('Firebase web config discovery failed; required VITE_FIREBASE_* values must come from env.');
    return;
  }

  const config = parseFirebaseSdkConfig(sdkResult.stdout);
  if (!config) {
    console.log('Firebase web config discovery returned an unknown format; required VITE_FIREBASE_* values must come from env.');
    return;
  }

  env.VITE_FIREBASE_API_KEY ||= config.apiKey;
  env.VITE_FIREBASE_PROJECT_ID ||= config.projectId;
  env.VITE_FIREBASE_STORAGE_BUCKET ||= config.storageBucket;
  env.VITE_FIREBASE_MESSAGING_SENDER_ID ||= config.messagingSenderId;
  env.VITE_FIREBASE_APP_ID ||= config.appId;
  env.VITE_FIREBASE_MEASUREMENT_ID ||= config.measurementId;
  env.GCP_PROJECT_NUMBER ||= config.projectNumber;
  console.log('Loaded Firebase web app config through Firebase CLI.');
}

function resolveGcloudPath() {
  return findExecutable('gcloud', [
    'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
    'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
  ]);
}

function resolveProjectNumber(gcloudBin, projectId) {
  if (!hasValue(projectId)) return '';
  const result = runCapture(
    gcloudBin,
    ['projects', 'describe', projectId, '--format=value(projectNumber)'],
    { allowFailure: true },
  );
  return result.status === 0 ? result.stdout.trim() : '';
}

function resolveWorkloadIdentityProvider(env) {
  if (hasValue(env.GCP_WORKLOAD_IDENTITY_PROVIDER)) return;

  const gcloudBin = resolveGcloudPath();
  if (!gcloudBin) {
    console.log('Workload Identity provider discovery skipped because gcloud is not available.');
    return;
  }

  const projectId = env.GCP_PROJECT_ID || env.FIREBASE_PROJECT_ID;
  const projectNumber = env.GCP_PROJECT_NUMBER || resolveProjectNumber(gcloudBin, projectId);
  if (!hasValue(projectNumber)) {
    console.log('Workload Identity provider discovery skipped because the Google project number could not be resolved.');
    return;
  }

  const defaultPoolId = env.GCP_WORKLOAD_IDENTITY_POOL_ID || 'github';
  const defaultProviderId = env.GCP_WORKLOAD_IDENTITY_PROVIDER_ID || 'github-newleaf';

  if (hasValue(env.GCP_WORKLOAD_IDENTITY_POOL_ID) && hasValue(env.GCP_WORKLOAD_IDENTITY_PROVIDER_ID)) {
    env.GCP_WORKLOAD_IDENTITY_PROVIDER =
      `projects/${projectNumber}/locations/global/workloadIdentityPools/${env.GCP_WORKLOAD_IDENTITY_POOL_ID}` +
      `/providers/${env.GCP_WORKLOAD_IDENTITY_PROVIDER_ID}`;
    return;
  }

  const poolsResult = runCapture(
    gcloudBin,
    ['iam', 'workload-identity-pools', 'list', '--project', projectId, '--location=global', '--format=json'],
    { allowFailure: true },
  );
  if (poolsResult.status === 0) {
    const pools = parseJsonText(poolsResult.stdout) ?? [];
    for (const pool of pools) {
      const poolId = getPathBasename(pool.name);
      if (!poolId) continue;
      const providersResult = runCapture(
        gcloudBin,
        [
          'iam',
          'workload-identity-pools',
          'providers',
          'list',
          '--project',
          projectId,
          '--location=global',
          `--workload-identity-pool=${poolId}`,
          '--format=json',
        ],
        { allowFailure: true },
      );
      if (providersResult.status !== 0) continue;
      const providers = parseJsonText(providersResult.stdout) ?? [];
      const githubProvider = providers.find((provider) =>
        /token\.actions\.githubusercontent\.com/i.test(provider.oidc?.issuerUri ?? ''),
      );
      if (githubProvider?.name) {
        env.GCP_WORKLOAD_IDENTITY_PROVIDER = githubProvider.name;
        console.log('Discovered GitHub Workload Identity provider through gcloud.');
        return;
      }
    }
  } else {
    console.log('Workload Identity provider discovery failed while listing pools.');
  }

  env.GCP_WORKLOAD_IDENTITY_PROVIDER =
    `projects/${projectNumber}/locations/global/workloadIdentityPools/${defaultPoolId}/providers/${defaultProviderId}`;
  console.log('Using conventional GitHub Workload Identity provider path.');
}

function resolveDeployServiceAccount(env) {
  if (hasValue(env.GCP_SERVICE_ACCOUNT)) return;

  const projectId = env.GCP_PROJECT_ID || env.FIREBASE_PROJECT_ID;
  const gcloudBin = resolveGcloudPath();
  if (gcloudBin && hasValue(projectId)) {
    const result = runCapture(
      gcloudBin,
      ['iam', 'service-accounts', 'list', '--project', projectId, '--format=json'],
      { allowFailure: true },
    );
    if (result.status === 0) {
      const accounts = parseJsonText(result.stdout) ?? [];
      const account =
        accounts.find((item) => /github|deploy|firebase|newleaf/i.test(`${item.email ?? ''} ${item.displayName ?? ''}`)) ||
        accounts[0];
      if (account?.email) {
        env.GCP_SERVICE_ACCOUNT = account.email;
        console.log('Discovered Google deploy service account through gcloud.');
        return;
      }
    }
  }

  if (hasValue(projectId)) {
    env.GCP_SERVICE_ACCOUNT = `github-action-1228863292@${projectId}.iam.gserviceaccount.com`;
    console.log('Using conventional Google deploy service account email.');
  }
}

function findExecutable(name, candidates) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [name], { encoding: 'utf8', shell: process.platform === 'win32' });
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
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    env: options.env ?? process.env,
    encoding: 'utf8',
    shell: false,
    stdio: options.stdio ?? 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
}

function getRepo(ghBin, explicitRepo) {
  if (explicitRepo) return explicitRepo;
  const result = spawnSync(ghBin, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function assertNoLocalValues(env, allowLocalValues) {
  if (allowLocalValues) return;
  const localNames = [
    'PUBLIC_BASE_URL',
    'ADMIN_BASE_URL',
    'SOCIAL_CALLBACK_BASE_URL',
    'CORS_ALLOWED_ORIGINS',
    'YOUTUBE_REDIRECT_URI',
  ].filter((name) => isLocalValue(env[name]));
  if (localNames.length > 0) {
    throw new Error(`Refusing to push local URL values: ${localNames.join(', ')}`);
  }
}

function assertNoPlatformHostedDomains(env) {
  const publicDomainNames = [
    'PUBLIC_BASE_URL',
    'ADMIN_BASE_URL',
    'SOCIAL_CALLBACK_BASE_URL',
    'CORS_ALLOWED_ORIGINS',
    'VITE_API_BASE_URL',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'HEYGEN_CALLBACK_URL',
    'YOUTUBE_REDIRECT_URI',
    'X_REDIRECT_URI',
    'LINKEDIN_REDIRECT_URI',
    'META_REDIRECT_URI',
    'TIKTOK_REDIRECT_URI',
  ].filter((name) => isPlatformHostedValue(env[name]));

  if (publicDomainNames.length > 0) {
    throw new Error(
      `Refusing to push Firebase/Google platform-hosted public domains: ${publicDomainNames.join(', ')}. ` +
      'Use api.newleafsystem.com, admin.newleafsystem.com, or another approved newleafsystem.com custom domain.',
    );
  }
}

function secretHasValue(env, name) {
  return hasValue(env[name]);
}

function validateGithubDeploymentConfig(env) {
  const missingVariables = REQUIRED_REPO_VARIABLE_NAMES.filter((name) => !hasValue(env[name]));
  const missingSecrets = REQUIRED_REPO_SECRET_NAMES.filter((name) => !secretHasValue(env, name));

  if (hasValue(env.YOUTUBE_CLIENT_ID) && !secretHasValue(env, 'YOUTUBE_CLIENT_SECRET')) {
    missingSecrets.push('YOUTUBE_CLIENT_SECRET');
  }

  if (missingVariables.length || missingSecrets.length) {
    const details = [];
    if (missingVariables.length) details.push(`repository variables: ${missingVariables.join(', ')}`);
    if (missingSecrets.length) details.push(`repository secrets: ${missingSecrets.join(', ')}`);
    throw new Error(
      [
        'Missing required deployment configuration for GitHub Actions.',
        details.join(' | '),
        'The bootstrap can derive some values from Firebase CLI and gcloud, but these remaining values are not available.',
      ].join(' '),
    );
  }
}

function configureGithub({ args, env }) {
  const ghBin = findExecutable('gh', [
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
  ]);
  if (!ghBin) throw new Error("GitHub CLI 'gh' is not installed.");
  const repo = getRepo(ghBin, args.repo);
  if (!repo) throw new Error('GitHub repo is required. Pass --repo owner/repo.');

  if (!args.dryRun) {
    const authStatus = spawnSync(ghBin, ['auth', 'status'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (authStatus.status !== 0) {
      throw new Error('GitHub CLI is not authenticated. Run "gh auth login" once, then rerun this command.');
    }
  }

  console.log(`Configuring GitHub Actions for ${repo}`);
  for (const name of REPO_VARIABLE_NAMES) {
    if (!hasValue(env[name])) {
      console.log(`Skipping empty repository variable: ${name}`);
      continue;
    }
    if (args.dryRun) {
      console.log(`DRY RUN: would set repository variable ${name}`);
      continue;
    }
    run(ghBin, ['variable', 'set', name, '--repo', repo, '--body', env[name]], { stdio: 'ignore' });
    console.log(`Set repository variable ${name}`);
  }

  for (const name of REPO_SECRET_NAMES) {
    if (!hasValue(env[name])) {
      console.log(`Skipping empty secret: ${name}`);
      continue;
    }
    if (args.dryRun) {
      console.log(`DRY RUN: would set secret ${name}`);
      continue;
    }
    run(ghBin, ['secret', 'set', name, '--repo', repo, '--body', env[name]], { stdio: 'ignore' });
    console.log(`Set secret ${name}`);
  }
}

function syncGoogle({ args, env, envFile }) {
  const googleArgs = ['scripts/sync-google-cloud-env.js', '--env-file', envFile];
  if (args.dryRun) googleArgs.push('--dry-run');
  if (args.updateCloudRun) googleArgs.push('--update-cloud-run');
  if (args.allowLocalValues) googleArgs.push('--allow-local-values');
  if (args.skipEnableApis) googleArgs.push('--skip-enable-apis');

  const gcloudBin = resolveGcloudPath();
  const childEnv = { ...process.env, ...env };
  if (gcloudBin) {
    childEnv.GCLOUD_BIN = gcloudBin;
  }

  console.log('Syncing Google Secret Manager and Cloud Run runtime config...');
  run(process.execPath, googleArgs, { env: childEnv });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = path.resolve(ROOT_DIR, args.envFile);
  if (!existsSync(envFile)) throw new Error(`Env file not found: ${envFile}`);
  const env = buildEnvValues(parseEnvFile(envFile));
  resolveFirebaseWebConfig(env, args);
  resolveDeployServiceAccount(env);
  resolveWorkloadIdentityProvider(env);
  assertNoLocalValues(env, args.allowLocalValues);
  assertNoPlatformHostedDomains(env);
  if (!args.skipGithub) validateGithubDeploymentConfig(env);

  console.log(`Using env file: ${envFile}`);
  if (!args.skipGithub) configureGithub({ args, env });
  else console.log('Skipping GitHub Actions configuration.');
  if (!args.skipGoogle) syncGoogle({ args, env, envFile });
  else console.log('Skipping Google configuration sync.');
  console.log('Deployment configuration bootstrap complete.');
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
