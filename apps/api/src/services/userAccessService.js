import { forbidden, notFound } from '../lib/httpErrors.js';

export const IMMUTABLE_ADMIN_EMAIL = 'sd.nirsha@gmail.com';
export const IMMUTABLE_ADMIN_EMAILS = Object.freeze([
  IMMUTABLE_ADMIN_EMAIL,
  'manish28june@gmail.com',
]);
export const USER_ROLES = Object.freeze(['admin', 'anonymous']);
export const USER_APP_IDS = Object.freeze(['admin', 'invest', 'picks', 'workbench', 'quant', 'desk']);

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
});

export function createUserAccessService({ repository, clock = () => new Date().toISOString() } = {}) {
  async function ensureAuthenticatedUser({ uid, email, displayName = null, photoUrl = null, authMode = 'firebase' }) {
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
      metadata: {
        ...(existing?.metadata ?? {}),
        authMode,
      },
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
  const role = isImmutableUser(user) ? 'admin' : normalizeRole(user?.role);
  const immutable = isImmutableUser(user);
  return {
    id: user.id,
    uid: user.uid ?? user.id,
    email: normalizeEmail(user.email),
    displayName: user.displayName ?? user.email ?? user.uid ?? user.id,
    photoUrl: user.photoUrl ?? null,
    role,
    roles: rolesForRole(role),
    appAccess: normalizeAppAccess(user?.appAccess, { role, immutable }),
    status: immutable ? 'active' : user.status ?? 'active',
    immutable,
    firstSeenAt: user.firstSeenAt ?? user.createdAt ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    roleUpdatedAt: user.roleUpdatedAt ?? null,
    roleUpdatedBy: user.roleUpdatedBy ?? null,
    accessManagedBy: user.accessManagedBy ?? null,
    accessUpdatedAt: user.accessUpdatedAt ?? null,
    accessUpdatedBy: user.accessUpdatedBy ?? null,
    createdAt: user.createdAt ?? null,
    updatedAt: user.updatedAt ?? null,
    authMode: user.authMode ?? user.metadata?.authMode ?? null,
  };
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
  if (immutable) {
    return Object.fromEntries(USER_APP_IDS.map((appId) => [appId, true]));
  }
  if (normalizeRole(role) === 'admin') {
    access.admin = true;
  }
  return access;
}

export function normalizeAppAccess(value, { role = 'anonymous', immutable = false } = {}) {
  const fallback = defaultAppAccess(role, { immutable });
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

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase() || null;
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
