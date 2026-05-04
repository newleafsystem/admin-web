import { config } from '../config.js';

let appPromise;
let authPromise;
let firestorePromise;

export async function getFirebaseApp() {
  if (config.firebase.disabled) {
    return null;
  }
  if (!appPromise) {
    appPromise = initializeFirebaseApp();
  }
  return appPromise;
}

export async function getFirebaseAuth() {
  if (!authPromise) {
    authPromise = (async () => {
      const app = await getFirebaseApp();
      if (!app) return null;
      const { getAuth } = await import('firebase-admin/auth');
      return getAuth(app);
    })();
  }
  return authPromise;
}

export async function getFirestore() {
  if (!firestorePromise) {
    firestorePromise = (async () => {
      const app = await getFirebaseApp();
      if (!app) return null;
      const { getFirestore: getAdminFirestore } = await import('firebase-admin/firestore');
      return config.firebase.firestoreDatabaseId === '(default)'
        ? getAdminFirestore(app)
        : getAdminFirestore(app, config.firebase.firestoreDatabaseId);
    })();
  }
  return firestorePromise;
}

async function initializeFirebaseApp() {
  const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  const hasCredential = Boolean(config.firebase.credentialsJson || config.firebase.useApplicationDefault);

  if (!isEmulator && !hasCredential) {
    return null;
  }

  try {
    const { applicationDefault, cert, getApps, initializeApp } = await import('firebase-admin/app');
    const existing = getApps()[0];
    if (existing) return existing;

    const options = {};
    if (config.firebase.projectId) {
      options.projectId = config.firebase.projectId;
    }

    if (config.firebase.credentialsJson) {
      // TODO: Load Firebase service account credentials from Secret Manager in deployed environments.
      options.credential = cert(JSON.parse(config.firebase.credentialsJson));
    } else if (config.firebase.useApplicationDefault) {
      options.credential = applicationDefault();
    }

    return initializeApp(options);
  } catch (error) {
    console.warn('Firebase Admin was not initialized; using local-only placeholders.', error.message);
    return null;
  }
}
