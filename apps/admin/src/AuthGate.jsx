import React, { useEffect, useState } from "react";
import { clearCurrentSessionCookie, fetchCurrentSession } from "./api.js";
import {
  isFirebaseConfigured,
  signInWithGoogle,
  signOutUser,
  subscribeToAuth
} from "./firebaseClient.js";
import { LeafLoader } from "./components/LeafLoader.jsx";

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
    return subscribeToAuth(async (firebaseUser) => {
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
  }, []);

  if (!isFirebaseConfigured) {
    return (
      <main className="auth-screen">
        <section className="auth-panel">
          <p className="eyebrow">NewLeaf Admin</p>
          <h1>Authentication is not configured</h1>
          <p>This deployed admin build is missing Firebase web configuration, so Google sign-in cannot start.</p>
        </section>
      </main>
    );
  }

  if (state.loading) {
    return (
      <main className="auth-screen">
        <section className="auth-panel auth-loading-panel">
          <p className="eyebrow">NewLeaf Admin</p>
          <LeafLoader label="Preparing NewLeaf" />
        </section>
      </main>
    );
  }

  if (!state.firebaseUser) {
    return (
      <main className="auth-screen">
        <section className="auth-panel">
          <p className="eyebrow">NewLeaf Admin</p>
          <h1>Sign in required</h1>
          <p>Use your approved Google account to access the operations console.</p>
          {state.error && <p className="form-error">{state.error}</p>}
          <button
            type="button"
            className="primary"
            onClick={async () => {
              try {
                setState((current) => ({ ...current, error: null }));
                await signInWithGoogle();
              } catch (error) {
                setState({ loading: false, firebaseUser: null, session: null, error: error.message });
              }
            }}
          >
            Sign in with Google
          </button>
        </section>
      </main>
    );
  }

  if (!state.session?.roles?.includes("admin")) {
    return (
      <main className="auth-screen">
        <section className="auth-panel">
          <p className="eyebrow">NewLeaf Admin</p>
          <h1>Access Pending</h1>
          <p>Your account is signed in, but an admin has not granted console access yet.</p>
          <div className="pending-account">
            <strong>{state.session?.user?.email ?? state.firebaseUser.email}</strong>
            <span>Role: {state.session?.user?.role ?? "anonymous"}</span>
          </div>
          {state.error && <p className="form-error">{state.error}</p>}
          <button type="button" className="ghost" onClick={() => void signOutEverywhere()}>
            Sign out
          </button>
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

async function signOutEverywhere() {
  await clearCurrentSessionCookie().catch(() => {});
  await signOutUser();
}

function isInvalidProductionSession(session) {
  if (import.meta.env.DEV) {
    return false;
  }
  return /@newleaf\.invalid$/i.test(session?.user?.email ?? "");
}
