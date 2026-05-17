# Architecture Flows

This document describes how the current NewLeaf implementation is intended to flow end to end. It complements the broader design in [end-to-end-api-solution.md](end-to-end-api-solution.md).

## Runtime Shape

```mermaid
flowchart LR
  Admin[React Admin UI] --> Api[Node API / Express]
  Api --> Repo[Repository Abstraction]
  Repo --> Local[(.local-data in local dev)]
  Repo -. production target .-> Firestore[(Firestore)]
  Api --> Assets[Assets Route / Local Storage]
  Api --> Review[Video Review Service]
  Api --> HeyGen[HeyGen Service]
  Api --> Assembler[Video Assembler / FFmpeg]
  Api --> Studio[Video Studio Renderer / FFmpeg]
  Api --> OAuth[Social OAuth Services]
  Api --> Publisher[Social Publisher Service]
  Publisher --> YT[YouTube Publisher]
  Publisher --> X[X Worker]
  Publisher --> LI[LinkedIn Worker]
  Publisher --> Meta[Meta / Instagram / Facebook Worker]
```

The API is the only component that talks to vendors. The admin UI consumes `/api/v1` routes and renders normalized operational state.

## API-Driven Async Product Strategy

NewLeaf product flows are API-driven and asynchronous. Frontend apps submit intent, receive a durable state record, and then render status from the API. They should not wait for provider or backend work to finish inside a long browser request.

Core split:

- Admin-web is the control plane. It creates, approves, queues, retries, cancels, and publishes work, then shows what is queued, failed, partially failed, and published.
- Client-web is mostly read-only. It renders published recommendations, reports, cards, videos, and market data from `api.newleafsystem.com`.
- Client-web writes are limited to user-owned product surfaces, such as portfolio creation, workbench settings, strategy-builder drafts, and user watchlists. Shared publication, recommendation, email, PDF, and video state remains backend-owned.
- API services own queues, locks, idempotency, provider credentials, retry state, and audit metadata.

Long-running channels return state, not final completion:

```text
Admin/client intent -> API creates durable state -> worker/provider fanout -> API updates status -> UI reads status
```

## External Service Submission Flow

```mermaid
sequenceDiagram
  participant Client as External System
  participant API as Service API
  participant Repo
  participant HeyGen
  participant Assembler

  Client->>API: POST /api/v1/service/text-to-heygen/jobs
  API->>API: Verify signed vendor request
  API->>Repo: Check idempotencyKey for this vendor client
  API->>Repo: Create text_to_heygen job
  API->>HeyGen: Request video generation
  API->>Repo: Store provider jobs and manifest artifact
  API-->>Client: 202 job id, provider status, sanitized manifest
  Client->>API: GET /api/v1/service/jobs/:jobId
  API-->>Client: Sanitized status and artifact links
```

Service API rules:

- Use server-to-server calls only. Do not put service keys in browser code.
- Vendor clients are created in the Vendors admin page and authenticate with signed requests.
- The legacy `SERVICE_API_KEY_HASHES` path is kept for local scripts only.
- The service response is sanitized and does not expose provider request payloads, local file paths, OAuth tokens, or secrets.
- Use `idempotencyKey` for retries so one client retry does not create duplicate HeyGen jobs.

## Content Creation Flow

```mermaid
sequenceDiagram
  participant Admin
  participant UI as Admin UI
  participant API
  participant Repo
  participant Assets

  Admin->>UI: Create content from upload, YouTube URL, or prompt
  UI->>API: POST /api/v1/jobs
  API->>Repo: createJob()
  alt local video upload
    UI->>API: POST /api/v1/assets/local-upload
    API->>Assets: store local video bytes
    API->>Repo: createArtifact(video)
  end
  API-->>UI: normalized job
```

Main records:

- `job`: source, status, owner, title, and workflow metadata.
- `artifact`: source files, generated video, transcript, captions, thumbnails, or payload snapshots.

## Picks Recommendation Publishing Flow

