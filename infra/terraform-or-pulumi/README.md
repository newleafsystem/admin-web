# IaC Placeholder

No Terraform or Pulumi stack is defined yet. When the app scaffold exists, use this area for repeatable infrastructure instead of one-off console changes.

## Suggested Modules

| Module | Resources |
| --- | --- |
| `firebase_project` | Firebase project wiring, Firestore database, Storage bucket, service accounts. |
| `gcp_cloud_run` | API service, PDF worker, HeyGen worker, publishing worker. |
| `gcp_cloud_tasks` | Queue definitions, retry policy, service account bindings. |
| `gcp_secrets` | Secret Manager entries and IAM bindings. |
| `gcp_storage` | Storage buckets, CORS policy, lifecycle policy. |

## State

Keep state per stage. Production state should be remote, encrypted, and access-controlled.

```text
infra/terraform-or-pulumi/
  modules/
  envs/
    development/
    staging/
    production/
```

## First Resources To Codify

1. Storage buckets and CORS.
2. Cloud Tasks queues and dead-letter handling.
3. Secret Manager secret shells and IAM.
4. Cloud Run service accounts.
5. Firestore indexes and rules deployment.
