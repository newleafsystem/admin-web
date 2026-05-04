# NewLeaf Infrastructure Starter

This directory holds starter infrastructure documentation and config placeholders for the NewLeaf MVP. It follows `docs/end-to-end-api-solution.md` and keeps the first deployment practical:

- Firebase Auth and Firestore are the source of truth for users, jobs, approvals, publish attempts, and audit logs.
- Firebase Hosting serves the admin UI and rewrites API requests to Cloud Run.
- Cloud Run runs the Node.js API and heavier services, including PDF work, transcript processing, HeyGen polling, video download, thumbnail generation, FFmpeg rendering, and social publishing.
- Firebase Storage / Google Cloud Storage is the canonical asset store for uploads, generated clips, thumbnails, and rendered videos.
- Cloud Tasks or Pub/Sub should handle async workflow dispatch once local-first workers are replaced.

Do not commit real secrets in this directory. Use Google Secret Manager for Firebase and Google Cloud services.

## Directory Map

```text
infra/
  env/                     Environment variable and secret inventory docs
  firebase/                Firebase, Firestore, Storage, and project placeholders
  stages/                  Development, staging, and production rollout notes
  terraform-or-pulumi/     IaC placeholder and module boundaries
```

## Workload Placement

| Capability | Initial Home | Notes |
| --- | --- | --- |
| Admin identity | Firebase Auth | Use custom claims or a Firestore-backed role sync. |
| Workflow state | Firestore | `contentJobs`, `providerJobs`, `publishPlans`, `publishAttempts`, `smartCollections`, and `auditLogs`. |
| Public webhooks | Cloud Run | Verify raw body signatures before enqueueing follow-up work. |
| PDF parsing/generation | Cloud Run | Do not run Chromium or heavy parsing in a Worker. |
| Script/transcript/video workers | Cloud Run | Queue-triggered workers with idempotent state transitions. |
| HeyGen callbacks | Cloud Run | Verify raw body signature before enqueueing. |
| Canonical assets | Firebase Storage / GCS | Store uploaded media, generated videos, thumbnails, and render outputs. |
| Publishing adapters | Cloud Run | Keep OAuth tokens and platform SDK work on the backend. |

## Naming Convention

Use the same stage suffix everywhere:

| Stage | Suffix | Example |
| --- | --- | --- |
| Development | `dev` | `newleaf-assets-dev` |
| Staging | `stg` | `newleaf-work-stg` |
| Production | `prod` | `newleaf-work-prod` |

Keep resource names boring and predictable:

- Firebase/GCP projects: `newleaf-dev`, `newleaf-stg`, `newleaf-prod`
- Storage buckets: `newleaf-assets-dev`, `newleaf-assets-stg`, `newleaf-assets-prod`
- Cloud Tasks queues: `newleaf-work-dev`, `newleaf-work-stg`, `newleaf-work-prod`
- Dead-letter queues: `newleaf-work-dlq-dev`, `newleaf-work-dlq-stg`, `newleaf-work-dlq-prod`

## Bootstrap Checklist

1. Create separate Firebase/GCP projects for each stage.
2. Enable Firebase Auth, Firestore, and optionally Firebase Storage.
3. Create Firebase Storage / GCS buckets and Cloud Tasks queues per stage.
4. Create Secret Manager entries from `infra/env/secrets.inventory.md`.
5. Deploy Firestore and Storage rules from `infra/firebase/`.
6. Deploy the API and worker services with stage-specific environment values.
7. Configure HeyGen and social webhooks only after endpoint URLs and secrets exist.
8. Run a smoke test for upload, job creation, webhook receipt, queue enqueue, and audit log write.
