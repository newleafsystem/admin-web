# NewLeaf API Platform

NewLeaf API Platform is an API-first content generation, review, and social publishing system. It supports video and document intake, AI-assisted review, video generation workflows, connected social accounts, multi-channel publishing, and an admin console for operational control.

The project is built as a local-first Node.js and React workspace, with a clear path toward Firebase Hosting, Google Cloud Run, Google Secret Manager, queue workers, and provider webhooks.

## What It Does

- Create content jobs from local video uploads, YouTube embeds, and text prompts.
- Generate scripts and videos through provider-backed workflows such as HeyGen.
- Review videos in an admin UI with video playback and GPT-powered summaries.
- Upload or generate video thumbnails for review and publishing preparation.
- Edit and render short walkthrough videos with the Video Studio timeline editor.
- Approve content before publishing.
- Publish approved videos to connected social channels.
- Track upload progress per channel.
- Assemble ordered multi-clip HeyGen videos from a manifest-driven timeline.
- Manage published records, including visibility, deletes, hashtags, and provider URLs.
- Sync existing social channel videos into the Published Videos library, even when they were not uploaded by this app.
- Connect and reconnect social accounts through OAuth flows.

## Current Platform Support

| Platform | Account Connection | Publishing | Delete | Notes |
| --- | --- | --- | --- | --- |
| YouTube | Google OAuth | Resumable upload | Provider delete wired | Supports privacy updates, channel sync, tags, hashtags |
| X / Twitter | OAuth scaffold | Video upload worker wired | Post delete wired | Channel sync wired; requires X API access and sufficient credits |
| LinkedIn | OAuth scaffold | Video post worker wired | Post delete wired | Channel sync wired; requires member/page permissions |
| Facebook | Meta OAuth scaffold | Page video worker wired | Video delete wired | Channel sync wired; requires Meta app permissions and Page access |
| Instagram | Meta OAuth scaffold | Reels/media container worker wired | Media delete wired | Channel sync wired; requires professional Instagram account and public video URL |
| TikTok | Placeholder | Not enabled by default | Not wired | Future adapter |

Provider access depends on your own developer apps, OAuth scopes, app review status, quota, and billing.

## Architecture

```text
React Admin UI
  -> Node.js API Gateway / BFF
    -> Repository abstraction
      -> local .local-data in development
      -> Firestore in Cloud Run production
    -> Assets service
    -> AI review service
    -> HeyGen service
    -> Social OAuth services
    -> Social publisher service
      -> YouTube publisher
      -> X publisher
      -> LinkedIn publisher
      -> Facebook publisher
      -> Instagram publisher
```

The admin UI never calls vendor APIs directly. The backend owns credentials, OAuth tokens, provider requests, retries, polling, webhooks, publishing state, and audit metadata.

## Repository Layout

```text
apps/
  api/        Node.js Express API, routes, services, local repository
  admin/      React + Vite admin operations console

packages/
  publishers/ Shared publisher adapter package and placeholders

docs/
  architecture, OAuth, implementation, and agentic AI docs

infra/
  Firebase and Google Cloud deployment placeholders
```

## Requirements

- Node.js 20 or newer
- npm
- Provider accounts only for the integrations you want to test

For local-only YouTube testing, you need:

- Google Cloud project
- YouTube Data API v3 enabled
- OAuth web client
- Redirect URI: `http://localhost:8080/api/v1/social/youtube/oauth/callback`

## Local Setup

Install dependencies:

```bash
npm install
```

Create local environment:

```bash
copy .env.example .env
```

Fill only the provider values you are actively testing. Do not commit `.env`.

Start both the API and admin UI:

```bash
npm run dev
```

Equivalent explicit command:

```bash
npm run dev:start
```

Restart both dev servers:

```bash
npm run dev:restart
```

Stop both dev servers:

```bash
npm run dev:stop
```

The dev scripts start hidden Node processes and write process state/logs under `.dev-logs/`.

You can still start each server separately when needed.

Start only the API:

```bash
npm run dev:api
```

Start only the admin UI:

```bash
npm run dev:admin
```

Open:

```text
http://localhost:5173
```

The API defaults to:

```text
http://localhost:8080/api/v1
```

### Local, Production, And Hybrid API Targets

Use three separate modes intentionally.

**Full local development**

Use this when changing backend or frontend code locally:

