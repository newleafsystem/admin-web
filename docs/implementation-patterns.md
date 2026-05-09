# Implementation Patterns

This document captures the patterns that should guide future implementation work in this repo.

## Change Impact Pattern

Do not modify a file in isolation. Before editing, identify the surrounding feature path and update the related code, tests, docs, and deployment config that are affected by the same behavior.

Rules:

- Start from the file being changed, then inspect its imports, callers, route mounting, service factory wiring, repository methods, UI API client calls, and deployment/env references.
- For API changes, check the matching route, service, repository adapter, local repository behavior, Firestore repository behavior, API client, UI section, tests, and docs.
- For UI changes, check the matching API client function, backend route contract, state normalization, CSS, empty/loading/error states, and any tests or manual verification docs.
- For storage, OAuth, publishing, rendering, or provider changes, check local mode, Cloud Run mode, GitHub Actions, env examples, README/docs, and retry/idempotency behavior.
- For every behavior change, either update existing tests or add focused tests near the changed module. If no automated test is practical, document the exact manual verification command or workflow.
- Do not leave templates behind the real implementation. When `.env`, deployment scripts, or runtime config changes, update `.env.example`, `.env.production.example`, README, and relevant setup scripts in the same change.
- Do not leave follow-up cleanup for the user when it can be completed safely in the repo. Finish the related files in the same pass, then report what changed and what was verified.

## API Service Wiring

`apps/api/src/app.js` is the composition root. New services should be created there and injected into routes.

Pattern:

```js
const service = options.service ?? createService({ repository, otherDependency });
app.use('/api/v1', createRoute({ repository, service }));
```

Benefits:

- Tests can inject fake services.
- Routes stay thin.
- Provider code is isolated from HTTP concerns.

## Route Pattern

Routes should follow this shape:

```js
router.post(
  '/resource',
  requireRole('admin', 'publisher'),
  asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['field']);
    const value = requireString(body, 'field');
    const result = await service.doWork({ value, actorUid: req.user.uid });
    res.status(202).json(result);
  }),
);
```

Use:

- `requireRole` for role checks.
- `asyncHandler` for async error handling.
- `badRequest`, `conflict`, and `notFound` from `httpErrors`.
- `validation.js` helpers instead of ad hoc request parsing.

## Repository Pattern

The repository is the data boundary. It supports local persisted development and a Firestore-backed production adapter selected with `REPOSITORY_PROVIDER=firestore`.

Rules:

- Do not mutate repository results in place.
- Keep methods intent-based and small.
- Add filters explicitly when services need them.
- Store provider snapshots in `metadata`, not top-level fields unless the field is part of the stable domain model.
- Cloud Run should run with `REPOSITORY_PROVIDER=firestore` and `FIRESTORE_DATABASE_ID=newleafdb`.

Stable domain records:

- `job`
- `artifact`
- `providerJob`
- `publishPlan`
- `publishAttempt`
- `socialAccount`
- `secret`
- `webhookEvent`

## User Access Pattern

`admin-web` is the authoritative writer for NewLeaf user access. It must write the same Firebase Auth user record consumed by `client-web`.

Rules:

- Firestore-backed users are stored in `users/{uid}` in project `newleaf-trading`, database `newleafdb`; the API repository may keep the internal method names `listAppUsers`, `updateAppUser`, etc.
- The stable user entitlement fields are `role`, `roles`, `status`, and `appAccess`.
- Canonical `appAccess` keys are `admin`, `invest`, `picks`, `workbench`, `quant`, and `desk`.
- `sd.nirsha@gmail.com` and `manish28june@gmail.com` are immutable admins. They always receive admin role and all app access in admin-web and client-web, and cannot be demoted or deleted through user management.
- The Users section should update role and application access together through `PATCH /api/v1/users/:userId`.
- `client-web` treats `appAccess` as the product navigation and route-access source of truth. Do not add a separate client-web-only entitlement store.
- `VITE_ADMIN_EMAILS` in client-web is bootstrap fallback only; once `admin-web` writes explicit `appAccess`, Firestore wins for env-only bootstrap admins.
- Firestore rules may allow a user to create or update only their own identity and conservative default `appAccess`; only admins may grant paid/private app access.

