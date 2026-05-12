import { forbidden, notFound } from '../lib/httpErrors.js';

export const IMMUTABLE_ADMIN_EMAIL = 'sd.nirsha@gmail.com';
export const IMMUTABLE_ADMIN_EMAILS = Object.freeze([
  IMMUTABLE_ADMIN_EMAIL,
  'manish28june@gmail.com',
]);
export const USER_ROLES = Object.freeze(['admin', 'anonymous']);
export const USER_APP_IDS = Object.freeze(['admin', 'invest', 'picks', 'workbench', 'quant', 'desk']);
export const USER_NOTIFICATION_TOPIC_IDS = Object.freeze([
  'weeklyPicks',
  'scannerAlerts',
  'publishingAlerts',
  'accountAccess',
  'systemAlerts',
]);

const DEFAULT_NOTIFICATION_TOPICS = Object.freeze({
  weeklyPicks: true,
  scannerAlerts: false,
  publishingAlerts: false,
  accountAccess: true,
  systemAlerts: false,
});

const LOCAL_ADMIN_USER = Object.freeze({
  id: 'local-dev',
  uid: 'local-dev',
  email: 'local-dev@newleaf.invalid',
  displayName: 'Local Admin',
  photoUrl: null,
  role: 'admin',
  roles: ['admin'],
  appAccess: {
    admin: true,
    invest: true,
    picks: true,
    workbench: true,
    quant: true,
    desk: true,
  },
  status: 'active',
  immutable: true,
  authMode: 'local-dev',
  notificationPreferences: {
    email: {
      enabled: true,
      address: 'local-dev@newleaf.invalid',
      topics: {
        weeklyPicks: true,
        scannerAlerts: false,
        publishingAlerts: false,
        accountAccess: true,
        systemAlerts: false,
      },
      updatedAt: null,
      updatedBy: null,
    },
  },
});

