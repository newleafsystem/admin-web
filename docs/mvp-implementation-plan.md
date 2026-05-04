# NewLeaf MVP Implementation Plan

This plan turns `docs/end-to-end-api-solution.md` into a practical first build. The MVP should prove the full content lifecycle with one publishing platform before broadening scope.

## Principles

- Firestore is the source of truth for job state, approvals, provider jobs, publish attempts, and audit history.
- Backend services own vendor credentials, retries, polling, webhook verification, and publishing state.
- Cloud Run handles heavy work such as PDF parsing, transcript generation, video download, thumbnail extraction, and social publishing.
- Firebase Hosting and Cloud Run handle public webhooks, validation, queue enqueueing, and API pass-through.
- Every external callback and queue message must be idempotent.

## Phase 0: Infrastructure Foundation

Deliverables:

- Create `development`, `staging`, and `production` Firebase/GCP projects.
- Enable Firebase Auth, Firestore, and optional Firebase Storage.
- Create Firebase Storage / Google Cloud Storage buckets, Cloud Tasks queues, Pub/Sub topics, and dead-letter handling per stage.
- Create Secret Manager entries from `infra/env/secrets.inventory.md`.
- Deploy initial Firestore indexes, Firestore rules, and Storage rules from `infra/firebase/`.
- Decide whether MVP queue execution uses Cloud Tasks, Pub/Sub, or Firebase Functions task queues.

Acceptance criteria:

- Admin users can authenticate in development.
- API service can write a `contentJobs` document and an `auditLogs` entry.
- A test asset can be uploaded to the selected asset store and referenced by an artifact document.
- Webhook endpoint responds quickly to `OPTIONS`.

## Phase 1: API And Admin Foundations

Deliverables:

- Node.js API gateway with `/api/v1`.
- Firebase Auth verification and role checks.
- Job creation and job list endpoints.
- Signed upload and download URL endpoints.
- Admin dashboard, content queue, and job detail shell.

Acceptance criteria:

- An authenticated editor can create a job from a PDF upload.
- A viewer can read but not mutate job data.
- Every create or update path writes an audit log.

## Phase 2: PDF And Script Workflow

Deliverables:

- PDF source artifact storage.
- PDF extraction worker on Cloud Run.
- Structured script schema with scenes, narration, on-screen text, citations, disclaimers, and target duration.
- Script generation endpoint and script editor in the admin UI.

Acceptance criteria:

- A PDF job moves from `draft` to `source_ingested` to `content_extracted` to `script_ready`.
- Extracted text and generated script are stored as separate artifacts.
- Script regeneration does not overwrite prior script artifacts.

## Phase 3: HeyGen Video Generation

Deliverables:

- HeyGen API client.
- Video generation endpoint.
- Provider job documents with request payload snapshots.
- HeyGen webhook verification and idempotency.
- Polling fallback for missed webhook events.
- Final video download into canonical storage.

Acceptance criteria:

- A job moves from `script_ready` to `video_requested` to `video_ready`.
- Duplicate webhooks do not duplicate artifacts or state transitions.
- Failed provider jobs store error details and can be retried.

## Phase 4: Review And Approval

Deliverables:

- Review workspace for source, extracted text, script, final video, captions, thumbnail, and disclaimer.
- Approval and rejection actions.
- Regenerate script and regenerate video controls.
- Approval lock that prevents accidental mutation of approved content.

Acceptance criteria:

- Reviewer approval moves a job to `approved`.
- Rejected content returns to an editable state with an audit trail.
- Approved content can still receive platform-specific metadata edits through a publish plan.

## Phase 5: Publishing MVP

Deliverables:

- OAuth connection flow for YouTube first.
- YouTube publisher adapter.
- Publish plans and publish attempts.
- Retry controls and duplicate-post prevention.
- Publications dashboard.

Acceptance criteria:

- A publisher can create and approve a YouTube publish plan.
- A publish attempt stores provider IDs, provider URL, status, and errors.
- Retrying a failed attempt cannot create a second public post for the same attempt.

## Phase 6: Multi-Platform Expansion

Add platforms after the YouTube path is stable:

1. LinkedIn.
2. X.
3. Instagram/Facebook after the Meta app review path is clear.
4. TikTok after Direct Post or inbox flow approval is clear.

Each adapter must implement validation, publish, status refresh where needed, OAuth token refresh, provider request snapshots, and retry-safe publish attempts.

## MVP Cut Line

In scope:

- Authenticated admin workflow.
- PDF upload and extraction.
- Structured script generation and editing.
- HeyGen generation with webhook plus polling.
- Human review and approval.
- One production-ready publishing adapter, preferably YouTube.
- Audit logs for all approvals, regenerations, publishes, and failures.

Out of scope until after MVP:

- Multi-tenant billing.
- Analytics ingestion.
- Comment moderation.
- Automated trading data ingestion.
- Multi-platform simultaneous launch beyond the first adapter.
