# API Auth And Role Boundaries

NewLeaf API routes are private by default. Anonymous access is limited to health checks, provider callbacks, OAuth callbacks, public asset reads, public Firestore reads, browser auth-session endpoints, and the service endpoints that enforce their own service credentials.

## Auth Modes

| Auth mode | Used by | Credential |
| --- | --- | --- |
| Firebase bearer token | Admin UI, authenticated browser clients, local API tools | `Authorization: Bearer <Firebase ID token>` |
| NewLeaf session cookie | Browser access through `*.newleafsystem.com` | HTTP-only shared session cookie |
| Signed service client | Vendor and backend integrations | `x-newleaf-key-id`, `x-newleaf-timestamp`, `x-newleaf-signature` |
| Legacy service API key | Local scripts and compatibility only | `x-newleaf-api-key` or bearer API key |

The preferred production browser path is through `https://api.newleafsystem.com`. Raw Cloud Run URLs cannot receive the `.newleafsystem.com` shared browser cookie.

## Route Boundary

| Route group | Boundary |
| --- | --- |
| `GET /healthz`, `GET /api/v1/health` | Public health check. |
| `/api/auth/*` | Browser auth-session endpoints. They validate Firebase/session credentials internally where required. |
| `/api/v1/public/*` | Public asset and allowlisted public Firestore reads only. |
| `/api/v1/webhooks/*`, `/api/v1/social/*` OAuth callback | Provider callback routes with provider-specific validation where implemented. |
| `/api/v1/service/docs`, `/api/v1/service/openapi.yaml` | Protected docs. Admin bearer/session credentials or service credentials required. |
| Operational `/api/v1/service/*` | Signed service credentials required. Admin Firebase credentials are not accepted for these calls. |
| `/api/v1/firestore/*`, `/api/v1/users`, `/api/v1/watchlists`, `/api/v1/assets`, `/api/v1/jobs`, `/api/v1/market`, `/api/v1/service-clients`, `/api/v1/smart-collections`, `/api/v1/social/accounts`, `/api/v1/video-projects`, publishing routes | Global Firebase bearer token or NewLeaf session cookie required before the route handler runs. Route-level roles and ownership checks apply after auth. |

## Role Rules

`requireRole(...)` allows admins through every protected role check. Non-admin users must have at least one of the roles listed by the route.

High-level ownership:

- `admin`: user management, vendor service clients, protected owner records, and all admin operations.
- `editor`: content creation, uploads, job editing, thumbnail generation, and draft workflow operations.
- `reviewer`: review queues and review transitions.
- `publisher`: publishing, social account management, and publication retries.
- `viewer`: read-only operational views where the route explicitly allows it.
- `service`: service API documentation access and service-owned backend integrations.

Firestore bridge rules are path-aware:

- public bridge reads only allowlisted public documents and collections;
- authenticated user bridge reads and writes only the signed-in user's allowed subcollections unless the user is an admin;
- admin bridge access is still restricted to approved root collections and configured paths.

## Verification

Security checks are covered by API tests:

- anonymous protected admin/product routes return `401`;
- anonymous service routes return `401`;
- service clients without the required scope return `403`;
- service clients cannot read jobs owned by another service client;
- revoked service clients return `403`;
- protected Swagger/OpenAPI docs reject anonymous requests and accept signed service credentials.
