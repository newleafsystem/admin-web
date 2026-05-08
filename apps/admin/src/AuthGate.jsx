import React, { useEffect, useState } from "react";
import { clearCurrentSessionCookie, fetchCurrentSession } from "./api.js";
import {
  isFirebaseConfigured,
  signInWithGoogle,
  signOutUser,
  subscribeToAuth
} from "./firebaseClient.js";
import { LeafLoader } from "./components/LeafLoader.jsx";
import { PublicFooter, canonicalLegalLinks } from "./components/PublicFooter.jsx";
import { BrandLogo } from "./components/BrandLogo.jsx";

const legalRedirectByPath = Object.freeze({
  "/privacy-policy": canonicalLegalLinks.privacyPolicy,
  "/privacy": canonicalLegalLinks.privacyPolicy,
  "/terms-and-conditions": canonicalLegalLinks.termsAndConditions,
  "/terms": canonicalLegalLinks.termsAndConditions
});

const productHighlights = Object.freeze([
  {
    title: "Picks",
    description: "Weekly options ideas with review-ready content and publishing workflows."
  },
  {
    title: "Workbench",
    description: "Strategy analysis, scanners, and research assets prepared for education-led publishing."
  },
  {
    title: "Invest",
    description: "Portfolio and execution storytelling supported by structured operational controls."
  },
  {
    title: "Builder",
    description: "Reusable strategy explainers and content assets for NewLeaf operations."
  }
]);

