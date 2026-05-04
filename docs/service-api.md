# NewLeaf Service API

The Service API lets trusted backend systems submit text-to-HeyGen video jobs without using admin credentials.

Do not call these routes from browser or mobile code. Store credentials only in the calling backend.

## Swagger UI

When the API is running locally, open:

```text
http://localhost:8080/api/v1/service/docs
```

The raw OpenAPI contract is available at:

```text
http://localhost:8080/api/v1/service/openapi.yaml
```

The Swagger page is public documentation. Protected API calls still require the signed request headers below.

Swagger "Try it out" is intentionally disabled because this API is meant for backend-to-backend calls. Generate the HMAC signature in the calling backend, Postman pre-request script, or a local test script, then send the signed request from there. If a request is sent without signed headers, the API returns `Missing service API credentials`.

## Vendor Access

Admins create vendor access from the **Vendors** page.

Each vendor receives:

- `keyId`: public identifier sent in `x-newleaf-key-id`.
- `signingSecret`: one-time secret used to sign requests.

NewLeaf stores the signing secret through the repository secret boundary and does not show it again. Rotate the vendor if the secret is lost or exposed.

## Signed Request Headers

Every service request uses:

```text
x-newleaf-key-id: svc_...
x-newleaf-timestamp: 1760000000
x-newleaf-signature: sha256=<hex hmac>
```

The signature is HMAC-SHA256 over:

```text
METHOD
PATH_WITH_QUERY
TIMESTAMP
SHA256_RAW_BODY_HEX
```

Example path:

```text
/api/v1/service/text-to-heygen/jobs
```

The timestamp must be within `SERVICE_API_SIGNATURE_TOLERANCE_SEC`.

## Submit Text-To-HeyGen Job

```http
POST /api/v1/service/text-to-heygen/jobs
```

Body:

```json
{
  "title": "BABA Iron Condor",
  "script": "Full narration script here.",
  "targetDurationSec": 240,
  "idempotencyKey": "baba-iron-condor-2026-05-01",
  "segmentMode": "single",
  "autoStart": true
}
```

For large markdown scripts, send the script as UTF-8 base64:

```json
{
  "title": "BABA Iron Condor",
  "scriptBase64": "IyBCQUJBIElyb24gQ29uZG9y...",
  "scriptEncoding": "base64",
  "targetDurationSec": 240,
  "idempotencyKey": "baba-iron-condor-2026-05-01",
  "segmentMode": "slides"
}
```

`scriptBase64` accepts standard base64 and base64url. Base64 is only a transport encoding, not encryption. Security and integrity come from the signed request headers, which sign the exact raw JSON body.

`segmentMode` values:

- `single`: send the full script as one HeyGen prompt.
- `slides`: split markdown headings like `## Slide 1: Intro` into ordered segments.
- `segments`: use the explicit `segments` array.

Explicit segment example:

```json
{
  "title": "BABA Iron Condor",
  "script": "Fallback full script for review.",
  "segmentMode": "segments",
  "segments": [
    {
      "sequence": 10,
      "segmentKey": "intro",
      "title": "Intro",
      "prompt": "Introduce the BABA iron condor setup.",
      "required": true
    }
  ],
  "idempotencyKey": "baba-iron-condor-segmented"
}
```

Use `idempotencyKey` for all retries. Reusing the same key with the same vendor returns the existing job instead of creating duplicate HeyGen requests.

## Check Status

```http
GET /api/v1/service/jobs/:jobId
```

The response includes sanitized job status, provider jobs, assembly progress, artifacts, and the manifest timeline when available.

## Retry Failed Job

```http
POST /api/v1/service/jobs/:jobId/retry
```

Only `failed` and `script_ready` jobs can be retried.

## Download Artifact

```http
GET /api/v1/service/jobs/:jobId/artifacts/:artifactId/content
```

The same signed request headers are required. The service key must own the job.

## Security Notes

- Do not store raw credentials in `.env.example`, docs, screenshots, or commits.
- Do not wrap the full script in JWT. The API already verifies request integrity with HMAC signatures; JWT would add operational complexity without solving large markdown transport.
- Rotate a vendor client when a signing secret is exposed.
- Use Firebase Hosting, Cloud Run, or an API gateway for IP allowlisting and edge rate limiting in production.
- Keep `SERVICE_API_RATE_LIMIT_PER_MINUTE` low for local and staging use.