```env
PUBLIC_BASE_URL=http://localhost:8080
ADMIN_BASE_URL=http://localhost:5173
VITE_API_BASE_URL=http://localhost:8080/api/v1
SOCIAL_CALLBACK_BASE_URL=http://localhost:8080
CORS_ALLOWED_ORIGINS=http://localhost:5173 http://127.0.0.1:5173
REPOSITORY_PROVIDER=local
```

Run:

```bash
npm run dev:start
```

**Firebase production**

In production, the browser should not call `localhost:8080`. Firebase Hosting serves the admin app and rewrites `/api/**` to Cloud Run:

```env
PUBLIC_BASE_URL=https://admin.newleafsystem.com
ADMIN_BASE_URL=https://admin.newleafsystem.com
VITE_API_BASE_URL=/api/v1
SOCIAL_CALLBACK_BASE_URL=https://admin.newleafsystem.com
CORS_ALLOWED_ORIGINS=https://admin.newleafsystem.com
REPOSITORY_PROVIDER=firestore
```

This keeps browser API calls same-origin through Firebase Hosting.

The `npm run firebase:build` command forces `VITE_API_BASE_URL=/api/v1` unless you deliberately override it, so local `.env` values cannot accidentally ship a bundle that calls `localhost:8080`.

**Hybrid local UI against production API**

This is possible for smoke testing, but it should not be the default because it can create or mutate real production jobs, OAuth state, provider records, and publish attempts.

Use it only when you intentionally want your local Vite UI to call the deployed API:

```env
VITE_API_BASE_URL=https://admin.newleafsystem.com/api/v1
```

For this to work, the deployed API must allow the local Vite origin in `CORS_ALLOWED_ORIGINS`, and production auth must be configured correctly. Do not use this mode for destructive publishing, OAuth reconnects, or delete flows unless you are deliberately testing production.

## Environment Variables

Use `.env.example` as the source of truth for local values and `.env.production.example` as the source of truth for deployment values. Keep the real `.env` and `.env.production` files uncommitted.

Important groups:

- Runtime: `PORT`, `PUBLIC_BASE_URL`, `ADMIN_BASE_URL`, `CORS_ALLOWED_ORIGINS`
- AI review: `AI_PROVIDER`, `OPENAI_API_KEY`, `AI_MODEL`, `AI_TRANSCRIPTION_MODEL`
- YouTube: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`, `YOUTUBE_SCOPES`
- X: `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`, `X_SCOPES`
- LinkedIn: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`
- Meta: `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`
- HeyGen: `HEYGEN_API_KEY`, `HEYGEN_WEBHOOK_SECRET`
- FFmpeg render: `FFMPEG_PATH`, `FFPROBE_PATH`, `FFMPEG_FONT_FILE`
- Local persistence: `LOCAL_DATA_DIR`

Recommended files:

```bash
copy .env.example .env
copy .env.production.example .env.production
```

Use `.env` for `npm run dev:start`. Use `.env.production` only for deployment sync/setup commands.

## Firebase And Google Cloud Deployment

Production is now intended to run without Cloudflare in the request path.

```text
names.co.uk DNS
  -> Firebase Hosting: admin.newleafsystem.com
  -> Firebase Hosting /api rewrite
  -> Cloud Run API: newleaf-api
  -> Cloud Run FFmpeg renderer: newleaf-ffmpeg-renderer
  -> Firebase Storage / Google Cloud Storage for media
  -> Google Secret Manager for secrets
```

Firebase Hosting serves the Vite admin UI from `apps/admin/dist`. The hosting config rewrites `/api/**` to the `newleaf-api` Cloud Run service in `us-central1`, so the admin UI can keep using same-origin `/api/v1` calls in production.

Required DNS at names.co.uk:

- `admin.newleafsystem.com` records provided by Firebase Hosting custom domain setup.
- Optional `api.newleafsystem.com` records if you also map a direct Cloud Run custom domain for the API.

Required GitHub secrets and variables:

