import { getAnalytics, isSupported as isAnalyticsSupported } from "firebase/analytics";
import { firebaseApp } from "./firebaseClient.js";

const measurementId = import.meta.env.VITE_FIREBASE_MEASUREMENT_ID?.trim();

export async function initializeFirebaseAnalytics() {
  if (!firebaseApp || !measurementId) {
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
