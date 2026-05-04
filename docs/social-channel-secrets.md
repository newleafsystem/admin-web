# Social Channel Secrets

Use this project with one connected account per publishing channel. Your Google account can authorize YouTube, but Facebook, Instagram, X/Twitter, LinkedIn, and TikTok still require their own OAuth apps and account tokens.

## Local Development

The normal local path now uses OAuth account management and repository state. Do not commit sample account JSON.

If you need a temporary local-only account config while debugging legacy flows, create an untracked JSON file outside committed sample folders and point `.env` at it:

```bash
SOCIAL_ACCOUNTS_CONFIG_PATH=.local-data/social-accounts.local.json
```

Leave `SOCIAL_ACCOUNTS_CONFIG_PATH` blank when using OAuth/Firestore account state.

## Production

Production should not depend on a local JSON file. Store these values in Google Secret Manager or an equivalent managed secret store:

- OAuth client secrets
- OAuth refresh tokens
- HeyGen API key
- HeyGen webhook secret
- storage signing or service-account secrets, if any direct object access keys are introduced
- Token encryption keys

Firestore should store only non-secret metadata and secret references, such as:

```json
{
  "platform": "youtube",
  "accountName": "NewLeaf YouTube Channel",
  "status": "connected",
  "scopes": ["https://www.googleapis.com/auth/youtube.upload"],
  "tokenSecretRef": "projects/newleaf-prod/secrets/youtube-main-oauth-token"
}
```

## Admin-Driven Account Management

The normal workflow should be:

1. Admin clicks `Connect account`.
2. Backend creates a signed OAuth state and redirects to the provider.
3. Provider redirects back to `/api/v1/social/:platform/oauth/callback`.
4. Backend exchanges the code for tokens.
5. Backend stores refresh-token payloads in Secret Manager.
6. Backend stores account metadata and `tokenSecretRef` in Firestore.

The local JSON template is only for bootstrapping and development. After OAuth is implemented, admins should not edit JSON files to add or reconnect publishing accounts.

## Why Not One Google Credential

Publishing APIs are separate trust relationships:

- YouTube uses Google OAuth and the YouTube Data API.
- Facebook and Instagram use Meta OAuth and Graph API permissions.
- X/Twitter uses X OAuth scopes for posts and media.
- LinkedIn uses LinkedIn OAuth and page/member permissions.
- TikTok uses TikTok OAuth and Content Posting permissions.

If you use Google SSO to log into another platform, that does not give this backend permission to publish through that platform's API. Each channel must go through its provider's OAuth flow.
