# Secret Inventory

Create one secret per stage unless the provider requires a shared value. Rotate production secrets independently from development and staging.

## Google Secret Manager

| Secret | Stage Scope | Used By | Notes |
| --- | --- | --- | --- |
| `heygen-api-key` | all | API, HeyGen worker | Calls HeyGen generation and status APIs. |
| `heygen-webhook-secret` | all | API | Signature verification for raw webhook body. |
| `internal-api-token` | all | API, Cloud Run services | Authenticates internal service calls. |
| `social-token-encryption-key` | all | API, publishing workers | Encrypts OAuth refresh tokens before persistence. |
| `youtube-client-secret` | stage/prod | API, YouTube publisher | OAuth app secret. |
| `youtube-main-oauth-token` | stage/prod | API, YouTube publisher | Refresh token payload for the connected YouTube channel. |
| `linkedin-client-secret` | stage/prod | API, LinkedIn publisher | OAuth app secret. |
| `linkedin-main-oauth-token` | stage/prod | API, LinkedIn publisher | Refresh token payload for the connected LinkedIn member/page. |
| `x-client-secret` | stage/prod | API, X publisher | OAuth app secret if OAuth app requires one. |
| `x-main-oauth-token` | stage/prod | API, X publisher | Refresh token payload for the connected X account. |
| `meta-client-secret` | stage/prod | API, Meta publisher | Add only when Meta flow is approved. |
| `meta-main-oauth-token` | stage/prod | API, Meta publisher | Refresh token payload for connected Facebook/Instagram assets. |
| `tiktok-client-secret` | stage/prod | API, TikTok publisher | Add only when TikTok flow is approved. |
| `tiktok-main-oauth-token` | stage/prod | API, TikTok publisher | Refresh token payload for the connected TikTok account. |

Do not store OAuth refresh tokens as plain Firestore fields. Store encrypted token payloads or Secret Manager references in `connectedAccounts/{accountId}`.
