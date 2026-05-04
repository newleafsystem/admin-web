import { Router } from 'express';
import { config } from '../config.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { badRequest, notFound } from '../lib/httpErrors.js';
import {
  optionalString,
  optionalStringArray,
  rejectUnknownFields,
  requireObject,
  requireString,
} from '../lib/validation.js';

export const SUPPORTED_PLATFORMS = [
  {
    id: 'youtube',
    label: 'YouTube',
    provider: 'google',
    scopes: config.youtube.scopes,
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    provider: 'linkedin',
    scopes: config.linkedin.scopes,
  },
  {
    id: 'x',
    label: 'X',
    provider: 'x',
    scopes: config.x.scopes,
  },
  {
    id: 'instagram',
    label: 'Instagram',
    provider: 'meta',
    scopes: config.meta.instagramScopes,
  },
  {
    id: 'facebook',
    label: 'Facebook',
    provider: 'meta',
    scopes: config.meta.facebookScopes,
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    provider: 'tiktok',
    scopes: ['video.upload'],
  },
];

export function createSocialAccountsRouter({ repository, socialConfigService, socialOAuthService, youtubeOAuthService }) {
  const router = Router();

  router.get(
    '/platforms',
    requireRole('admin', 'publisher', 'viewer'),
    asyncHandler(async (req, res) => {
      res.json({ platforms: SUPPORTED_PLATFORMS });
    }),
  );

  router.get(
    '/accounts',
    requireRole('admin', 'publisher', 'viewer'),
    asyncHandler(async (req, res) => {
      const [storedAccounts, configuredAccounts] = await Promise.all([
        repository.listSocialAccounts(),
        socialConfigService.listConfiguredAccounts(),
      ]);
      const accountsById = new Map();
      for (const account of configuredAccounts) {
        accountsById.set(account.id, account);
      }
      for (const account of storedAccounts) {
        accountsById.set(account.id, { ...account, source: 'repository' });
      }
      res.json({ accounts: Array.from(accountsById.values()) });
    }),
  );

  router.post(
    '/accounts',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, ['id', 'platform', 'accountName', 'scopes', 'tokenSecretRef', 'status']);
      const platform = assertPlatform(requireString(body, 'platform', { maxLength: 40 }));
      const platformConfig = getPlatform(platform);
      const account = await repository.upsertSocialAccount({
        id: optionalString(body, 'id', { maxLength: 120 }),
        platform,
        accountName: requireString(body, 'accountName', { maxLength: 200 }),
        ownerUid: req.user.uid,
        status: optionalString(body, 'status', { maxLength: 40, defaultValue: 'connected' }),
        scopes: optionalStringArray(body, 'scopes', {
          defaultValue: platformConfig.scopes,
          minItems: 0,
          maxItems: 20,
        }),
        tokenSecretRef: optionalString(body, 'tokenSecretRef', { maxLength: 500, defaultValue: null }),
      });
      res.status(201).json({
        account,
        next: 'Use OAuth callback handling to exchange provider codes and store refresh tokens in Secret Manager.',
      });
    }),
  );

  router.get(
    '/config',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      const socialConfig = await socialConfigService.getSanitizedConfig();
      res.json({
        socialConfig,
        warning: 'Secret values are redacted. Store production secrets in Secret Manager or provider-managed secret storage.',
      });
    }),
  );

  router.post(
    '/:platform/oauth/start',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      const body = req.body ? requireObject(req.body) : {};
      rejectUnknownFields(body, ['accountName', 'reconnectAccountId', 'loginHint', 'redirectAfter']);
      const platform = assertPlatform(req.params.platform);
      const platformConfig = getPlatform(platform);
      const state = platform === 'youtube' ? youtubeOAuthService.createStateId() : socialOAuthService.createStateId(platform);
      const authorization =
        platform === 'youtube'
          ? youtubeOAuthService.buildAuthorizationUrl({
              state,
              loginHint: optionalString(body, 'loginHint', { maxLength: 320, defaultValue: null }),
              scopes: platformConfig.scopes,
            })
          : socialOAuthService.buildAuthorizationUrl({
              platform,
              state,
              loginHint: optionalString(body, 'loginHint', { maxLength: 320, defaultValue: null }),
              scopes: platformConfig.scopes,
            });
      if (authorization.setupRequired) {
        return res.status(409).json({
          platform,
          ...authorization,
        });
      }

      await repository.createOAuthState({
        id: state,
        platform,
        actorUid: req.user.uid,
        accountName: optionalString(body, 'accountName', { maxLength: 200, defaultValue: null }),
        reconnectAccountId: optionalString(body, 'reconnectAccountId', { maxLength: 120, defaultValue: null }),
        redirectAfter: optionalString(body, 'redirectAfter', { maxLength: 500, defaultValue: null }),
        scopes: authorization.scopes,
        metadata: authorization.metadata ?? {},
      });

      res.status(202).json({
        platform,
        provider: platformConfig.provider,
        scopes: authorization.scopes,
        state,
        authorizationUrl: authorization.authorizationUrl,
        redirectUri: authorization.redirectUri,
      });
    }),
  );

  router.post(
    '/accounts/:accountId/reconnect',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      const account = await repository.getSocialAccount(req.params.accountId);
      if (!account) throw notFound('Social account not found', { accountId: req.params.accountId });

      const platformConfig = getPlatform(account.platform);
      const reconnectScopes = mergeScopes(platformConfig.scopes, account.scopes);
      const state = account.platform === 'youtube' ? youtubeOAuthService.createStateId() : socialOAuthService.createStateId(account.platform);
      const authorization =
        account.platform === 'youtube'
          ? youtubeOAuthService.buildAuthorizationUrl({
              state,
              scopes: reconnectScopes,
            })
          : socialOAuthService.buildAuthorizationUrl({
              platform: account.platform,
              state,
              scopes: reconnectScopes,
            });
      if (authorization.setupRequired) {
        return res.status(409).json({
          platform: account.platform,
          ...authorization,
        });
      }

      await repository.createOAuthState({
        id: state,
        platform: account.platform,
        actorUid: req.user.uid,
        accountName: account.accountName,
        reconnectAccountId: account.id,
        scopes: authorization.scopes,
        metadata: authorization.metadata ?? {},
      });

      const pending = await repository.upsertSocialAccount({
        ...account,
        id: req.params.accountId,
        platform: account.platform,
        accountName: account.accountName,
        ownerUid: req.user.uid,
        status: 'oauth_pending',
        scopes: reconnectScopes,
        tokenSecretRef: account.tokenSecretRef ?? null,
        tokenHealth: 'oauth_pending',
      });
      res.status(202).json({
        account: pending,
        authorizationUrl: authorization.authorizationUrl,
        state,
      });
    }),
  );

  router.delete(
    '/accounts/:accountId',
    requireRole('admin', 'publisher'),
    asyncHandler(async (req, res) => {
      const deleted = await repository.deleteSocialAccount(req.params.accountId);
      if (!deleted) throw notFound('Social account not found', { accountId: req.params.accountId });
      res.status(204).send();
    }),
  );

  return router;
}

