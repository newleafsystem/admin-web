import { existsSync } from 'node:fs';
import path from 'node:path';

loadLocalEnv();

function readBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readOptionalString(name) {
  const value = process.env[name]?.trim();
  return value || null;
}

function readStringList(name, fallback) {
  return (process.env[name] ?? fallback)
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: readNumber('PORT', 8080),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080',
  adminBaseUrl: process.env.ADMIN_BASE_URL ?? 'http://localhost:5173',
  auth: {
    requireAuth: readBoolean('REQUIRE_AUTH', false),
    adminEmails: readStringList('AUTH_ADMIN_EMAILS', '').map((email) => email.toLowerCase()),
  },
  serviceApi: {
    keyHashes: readStringList('SERVICE_API_KEY_HASHES', ''),
    rateLimitPerMinute: readNumber('SERVICE_API_RATE_LIMIT_PER_MINUTE', 20),
    signatureToleranceSec: readNumber('SERVICE_API_SIGNATURE_TOLERANCE_SEC', 300),
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID ?? null,
    firestoreDatabaseId: readOptionalString('FIRESTORE_DATABASE_ID') ?? '(default)',
    credentialsJson: process.env.FIREBASE_CREDENTIALS_JSON ?? null,
    useApplicationDefault: readBoolean('FIREBASE_USE_APPLICATION_DEFAULT', false),
    disabled: readBoolean('FIREBASE_ADMIN_DISABLED', false),
  },
  repository: {
    provider: readOptionalString('REPOSITORY_PROVIDER') ?? 'local',
    firestoreCollectionPrefix: readOptionalString('FIRESTORE_COLLECTION_PREFIX') ?? '',
  },
  heygen: {
    apiKey: process.env.HEYGEN_API_KEY ?? null,
    apiBaseUrl: process.env.HEYGEN_API_BASE_URL ?? 'https://api.heygen.com',
    callbackUrl: readOptionalString('HEYGEN_CALLBACK_URL'),
    webhookSecret: process.env.HEYGEN_WEBHOOK_SECRET ?? null,
    signatureHeader: process.env.HEYGEN_SIGNATURE_HEADER ?? 'signature',
    timestampHeader: process.env.HEYGEN_TIMESTAMP_HEADER ?? 'x-heygen-timestamp',
  },
  videoAssembler: {
    storageDir: readOptionalString('VIDEO_STORAGE_DIR') ?? path.join(process.env.LOCAL_DATA_DIR ?? '.local-data', 'video-assembler'),
    ffmpegPath: readOptionalString('FFMPEG_PATH'),
    ffprobePath: readOptionalString('FFPROBE_PATH'),
    fontFile: readOptionalString('FFMPEG_FONT_FILE'),
  },
  storage: {
    bucket: readOptionalString('GCS_BUCKET'),
  },
  ai: {
    provider: readOptionalString('AI_PROVIDER') ?? (readOptionalString('OPENAI_API_KEY') ? 'openai' : null),
    apiKey: readOptionalString('AI_API_KEY') ?? readOptionalString('OPENAI_API_KEY'),
    model: readOptionalString('AI_MODEL'),
    baseUrl: readOptionalString('AI_BASE_URL'),
    transcriptionModel: readOptionalString('AI_TRANSCRIPTION_MODEL') ?? readOptionalString('OPENAI_TRANSCRIPTION_MODEL'),
    transcriptionBaseUrl:
      readOptionalString('AI_TRANSCRIPTION_BASE_URL') ?? readOptionalString('OPENAI_TRANSCRIPTION_BASE_URL'),
    maxTranscriptionBytes: readNumber('AI_MAX_TRANSCRIPTION_BYTES', 25 * 1024 * 1024),
  },
  localDataDir: process.env.LOCAL_DATA_DIR ?? '.local-data',
  social: {
    callbackBaseUrl: process.env.SOCIAL_CALLBACK_BASE_URL ?? 'http://localhost:8080',
    accountsConfigPath: readOptionalString('SOCIAL_ACCOUNTS_CONFIG_PATH'),
    publisherEnabledPlatforms: readStringList('SOCIAL_PUBLISH_ENABLED_PLATFORMS', 'youtube x linkedin instagram facebook'),
    autoResumeQueuedUploads: readBoolean('SOCIAL_AUTO_RESUME_QUEUED_UPLOADS', true),
    publisherStatusMaxPolls: readNumber('SOCIAL_PUBLISH_STATUS_MAX_POLLS', 20),
  },
  cors: {
    allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173 http://127.0.0.1:5173')
      .split(/\s+/)
      .filter(Boolean),
  },
  youtube: {
    clientId: process.env.YOUTUBE_CLIENT_ID ?? null,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET ?? null,
    redirectUri:
      process.env.YOUTUBE_REDIRECT_URI ??
      `${process.env.SOCIAL_CALLBACK_BASE_URL ?? 'http://localhost:8080'}/api/v1/social/youtube/oauth/callback`,
    scopes: (
      process.env.YOUTUBE_SCOPES ??
      'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl'
    )
      .split(/\s+/)
      .filter(Boolean),
    uploadChunkBytes: readNumber('YOUTUBE_UPLOAD_CHUNK_BYTES', 8 * 1024 * 1024),
    defaultPrivacyStatus: process.env.YOUTUBE_DEFAULT_PRIVACY_STATUS ?? 'private',
    defaultCategoryId: process.env.YOUTUBE_DEFAULT_CATEGORY_ID ?? '22',
    autoResumeQueuedUploads: readBoolean('YOUTUBE_AUTO_RESUME_QUEUED_UPLOADS', true),
  },
  x: {
    clientId: readOptionalString('X_CLIENT_ID'),
    clientSecret: readOptionalString('X_CLIENT_SECRET'),
    redirectUri:
      readOptionalString('X_REDIRECT_URI') ??
      `${process.env.SOCIAL_CALLBACK_BASE_URL ?? 'http://localhost:8080'}/api/v1/social/x/oauth/callback`,
    scopes: readStringList('X_SCOPES', 'tweet.read users.read tweet.write media.write offline.access'),
    uploadChunkBytes: readNumber('X_UPLOAD_CHUNK_BYTES', 4 * 1024 * 1024),
  },
  linkedin: {
    clientId: readOptionalString('LINKEDIN_CLIENT_ID'),
    clientSecret: readOptionalString('LINKEDIN_CLIENT_SECRET'),
    redirectUri:
      readOptionalString('LINKEDIN_REDIRECT_URI') ??
      `${process.env.SOCIAL_CALLBACK_BASE_URL ?? 'http://localhost:8080'}/api/v1/social/linkedin/oauth/callback`,
    scopes: readStringList('LINKEDIN_SCOPES', 'openid profile email w_member_social r_organization_social'),
    apiVersion: readOptionalString('LINKEDIN_API_VERSION') ?? '202604',
  },
  meta: {
    appId: readOptionalString('META_APP_ID'),
    appSecret: readOptionalString('META_APP_SECRET'),
    redirectUri:
      readOptionalString('META_REDIRECT_URI') ??
      `${process.env.SOCIAL_CALLBACK_BASE_URL ?? 'http://localhost:8080'}/api/v1/social/meta/oauth/callback`,
    graphVersion: readOptionalString('META_GRAPH_VERSION') ?? 'v21.0',
    facebookScopes: readStringList('META_FACEBOOK_SCOPES', 'pages_show_list pages_manage_posts pages_read_engagement'),
    instagramScopes: readStringList(
      'META_INSTAGRAM_SCOPES',
      'pages_show_list pages_read_engagement instagram_basic instagram_content_publish',
    ),
  },
});

export function isProduction() {
  return config.nodeEnv === 'production';
}

function loadLocalEnv() {
  if (process.env.NEWLEAF_SKIP_DOTENV === '1') {
    return;
  }

  for (const envPath of candidateEnvPaths()) {
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath);
      return;
    }
  }
}

function candidateEnvPaths() {
  const cwd = process.cwd();
  return [
    path.resolve(cwd, '.env'),
    path.resolve(cwd, '..', '.env'),
    path.resolve(cwd, '..', '..', '.env'),
  ];
}
