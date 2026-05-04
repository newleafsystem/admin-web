import crypto from 'node:crypto';
import { config } from '../config.js';
import { badRequest, conflict } from '../lib/httpErrors.js';

const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const X_ME_URL = 'https://api.x.com/2/users/me';
const LINKEDIN_AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
const LINKEDIN_ME_URL = 'https://api.linkedin.com/v2/me';

export function createSocialOAuthService(options = {}) {
  const serviceConfig = options.config ?? config;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    createStateId(platform) {
      return `${platform}_${crypto.randomUUID()}`;
    },

    buildAuthorizationUrl({ platform, state, loginHint = null, scopes = null }) {
      const platformConfig = getProviderConfig(serviceConfig, platform);
      const missing = getMissingConfig(platform, platformConfig);
      if (missing.length > 0) {
        return {
          setupRequired: true,
          missing,
          setup: setupMessage(platform),
        };
      }

      if (platform === 'x') {
        return buildXAuthorizationUrl({ platformConfig, state, scopes, loginHint });
      }
      if (platform === 'linkedin') {
        return buildLinkedInAuthorizationUrl({ platformConfig, state, scopes });
      }
      if (platform === 'facebook' || platform === 'instagram') {
        return buildMetaAuthorizationUrl({ platform, platformConfig, state, scopes });
      }
      throw badRequest('Unsupported OAuth platform', { platform });
    },

    async exchangeAuthorizationCode({ platform, code, oauthState }) {
      const platformConfig = getProviderConfig(serviceConfig, platform);
      const missing = getMissingConfig(platform, platformConfig);
      if (missing.length > 0) {
        throw conflict(`${platform} OAuth is not configured`, { missing });
      }

      if (platform === 'x') {
        return exchangeXAuthorizationCode({
          fetchImpl,
          platformConfig,
          code,
          codeVerifier: oauthState.metadata?.codeVerifier,
        });
      }
      if (platform === 'linkedin') {
        return exchangeLinkedInAuthorizationCode({ fetchImpl, platformConfig, code });
      }
      if (platform === 'facebook' || platform === 'instagram') {
        return exchangeMetaAuthorizationCode({ fetchImpl, platformConfig, code });
      }
      throw badRequest('Unsupported OAuth platform', { platform });
    },

    async fetchAccountProfile({ platform, accessToken }) {
      if (platform === 'x') {
        return fetchXProfile({ fetchImpl, accessToken });
      }
      if (platform === 'linkedin') {
        return fetchLinkedInProfile({ fetchImpl, accessToken });
      }
      if (platform === 'facebook' || platform === 'instagram') {
        return fetchMetaProfile({
          fetchImpl,
          platform,
          platformConfig: serviceConfig.meta,
          accessToken,
        });
      }
      throw badRequest('Unsupported OAuth platform', { platform });
    },
  };
}

function buildXAuthorizationUrl({ platformConfig, state, scopes, loginHint }) {
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
  const requestedScopes = scopes ?? platformConfig.scopes;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: platformConfig.clientId,
    redirect_uri: platformConfig.redirectUri,
    scope: requestedScopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  if (loginHint) {
    params.set('login_hint', loginHint);
  }
  return {
    setupRequired: false,
    authorizationUrl: `${X_AUTHORIZE_URL}?${params.toString()}`,
    redirectUri: platformConfig.redirectUri,
    scopes: requestedScopes,
    metadata: {
      codeVerifier,
      codeChallenge,
      codeChallengeMethod: 'S256',
    },
  };
}

function buildLinkedInAuthorizationUrl({ platformConfig, state, scopes }) {
  const requestedScopes = scopes ?? platformConfig.scopes;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: platformConfig.clientId,
    redirect_uri: platformConfig.redirectUri,
    state,
    scope: requestedScopes.join(' '),
  });
  return {
    setupRequired: false,
    authorizationUrl: `${LINKEDIN_AUTHORIZE_URL}?${params.toString()}`,
    redirectUri: platformConfig.redirectUri,
    scopes: requestedScopes,
    metadata: {},
  };
}

function buildMetaAuthorizationUrl({ platform, platformConfig, state, scopes }) {
  const requestedScopes = scopes ?? (platform === 'instagram' ? platformConfig.instagramScopes : platformConfig.facebookScopes);
  const params = new URLSearchParams({
    client_id: platformConfig.appId,
    redirect_uri: platformConfig.redirectUri,
    state,
    scope: requestedScopes.join(','),
    response_type: 'code',
    auth_type: 'rerequest',
  });
  return {
    setupRequired: false,
    authorizationUrl: `https://www.facebook.com/${platformConfig.graphVersion}/dialog/oauth?${params.toString()}`,
    redirectUri: platformConfig.redirectUri,
    scopes: requestedScopes,
    metadata: {
      metaPlatform: platform,
    },
  };
}

