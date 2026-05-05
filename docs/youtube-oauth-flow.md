# YouTube OAuth Connection Flow

The Accounts UI should use Google's OAuth 2.0 web-server flow for YouTube. This lets an admin click `Connect` or `Reconnect`, complete Google SSO/consent in the browser, and return to NewLeaf with a connected YouTube channel.

## Required Google Setup

This cannot be fully avoided by code:

1. Create or select a Google Cloud project.
2. Enable YouTube Data API v3.
3. Configure the OAuth consent screen.
4. Create an OAuth 2.0 `Web application` client.
5. Add the redirect URI:

```text
http://localhost:8080/api/v1/social/youtube/oauth/callback
```

6. Set these backend env vars:

```text
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=http://localhost:8080/api/v1/social/youtube/oauth/callback
```

## Runtime Flow

1. Admin clicks `Authorize YouTube`.
2. Admin UI calls:

```http
POST /api/v1/social/youtube/oauth/start
```

3. API creates an OAuth state and redirects the browser to:

```text
https://accounts.google.com/o/oauth2/v2/auth
```

with:

- `response_type=code`
- `access_type=offline`
- `include_granted_scopes=true`
- `prompt=consent`
- `scope=https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly`

`youtube.upload` is enough for video uploads, but the local connection flow also calls `channels.list?mine=true` to identify the selected channel. That channel lookup requires `youtube.readonly` or another read-capable YouTube scope.

4. Google redirects back to:

```http
GET /api/v1/social/youtube/oauth/callback?code=...&state=...
```

5. API exchanges the code at:

```text
https://oauth2.googleapis.com/token
```

6. API calls:

```http
GET https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&mine=true&maxResults=1
```

7. API stores the token payload through the secret abstraction and stores only account metadata plus `tokenSecretRef`.

## Upload Scope

Video upload uses:

```text
https://www.googleapis.com/auth/youtube.upload
```

The upload endpoint is:

```http
POST https://www.googleapis.com/upload/youtube/v3/videos
```

`videos.insert` costs 100 quota units per call.

## Production Notes

- OAuth tokens are loaded through the repository secret abstraction. Publisher and sync services must treat `tokenSecretRef` as opaque so local `dev-memory:`, Firestore `firestore-secret:`, and future Google Secret Manager references work without provider-service changes.
- If stricter secret isolation is needed later, move token payload storage behind the repository adapter to Google Secret Manager without changing publisher services.
- If Google does not return a refresh token, the user likely already granted consent. Use `prompt=consent` for reconnects when a refresh token is required.
- Public video uploads from unverified API clients can be restricted by Google until app verification/audit is complete.
- Do not use a Google service account for a normal YouTube channel. YouTube user-channel publishing requires OAuth user consent.

## Official References

- Server-side OAuth for YouTube Data API: https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps
- YouTube OAuth scopes: https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps#identify-access-scopes
- YouTube channels.list: https://developers.google.com/youtube/v3/docs/channels/list
- YouTube videos.insert: https://developers.google.com/youtube/v3/docs/videos/insert
- YouTube OAuth overview: https://developers.google.com/youtube/v3/guides/authentication