export function AuthGate({ children }) {
  const [state, setState] = useState({
    loading: isFirebaseConfigured,
    firebaseUser: null,
    session: null,
    error: null
  });

  useEffect(() => {
    if (!isFirebaseConfigured) {
      return undefined;
    }
    let authStateResolved = false;
    const fallbackTimer = window.setTimeout(() => {
      if (!authStateResolved) {
        setState((current) => current.loading ? { ...current, loading: false } : current);
      }
    }, 6000);
    const unsubscribe = subscribeToAuth(async (firebaseUser) => {
      authStateResolved = true;
      window.clearTimeout(fallbackTimer);
      if (!firebaseUser) {
        setState({ loading: false, firebaseUser: null, session: null, error: null });
        return;
      }
      setState((current) => ({ ...current, loading: true, firebaseUser, error: null }));
      try {
        const session = await fetchCurrentSession();
        if (isInvalidProductionSession(session)) {
          throw new Error("Server authentication is misconfigured. Please retry after deployment is corrected.");
        }
        setState({ loading: false, firebaseUser, session, error: null });
      } catch (error) {
        setState({ loading: false, firebaseUser, session: null, error: error.message });
      }
    });
    return () => {
      window.clearTimeout(fallbackTimer);
      unsubscribe();
    };
  }, []);

  const isAdmin = state.session?.roles?.includes("admin");
  const legalRedirectUrl = getLegalRedirectUrl();

  useEffect(() => {
    if (legalRedirectUrl && typeof window !== "undefined") {
      window.location.replace(legalRedirectUrl);
    }
  }, [legalRedirectUrl]);

  useEffect(() => {
    if (typeof window === "undefined" || state.loading) {
      return;
    }
    if (legalRedirectUrl) {
      return;
    }
    if (!state.firebaseUser && window.location.pathname !== "/") {
      window.history.replaceState({}, "", "/");
      return;
    }
    if (state.firebaseUser && state.session && !isAdmin && window.location.pathname !== "/403") {
      window.history.replaceState({}, "", "/403");
      return;
    }
    if (isAdmin && window.location.pathname === "/403") {
      window.history.replaceState({}, "", "/");
    }
  }, [isAdmin, legalRedirectUrl, state.firebaseUser, state.loading, state.session]);

  async function handleGoogleSignIn() {
    try {
      setState((current) => ({ ...current, error: null }));
      await signInWithGoogle();
    } catch (error) {
      setState({ loading: false, firebaseUser: null, session: null, error: error.message });
    }
  }

  if (legalRedirectUrl) {
    return (
      <AuthPublicShell>
        <section className="auth-panel auth-loading-panel">
          <p className="eyebrow">NewLeaf System</p>
          <LeafLoader label="Opening legal page" />
        </section>
      </AuthPublicShell>
    );
  }

  if (!isFirebaseConfigured) {
    return (
      <AuthPublicShell>
        <section className="auth-panel auth-panel-centered">
          <p className="eyebrow">NewLeaf Admin</p>
          <h1>Authentication is not configured</h1>
          <p>This deployed admin build is missing Firebase web configuration, so Google sign-in cannot start.</p>
        </section>
      </AuthPublicShell>
    );
  }

  if (state.loading) {
    return (
      <AuthPublicShell>
        <section className="auth-panel auth-loading-panel">
          <p className="eyebrow">NewLeaf Admin</p>
          <LeafLoader label="Preparing NewLeaf" />
        </section>
      </AuthPublicShell>
    );
  }

  if (!state.firebaseUser) {
    return (
      <AuthPublicShell>
        <section className="login-hero" aria-labelledby="login-title">
          <div className="login-brand-column">
            <div className="login-brand-lockup">
              <BrandLogo className="login-brand-mark" />
              <div>
                <strong>NewLeaf System</strong>
                <span>newleafsystem.com admin console</span>
              </div>
            </div>

            <div className="login-hero-copy">
              <p className="eyebrow">Private admin operations</p>
              <h1 id="login-title">Manage NewLeaf System operations.</h1>
              <p>
                Administer the workflows behind newleafsystem.com from one protected workspace. The console currently
                covers content review, video publishing, vendors, users, and operational controls.
              </p>
            </div>

            <div className="login-product-grid" aria-label="NewLeaf product areas">
              {productHighlights.map((product) => (
                <article className="login-product-card" key={product.title}>
                  <strong>{product.title}</strong>
                  <p>{product.description}</p>
                </article>
              ))}
            </div>

            <p className="login-risk-note">
              NewLeaf content is educational and risk-aware. Options involve risk and are not suitable for every
              investor.
            </p>
          </div>

          <aside className="login-panel" aria-label="Admin sign in">
            <div className="login-panel-header">
              <p className="eyebrow">Approved access only</p>
              <h2>Sign in to continue</h2>
              <p>Use your approved Google account. Access is granted by NewLeaf administrators.</p>
            </div>
            {state.error && <p className="form-error">{state.error}</p>}
            <button type="button" className="primary login-google-button" onClick={() => void handleGoogleSignIn()}>
              <span aria-hidden="true">G</span>
              Sign in with Google
            </button>
            <div className="login-security-list" aria-label="Security controls">
              <span>Role-gated admin routes</span>
              <span>Protected API sessions</span>
              <span>Private vendor operations</span>
            </div>
          </aside>
        </section>
      </AuthPublicShell>
    );
  }

  if (!isAdmin) {
    return (
      <main className="forbidden-screen">
        <div className="auth-public-shell forbidden-public-shell">
          <section className="forbidden-shell" aria-labelledby="forbidden-title">
            <div className="forbidden-status" aria-hidden="true">
              <span>403</span>
            </div>
            <div className="forbidden-content">
              <p className="eyebrow">NewLeaf Admin</p>
              <h1 id="forbidden-title">Access forbidden</h1>
              <p>
                This Google account is signed in, but it does not have permission to open the NewLeaf
                operations console.
              </p>
              <div className="forbidden-account">
                <span>Signed in as</span>
                <strong>{state.session?.user?.email ?? state.firebaseUser.email}</strong>
              </div>
              {state.error && <p className="form-error">{state.error}</p>}
              <div className="forbidden-actions">
                <button type="button" className="primary" onClick={() => void signOutEverywhere({ redirectTo: "/" })}>
                  Sign out
                </button>
              </div>
            </div>
          </section>
          <PublicFooter />
        </div>
      </main>
    );
  }

  return (
    <>
      <div className="auth-session-bar">
        <span>{state.session.user.email}</span>
        <button type="button" className="ghost" onClick={() => void signOutEverywhere()}>
          Sign out
        </button>
      </div>
      {renderChildren(children, state.session)}
    </>
  );
}

function renderChildren(children, session) {
  return typeof children === "function" ? children(session) : children;
}

function AuthPublicShell({ children }) {
  return (
    <main className="auth-screen">
      <div className="auth-public-shell">
        {children}
        <PublicFooter />
      </div>
    </main>
  );
}

async function signOutEverywhere({ redirectTo = null } = {}) {
  await clearCurrentSessionCookie().catch(() => {});
  await signOutUser();
  if (redirectTo && typeof window !== "undefined" && window.location.pathname !== redirectTo) {
    window.history.replaceState({}, "", redirectTo);
  }
}

function isInvalidProductionSession(session) {
  if (import.meta.env.DEV) {
    return false;
  }
  return /@newleaf\.invalid$/i.test(session?.user?.email ?? "");
}

function getLegalRedirectUrl() {
  if (typeof window === "undefined") {
    return null;
  }
  const normalized = window.location.pathname.replace(/\/+$/, "").toLowerCase() || "/";
  return legalRedirectByPath[normalized] ?? null;
}