- `FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING` for Firebase Hosting deploys.
- `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT` for the Cloud Run deploy workflow.
- `MEDIA_RENDER_HMAC_SECRET` for API-to-renderer signing.
- `GCP_PROJECT_ID=newleaf-trading`
- `GCP_REGION=us-central1`
- `GOOGLE_CLOUD_RUN_API_SERVICE=newleaf-api`
- `GOOGLE_CLOUD_RUN_RENDERER_SERVICE=newleaf-ffmpeg-renderer`
- `GCS_BUCKET=<firebase-storage-bucket>`
- `SKIP_ENABLE_APIS=true`
- `SKIP_PROVISIONING=true`
- `CLOUD_BUILD_SUPPRESS_LOGS=true`
- `REQUIRE_AUTH=true`
- `FIRESTORE_DATABASE_ID=newleafdb`
- `PUBLIC_BASE_URL=https://admin.newleafsystem.com`
- `ADMIN_BASE_URL=https://admin.newleafsystem.com`
- `SOCIAL_CALLBACK_BASE_URL=https://admin.newleafsystem.com`
- `CORS_ALLOWED_ORIGINS=https://admin.newleafsystem.com`

You can push the repository variables and deployment secrets with GitHub CLI:

```bash
ENV_FILE=.env.production npm run github:setup-actions -- --repo <github-owner>/<repo-name>
```

Run a dry run first:

```bash
ENV_FILE=.env.production npm run github:setup-actions -- --repo <github-owner>/<repo-name> --dry-run
```