export function createSocialOAuthCallbackRouter({ repository, socialOAuthService, youtubeOAuthService }) {
  const router = Router();

  router.get(
    '/youtube/oauth/callback',
    asyncHandler(async (req, res) => {
      if (req.query.error) {
        throw badRequest('YouTube OAuth authorization failed', {
          error: req.query.error,
          errorDescription: req.query.error_description,
        });
      }

      const code = requireQueryString(req.query, 'code');
      const state = requireQueryString(req.query, 'state');
      const oauthState = await repository.consumeOAuthState(state);
      if (!oauthState || oauthState.platform !== 'youtube') {
        throw badRequest('Invalid or expired YouTube OAuth state');
      }

      const tokens = await youtubeOAuthService.exchangeAuthorizationCode(code);
      const channel = await youtubeOAuthService.fetchMyChannel(tokens.accessToken);
      const channelId = channel.id ?? `unknown_${Date.now()}`;
      const existingAccount = oauthState.reconnectAccountId
        ? await repository.getSocialAccount(oauthState.reconnectAccountId)
        : null;
      const existingSecret = existingAccount?.tokenSecretRef
        ? await repository.getSecret(existingAccount.tokenSecretRef)
        : null;
      const refreshToken = tokens.refreshToken ?? existingSecret?.value?.refreshToken ?? null;
      const tokenSecret = await repository.putSecret({
        id: `youtube-oauth-${channelId}`,
        provider: 'youtube',
        kind: 'oauth-token',
        value: {
          accessToken: tokens.accessToken,
          refreshToken,
          tokenType: tokens.tokenType,
          expiresAt: tokens.expiresAt,
          scope: tokens.scope,
        },
        metadata: {
          channelId,
          scopes: tokens.scopes,
          hasRefreshToken: Boolean(refreshToken),
        },
      });

      const account = await repository.upsertSocialAccount({
        id: oauthState.reconnectAccountId ?? `youtube-${channelId}`,
        platform: 'youtube',
        accountName: oauthState.accountName ?? channel.title ?? 'YouTube Channel',
        ownerUid: oauthState.actorUid,
        status: 'connected',
        scopes: tokens.scopes.length ? tokens.scopes : oauthState.scopes,
        tokenSecretRef: tokenSecret.secretRef,
        tokenHealth: refreshToken ? 'healthy' : 'access_token_only',
        providerAccountId: channelId,
        metadata: {
          channel,
          connectedVia: 'google-oauth-web-server',
        },
      });

      const redirectUrl = buildAdminRedirectUrl(oauthState.redirectAfter, {
        socialConnected: 'youtube',
        accountId: account.id,
      });
      res.redirect(303, redirectUrl);
    }),
  );

  router.get(
    '/x/oauth/callback',
    asyncHandler(async (req, res) => handleSocialOAuthCallback({ req, res, repository, socialOAuthService, expectedPlatform: 'x' })),
  );

  router.get(
    '/linkedin/oauth/callback',
    asyncHandler(async (req, res) =>
      handleSocialOAuthCallback({ req, res, repository, socialOAuthService, expectedPlatform: 'linkedin' }),
    ),
  );

  router.get(
    '/meta/oauth/callback',
    asyncHandler(async (req, res) =>
      handleSocialOAuthCallback({ req, res, repository, socialOAuthService, expectedProvider: 'meta' }),
    ),
  );

  router.get(
    '/facebook/oauth/callback',
    asyncHandler(async (req, res) =>
      handleSocialOAuthCallback({ req, res, repository, socialOAuthService, expectedPlatform: 'facebook' }),
    ),
  );

  router.get(
    '/instagram/oauth/callback',
    asyncHandler(async (req, res) =>
      handleSocialOAuthCallback({ req, res, repository, socialOAuthService, expectedPlatform: 'instagram' }),
    ),
  );

  return router;
}

