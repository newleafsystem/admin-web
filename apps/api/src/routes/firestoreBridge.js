import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '../lib/firebaseAdmin.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/httpErrors.js';
import { requireObject } from '../lib/validation.js';

const SERVER_TIMESTAMP_MARKER = '__newleafServerTimestamp';
const PUBLIC_COLLECTIONS = new Set(['tiles', 'weeklyPicks', 'pick_outcomes']);
const PUBLIC_DOCUMENTS = [
  /^tiles\/[^/]+$/,
  /^weeklyPicks\/[^/]+$/,
  /^pick_outcomes\/[^/]+$/,
  /^analyses\/[^/]+$/,
  /^marketState\/current$/,
  /^config\/alertThresholds$/,
];
const ADMIN_COLLECTIONS = new Set(['tiles', 'weeklyPicks', 'pick_outcomes', 'analyses', 'users']);
const USER_SUBCOLLECTIONS = new Set([
  'portfolio',
  'shortlist',
  'pnlHistory',
  'portfolioSettings',
  'pendingOrders',
]);

export function createPublicFirestoreBridgeRouter() {
  const router = Router();

  router.post('/get', asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    const path = readDocumentPath(body, 'path');
    authorizeFirestoreBridge({ path, operation: 'read', publicOnly: true });
    res.json({ document: await readDocument(path) });
  }));

  router.post('/query', asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    const collectionPath = readCollectionPath(body, 'collection');
    authorizeFirestoreBridge({ path: collectionPath, operation: 'read', isCollection: true, publicOnly: true });
    res.json({ documents: await runQuery(body) });
  }));

  return router;
}

export function createFirestoreBridgeRouter() {
  const router = Router();

  router.post('/get', asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    const path = readDocumentPath(body, 'path');
    authorizeFirestoreBridge({ path, operation: 'read', user: req.user });
    res.json({ document: await readDocument(path) });
  }));

  router.post('/query', asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    const collectionPath = readCollectionPath(body, 'collection');
    authorizeFirestoreBridge({ path: collectionPath, operation: 'read', isCollection: true, user: req.user });
    res.json({ documents: await runQuery(body) });
  }));

  router.post('/set', asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    const path = readDocumentPath(body, 'path');
    authorizeFirestoreBridge({ path, operation: 'write', user: req.user });
    await setDocument(path, body.data, body.merge === true);
    res.json({ document: await readDocument(path) });
  }));

  router.post('/update', asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    const path = readDocumentPath(body, 'path');
    authorizeFirestoreBridge({ path, operation: 'write', user: req.user });
    await updateDocument(path, body.data);
    res.json({ document: await readDocument(path) });
  }));

  router.post('/delete', asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    const path = readDocumentPath(body, 'path');
    authorizeFirestoreBridge({ path, operation: 'write', user: req.user });
    await deleteDocument(path);
    res.status(204).send();
  }));

  router.post('/add', asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    const collectionPath = readCollectionPath(body, 'collection');
    authorizeFirestoreBridge({ path: collectionPath, operation: 'write', isCollection: true, user: req.user });
    const document = await addDocument(collectionPath, body.data);
    res.status(201).json({ document });
  }));

  return router;
}

function authorizeFirestoreBridge({ path, operation, isCollection = false, publicOnly = false, user = null }) {
  if (operation === 'read' && isPublicReadable(path, isCollection)) {
    return;
  }

  if (publicOnly) {
    throw forbidden('Public Firestore bridge path is not allowed', { path });
  }

  const isAdmin = Array.isArray(user?.roles) && user.roles.includes('admin');
  if (isAdmin && isAdminAllowed(path, isCollection)) {
    return;
  }

  if (isOwnUserPath(path, user?.uid)) {
    return;
  }

  throw forbidden('Firestore bridge path is not allowed', { path });
}

function isPublicReadable(path, isCollection) {
  if (isCollection) {
    return PUBLIC_COLLECTIONS.has(path);
  }
  return PUBLIC_DOCUMENTS.some((pattern) => pattern.test(path));
}

function isAdminAllowed(path, isCollection) {
  const [root] = path.split('/');
  if (isCollection && path.startsWith('users/')) {
    return true;
  }
  return ADMIN_COLLECTIONS.has(root) || path === 'marketState/current' || path === 'config/alertThresholds';
}

function isOwnUserPath(path, uid) {
  if (!uid) return false;
  const segments = path.split('/');
  return (
    segments[0] === 'users' &&
    segments[1] === uid &&
    segments.length >= 3 &&
    USER_SUBCOLLECTIONS.has(segments[2])
  );
}