## Job State Pattern

Use `jobStateService` for meaningful workflow transitions. Avoid route-level status rewrites unless a status is local-only or explicitly harmless.

Important statuses:

- `draft`
- `source_ingested`
- `script_ready`
- `video_requested`
- `video_ready`
- `review_required`
- `approved`
- `publishing`
- `published`
- `partial_failed`
- `failed`

## Review Deletion Pattern

Admins can delete jobs that are still under review when the job has not entered publishing.

Rules:

- allow review deletion only for `review_required` and `video_ready`;
- reject deletion if any publish plan or publish attempt exists for the job;
- delete the job plus local repository artifact and provider-job records;
- use a custom confirmation modal in the admin UI;
- record a session audit event with title, status, source type, deleted artifact count, and deleted provider-job count.

Do not use this review delete path for approved, publishing, published, imported, or provider-published records. Those must go through publishing delete/archive flows so audit history is retained.

## Review Script Editing Pattern

The Review Workspace can edit scripts only for text-to-HeyGen jobs. Local uploads and YouTube embeds should not show script regeneration controls.

Rules:

- keep the script editor in the admin UI, but persist edits through `PATCH /api/v1/jobs/:jobId`;
- store reviewer edits in job metadata as `reviewScriptText`, `prompt`, and `scriptPreview`;
- when regenerating video from Review, send the current edited script text to `POST /api/v1/jobs/:jobId/regenerate-video`;
- backend services still own the HeyGen API call, provider jobs, manifest generation, and assembly;
- record a session audit event when a reviewer saves an edited script or requests regeneration from it.

This supports scripts generated outside NewLeaf, such as GPT or Claude drafts pasted by an editor, without letting the admin UI call external AI or video providers directly.

## Publishing Pattern

Publishing must fan out from one plan into one attempt per platform.

```text
job -> publishPlan -> publishAttempt[youtube]
                  -> publishAttempt[x]
                  -> publishAttempt[linkedin]
```

Attempt statuses:

- `queued`
- `retrying`
- `uploading`
- `processing`
- `published`
- `failed`
- `delete_requested`
- `deleted`

Each attempt should store progress metadata:

```json
{
  "publisherStatus": "Uploading video bytes to YouTube.",
  "progressStage": "uploading",
  "progressPercent": 45,
  "progressLabel": "Uploading video bytes to YouTube.",
  "uploadedBytes": 1048576,
  "totalBytes": 8388608,
  "lastProgressAt": "timestamp"
}
```

Publish metadata is required before a plan can publish:

- `title`: required, used as the YouTube video title, LinkedIn media title, Facebook video title, and the leading line for text-based social posts.
- `description`: required, used as YouTube/Facebook description and post body for LinkedIn, X, Instagram, and Facebook.
- `hashtags`: optional cross-platform hashtags. Store without `#`; publishers add the prefix when composing post text.
- `tags`: optional YouTube metadata tags. These are not the same as visible hashtags.

The API must enforce required `title` and `description` at publish-plan creation and again before starting an existing approved plan, so older draft data cannot bypass the rule.

## Provider Adapter Pattern

Provider publishing logic belongs in service modules. The current app has a dedicated YouTube publisher and a multi-platform social publisher service.

Provider methods should use this conceptual interface:

```ts
publishAttempt(attemptId): Promise<PublishResult>
updateMetadata?(attemptId, metadata, context): Promise<UpdateResult>
updatePrivacy?(attemptId, privacyStatus, context): Promise<UpdateResult>
deletePublication?(attemptId, context): Promise<DeleteResult>
importChannelPublications?(options): Promise<ImportResult>
resumeQueuedAttempts(): Promise<ResumeResult>
```

Provider implementations must:

- resolve the assigned connected account;
- load tokens through opaque secret references by calling `repository.getSecret(account.tokenSecretRef)`;
- verify required scopes before provider calls;
- persist intermediate provider IDs as soon as possible;
- update progress before long-running work;
- handle provider errors with actionable messages;
- preserve local audit records after provider deletes.
- clear stale `metadata.failureDetails` when retrying or moving an attempt back into an active progress state, so queued/uploading records do not display old failure payloads.

## OAuth Pattern

OAuth starts in the API and finishes in the API callback.

```text
POST /api/v1/social/:platform/oauth/start
GET  /api/v1/social/:platform/oauth/callback
```

Rules:

- Store an OAuth state record before redirecting.
- Include reconnect target when reconnecting an existing account.
- Store only secret references in account metadata.
- Keep refresh tokens and access tokens in managed secret storage.
- Merge configured scopes and existing saved scopes on reconnect so new permissions are requested without silently dropping old ones.

## OAuth Secret Reference Pattern

OAuth token references are repository-owned implementation details. Service code must treat `tokenSecretRef` as opaque.

Rules:

- Publisher, sync, import, thumbnail, metadata-update, and delete services must not check storage prefixes such as `dev-memory:` or `firestore-secret:`.
- Services must resolve tokens only through `repository.getSecret(account.tokenSecretRef)`.
- Services may write refreshed token payloads only through `repository.putSecret(...)` using the existing secret id and metadata.
- Local development may return `dev-memory:` refs and Firestore production may return `firestore-secret:` refs. Future Google Secret Manager refs should not require publisher service changes.
- Only repository adapters may parse or normalize secret reference prefixes.
- Errors should say the OAuth token secret is missing, expired, or lacks scope. They should not say a non-local secret type is unsupported.

## Webhook Pattern

Webhook routes should:

- respond quickly to provider validation requests;
- verify signatures before trusting payloads;
- record an idempotency key;
- persist raw provider payloads where useful;
- enqueue follow-up work instead of doing heavy work inline.

## Video Assembler Pattern

Generated multi-clip videos must be assembled from a manifest timeline, not from provider completion order.

Rules:

- `sequence` is the only source of truth for final clip order.
- Keep `segmentKey` stable so a HeyGen result, uploaded replacement, transcript, and review note can all target the same timeline segment.
- Store completed clip files under sequence-aware paths such as `input/20-market-context.mp4`.
- Use `SegmentStatusService` to map HeyGen completion events from `heygenVideoId` back to `projectId`, `sequence`, and `segmentKey`.
- HeyGen webhook or polling completion order is random and must only update segment status/source URL; it must never define timeline order.
- `videoAssemblyService` owns manifest creation, per-segment provider jobs, completion materialization, FFmpeg stitching, and final artifact creation.
- In local development without `HEYGEN_API_KEY`, provider jobs use deterministic dev HeyGen IDs and can be completed through the authenticated dev completion endpoint.
- If `HEYGEN_API_KEY` is configured, use HeyGen Video Agent for prompt-based segment generation and keep raw credentials out of manifests, provider job payloads, and audit records.
- Validate duplicate `sequence` and duplicate `segmentKey` before any FFmpeg work starts.
- Validate all required segments are `completed` and have local files before normalizing or stitching.
- Normalize every clip before concat because provider clips may differ in dimensions, fps, codecs, or audio settings.
- Keep the assembler callable outside Express so webhook workers, queue workers, and local CLI runs can share the same logic.

Use `docs/video-assembler.md` for the CLI and manifest details.

## Video Studio Pattern

Video Studio edits are timeline metadata until render time. Do not mutate uploaded source files when an admin changes trim, mute, callout, voiceover, or avatar settings.

Rules:

- store project timelines under local project storage in development, such as `.local-data/video-projects/<projectId>/timeline.json`;
- keep uploaded screen recordings, voiceovers, and avatar clips under the same project root;
- validate source paths against the project root before passing them to FFmpeg;
- use the backend renderer for FFmpeg work; the admin UI only edits timeline JSON;
- use byte-range streaming for preview and output video routes so browser seeking works;
- expose delete controls for project assets and local projects through custom confirmation modals;
- represent zoom effects as timeline tracks and render them in the backend with FFmpeg;
- render synchronously only for short MVP videos. Production render should move to a queue worker with persisted progress.