async function handleSocialOAuthCallback({ req, res, repository, socialOAuthService, expectedPlatform = null, expectedProvider = null }) {
  if (req.query.error) {
    throw badRequest('Social OAuth authorization failed', {
      error: req.query.error,
      errorDescription: req.query.error_description,
    });
  }

  const code = requireQueryString(req.query, 'code');
  const state = requireQueryString(req.query, 'state');
  const oauthState = await repository.consumeOAuthState(state);
  if (!oauthState) {
    throw badRequest('Invalid or expired social OAuth state');
  }
  if (expectedPlatform && oauthState.platform !== expectedPlatform) {
    throw badRequest('OAuth callback platform does not match stored state', {
      expectedPlatform,
      statePlatform: oauthState.platform,
    });
  }
  if (expectedProvider && getPlatform(oauthState.platform)?.provider !== expectedProvider) {
    throw badRequest('OAuth callback provider does not match stored state', {
      expectedProvider,
      statePlatform: oauthState.platform,
    });
  }

  const tokens = await socialOAuthService.exchangeAuthorizationCode({
    platform: oauthState.platform,
    code,
    oauthState,
  });
  const profile = await socialOAuthService.fetchAccountProfile({
    platform: oauthState.platform,
    accessToken: tokens.accessToken,
  });
  const existingAccount = oauthState.reconnectAccountId
    ? await repository.getSocialAccount(oauthState.reconnectAccountId)
    : null;
  const existingSecret = existingAccount?.tokenSecretRef
    ? await repository.getSecret(existingAccount.tokenSecretRef)
    : null;
  const refreshToken = tokens.refreshToken ?? existingSecret?.value?.refreshToken ?? null;
  const tokenSecret = await repository.putSecret({
    id: `${oauthState.platform}-oauth-${profile.providerAccountId}`,
    provider: oauthState.platform,
    kind: 'oauth-token',
    value: {
      accessToken: profile.tokenPatch?.accessToken ?? tokens.accessToken,
      userAccessToken: profile.tokenPatch?.userAccessToken ?? tokens.accessToken,
      pageAccessToken: profile.tokenPatch?.pageAccessToken ?? null,
      refreshToken,
      tokenType: tokens.tokenType,
      expiresAt: tokens.expiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      scope: tokens.scope,
      pageId: profile.tokenPatch?.pageId ?? null,
      instagramAccountId: profile.tokenPatch?.instagramAccountId ?? null,
    },
    metadata: {
      providerAccountId: profile.providerAccountId,
      scopes: tokens.scopes.length ? tokens.scopes : oauthState.scopes,
      hasRefreshToken: Boolean(refreshToken),
    },
  });

  const account = await repository.upsertSocialAccount({
    id: oauthState.reconnectAccountId ?? `${oauthState.platform}-${profile.providerAccountId}`,
    platform: oauthState.platform,
    accountName: oauthState.accountName ?? profile.accountName,
    ownerUid: oauthState.actorUid,
    status: 'connected',
    scopes: tokens.scopes.length ? tokens.scopes : oauthState.scopes,
    tokenSecretRef: tokenSecret.secretRef,
    tokenHealth: refreshToken || oauthState.platform === 'facebook' || oauthState.platform === 'instagram' ? 'healthy' : 'access_token_only',
    providerAccountId: profile.providerAccountId,
    metadata: {
      ...profile.metadata,
      connectedVia: `${getPlatform(oauthState.platform)?.provider ?? oauthState.platform}-oauth`,
    },
  });

  const redirectUrl = buildAdminRedirectUrl(oauthState.redirectAfter, {
    socialConnected: oauthState.platform,
    accountId: account.id,
  });
  res.redirect(303, redirectUrl);
}

function assertPlatform(platform) {
  const normalized = String(platform ?? '').toLowerCase();
  if (!SUPPORTED_PLATFORMS.some((candidate) => candidate.id === normalized)) {
    throw badRequest('Unsupported social platform', {
      platform,
      supported: SUPPORTED_PLATFORMS.map((candidate) => candidate.id),
    });
  }
  return normalized;
}

function getPlatform(platform) {
  return SUPPORTED_PLATFORMS.find((candidate) => candidate.id === platform);
}

function mergeScopes(...scopeLists) {
  return Array.from(new Set(scopeLists.flatMap((scopes) => scopes ?? []).filter(Boolean)));
}

function requireQueryString(query, field) {
  const value = query[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${field} query parameter is required`);
  }
  return value;
}

function buildAdminRedirectUrl(redirectAfter, params) {
  const url = new URL(redirectAfter || config.adminBaseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