export function createUserAccessService({ repository, clock = () => new Date().toISOString() } = {}) {
  async function ensureAuthenticatedUser({
    uid,
    email,
    displayName = null,
    photoUrl = null,
    authMode = 'firebase',
    loginContext = null,
  }) {
    if (!repository) {
      throw new Error('userAccessService requires repository');
    }

    const normalizedEmail = normalizeEmail(email);
    const immutable = isImmutableAdminEmail(normalizedEmail);
    const existing = (uid ? await repository.getAppUser(uid) : null) ??
      (normalizedEmail ? await repository.findAppUserByEmail(normalizedEmail) : null);
    const timestamp = clock();
    const role = immutable ? 'admin' : normalizeRole(existing?.role);
    const id = existing?.id ?? uid;
    const appAccess = normalizeAppAccess(existing?.appAccess, { role, immutable });

    const user = await repository.upsertAppUser({
      id,
      uid,
      email: normalizedEmail,
      displayName: displayName || existing?.displayName || normalizedEmail || uid,
      photoUrl: photoUrl ?? existing?.photoUrl ?? null,
      role,
      roles: rolesForRole(role),
      appAccess,
      status: immutable ? 'active' : existing?.status ?? 'active',
      immutable,
      accessManagedBy: existing?.accessManagedBy ?? 'admin-web',
      accessUpdatedAt: existing?.accessUpdatedAt ?? timestamp,
      accessUpdatedBy: existing?.accessUpdatedBy ?? null,
      firstSeenAt: existing?.firstSeenAt ?? timestamp,
      lastLoginAt: timestamp,
      lastLoginContext: loginContext
        ? normalizeLoginContext(loginContext, timestamp)
        : existing?.lastLoginContext ?? null,
      metadata: {
        ...(existing?.metadata ?? {}),
        authMode,
      },
      notificationPreferences: existing?.notificationPreferences,
    });

    return normalizeUser(user);
  }

  async function listUsers() {
    const users = await repository.listAppUsers();
    return users.map(normalizeUser).sort(compareUsers);
  }

  async function updateUserRole(userId, role, { actorUid = null } = {}) {
    return updateUserAccess(userId, { role }, { actorUid });
  }

  async function updateUserAccess(userId, { role = undefined, appAccess = undefined } = {}, { actorUid = null } = {}) {
    const existing = await repository.getAppUser(userId);
    if (!existing) {
      throw notFound('User not found', { userId });
    }
    if (isImmutableUser(existing)) {
      throw forbidden('The primary NewLeaf admin cannot be changed', { userId, email: existing.email });
    }

    const nextRole = role === undefined ? normalizeRole(existing.role) : normalizeRole(role);
    const nextAppAccess = normalizeAppAccess(appAccess ?? existing.appAccess, { role: nextRole });
    if (role !== undefined && appAccess === undefined) {
      nextAppAccess.admin = nextRole === 'admin';
    }
    const updated = await repository.updateAppUser(userId, {
      role: nextRole,
      roles: rolesForRole(nextRole),
      appAccess: nextAppAccess,
      roleUpdatedAt: clock(),
      roleUpdatedBy: actorUid,
      accessManagedBy: 'admin-web',
      accessUpdatedAt: clock(),
      accessUpdatedBy: actorUid,
    });
    return normalizeUser(updated);
  }

  async function updateUserNotifications(userId, { email = undefined } = {}, { actorUid = null } = {}) {
    const existing = await repository.getAppUser(userId);
    if (!existing) {
      throw notFound('User not found', { userId });
    }

    const current = normalizeNotificationPreferences(existing.notificationPreferences, existing);
    const next = normalizeNotificationPreferences(
      {
        ...current,
        ...(email !== undefined
          ? {
              email: {
                ...current.email,
                ...email,
                topics: {
                  ...current.email.topics,
                  ...(email.topics ?? {}),
                },
                updatedAt: clock(),
                updatedBy: actorUid,
              },
            }
          : {}),
      },
      existing,
    );

    const updated = await repository.updateAppUser(userId, {
      notificationPreferences: next,
      notificationsUpdatedAt: clock(),
      notificationsUpdatedBy: actorUid,
    });
    return normalizeUser(updated);
  }

  async function deleteUser(userId) {
    const existing = await repository.getAppUser(userId);
    if (!existing) {
      throw notFound('User not found', { userId });
    }
    if (isImmutableUser(existing)) {
      throw forbidden('The primary NewLeaf admin cannot be deleted', { userId, email: existing.email });
    }
    return normalizeUser(await repository.deleteAppUser(userId));
  }

  return {
    ensureAuthenticatedUser,
    listUsers,
    updateUserRole,
    updateUserAccess,
    updateUserNotifications,
    deleteUser,
  };
}

export function localAdminUser() {
  return { ...LOCAL_ADMIN_USER };
}

export function normalizeRole(role) {
  return USER_ROLES.includes(role) ? role : 'anonymous';
}

export function normalizeUser(user) {
  const id = normalizeIdentifier(user?.id) || normalizeIdentifier(user?.uid);
  const uid = normalizeIdentifier(user?.uid) || id;
  const role = isImmutableUser(user) ? 'admin' : normalizeRole(user?.role);
  const immutable = isImmutableUser(user);
  return {
    id,
    uid,
    email: normalizeEmail(user.email),
    displayName: user.displayName || user.email || uid || id || 'Unknown user',
    photoUrl: user.photoUrl ?? null,
    role,
    roles: rolesForRole(role),
    appAccess: normalizeAppAccess(user?.appAccess, { role, immutable }),
    status: immutable ? 'active' : user.status ?? 'active',
    immutable,
    firstSeenAt: user.firstSeenAt ?? user.createdAt ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    lastLoginContext: normalizeLoginContext(user.lastLoginContext),
    roleUpdatedAt: user.roleUpdatedAt ?? null,
    roleUpdatedBy: user.roleUpdatedBy ?? null,
    accessManagedBy: user.accessManagedBy ?? null,
    accessUpdatedAt: user.accessUpdatedAt ?? null,
    accessUpdatedBy: user.accessUpdatedBy ?? null,
    notificationPreferences: normalizeNotificationPreferences(user.notificationPreferences, user),
    notificationsUpdatedAt: user.notificationsUpdatedAt ?? null,
    notificationsUpdatedBy: user.notificationsUpdatedBy ?? null,
    createdAt: user.createdAt ?? null,
    updatedAt: user.updatedAt ?? null,
    authMode: user.authMode ?? user.metadata?.authMode ?? null,
  };
}