Current routes:

```text
POST /api/v1/video-projects
DELETE /api/v1/video-projects/:projectId
GET  /api/v1/video-projects/:projectId/timeline
PUT  /api/v1/video-projects/:projectId/timeline
POST /api/v1/video-projects/:projectId/assets
DELETE /api/v1/video-projects/:projectId/assets/:trackId
POST /api/v1/video-projects/:projectId/render
GET  /api/v1/video-projects/:projectId/status
GET  /api/v1/video-projects/:projectId/output
```

## Admin API Client Pattern

`apps/admin/src/api.js` owns all HTTP calls and response normalization.

Section components should consume normalized records. They should not know raw provider response shapes.

Normalization should:

- provide default arrays for optional arrays;
- convert provider platform names into UI labels;
- expose display-ready dates;
- extract thumbnail URLs and provider URLs;
- keep raw metadata available for advanced views.

## External Service API Pattern

External systems should not call broad admin endpoints. Use narrow service endpoints mounted under `/api/v1/service`.

Rules:

- prefer managed vendor clients from the Vendors page;
- require signed requests with `x-newleaf-key-id`, `x-newleaf-timestamp`, and `x-newleaf-signature`;
- compute signatures with HMAC-SHA256 over method, path, timestamp, and raw body hash;
- keep the legacy `SERVICE_API_KEY_HASHES` path only for local scripted compatibility;
- set `req.user.uid` to a service identity such as `service:<clientId>`;
- store only the service client id or short fingerprint in job metadata for ownership checks;
- enforce idempotency through caller-provided `idempotencyKey`;
- accept full markdown scripts as plain JSON text or UTF-8 `scriptBase64`; base64 is a transport encoding only, not a security layer;
- return sanitized jobs, provider jobs, manifests, and artifacts; never return raw provider request payloads, API keys, OAuth tokens, local file paths, or full repository records;
- expose service-owned artifact content only after checking the job belongs to the same service key fingerprint;
- expose vendor documentation through `GET /api/v1/service/docs` and the raw OpenAPI contract through `GET /api/v1/service/openapi.yaml`;
- protect docs routes with either an approved admin Firebase bearer token, approved admin session cookie, or valid vendor service credentials;
- keep every operational service route protected by signed request headers;
- keep a low default rate limit and move rate limiting to Firebase Hosting, Cloud Run, or API gateway ingress for production.

The current text-to-HeyGen service endpoint is:

```text
GET  /api/v1/service/docs
GET  /api/v1/service/openapi.yaml
POST /api/v1/service/text-to-heygen/jobs
GET  /api/v1/service/jobs/:jobId
POST /api/v1/service/jobs/:jobId/retry
GET  /api/v1/service/jobs/:jobId/artifacts/:artifactId/content
```

## Thumbnail Pattern

Thumbnails are job-scoped `thumbnail` artifacts.

Rules:

- store uploaded and generated thumbnails through the backend, never through direct admin UI storage calls;
- keep thumbnail files under `LOCAL_DATA_DIR`;
- update job metadata with `thumbnailArtifactId`, `thumbnailSource`, and `thumbnailUpdatedAt` when a thumbnail is selected;
- generate local-video thumbnails through FFmpeg from the current local video artifact;
- allow manual upload for any source type, including YouTube embeds and remote provider videos;
- show the same thumbnail controls in Review, Content Queue, and Published Videos so admins do not need to switch pages.
- Published Videos thumbnail changes must update the publication metadata as well as the job thumbnail artifact. For YouTube records, the backend should attempt `thumbnails.set` when the account has the required update scope.

Current endpoints:

```text
POST /api/v1/jobs/:jobId/thumbnail/upload
POST /api/v1/jobs/:jobId/thumbnail/generate
```

## Asset Storage Pattern

Local development uses `.local-data` by default for cost control, speed, and offline development. Production Cloud Run must use object storage for media artifacts because `/tmp` is ephemeral and not shared across instances. Local development may opt into the production-like object storage path by setting `GCS_BUCKET`.

