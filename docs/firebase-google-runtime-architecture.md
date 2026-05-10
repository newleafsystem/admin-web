# Firebase And Google Cloud Runtime Architecture

NewLeaf production deployment is now Firebase/Google-first. Cloudflare should not be used for DNS, Worker routing, R2, KV, D1, or Queues in the active production path.

## Runtime Split

```text
names.co.uk DNS
  -> Firebase Hosting
    -> static Vite admin UI from apps/admin/dist
    -> optional /api/** rewrite to Cloud Run service newleaf-api
  -> Cloud Run API
    -> api.newleafsystem.com for browser auth, provider OAuth, service API, admin API, publishing orchestration
  -> Cloud Run media renderer
    -> FFmpeg execution
  -> Firebase Storage / Google Cloud Storage
    -> uploaded media, generated clips, rendered exports, thumbnails
  -> Google Secret Manager
    -> OAuth secrets, API keys, renderer HMAC secret, token encryption keys
  -> Firestore
    -> canonical job, account, audit, and publishing state
```

## DNS

Keep authoritative DNS at names.co.uk.

Use Firebase Hosting custom domain setup for:

- `admin.newleafsystem.com`

Use a direct Cloud Run API custom domain for:

- `api.newleafsystem.com`

Both admin-web and client-web should use `api.newleafsystem.com` for shared browser authentication. Firebase Hosting rewrites for `/api/**` may remain as a compatibility path for the admin UI, but the canonical API origin is the Cloud Run custom domain.

Required browser-auth runtime values:

```text
PUBLIC_BASE_URL=https://api.newleafsystem.com
ADMIN_BASE_URL=https://admin.newleafsystem.com
SOCIAL_CALLBACK_BASE_URL=https://api.newleafsystem.com
CORS_ALLOWED_ORIGINS=https://admin.newleafsystem.com https://newleafsystem.com https://www.newleafsystem.com https://preview.newleafsystem.com
AUTH_SESSION_COOKIE_DOMAIN=.newleafsystem.com
AUTH_SESSION_COOKIE_PATH=/
AUTH_SESSION_COOKIE_SAME_SITE=lax
AUTH_SESSION_COOKIE_SECURE=true
```

## Active Deploy Commands

Pushes to `main` deploy Firebase Hosting through `.github/workflows/firebase-production.yml`
and deploy the Cloud Run API plus renderer through `.github/workflows/google-cloud-run.yml`.
Use the Cloud Run workflow's manual dispatch controls when you need to redeploy only one
service.

```bash
npm run firebase:deploy:hosting
ENV_FILE=.env.production npm run gcp:setup-renderer
ENV_FILE=.env.production npm run gcp:setup-api
npm run gcp:sync-env:prod:update
```

Use `.env.example` for local development and `.env.production.example` as the production template. Do not push local `localhost` values to Cloud Run.

## Cloud Run Services

### API

`services/api/Dockerfile` packages `apps/api` for Cloud Run. It currently includes FFmpeg so the existing local Video Studio render path does not break during the migration.

The first Cloud Run API deployment keeps the existing Express route surface. It is the migration bridge away from local development and away from Cloudflare.

### Media Renderer

`services/media-renderer` packages FFmpeg and reads/writes media using Google Cloud Storage. The API-to-renderer request is signed with `MEDIA_RENDER_HMAC_SECRET`.

## Storage

Use Firebase Storage / Google Cloud Storage for media. Preferred object layout:

```text
uploads/{ownerUserId}/{projectId}/{assetId}/{filename}
renders/{ownerUserId}/{projectId}/{jobId}/output.mp4
thumbnails/{ownerUserId}/{projectId}/{assetId}/thumb.jpg
audit/YYYY/MM/DD/{eventId}.json
tmp/{jobId}/{filename}
```

Do not allow raw user-provided paths to become object keys.

## Secrets

Use Google Secret Manager for:

- `HEYGEN_API_KEY`
- `OPENAI_API_KEY` or `AI_API_KEY`
- OAuth client secrets
- `MEDIA_RENDER_HMAC_SECRET`
- `SERVICE_API_KEY_HASHES`
- `TOKEN_ENCRYPTION_KEY`

Do not store raw secrets in Firestore, Storage, or logs.

## Current Migration State

Completed:

- Firebase Hosting is the admin UI deployment target.
- Firebase Hosting rewrites `/api/**` to Cloud Run service `newleaf-api`.
- Cloud Run API Docker build scaffolding exists.
- Cloud Run API selects the Firestore repository with `REPOSITORY_PROVIDER=firestore`.
- Cloud Run FFmpeg renderer uses Google Cloud Storage.
- Legacy edge-runtime workflows and active npm scripts have been removed.

Still pending before production hardening:

- Move Video Studio uploads and rendered outputs from local disk to Firebase Storage.
- Replace the temporary in-process API FFmpeg fallback with API-to-renderer Cloud Run calls for production render jobs.
- Add Cloud Tasks or Pub/Sub for long-running async jobs.
- Add Firebase Auth or verified Google identity enforcement for admin routes.
