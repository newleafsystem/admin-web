# `@newleaf/publishers`

Plain JavaScript ES module scaffold for NewLeaf publishing workers.

This package owns the common publisher adapter convention, validation helpers, idempotency guidance, and provider-specific placeholder adapters for:

- YouTube
- X / Twitter
- LinkedIn
- Instagram / Facebook through Meta Graph API
- TikTok

No adapter makes a real network call yet. `publish()` and `refreshStatus()` return structured placeholder results that make it clear what would be persisted by the worker once provider integrations are implemented.

## Publisher Convention

JavaScript does not enforce interfaces, so adapters follow this object shape by convention:

```js
{
  platform: "youtube",
  validate(plan) {},
  publish(attempt) {},
  refreshStatus(attempt) {}
}
```

The intended contract mirrors the architecture document:

```ts
interface Publisher {
  platform: string;
  validate(plan: PublishPlan): Promise<ValidationResult>;
  publish(attempt: PublishAttempt): Promise<PublishResult>;
  refreshStatus?(attempt: PublishAttempt): Promise<PublishStatus>;
}
```

Usage:

```js
import { getPublisher } from "@newleaf/publishers";

const publisher = getPublisher("youtube");
const validation = await publisher.validate(plan);

if (validation.ok) {
  const result = await publisher.publish(attempt);
  // Persist result.providerPostId, result.providerUrl, result.idempotency, and snapshots.
}
```

## Expected Inputs

Adapters accept plain objects that can be shaped from `publishPlans/{planId}` and `publishAttempts/{attemptId}`.

```js
const plan = {
  planId: "plan-123",
  jobId: "job-123",
  platform: "youtube",
  video: {
    storageKey: "jobs/job-123/video/final.mp4",
    mimeType: "video/mp4",
    sizeBytes: 12345678,
    durationSec: 240,
    width: 1920,
    height: 1080,
    checksum: "sha256:..."
  },
  metadata: {
    title: "BABA Iron Condor: Defined-Risk Trade Setup",
    caption: "Educational content, not financial advice.",
    description: "Educational content, not financial advice.",
    tags: ["BABA", "options", "ironcondor"],
    privacy: "private"
  }
};
```

```js
const attempt = {
  attemptId: "attempt-123",
  planId: "plan-123",
  jobId: "job-123",
  platform: "youtube",
  connectedAccountId: "account-123",
  attemptNo: 1,
  plan
};
```

## Validation

`src/validation.js` provides helpers for:

- Video size.
- Video duration.
- Video width and height.
- Video aspect ratio.
- Caption, title, description, and tag limits.

The default provider limits are scaffold policy defaults, not live provider guarantees. Replace them with provider-audited limits during each real integration because social API media restrictions and app-review rules change.

## Idempotency Guidance

Publishing workers should treat the persisted `publishAttempt` as the idempotency boundary.

- Use `platform + publishAttemptId` as the stable idempotency key for retries.
- Persist provider media/upload IDs before creating the final public post.
- Never create more than one public post for the same `publishAttempt`.
- Store provider request and response snapshots for debugging and audit logs.
- On retry, resume from the last persisted provider step when the API supports it.
- Put repeatedly failing attempts on a dead-letter queue with enough state to investigate.

## Provider TODOs

### YouTube

- Add OAuth token refresh using the connected account secret reference.
- Request and verify the `youtube.upload` scope.
- Implement `videos.insert` with resumable upload.
- Map title, description, tags, privacy, scheduled publish time, and synthetic media declaration.
- Confirm behavior for unaudited API projects that may force private visibility.
- Persist YouTube video ID, processing state, canonical watch URL, and request/response snapshots.

### X / Twitter

- Add OAuth token refresh using the connected account secret reference.
- Implement chunked media upload: initialize, append chunks, finalize, and status polling.
- Persist `media_id` and processing state before creating the post.
- Create the final post only after media processing is complete.
- Keep retries idempotent so a completed media upload does not produce duplicate posts.

### LinkedIn

- Add OAuth token refresh using the connected account secret reference.
- Support person-owned and organization-owned video publishing.
- Implement initialize upload, one or more video part uploads, finalize upload, and share creation.
- Preserve upload ETags for finalize.
- Persist the returned video URN, share URN, public URL, and request/response snapshots.

### Instagram / Facebook

- Add OAuth token refresh using the connected account secret reference.
- Keep the adapter behind feature flags because Meta permissions and app review can block production.
- Verify the Instagram account is professional and linked to a Facebook Page.
- Implement create-container then publish-container flow for Reels/feed publishing.
- Persist container IDs, publish IDs, public URLs, and request/response snapshots.

### TikTok

- Add OAuth token refresh using the connected account secret reference.
- Implement Content Posting API direct-post or inbox flow based on account/app approval.
- Handle audit restrictions that may limit unaudited clients to private or inbox flows.
- Persist upload IDs, publish IDs, inbox/manual-completion state, public URLs, and request/response snapshots.