Rules:

- `GCS_BUCKET` is the canonical backend media bucket setting; do not add provider-switch env vars for production;
- when `GCS_BUCKET` is unset, local admin uploads remain in `.local-data` and artifacts use `storageProvider: "local-disk"`;
- when `GCS_BUCKET` is configured, admin uploads must write bytes to Firebase Storage / Google Cloud Storage and store artifacts with `storageProvider: "gcs"`;
- do not force all local video files into the bucket by default; use `GCS_BUCKET` locally only when testing Cloud Run/publisher/storage behavior end to end;
- artifact `storageKey` values are object keys, never raw user paths;
- API preview/download endpoints may stream `gcs` artifacts back through authenticated routes;
- publisher services must materialize `gcs` artifacts into a short-lived `/tmp` cache before provider upload;
- publisher services must not assume `metadata.localPath` exists in Cloud Run;
- old `local-disk` artifacts whose files are missing must fail with an actionable re-upload/regenerate message.

## Admin Section Pattern

Feature sections live in `apps/admin/src/sections`.

Preferred shape:

```jsx
export function SectionName(props) {
  return <div className="view-stack">...</div>;
}
```

Use section-local state for UI-only concerns such as:

- selected filters;
- open modals;
- open action menus;
- local form fields.

Keep API mutations in `App.jsx` or a dedicated state owner unless the mutation is truly section-local.

## UI Pattern

The app is an operations console. Favor:

- dense but readable tables;
- compact cards for repeated records;
- modals for focused details and confirmations;
- progress meters for long-running provider work;
- top-right action menus for per-card operations;
- filters that reduce operational noise.

Avoid:

- marketing-style landing pages;
- decorative hero sections;
- browser `alert`, `confirm`, or `prompt`;
- showing provider internals as default UI when a concise status is enough.

## Button Color Pattern

Buttons use a simple two-level hierarchy unless a provider-specific or destructive action needs special treatment.

Primary buttons:

- Use only for the main commit action in a focused area: create job, create plan, authorize account, approve, publish, save.
- Use the NewLeaf admin accent tokens:
  - background: `--button-primary-bg` / `--accent` (`#2364aa`)
  - hover background: `--button-primary-hover-bg` / `--accent-strong` (`#164a82`)
  - text: `--button-primary-text` (`#ffffff`)
- Apply with `className="primary"`.

Secondary buttons:

- Use for navigation, cancel, open details, filters, retry, and supporting actions.
- Default `button` styling is the secondary style. `className="secondary"` is optional and only needed for clarity.
- Use the neutral tokens:
  - background: `--button-secondary-bg` / `--surface` (`#ffffff`)
  - border: `--button-secondary-border` / `--line` (`#d8dee4`)
  - text: `--button-secondary-text` / `--ink` (`#1f2933`)
  - hover background: `--button-secondary-hover-bg` / `--surface-alt` (`#eef4f2`)
  - hover text: `--button-secondary-hover-text` / `--accent-strong` (`#164a82`)

Destructive buttons use `button.danger`. Provider-specific sync buttons may use brand color, but only inside provider-local sections.

## Brand Color Pattern

Use brand color only where it helps admins understand provider-specific context.

Good uses:

- platform section accents;
- provider sync buttons;
- connected-account identity markers;
- destination chips for YouTube, LinkedIn, X, Instagram, Facebook, and TikTok.

Avoid using provider brand colors for generic product actions such as saving forms, approving review jobs, closing modals, or filtering tables. Those controls should keep the NewLeaf admin palette so the UI does not become visually noisy.

When a platform-specific action exists in a multi-platform view, place it inside that platform section instead of as a global page action. If only one provider is currently implemented, disabled provider-local buttons may be shown for parity, but their copy must make the unavailable state clear.

## Published Videos Pattern

The Published Videos section is a library, not a raw debug view.

Active records should show video cards with:

- thumbnail;
- title;
- account/channel;
- status and visibility badges;
- provider URL action;
- visibility control where supported;
- editable title, description, tags, hashtags, and thumbnail controls;
- `...` action menu for delete, hype, and YouTube republish actions.

