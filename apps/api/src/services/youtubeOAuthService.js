import crypto from 'node:crypto';
import { config } from '../config.js';
import { badRequest, conflict } from '../lib/httpErrors.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const YOUTUBE_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';

export function createYouTubeOAuthService(options = {}) {
  const serviceConfig = options.config ?? config.youtube;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    getMissingConfig() {
      return [
        ['YOUTUBE_CLIENT_ID', serviceConfig.clientId],
        ['YOUTUBE_CLIENT_SECRET', serviceConfig.clientSecret],
        ['YOUTUBE_REDIRECT_URI', serviceConfig.redirectUri],
      ]
        .filter(([, value]) => !value)
        .map(([name]) => name);
    },

    isConfigured() {
      return this.getMissingConfig().length === 0;
    },

    createStateId() {
      return `youtube_${crypto.randomUUID()}`;
    },

    buildAuthorizationUrl({ state, loginHint, scopes = serviceConfig.scopes, prompt = 'consent' }) {
      const missing = this.getMissingConfig();
      if (missing.length > 0) {
        return {
          setupRequired: true,
          missing,
          setup: 'Create a Google OAuth web client, enable YouTube Data API v3, and configure the redirect URI.',
        };
      }

      const params = new URLSearchParams({
        client_id: serviceConfig.clientId,
        redirect_uri: serviceConfig.redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        access_type: 'offline',
        include_granted_scopes: 'true',
        prompt,
        state,
      });
      if (loginHint) {
        params.set('login_hint', loginHint);
      }

      return {
        setupRequired: false,
        authorizationUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`,
        redirectUri: serviceConfig.redirectUri,
        scopes,
      };
    },

    async exchangeAuthorizationCode(code) {
      const missing = this.getMissingConfig();
      if (missing.length > 0) {
        throw conflict('YouTube OAuth is not configured', { missing });
      }

      const response = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          code,
          client_id: serviceConfig.clientId,
          client_secret: serviceConfig.clientSecret,
          redirect_uri: serviceConfig.redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw badRequest('Google OAuth token exchange failed', {
          status: response.status,
          error: payload.error,
          errorDescription: payload.error_description,
        });
      }

      return normalizeTokenPayload(payload);
    },

    async refreshAccessToken(refreshToken) {
      const missing = this.getMissingConfig();
      if (missing.length > 0) {
        throw conflict('YouTube OAuth is not configured', { missing });
      }

      const response = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          refresh_token: refreshToken,
          client_id: serviceConfig.clientId,
          client_secret: serviceConfig.clientSecret,
          grant_type: 'refresh_token',
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw badRequest('Google OAuth refresh failed', {
          status: response.status,
          error: payload.error,
          errorDescription: payload.error_description,
        });
      }

      return normalizeTokenPayload(payload);
    },

    async fetchMyChannel(accessToken) {
      const url = new URL(YOUTUBE_CHANNELS_URL);
      url.searchParams.set('part', 'snippet,contentDetails');
      url.searchParams.set('mine', 'true');
      url.searchParams.set('maxResults', '1');

      const response = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw badRequest('Unable to read the authorized YouTube channel', {
          status: response.status,
          error: payload.error,
        });
      }

      const channel = payload.items?.[0];
      return {
        id: channel?.id ?? null,
        title: channel?.snippet?.title ?? null,
        description: channel?.snippet?.description ?? null,
        thumbnailUrl:
          channel?.snippet?.thumbnails?.default?.url ??
          channel?.snippet?.thumbnails?.medium?.url ??
          channel?.snippet?.thumbnails?.high?.url ??
          null,
        uploadsPlaylistId: channel?.contentDetails?.relatedPlaylists?.uploads ?? null,
        raw: channel ?? null,
      };
    },

    async revokeToken(token) {
      const response = await fetchImpl(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token }),
      });
      return {
        revoked: response.ok,
        status: response.status,
      };
    },
  };
}

function normalizeTokenPayload(payload) {
  const expiresIn = Number(payload.expires_in ?? 0);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    scope: payload.scope ?? null,
    scopes: typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [],
    tokenType: payload.token_type ?? 'Bearer',
    expiresIn,
    expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    raw: payload,
  };
}
