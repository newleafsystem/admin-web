import React, { useEffect, useState } from "react";
import { clearCurrentSessionCookie, fetchCurrentSession } from "./api.js";
import {
  isFirebaseConfigured,
  signInWithGoogle,
  signOutUser,
  subscribeToAuth
} from "./firebaseClient.js";
import { LeafLoader } from "./components/LeafLoader.jsx";

const publicLegalPages = Object.freeze({
  "/privacy-policy": "privacy",
  "/privacy": "privacy",
  "/terms-and-conditions": "terms",
  "/terms": "terms"
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
    description: "Reusable strategy explainers and video assets for the NewLeaf content engine."
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
  const publicLegalPage = getPublicLegalPage();

  useEffect(() => {
    if (typeof window === "undefined" || state.loading) {
      return;
    }
    if (!state.firebaseUser && !publicLegalPage && window.location.pathname !== "/") {
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
  }, [isAdmin, publicLegalPage, state.firebaseUser, state.loading, state.session]);

  async function handleGoogleSignIn() {
    try {
      setState((current) => ({ ...current, error: null }));
      await signInWithGoogle();
    } catch (error) {
      setState({ loading: false, firebaseUser: null, session: null, error: error.message });
    }
  }

  if (publicLegalPage) {
    return <LegalPage page={publicLegalPage} />;
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
              <span className="login-brand-mark">NL</span>
              <div>
                <strong>NewLeaf System</strong>
                <span>Admin operations console</span>
              </div>
            </div>

            <div className="login-hero-copy">
              <p className="eyebrow">Private publishing operations</p>
              <h1 id="login-title">Run the content engine behind NewLeaf.</h1>
              <p>
                Coordinate educational options content, review workflows, video generation, and social publishing from
                one protected operations workspace.
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

function LegalPage({ page }) {
  const content = page === "terms" ? legalContent.terms : legalContent.privacy;
  return (
    <AuthPublicShell>
      <article className="legal-page" aria-labelledby="legal-page-title">
        <a className="legal-back-link" href="/">Back to sign in</a>
        <p className="eyebrow">NewLeaf System</p>
        <h1 id="legal-page-title">{content.title}</h1>
        <p className="legal-updated">Last updated: May 8, 2026</p>
        <div className="legal-content">
          {content.sections.map((section) => (
            <section key={section.heading}>
              <h2>{section.heading}</h2>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </section>
          ))}
        </div>
      </article>
    </AuthPublicShell>
  );
}

function PublicFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="auth-footer">
      <span>Copyright {year} NewLeaf System. All rights reserved.</span>
      <nav aria-label="Legal links">
        <a href="/privacy-policy">Privacy Policy</a>
        <a href="/terms-and-conditions">Terms and Conditions</a>
      </nav>
    </footer>
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

function getPublicLegalPage() {
  if (typeof window === "undefined") {
    return null;
  }
  const normalized = window.location.pathname.replace(/\/+$/, "").toLowerCase() || "/";
  return publicLegalPages[normalized] ?? null;
}

const legalContent = Object.freeze({
  privacy: {
    title: "Privacy Policy",
    sections: [
      {
        heading: "Overview",
        paragraphs: [
          "NewLeaf System uses account information to protect access to private administrative tools and to operate the content and publishing workflow.",
          "This admin experience may rely on Google sign-in, session cookies, analytics, and operational logs to keep the service reliable and secure."
        ]
      },
      {
        heading: "Information We Use",
        paragraphs: [
          "We may process account identifiers such as name, email address, profile image, role assignment, login time, and actions taken inside the console.",
          "We may also process operational metadata connected to content intake, reviews, video generation, publishing attempts, vendor access, and audit events."
        ]
      },
      {
        heading: "How Information Is Used",
        paragraphs: [
          "Information is used to authenticate approved users, enforce access controls, support publishing operations, troubleshoot errors, and maintain audit records.",
          "We do not use the admin console to provide guaranteed investment outcomes or personal financial advice."
        ]
      },
      {
        heading: "Third-Party Services",
        paragraphs: [
          "The platform may integrate with services such as Google, Firebase, YouTube, HeyGen, and other publishing or infrastructure providers.",
          "Those providers process data under their own terms and privacy practices when their services are used."
        ]
      },
      {
        heading: "Contact",
        paragraphs: [
          "Questions about this policy can be sent to support@newleafsystem.com."
        ]
      }
    ]
  },
  terms: {
    title: "Terms and Conditions",
    sections: [
      {
        heading: "Use of Service",
        paragraphs: [
          "NewLeaf System admin tools are private operational software. You may use them only if you are approved by NewLeaf System and comply with assigned access limits.",
          "You are responsible for keeping your account secure and for using the console in a lawful, authorized, and risk-aware manner."
        ]
      },
      {
        heading: "Educational Content",
        paragraphs: [
          "NewLeaf System content is educational. Options and securities involve risk, and past performance does not guarantee future results.",
          "Published content should not state or imply that any trade, model, strategy, or outcome is guaranteed, risk-free, or certain."
        ]
      },
      {
        heading: "Operational Responsibilities",
        paragraphs: [
          "Admins are responsible for reviewing titles, descriptions, metadata, scheduled publish times, channel selections, and provider outputs before approval.",
          "Vendor credentials, OAuth tokens, and provider secrets must not be shared, exposed, or stored outside approved systems."
        ]
      },
      {
        heading: "Availability and Changes",
        paragraphs: [
          "The service may change over time as workflows, providers, and access controls are updated.",
          "NewLeaf System may restrict, suspend, or revoke access when needed to protect users, systems, vendors, or publishing channels."
        ]
      },
      {
        heading: "Contact",
        paragraphs: [
          "Questions about these terms can be sent to support@newleafsystem.com."
        ]
      }
    ]
  }
});
