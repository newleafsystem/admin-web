# Google Cloud Run Media Renderer

NewLeaf uses Firebase Hosting for the admin UI, Google Cloud Run for the API, and Google Cloud Run for FFmpeg-heavy media rendering.

```text
Admin UI
  -> Firebase Hosting /api rewrite
  -> Cloud Run API
  -> Cloud Run media renderer
  -> Google Cloud Storage / Firebase Storage media objects
  -> API render status
```

Cloud Run is used because Firebase Hosting and normal API containers should not run long FFmpeg work inline.

## What The Renderer Does

The first renderer slice supports timeline export jobs:

- downloads timeline assets from Google Cloud Storage
- trims video clips by `start` and `end`
- sorts clips by `timelineStart`
- normalizes clips to the timeline resolution and FPS
- concatenates clips into one MP4
- adds replacement audio or a silent AAC track
- applies simple text overlays
- uploads the final MP4 back to Google Cloud Storage at `outputObjectKey`

The renderer never accepts raw FFmpeg arguments.

## Required Local Tools

- `gcloud`
- `bash`
- Firebase Storage / Google Cloud Storage bucket access in the target project

## Required Environment Variables

Set these in your shell before running the setup script:

```bash
export GCP_PROJECT_ID="newleaf-trading"
export MEDIA_RENDER_HMAC_SECRET="<long-random-shared-secret>"
```

Optional:

```bash
export GCP_REGION="us-central1"
export SERVICE_NAME="newleaf-ffmpeg-renderer"
export SERVICE_ACCOUNT_NAME="newleaf-renderer"
export GCS_BUCKET="newleaf-trading.appspot.com"
export MAX_INSTANCES="2"
export MEMORY="2Gi"
export CPU="2"
export TIMEOUT="3600"
```

## Deploy

```bash
bash scripts/setup-google-cloud-run-renderer.sh
```

Equivalent npm script:

```bash
npm run gcp:setup-renderer
```

The script:

- enables required Google Cloud APIs
- creates a Cloud Run service account if missing
- stores the render HMAC secret in Secret Manager
- grants the Cloud Run service account access to Secret Manager and the storage bucket
- deploys `services/media-renderer` to Cloud Run
- prints the resulting renderer URL

## Wire The API

After deployment, pass the renderer URL and the same HMAC secret to the Cloud Run API service:

```bash
export MEDIA_RENDERER_URL="https://newleaf-ffmpeg-renderer-xxxxx.a.run.app"
export MEDIA_RENDER_HMAC_SECRET="<same-long-random-shared-secret>"
npm run gcp:setup-api
```

For GitHub deployments, keep `MEDIA_RENDER_HMAC_SECRET` in Secret Manager or GitHub Actions secrets, not in source code.

## Security Notes

- Cloud Run is deployed with unauthenticated ingress for MVP, but `/render` requires the HMAC signature from the API.
- Storage access is granted through the Cloud Run service account, not long-lived object storage keys.
- The API and renderer must share `MEDIA_RENDER_HMAC_SECRET`.
- Rotate the HMAC secret before production if it was used during local testing.

## Known Limits

- Rendering is synchronous for the first slice. It is suitable for short MVP exports.
- Long renders should move to Cloud Run Jobs or an async callback flow.
- The renderer currently supports basic video trim/concat, replacement audio, silent audio, and text overlays. Avatar PiP and advanced zoom/pan are future extensions.
