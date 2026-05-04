# Environment Variables

Use stage-specific environment files locally and managed runtime configuration in deployed environments. Keep raw secrets out of checked-in files.

## Variable Groups

| Group | Examples | Owner |
| --- | --- | --- |
| Public admin UI config | `PUBLIC_API_BASE_URL`, `PUBLIC_FIREBASE_PROJECT_ID` | Admin app build/deploy |
| API service config | `APP_STAGE`, `FIREBASE_PROJECT_ID`, `ASSET_STORAGE_PROVIDER` | Cloud Run API |
| Queue config | `QUEUE_PROVIDER`, `CLOUD_TASKS_QUEUE` | API and workers |
| Secret refs | `HEYGEN_API_KEY_SECRET`, `SOCIAL_TOKEN_KEY_SECRET` | Secret Manager names |

## Local Development

Use `env.example` as the non-secret baseline. Developers can copy it into an ignored local file once a root app scaffold exists.

For emulators:

- Firebase Auth emulator: `127.0.0.1:9099`
- Firestore emulator: `127.0.0.1:8080`
- Firebase Storage emulator: `127.0.0.1:9199`
- Local API: `127.0.0.1:8081`

## Deployed Environments

Prefer secret references over raw secret values:

```text
HEYGEN_API_KEY_SECRET=projects/newleaf-dev/secrets/heygen-api-key/versions/latest
SOCIAL_TOKEN_KEY_SECRET=projects/newleaf-dev/secrets/social-token-encryption-key/versions/latest
```

Cloud Run services should receive Secret Manager references through deployment scripts or runtime secret bindings, not raw secret values.
