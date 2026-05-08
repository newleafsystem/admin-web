import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./AuthGate.jsx";
import { LeafLoader } from "./components/LeafLoader.jsx";
import "./styles.css";

const App = lazy(() => import("./App.jsx"));

initializeAnalyticsWhenIdle();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate>
      {(session) => (
        <Suspense
          fallback={
            <main className="auth-screen">
              <div className="auth-public-shell">
                <section className="auth-panel auth-loading-panel">
                  <p className="eyebrow">NewLeaf Admin</p>
                  <LeafLoader label="Opening console" />
                </section>
              </div>
            </main>
          }
        >
          <App session={session} />
        </Suspense>
      )}
    </AuthGate>
  </React.StrictMode>
);

function initializeAnalyticsWhenIdle() {
  const start = () => {
    import("./firebaseAnalytics.js")
      .then(({ initializeFirebaseAnalytics }) => initializeFirebaseAnalytics())
      .catch((error) => {
        console.warn("Firebase Analytics module was not loaded.", error.message);
      });
  };

  if (typeof window === "undefined") {
    return;
  }

  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(start, { timeout: 3000 });
    return;
  }

  window.setTimeout(start, 1500);
}
