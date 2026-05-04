# Firebase Starter

Firebase owns identity and workflow state for the MVP. Backend services should use Firebase Admin SDK credentials and bypass client rules for trusted state transitions, while the admin UI should be constrained by Firestore and Storage rules.

## Services

| Service | Use |
| --- | --- |
| Firebase Auth | Admin login and custom role claims. |
| Firestore | Source of truth for jobs, artifacts, provider jobs, publish plans, attempts, accounts, webhook events, and audit logs. |
| Firebase Storage / GCS | Source asset store for uploads, generated clips, thumbnails, and rendered videos. |
| Google Secret Manager | API keys, OAuth client secrets, refresh tokens, webhook secrets, signing keys. |
| Cloud Tasks | First-choice async queue when Firestore is the workflow driver. |
| Firebase Hosting | Admin UI hosting with `/api/**` rewrites to Cloud Run. |

## Config Files

- `firebase.json.example` shows the intended Firebase CLI wiring without adding a root-level `firebase.json`.
- `firestore.rules` is a restrictive starter rule set for the admin UI.
- `firestore.indexes.json` contains early indexes for queue dashboards and pollers.
- `storage.rules` is a signed-URL-first starter policy.
- `projects.example.json` documents stage-to-project mappings.

## Firestore Collections

Align collection names with the architecture doc:

- `users/{uid}`
- `contentJobs/{jobId}`
- `artifacts/{artifactId}`
- `providerJobs/{providerJobId}`
- `connectedAccounts/{accountId}`
- `publishPlans/{planId}`
- `publishAttempts/{attemptId}`
- `auditLogs/{auditId}`
- `smartCollections/{collectionId}`
- `webhookEvents/{eventId}`
- `oauthStates/{stateId}`
- `serviceClients/{clientId}`
- `repositorySecrets/{secretId}` for interim repository-backed secrets; move OAuth refresh tokens to Secret Manager for hardened production.

## Role Model

Start with these role names:

- `admin`: manage users, roles, settings, all jobs, and all publish plans.
- `editor`: upload source files, edit scripts, and request regeneration.
- `reviewer`: approve or reject generated content.
- `publisher`: manage connected accounts and publish approved plans.
- `viewer`: read-only access.

Prefer custom claims for fast UI authorization checks. Keep a matching `users/{uid}` document for display data and audit history.

## Deployment Notes

From a future app repo root, the Firebase config can point back to these files:

```bash
firebase deploy --only firestore:rules,firestore:indexes,storage --project newleaf-dev
```

Cloud Run workers should receive `FIREBASE_PROJECT_ID`, `APP_STAGE`, and the Secret Manager resource names they need. Do not pass raw social refresh tokens through environment variables.