```mermaid
sequenceDiagram
  participant Admin
  participant UI as Admin UI
  participant API
  participant Repo as Firestore/Repository
  participant Client as Client Web
  participant Email
  participant PDF
  participant HeyGen
  participant Assembler

  Admin->>UI: Curate daily recommendation batch
  UI->>API: POST/PATCH /api/v1/recommendation-batches
  API->>Repo: Store canonical recommendationBatch
  Admin->>UI: Approve and publish batch
  UI->>API: POST approve, POST publish
  API->>Repo: Mark published and store public snapshot
  Client->>API: GET /api/v1/public/recommendations/latest
  API-->>Client: Published picks/invest card data
  API->>Repo: Create text_to_heygen recommendation video job
  API->>Email: Queue weeklyPicks notification channel
  API->>PDF: Queue batch PDF channel
  API->>HeyGen: Submit approved script through existing backend flow
  HeyGen-->>API: Webhook or polling completion
  API->>Assembler: Assemble final video when all segments are ready
  API->>Repo: Mark channel states and final batch status
```

Channel ownership:

- Firestore is the canonical source for the approved recommendation batch and audit state.
- R2 or public storage is a delivery/cache layer for client-web cards, not the only source of truth.
- The first implemented public surface is the API recommendation route; storage cache generation can be added later without changing the client contract.
- Live-site cards, email, PDF, script, and HeyGen video all derive from the same stable `recommendationBatchId`.
- Email recipients are resolved from user notification preferences, not ad hoc recipient lists.
- Video generation must reuse the existing backend HeyGen flow; the admin UI never calls HeyGen directly.

## HeyGen Generation Flow

```mermaid
sequenceDiagram
  participant UI
  participant API
  participant HeyGen
  participant Assembler
  participant Repo
  participant Webhook

  UI->>API: POST /api/v1/jobs/:jobId/generate-video
  API->>Assembler: create manifest with ordered segments
  API->>HeyGen: create async video request per segment
  API->>Repo: create providerJob per segment, status video_requested
  HeyGen-->>Webhook: completion event
  Webhook->>Repo: record webhook event idempotently
  Webhook->>Assembler: download completed segment and update manifest
  API->>HeyGen: polling fallback if webhook is missed
  Assembler->>Assembler: assemble completed segment clips by manifest sequence
  Assembler->>Repo: create final video artifact and mark video_ready
```

Rules:

- Webhooks are the primary completion signal.
- Polling is the fallback for missed or delayed events.
- Provider events must be deduplicated.
- Multi-clip jobs must assemble by manifest `sequence`, not webhook or polling completion order.
- Local development can use the authenticated dev completion endpoint instead of real HeyGen callbacks.
- The final video should be copied into NewLeaf-owned storage before publishing.

## Review Flow

```mermaid
flowchart TD
  Ready[video_ready or review_required] --> Review[Review Workspace]
  Review --> Summary[Generate summary with configured AI provider]
  Review --> Approve[Approve Job]
  Review --> RegenScript[Regenerate Script]
  Review --> RegenVideo[Regenerate HeyGen Video]
  Review --> Thumbnail[Upload or Generate Thumbnail]
  Approve --> Publishable[approved]
```

Review expectations:

- Local uploads and YouTube embeds should show video preview and summary controls.
- Thumbnails can be manually uploaded for any source or generated from the current local video artifact with FFmpeg.
- Script/video regeneration is only for generated script or HeyGen-backed jobs.
- Text-to-HeyGen review scripts are editable. Admin edits are saved through the API and reused as the prompt when regenerating the video.
- Published jobs should move out of the normal review queue.

## Video Studio Flow

```mermaid
sequenceDiagram
  participant Admin
  participant UI as Admin UI
  participant API
  participant Storage as Local Project Storage
  participant FFmpeg

  Admin->>UI: Create/load Video Studio project
  UI->>API: POST /api/v1/video-projects
  API->>Storage: Create timeline.json and status.json
  Admin->>UI: Upload screen, voiceover, avatar
  UI->>API: POST /api/v1/video-projects/:projectId/assets
  API->>Storage: Save uploaded bytes under project uploads
  Admin->>UI: Set trim, mute, PIP, callout
  UI->>API: PUT /api/v1/video-projects/:projectId/timeline
  API->>Storage: Save timeline metadata
  Admin->>UI: Render
  UI->>API: POST /api/v1/video-projects/:projectId/render
  API->>FFmpeg: Normalize, trim, overlay, draw text, map audio
  FFmpeg-->>Storage: output/final.mp4
  API-->>UI: Render status and output URL
```