async function runQuery(body) {
  const collectionPath = readCollectionPath(body, 'collection');
  let ref = (await requireFirestore()).collection(collectionPath);

  for (const filter of readFilters(body.filters)) {
    ref = ref.where(filter.field, filter.op, filter.value);
  }

  for (const order of readOrderBy(body.orderBy)) {
    ref = ref.orderBy(order.field, order.direction);
  }

  const limit = readLimit(body.limit);
  if (limit !== null) {
    ref = ref.limit(limit);
  }

  const snapshot = await ref.get();
  return snapshot.docs.map(documentFromSnapshot);
}

async function readDocument(path) {
  const snapshot = await (await requireFirestore()).doc(path).get();
  if (!snapshot.exists) return null;
  return documentFromSnapshot(snapshot);
}

async function setDocument(path, data, merge) {
  await (await requireFirestore()).doc(path).set(toFirestoreValue(requireObject({ data }).data), { merge });
}

async function updateDocument(path, data) {
  const ref = (await requireFirestore()).doc(path);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw notFound('Firestore document not found', { path });
  }
  await ref.update(toFirestoreValue(requireObject({ data }).data));
}

async function deleteDocument(path) {
  await (await requireFirestore()).doc(path).delete();
}

async function addDocument(collectionPath, data) {
  const ref = await (await requireFirestore()).collection(collectionPath).add(toFirestoreValue(requireObject({ data }).data));
  return readDocument(ref.path);
}

async function requireFirestore() {
  const firestore = await getFirestore();
  if (!firestore) {
    throw conflict('Firestore is not configured for API access');
  }
  return firestore;
}

function documentFromSnapshot(snapshot) {
  return {
    id: snapshot.id,
    path: snapshot.ref.path,
    data: toJsonValue(snapshot.data() ?? {}),
  };
}

function readDocumentPath(source, field) {
  const path = normalizePath(source[field]);
  if (path.split('/').length % 2 !== 0) {
    throw badRequest('Expected a Firestore document path', { field });
  }
  return path;
}

function readCollectionPath(source, field) {
  const path = normalizePath(source[field]);
  if (path.split('/').length % 2 !== 1) {
    throw badRequest('Expected a Firestore collection path', { field });
  }
  return path;
}

function normalizePath(value) {
  const path = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  const segments = path.split('/').filter(Boolean);
  if (
    !segments.length ||
    segments.length > 8 ||
    path.length > 512 ||
    path.includes('\\') ||
    segments.some((segment) => segment === '.' || segment === '..' || !/^[A-Za-z0-9_.:@-]+$/.test(segment))
  ) {
    throw badRequest('Invalid Firestore path');
  }
  return segments.join('/');
}

function readFilters(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw badRequest('Invalid Firestore query filters');
  }
  return value.map((filter) => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      throw badRequest('Invalid Firestore query filter');
    }
    const field = readField(filter.field);
    const op = String(filter.op ?? '==');
    if (!['==', '!=', '<', '<=', '>', '>=', 'array-contains', 'in', 'array-contains-any'].includes(op)) {
      throw badRequest('Unsupported Firestore query operator', { op });
    }
    return { field, op, value: filter.value };
  });
}

function readOrderBy(value) {
  if (value === undefined) return [];
  const orders = Array.isArray(value) ? value : [value];
  if (orders.length > 4) {
    throw badRequest('Too many Firestore orderBy clauses');
  }
  return orders.map((order) => {
    if (!order || typeof order !== 'object' || Array.isArray(order)) {
      throw badRequest('Invalid Firestore orderBy clause');
    }
    const direction = String(order.direction ?? 'asc').toLowerCase();
    if (!['asc', 'desc'].includes(direction)) {
      throw badRequest('Invalid Firestore orderBy direction', { direction });
    }
    return { field: readField(order.field), direction };
  });
}

function readField(value) {
  const field = String(value ?? '').trim();
  if (!field || field.length > 120 || field.includes('/') || field.includes('\\') || field.includes('..')) {
    throw badRequest('Invalid Firestore field name');
  }
  return field;
}

function readLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw badRequest('Invalid Firestore query limit', { max: 500 });
  }
  return limit;
}

function toJsonValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue).filter((item) => item !== undefined);
  }

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = toJsonValue(child);
    if (normalized !== undefined) {
      out[key] = normalized;
    }
  }
  return out;
}

function toFirestoreValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(toFirestoreValue).filter((item) => item !== undefined);
  }
  if (value[SERVER_TIMESTAMP_MARKER] === true) {
    return serverTimestamp();
  }

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = toFirestoreValue(child);
    if (normalized !== undefined) {
      out[key] = normalized;
    }
  }
  return out;
}

function serverTimestamp() {
  return FieldValue.serverTimestamp();
}
