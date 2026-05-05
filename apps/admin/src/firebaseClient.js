import { initializeApp, getApps } from "firebase/app";
import { getAnalytics, isSupported as isAnalyticsSupported } from "firebase/analytics";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "firebase/auth";

function readFirebaseConfig() {
  const config = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY?.trim(),
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim(),
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim(),
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET?.trim(),
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim(),
    appId: import.meta.env.VITE_FIREBASE_APP_ID?.trim(),
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID?.trim()
  };

  const required = ["apiKey", "authDomain", "projectId", "appId"];
  return required.every((key) => Boolean(config[key])) ? config : null;
}

const firebaseConfig = readFirebaseConfig();

export const isFirebaseConfigured = Boolean(firebaseConfig);
export const firebaseApp = firebaseConfig ? getApps()[0] ?? initializeApp(firebaseConfig) : null;
export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null;

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

export function subscribeToAuth(callback) {
  if (!firebaseAuth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(firebaseAuth, callback);
}

export async function signInWithGoogle() {
  if (!firebaseAuth) {
    throw new Error("Firebase is not configured for this admin build.");
  }
  return signInWithPopup(firebaseAuth, googleProvider);
}

export async function signOutUser() {
  if (firebaseAuth) {
    await signOut(firebaseAuth);
  }
}

export async function getAuthToken() {
  if (!firebaseAuth?.currentUser) {
    return null;
  }
  return firebaseAuth.currentUser.getIdToken();
}

export async function initializeFirebaseAnalytics() {
  if (!firebaseApp || !firebaseConfig?.measurementId) {
    return null;
  }

  try {
    if (await isAnalyticsSupported()) {
      return getAnalytics(firebaseApp);
    }
  } catch (error) {
    console.warn("Firebase Analytics was not initialized.", error.message);
  }
  return null;
}
