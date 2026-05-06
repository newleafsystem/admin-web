import { forbidden, notFound } from '../lib/httpErrors.js';

export const IMMUTABLE_ADMIN_EMAIL = 'sd.nirsha@gmail.com';
export const USER_ROLES = Object.freeze(['admin', 'anonymous']);

const LOCAL_ADMIN_USER = Object.freeze({
  id: 'local-dev',
  uid: 'local-dev',
  email: 'local-dev@newleaf.invalid',
  displayName: 'Local Admin',
  photoUrl: null,
  role: 'admin',
  roles: ['admin'],
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

    const user = await repository.upsertAppUser({
      id,
      uid,
      email: normalizedEmail,
      displayName: displayName || existing?.displayName || normalizedEmail || uid,
      photoUrl: photoUrl ?? existing?.photoUrl ?? null,
      role,
      status: existing?.status ?? 'active',
      immutable,
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
    const existing = await repository.getAppUser(userId);
    if (!existing) {
      throw notFound('User not found', { userId });
    }
    if (isImmutableUser(existing)) {
      throw forbidden('The primary NewLeaf admin cannot be changed', { userId, email: existing.email });
    }

    const updated = await repository.updateAppUser(userId, {
      role: normalizeRole(role),
      roleUpdatedAt: clock(),
      roleUpdatedBy: actorUid,
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
  return {
    id: user.id,
    uid: user.uid ?? user.id,
    email: normalizeEmail(user.email),
    displayName: user.displayName ?? user.email ?? user.uid ?? user.id,
    photoUrl: user.photoUrl ?? null,
    role,
    roles: role === 'admin' ? ['admin'] : ['anonymous'],
    status: user.status ?? 'active',
    immutable: isImmutableUser(user),
    firstSeenAt: user.firstSeenAt ?? user.createdAt ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    roleUpdatedAt: user.roleUpdatedAt ?? null,
    roleUpdatedBy: user.roleUpdatedBy ?? null,
    createdAt: user.createdAt ?? null,
    updatedAt: user.updatedAt ?? null,
    authMode: user.authMode ?? user.metadata?.authMode ?? null,
  };
}

export function isImmutableAdminEmail(email) {
  return normalizeEmail(email) === IMMUTABLE_ADMIN_EMAIL;
}

function isImmutableUser(user) {
  return Boolean(user?.immutable) || isImmutableAdminEmail(user?.email);
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