The timeline JSON is the source of truth. Uploaded files are immutable inputs for the MVP; FFmpeg only writes temporary render files and the final MP4.

## Publishing Flow

```mermaid
sequenceDiagram
  participant Admin
  participant UI
  participant API
  participant Repo
  participant Publisher
  participant Platform

  Admin->>UI: Create publish plan
  UI->>API: POST /api/v1/publish-plans
  API->>Repo: createPublishPlan(draft)
  Admin->>UI: Approve and publish
  UI->>API: POST /api/v1/publish-plans/:planId/publish
  API->>Repo: createPublishAttempt per platform
  API->>Publisher: enqueueAttempt()
  Publisher->>Platform: upload media / create post
  Publisher->>Repo: update progress and provider IDs
  UI->>API: poll jobs, plans, publications
```

State ownership:

- `publishPlan.status` describes the overall plan.
- `publishAttempt.status` describes one platform execution.
- `publishAttempt.metadata` stores progress labels, bytes, account metadata, provider snapshots, privacy, title, tags, thumbnails, and operational notes.

## Published Library Flow

```mermaid
flowchart LR
  Attempts[publishAttempts] --> API[GET /api/v1/publications]
  API --> Normalize[Admin API normalization]
  Normalize --> Cards[Published Videos cards]
  Cards --> Actions[Open, visibility update, hype, delete]
```

The Published Videos page is the operational library for active and deleted provider records. Active records are shown as compact video cards. Deleted records remain visible through filters as audit records.

## Publication Channel Sync Flow

```mermaid
sequenceDiagram
  participant Admin
  participant UI
  participant API
  participant Importer as Social Publication Import Service
  participant Provider
  participant Repo

  Admin->>UI: Sync platform section
  UI->>API: POST /api/v1/publications/import/:platform
  API->>Importer: importChannelPublications(platform)
  Importer->>Repo: resolve connected account and token reference
  Importer->>Provider: list account/channel videos
  API->>Repo: upsert external job, plan, attempt
  API-->>UI: imported and updated publication records
```

Purpose:

- Bring existing social channel videos into NewLeaf even when they were not uploaded by this app.
- Keep provider IDs and URLs aligned so later visibility edits and deletes can target the correct video.
- Avoid duplicate local records by matching provider post IDs.

Current sync support is modular:

- YouTube uses the YouTube publisher importer and Data API upload playlist flow.
- X imports video or animated GIF posts from the authenticated user's posts.
- LinkedIn imports owner posts with video media.
- Facebook imports Page videos.
- Instagram imports professional account videos and reels.

## Account Connection Flow

```mermaid
sequenceDiagram
  participant Admin
  participant UI
  participant API
  participant Provider
  participant Repo

  Admin->>UI: Connect or reconnect account
  UI->>API: POST /api/v1/social/:platform/oauth/start
  API->>Repo: create OAuth state
  API-->>UI: authorizationUrl
  UI->>Provider: redirect
  Provider->>API: OAuth callback
  API->>Provider: exchange code for tokens
  API->>Repo: store secret ref and account metadata
```

Provider-specific OAuth code belongs in backend services. The UI should only start the flow and display account health.

## Delete And Visibility Update Flow

```mermaid
sequenceDiagram
  participant UI
  participant API
  participant Publisher
  participant Provider
  participant Repo

  UI->>API: PATCH /api/v1/publications/:attemptId
  API->>Publisher: updatePrivacy()
  Publisher->>Provider: provider update endpoint
  Publisher->>Repo: update metadata and progress

  UI->>API: POST /api/v1/publications/:attemptId/delete
  API->>Publisher: deletePublication()
  Publisher->>Repo: mark delete_requested
  Publisher->>Provider: provider delete endpoint
  Publisher->>Repo: mark deleted audit record
```

Deleting from a provider does not remove the NewLeaf audit record. This prevents loss of operational history.

## Production Target

Local development currently uses the in-memory repository with local persistence. Production should replace local persistence with:

- Firestore for jobs, artifacts, provider jobs, publish plans, attempts, accounts, smart collections, and audit logs.
- Google Secret Manager for OAuth refresh tokens and API keys.
- Cloud Tasks or Pub/Sub for async workers.
- Firebase Storage / Google Cloud Storage for canonical assets.