function normalizeIdentifier(value) {
  return String(value ?? '').trim();
}

export function isImmutableAdminEmail(email) {
  return IMMUTABLE_ADMIN_EMAILS.includes(normalizeEmail(email));
}

function isImmutableUser(user) {
  return Boolean(user?.immutable) || isImmutableAdminEmail(user?.email);
}

function rolesForRole(role) {
  return normalizeRole(role) === 'admin' ? ['admin'] : ['anonymous'];
}

export function defaultAppAccess(role = 'anonymous', { immutable = false } = {}) {
  const access = Object.fromEntries(USER_APP_IDS.map((appId) => [appId, false]));
  if (immutable || normalizeRole(role) === 'admin') {
    return Object.fromEntries(USER_APP_IDS.map((appId) => [appId, true]));
  }
  return access;
}

export function normalizeAppAccess(value, { role = 'anonymous', immutable = false } = {}) {
  const fallback = defaultAppAccess(role, { immutable });
  if (immutable || normalizeRole(role) === 'admin') {
    return fallback;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback;
  }

  return Object.fromEntries(
    USER_APP_IDS.map((appId) => [
      appId,
      value[appId] === true || value[appId] === 'true' || value[appId] === 1,
    ]),
  );
}

export function normalizeNotificationPreferences(value, user = {}) {
  const email = value?.email && typeof value.email === 'object' && !Array.isArray(value.email)
    ? value.email
    : {};
  const address = normalizeEmail(email.address ?? user.communicationEmail ?? user.email);
  const enabled = address ? email.enabled !== false : false;
  return {
    email: {
      enabled,
      address,
      topics: normalizeNotificationTopics(email.topics),
      updatedAt: cleanString(email.updatedAt, 40),
      updatedBy: cleanString(email.updatedBy, 120),
    },
  };
}

function normalizeNotificationTopics(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    USER_NOTIFICATION_TOPIC_IDS.map((topicId) => [
      topicId,
      Object.prototype.hasOwnProperty.call(source, topicId)
        ? source[topicId] === true
        : DEFAULT_NOTIFICATION_TOPICS[topicId] === true,
    ]),
  );
}

export function normalizeLoginContext(value, capturedAt = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const context = {
    ipAddress: cleanString(value.ipAddress, 80),
    country: cleanString(value.country, 16),
    city: cleanString(value.city, 120),
    region: cleanString(value.region, 120),
    regionCode: cleanString(value.regionCode, 32),
    continent: cleanString(value.continent, 32),
    timezone: cleanString(value.timezone, 80),
    latitude: cleanString(value.latitude, 40),
    longitude: cleanString(value.longitude, 40),
    postalCode: cleanString(value.postalCode, 40),
    metroCode: cleanString(value.metroCode, 40),
    rayId: cleanString(value.rayId, 80),
    userAgent: cleanString(value.userAgent, 240),
    source: cleanString(value.source, 40) ?? 'unknown',
    capturedAt: cleanString(value.capturedAt, 40) ?? capturedAt,
  };

  if (
    !context.ipAddress &&
    !context.country &&
    !context.city &&
    !context.region &&
    !context.timezone &&
    !context.userAgent
  ) {
    return null;
  }

  return context;
}

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase() || null;
}

function cleanString(value, maxLength) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
    return null;
  }
  return trimmed.slice(0, maxLength);
}

function compareUsers(left, right) {
  if (left.immutable !== right.immutable) {
    return left.immutable ? -1 : 1;
  }
  if (left.role !== right.role) {
    return left.role === 'admin' ? -1 : 1;
  }
  return String(right.lastLoginAt ?? right.updatedAt ?? '').localeCompare(String(left.lastLoginAt ?? left.updatedAt ?? ''));
}