The script sets repository variables and these secrets: `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, `MEDIA_RENDER_HMAC_SECRET`, and `FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING` when `FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING_FILE` or `FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING` is provided. It does not print secret values.

Sync production secrets and runtime values from `.env.production` to Google Secret Manager:

```bash
npm run gcp:sync-env:prod
```

This reads `.env.production`, creates or updates the populated NewLeaf Secret Manager secrets, and does not print secret values. To also update existing Cloud Run services with non-secret runtime env vars and Secret Manager bindings:

```bash
npm run gcp:sync-env:prod:update
```

Secret sync can use either `gcloud` authentication or Google Application Default Credentials through `GOOGLE_APPLICATION_CREDENTIALS`. Updating Cloud Run service env vars still requires the Google Cloud CLI.

Run a preview first:

```bash
npm run gcp:sync-env:prod:update -- --dry-run
```

The sync script refuses to push `localhost` or `127.0.0.1` URLs to Cloud Run unless you pass `--allow-local-values`, so set production URLs before updating deployed services.

Deploy lifecycle:

- Pull requests create Firebase Hosting preview channels through `.github/workflows/firebase-hosting-pull-request.yml`.
- `main` deploys Firebase Hosting production through `.github/workflows/firebase-production.yml`.
- `main` deploys Cloud Run API only when API-related files change through `.github/workflows/google-cloud-run.yml`.
- `main` deploys the FFmpeg renderer only when `services/media-renderer/` or its deploy script changes.
- Cloud Run deployments can still be run manually from `.github/workflows/google-cloud-run.yml` or local scripts when you need a selective API or renderer rollout.
- CodeQL scans JavaScript/TypeScript through `.github/workflows/codeql.yml`.

Deploy Firebase Hosting locally:

```bash
npm run firebase:deploy:hosting
```

Deploy the Cloud Run API from production values:

```bash
ENV_FILE=.env.production npm run gcp:setup-api
```

PowerShell equivalent:

```powershell
$env:ENV_FILE=".env.production"; npm run gcp:setup-api
```

Deploy the Cloud Run FFmpeg renderer from production values:

```bash
ENV_FILE=.env.production npm run gcp:setup-renderer
```

PowerShell equivalent:

```powershell
$env:ENV_FILE=".env.production"; npm run gcp:setup-renderer
```

Routine CI deploys default to `SKIP_ENABLE_APIS=true`, `SKIP_PROVISIONING=true`, and `CLOUD_BUILD_SUPPRESS_LOGS=true`. That means GitHub Actions deploys existing Cloud Run services and does not try to enable APIs, create service accounts, update IAM bindings, create Secret Manager secrets, or stream Cloud Build logs requiring broad project Viewer access on every push. Do one-time provisioning from an owner/admin account only:

```bash
ENV_FILE=.env.production SKIP_ENABLE_APIS=false SKIP_PROVISIONING=false npm run gcp:setup-renderer
ENV_FILE=.env.production SKIP_ENABLE_APIS=false SKIP_PROVISIONING=false npm run gcp:setup-api
```

Both setup scripts load `.env` automatically. Existing shell variables override `.env` values when you need to temporarily change a deploy value.

Production secrets should live in Google Secret Manager. Firestore stores account metadata and secret references; raw refresh tokens should not be stored as plain Firestore fields in a hardened production setup.

## Common Commands

Run workspace checks:

```bash
npm run check
```

Build the admin UI:

```bash
npm run build -w @newleaf/admin
```

Run all available tests/checks:

```bash
npm test
```

Assemble local video clips from a manifest:

```bash
npm run assemble:video -- <path-to-manifest.json>
```

This requires FFmpeg in your `PATH` and completed clip files at the manifest `localFilePath` values.

Render a Video Studio timeline:

```bash
npm run render:timeline -- <path-to-timeline.json>
```

This requires FFmpeg in your `PATH` and local source files at the timeline `tracks[].source` values.

Check whether a manifest is ready to stitch:

```bash
npm run check:project-ready -- <path-to-manifest.json>
```

## Main Workflows

### 1. Connect Accounts

Use the Accounts page to start OAuth for a provider. The backend creates OAuth state, redirects to the provider, exchanges the callback code, and stores account metadata plus a local secret reference.

YouTube is the most complete connection flow today.

### 2. Create Content

Use Create Content to create a job from:

- uploaded local video;
- YouTube embed URL;
- text prompt for HeyGen generation.

Local uploads are stored in local development storage under the configured local data directory.

### 3. Review Content

Use Review to preview the video and generate an AI review summary. Text-to-HeyGen review scripts can be edited before regenerating the video, so admins can paste a GPT or Claude draft and render from that exact script. Local videos can be transcribed when the configured AI transcription model supports the file size and MIME type.

### 4. Publish Content

Use Content Queue -> Publishing Controls.

Before creating a publish plan, each video requires:

- title;
- description;
- selected destination platforms.

Optional metadata:

- hashtags for all platforms;
- YouTube metadata tags;
- AI-generated YouTube tags.

The API enforces title and description before plan creation and again before publishing.

### 5. Track Publishing Progress

Use Content Queue -> Media And Upload Status to see per-channel progress for queued, uploading, processing, published, failed, and deleted attempts.

### 6. Manage Published Videos

Use Published Videos to:

- view active platform records as video cards;
- open provider URLs;
- update visibility where supported;
- delete from a channel;
- delete from all channels for a job;
- view deleted records through filters;
- sync existing supported channel videos into the library from each platform section.

## API Highlights

Jobs:

```text
POST /api/v1/jobs
GET  /api/v1/jobs
GET  /api/v1/jobs/:jobId
POST /api/v1/jobs/:jobId/generate-video
POST /api/v1/jobs/:jobId/regenerate-video
POST /api/v1/jobs/:jobId/provider-jobs/:providerJobId/poll
POST /api/v1/jobs/:jobId/video-assembly/segments/:heygenVideoId/complete
POST /api/v1/jobs/:jobId/generate-summary
POST /api/v1/jobs/:jobId/thumbnail/upload
POST /api/v1/jobs/:jobId/thumbnail/generate
POST /api/v1/jobs/:jobId/approve
```

Publishing:

```text
GET  /api/v1/publish-plans
POST /api/v1/publish-plans
POST /api/v1/publish-plans/generate-youtube-tags
POST /api/v1/publish-plans/:planId/approve
POST /api/v1/publish-plans/:planId/publish
POST /api/v1/publish-attempts/:attemptId/retry
GET  /api/v1/publications
PATCH /api/v1/publications/:attemptId
POST /api/v1/publications/:attemptId/delete
POST /api/v1/publications/delete
POST /api/v1/publications/import/youtube
POST /api/v1/publications/import/:platform
```

Social accounts:

```text
GET    /api/v1/social/accounts
POST   /api/v1/social/:platform/oauth/start
GET    /api/v1/social/:platform/oauth/callback
POST   /api/v1/social/accounts/:accountId/reconnect
DELETE /api/v1/social/accounts/:accountId
```

Assets:

```text
POST /api/v1/assets/local-upload
GET  /api/v1/assets/:artifactId/content
```

Video Studio:

```text
POST /api/v1/video-projects
DELETE /api/v1/video-projects/:projectId
GET  /api/v1/video-projects/:projectId/timeline
PUT  /api/v1/video-projects/:projectId/timeline
POST /api/v1/video-projects/:projectId/assets
DELETE /api/v1/video-projects/:projectId/assets/:trackId
POST /api/v1/video-projects/:projectId/render
GET  /api/v1/video-projects/:projectId/status
GET  /api/v1/video-projects/:projectId/output
```

Webhooks:

```text
POST /api/v1/webhooks/heygen
POST /api/v1/webhooks/social/:platform
```

## Documentation

- [AGENTS.md](AGENTS.md): operating guide for AI coding agents.
- [docs/architecture-flows.md](docs/architecture-flows.md): current architecture and workflow flows.
- [docs/implementation-patterns.md](docs/implementation-patterns.md): route, service, repository, provider, and admin UI patterns.
- [docs/firebase-google-runtime-architecture.md](docs/firebase-google-runtime-architecture.md): Firebase Hosting, Cloud Run, Storage, Secret Manager production direction.
- [docs/google-cloud-run-media-renderer.md](docs/google-cloud-run-media-renderer.md): FFmpeg renderer deployment on Google Cloud Run.
- [docs/video-assembler.md](docs/video-assembler.md): manifest-driven multi-clip video assembly with FFmpeg.
- [docs/agentic-ai-skills.md](docs/agentic-ai-skills.md): reusable agent skills and multi-agent task splitting guidance.
- [docs/end-to-end-api-solution.md](docs/end-to-end-api-solution.md): full product architecture.
- [docs/mvp-implementation-plan.md](docs/mvp-implementation-plan.md): phased MVP plan.
- [docs/social-channel-secrets.md](docs/social-channel-secrets.md): secret and connected-account model.
- [docs/service-api.md](docs/service-api.md): signed vendor API usage.
- [docs/service-api-openapi.yaml](docs/service-api-openapi.yaml): OpenAPI contract for service clients.
- [docs/newleaf-video-studio.md](docs/newleaf-video-studio.md): timeline-based walkthrough editor and FFmpeg render API.
- [docs/youtube-oauth-flow.md](docs/youtube-oauth-flow.md): YouTube OAuth setup and connection flow.

## External Service API

Other backend systems can submit text-to-HeyGen jobs without using admin credentials.

Create vendor access from the **Vendors** page. The UI shows a `keyId` and one-time `signingSecret`. The calling backend signs every request with HMAC-SHA256 and sends `x-newleaf-key-id`, `x-newleaf-timestamp`, and `x-newleaf-signature`.

Swagger docs:

```text
http://localhost:8080/api/v1/service/docs
```

Raw OpenAPI YAML:

```text
http://localhost:8080/api/v1/service/openapi.yaml
```

Submit a job:

```text
POST /api/v1/service/text-to-heygen/jobs
```

Check status:

```text
GET /api/v1/service/jobs/<jobId>
```

The legacy `SERVICE_API_KEY_HASHES` environment variable remains available for local scripted tests, but managed vendor clients should use the signed request flow. Do not expose service credentials in a browser or mobile app. For production, put edge rate limiting and IP allowlists at Firebase Hosting, Cloud Run, or your API gateway.

For full markdown scripts, vendors can send either plain JSON text in `script` or UTF-8 base64 in `scriptBase64`. Use `segmentMode: "slides"` for scripts with headings such as `## Slide 1: Intro`.

## Security Before Publishing To GitHub

Do this before pushing the repository:

1. Rotate any API keys, OAuth client secrets, or tokens that were pasted into chat, logs, commits, or screenshots.
2. Confirm `.env` is not committed.
3. Confirm `.local-data/` is not committed. Local repository data can contain OAuth tokens and provider IDs.
4. Confirm `.secrets/`, service account files, and token files are not committed.
5. Use `.env.example` for public configuration examples.
6. Use placeholders in docs and screenshots.

This repo already ignores the main local secret paths in `.gitignore`.

## Production Direction

The local implementation is designed to evolve toward:

- Firebase Auth for admin identity;
- Firestore for jobs, artifacts, provider jobs, publish plans, attempts, accounts, smart collections, and audit logs;
- Google Secret Manager for credentials;
- Cloud Tasks or Pub/Sub for async workers;
- Firebase Storage or Google Cloud Storage for canonical assets;
- Cloud Run or Functions for heavy workloads such as video processing, transcription, PDF parsing, and provider uploads.

## Status

This project is under active development. YouTube is the most complete path. Other social publishers have worker scaffolding and require real provider apps, OAuth permissions, app review, quota, and provider-specific production hardening.

## License

Private project. Add a license before publishing as open source.