Deleted records should be available through filters and should read as audit records.

Sync controls belong inside each platform section. For example, YouTube channel import appears in the YouTube section, not in the Published Library toolbar.

YouTube published records may start a republish flow from the card. The UI should collect destination channels, schedule, and replacement metadata in one modal, then create a publish plan with `republishOfPublicationId`. Only explicit republish plans may bypass the normal duplicate-platform guard; standard publishing must continue blocking accidental reposts to already-published or active platforms.

## Content Queue Archive Pattern

Content Queue is for active operational work. Do not show publishing records there after provider videos have been deleted and the remaining platform attempts are only failed leftovers without provider post IDs.

Archived publishing records should move to Audit and Published Videos deleted filters:

- plans with status `deleted`;
- plans where every attempt is `deleted`;
- plans with at least one deleted attempt and only failed, no-provider leftovers.

Keep deleted publication records in the repository for audit. Hide them from active queue and upload progress views with shared helpers such as `isArchivedPublishPlan`.

Dashboard publishing summaries must use the same archive helper. Deleted or archived publishing records belong in Audit and Published Videos filters, not in the Dashboard active Publishing Plans list or active metrics.

## Audit Pattern

Audit views must show enough detail for production troubleshooting, not only action names.

Use progressive disclosure for audit detail. The first view should show compact summary facts; detailed request fields, provider IDs, attempt cards, and progress meters should render only after an admin expands the audit card. The compact audit row itself is the accordion trigger; avoid separate `Show details` buttons.

Session audit events should include:

- action;
- actor;
- resource id or label;
- captured time;
- request details such as platform, plan id, attempt id, previous status, next status, provider id, sync counts, or changed fields.

Archived publishing audit records should show:

- plan id, job id, platforms, schedule, approval, archive reason, and timestamps;
- every platform attempt with account, provider post id, provider URL, visibility, status, error code/message, and progress;
- deleted publication details with delete reason, deleted by, provider deletion result, post id, title, description, tags, hashtags, and retained progress metadata.

For production, persist audit events in the backend repository instead of only client session state. Provider secrets and raw OAuth tokens must never be written into audit records.

## Publication Channel Sync Pattern

Channel sync imports videos that exist in a connected social account even if NewLeaf did not upload them.

Flow:

1. The Published Videos platform section calls `importPlatformPublications(platform)`.
2. The admin API client posts to `POST /api/v1/publications/import/:platform`.
3. The publishing route validates the platform and delegates to `socialPublisherService.importChannelPublications(...)`.
4. `socialPublisherService` delegates provider-specific imports to `socialPublicationImportService`.
5. The importer resolves a connected account, loads/refreshes the OAuth token, and verifies required read scopes.
6. Provider records are normalized into external `job`, `publishPlan`, and `publishAttempt` records.
7. The route returns normalized publications to the UI.

Current sync providers:

- YouTube: delegated to the YouTube publisher importer. It reads the authenticated uploads playlist and batches `videos.list` details.
- X: reads recent authenticated-user posts with media expansions and imports video or animated GIF posts.
- LinkedIn: reads owner posts and imports records with video media.
- Facebook: reads Page videos through the Graph API.
- Instagram: reads professional account media and imports video or reel records.

Do not create duplicates for the same provider post ID. Provider IDs are the durable idempotency key. Deleted records stay as audit records and should not be overwritten back to active by sync unless the user explicitly requests a restore behavior.

## Secrets Pattern

Never put real values in docs or examples.

Allowed examples:

```env
OPENAI_API_KEY=sk-...
YOUTUBE_CLIENT_SECRET=...
```

Disallowed examples:

- full API keys;
- OAuth refresh tokens;
- `.local-data/repository.json` secret values;
- copied provider callback payloads containing credentials.

## Verification Pattern

Run the strongest cheap checks available:

```bash
npm run check
npm run build -w @newleaf/admin
```

For provider changes, add or document manual verification steps because many flows require real OAuth apps, app review, quota, and provider-side permissions.
