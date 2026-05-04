# Deployment Stages

Use isolated stages from the start. The workflow handles third-party credentials, financial content, approvals, and public publishing, so shared development and production resources are not acceptable.

## Development

Purpose:

- Local and shared development.
- Firebase emulators where possible.
- Sandbox HeyGen and social credentials when available.
- Firebase Storage bucket and Cloud Tasks queue can be real but disposable.

Defaults:

- Firebase project: `newleaf-dev`
- Storage bucket: `newleaf-assets-dev`
- Cloud Tasks queue: `newleaf-work-dev`
- Admin URL: `http://localhost:5173` or `https://admin-dev.newleaf.example`
- API URL: `http://localhost:8081` or `https://api-dev.newleaf.example`

Promotion gate:

- Firestore rules deploy successfully.
- Upload URL smoke test passes.
- Job creation writes `contentJobs` and `auditLogs`.
- Webhook route responds to `OPTIONS` quickly.

## Staging

Purpose:

- Production-like validation.
- Real webhook registration.
- Social platform OAuth callback validation.
- Manual review workflow rehearsal.

Defaults:

- Firebase project: `newleaf-stg`
- Storage bucket: `newleaf-assets-stg`
- Cloud Tasks queue: `newleaf-work-stg`
- Admin URL: `https://admin-staging.newleaf.example`
- API URL: `https://api-staging.newleaf.example`

Promotion gate:

- HeyGen success and failure webhook events are verified and deduped.
- Polling fallback transitions stuck jobs.
- Generated videos are copied to canonical storage.
- Publish attempt retry cannot create duplicate public posts.
- Audit logs exist for approval, rejection, regeneration, and publish attempts.

## Production

Purpose:

- Real users, real assets, and public publishing.

Defaults:

- Firebase project: `newleaf-prod`
- Storage bucket: `newleaf-assets-prod`
- Cloud Tasks queue: `newleaf-work-prod`
- Admin URL: `https://admin.newleaf.example`
- API URL: `https://api.newleaf.example`

Release requirements:

- Production secrets are created and access is limited by service account.
- Firestore and Storage rules are deployed from reviewed config.
- Dead-letter queue monitoring is enabled.
- Provider webhook secrets are rotated from any staging value.
- Backups or export process exists for Firestore and canonical assets.
- A manual kill switch exists for publishing workers.

## Change Promotion

Promote in this order:

1. Rules and indexes.
2. Infrastructure resources.
3. API and worker services.
4. Admin UI.
5. Webhook registrations.
6. Publishing adapter enablement flags.

Never enable a new public publishing adapter directly in production. Validate it in staging with a private or test account first.