async function exchangeXAuthorizationCode({ fetchImpl, platformConfig, code, codeVerifier }) {
  if (!codeVerifier) {
    throw badRequest('Missing X OAuth PKCE verifier');
  }
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (platformConfig.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${platformConfig.clientId}:${platformConfig.clientSecret}`).toString('base64')}`;
  }
  const response = await fetchImpl(X_TOKEN_URL, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: platformConfig.clientId,
      redirect_uri: platformConfig.redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  assertOAuthOk(response, payload, 'X OAuth token exchange');
  return normalizeTokenPayload(payload);
}

async function exchangeLinkedInAuthorizationCode({ fetchImpl, platformConfig, code }) {
  const response = await fetchImpl(LINKEDIN_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: platformConfig.redirectUri,
      client_id: platformConfig.clientId,
      client_secret: platformConfig.clientSecret,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  assertOAuthOk(response, payload, 'LinkedIn OAuth token exchange');
  return normalizeTokenPayload(payload);
}

async function exchangeMetaAuthorizationCode({ fetchImpl, platformConfig, code }) {
  const shortLivedUrl = new URL(`https://graph.facebook.com/${platformConfig.graphVersion}/oauth/access_token`);
  shortLivedUrl.searchParams.set('client_id', platformConfig.appId);
  shortLivedUrl.searchParams.set('redirect_uri', platformConfig.redirectUri);
  shortLivedUrl.searchParams.set('client_secret', platformConfig.appSecret);
  shortLivedUrl.searchParams.set('code', code);

  const shortResponse = await fetchImpl(shortLivedUrl);
  const shortPayload = await shortResponse.json().catch(() => ({}));
  assertOAuthOk(shortResponse, shortPayload, 'Meta OAuth token exchange');

  const longLivedUrl = new URL(`https://graph.facebook.com/${platformConfig.graphVersion}/oauth/access_token`);
  longLivedUrl.searchParams.set('grant_type', 'fb_exchange_token');
  longLivedUrl.searchParams.set('client_id', platformConfig.appId);
  longLivedUrl.searchParams.set('client_secret', platformConfig.appSecret);
  longLivedUrl.searchParams.set('fb_exchange_token', shortPayload.access_token);

  const longResponse = await fetchImpl(longLivedUrl);
  const longPayload = await longResponse.json().catch(() => ({}));
  const tokenPayload = longResponse.ok ? longPayload : shortPayload;
  return normalizeTokenPayload(tokenPayload, { fallbackTokenType: 'Bearer' });
}

async function fetchXProfile({ fetchImpl, accessToken }) {
  const url = new URL(X_ME_URL);
  url.searchParams.set('user.fields', 'username,name,profile_image_url,verified');
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = await response.json().catch(() => ({}));
  assertOAuthOk(response, payload, 'Unable to read X account profile');
  const user = payload.data ?? {};
  return {
    providerAccountId: user.id,
    accountName: user.username ? `@${user.username}` : user.name ?? 'X Account',
    tokenPatch: {},
    metadata: {
      user,
    },
  };
}

async function fetchLinkedInProfile({ fetchImpl, accessToken }) {
  const userInfoResponse = await fetchImpl(LINKEDIN_USERINFO_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (userInfoResponse.ok) {
    const userInfo = await userInfoResponse.json().catch(() => ({}));
    return {
      providerAccountId: userInfo.sub,
      accountName: userInfo.name ?? userInfo.email ?? 'LinkedIn Member',
      tokenPatch: {},
      metadata: {
        userInfo,
      },
    };
  }

  const meResponse = await fetchImpl(LINKEDIN_ME_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });
  const me = await meResponse.json().catch(() => ({}));
  assertOAuthOk(meResponse, me, 'Unable to read LinkedIn account profile');
  const localizedFirstName = localizedLinkedInField(me.localizedFirstName ?? me.firstName);
  const localizedLastName = localizedLinkedInField(me.localizedLastName ?? me.lastName);
  return {
    providerAccountId: me.id,
    accountName: [localizedFirstName, localizedLastName].filter(Boolean).join(' ') || 'LinkedIn Member',
    tokenPatch: {},
    metadata: {
      profile: me,
    },
  };
}

async function fetchMetaProfile({ fetchImpl, platform, platformConfig, accessToken }) {
  const user = await fetchMetaGraph({ fetchImpl, platformConfig, accessToken, path: 'me', params: { fields: 'id,name' } });
  const pages = await fetchMetaGraph({
    fetchImpl,
    platformConfig,
    accessToken,
    path: 'me/accounts',
    params: {
      fields: 'id,name,access_token,tasks,connected_instagram_account{id,username,profile_picture_url}',
      limit: '50',
    },
  });

  if (platform === 'facebook') {
    const page = pages.data?.find((candidate) => candidate.access_token) ?? pages.data?.[0];
    if (!page) {
      throw badRequest('No Facebook Page is available for this Meta account', {
        requiredPermissions: platformConfig.facebookScopes,
      });
    }
    return {
      providerAccountId: page.id,
      accountName: page.name ?? 'Facebook Page',
      tokenPatch: {
        accessToken: page.access_token ?? accessToken,
        userAccessToken: accessToken,
        pageAccessToken: page.access_token ?? null,
      },
      metadata: {
        user,
        page,
        connectedPages: pages.data ?? [],
      },
    };
  }

  const pageWithInstagram = pages.data?.find((candidate) => candidate.connected_instagram_account);
  if (!pageWithInstagram?.connected_instagram_account) {
    throw badRequest('No connected Instagram Business or Creator account is available for this Meta account', {
      requiredPermissions: platformConfig.instagramScopes,
    });
  }
  const instagramAccount = pageWithInstagram.connected_instagram_account;
  return {
    providerAccountId: instagramAccount.id,
    accountName: instagramAccount.username ? `@${instagramAccount.username}` : 'Instagram Account',
    tokenPatch: {
      accessToken: pageWithInstagram.access_token ?? accessToken,
      userAccessToken: accessToken,
      pageAccessToken: pageWithInstagram.access_token ?? null,
      pageId: pageWithInstagram.id,
      instagramAccountId: instagramAccount.id,
    },
    metadata: {
      user,
      page: pageWithInstagram,
      instagramAccount,
      connectedPages: pages.data ?? [],
    },
  };
}

async function fetchMetaGraph({ fetchImpl, platformConfig, accessToken, path, params = {} }) {
  const url = new URL(`https://graph.facebook.com/${platformConfig.graphVersion}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('access_token', accessToken);
  const response = await fetchImpl(url);
  const payload = await response.json().catch(() => ({}));
  assertOAuthOk(response, payload, `Meta Graph request failed: ${path}`);
  return payload;
}

function getProviderConfig(serviceConfig, platform) {
  if (platform === 'x') return serviceConfig.x;
  if (platform === 'linkedin') return serviceConfig.linkedin;
  if (platform === 'facebook' || platform === 'instagram') return serviceConfig.meta;
  throw badRequest('Unsupported OAuth platform', { platform });
}

function getMissingConfig(platform, platformConfig) {
  if (platform === 'x') {
    return [
      ['X_CLIENT_ID', platformConfig.clientId],
      ['X_REDIRECT_URI', platformConfig.redirectUri],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
  }
  if (platform === 'linkedin') {
    return [
      ['LINKEDIN_CLIENT_ID', platformConfig.clientId],
      ['LINKEDIN_CLIENT_SECRET', platformConfig.clientSecret],
      ['LINKEDIN_REDIRECT_URI', platformConfig.redirectUri],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
  }
  return [
    ['META_APP_ID', platformConfig.appId],
    ['META_APP_SECRET', platformConfig.appSecret],
    ['META_REDIRECT_URI', platformConfig.redirectUri],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

function setupMessage(platform) {
  const messages = {
    x: 'Create an X developer app, enable OAuth 2.0 Authorization Code with PKCE, and configure the callback URL.',
    linkedin: 'Create a LinkedIn app, enable the required Sign In/API products, and configure the redirect URL.',
    facebook: 'Create a Meta app with Facebook Login and Page permissions, then configure the redirect URL.',
    instagram:
      'Create a Meta app with Facebook Login, Instagram Graph permissions, a Facebook Page, and a connected Instagram Business or Creator account.',
  };
  return messages[platform] ?? 'Configure the provider OAuth application.';
}

function normalizeTokenPayload(payload, { fallbackTokenType = 'Bearer' } = {}) {
  const expiresIn = Number(payload.expires_in ?? 0);
  const refreshExpiresIn = Number(payload.refresh_token_expires_in ?? 0);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    scope: payload.scope ?? null,
    scopes: typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [],
    tokenType: payload.token_type ?? fallbackTokenType,
    expiresIn,
    expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    refreshExpiresIn,
    refreshExpiresAt: refreshExpiresIn > 0 ? new Date(Date.now() + refreshExpiresIn * 1000).toISOString() : null,
    raw: payload,
  };
}

function localizedLinkedInField(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (value.localized && typeof value.preferredLocale === 'object') {
    const key = `${value.preferredLocale.language}_${value.preferredLocale.country}`;
    return value.localized[key] ?? Object.values(value.localized)[0] ?? '';
  }
  return Object.values(value)[0] ?? '';
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function assertOAuthOk(response, payload, message) {
  if (response.ok) return;
  throw badRequest(message, {
    status: response.status,
    error: payload.error,
    errorDescription: payload.error_description ?? payload.error?.message,
  });
}
