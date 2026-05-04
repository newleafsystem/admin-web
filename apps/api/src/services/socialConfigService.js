import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const SECRET_FIELD_PATTERN = /(secret|token|password|privateKey|clientSecret|refreshToken|accessToken)/i;

export function createSocialConfigService(options = {}) {
  const accountsConfigPath = options.accountsConfigPath ?? config.social.accountsConfigPath;
  const cwd = options.cwd ?? process.cwd();

  return {
    async loadConfig() {
      if (!accountsConfigPath) {
        return emptyConfig(null);
      }

      const resolvedPath = path.isAbsolute(accountsConfigPath)
        ? accountsConfigPath
        : path.resolve(cwd, accountsConfigPath);

      let text;
      try {
        text = await fs.readFile(resolvedPath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') {
          return emptyConfig(resolvedPath);
        }
        throw error;
      }

      const parsed = JSON.parse(text);
      return {
        path: resolvedPath,
        version: parsed.version ?? 1,
        oauthApps: parsed.oauthApps ?? {},
        connectedAccounts: Array.isArray(parsed.connectedAccounts) ? parsed.connectedAccounts : [],
      };
    },

    async listConfiguredAccounts() {
      const loaded = await this.loadConfig();
      return loaded.connectedAccounts.map((account) => ({
        id: account.id,
        platform: account.platform,
        accountName: account.accountName,
        ownerUid: account.ownerUid ?? null,
        status: account.status ?? 'configured',
        scopes: Array.isArray(account.scopes) ? account.scopes : [],
        tokenSecretRef: account.tokenSecretRef ?? null,
        source: 'config',
        configPath: loaded.path,
      }));
    },

    async getSanitizedConfig() {
      const loaded = await this.loadConfig();
      return {
        path: loaded.path,
        version: loaded.version,
        oauthApps: redactSecrets(loaded.oauthApps),
        connectedAccounts: redactSecrets(loaded.connectedAccounts),
      };
    },
  };
}

function emptyConfig(configPath) {
  return {
    path: configPath,
    version: 1,
    oauthApps: {},
    connectedAccounts: [],
  };
}

function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (SECRET_FIELD_PATTERN.test(key)) {
        return [key, summarizeSecret(entry)];
      }
      return [key, redactSecrets(entry)];
    }),
  );
}

function summarizeSecret(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  if (value.startsWith('secret:')) {
    return {
      type: 'secret-ref',
      ref: value.slice('secret:'.length),
    };
  }
  return {
    type: 'inline-secret',
    configured: true,
  };
}
