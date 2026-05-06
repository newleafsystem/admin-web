import React, { useEffect, useState } from "react";
import { fetchCurrentSession } from "./api.js";
import {
  isFirebaseConfigured,
  signInWithGoogle,
  signOutUser,
  subscribeToAuth
} from "./firebaseClient.js";

export function AuthGate({ children }) {
  const canUseLocalDevSession = isLocalDevHost();
  const localDevSession = canUseLocalDevSession
    ? {
        user: {
          id: "local-dev",
          uid: "local-dev",
          email: "local-dev@newleaf.invalid",
          displayName: "Local Admin",
          role: "admin",
          roles: ["admin"],
          immutable: true
        },
        roles: ["admin"]
      }
    : null;
  const [state, setState] = useState({
    loading: isFirebaseConfigured,
    firebaseUser: null,
    session: isFirebaseConfigured ? null : localDevSession,
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
        setState({ loading: false, firebaseUser, session, error: null });
      } catch (error) {
        setState({ loading: false, firebaseUser, session: null, error: error.message });
      }
    });
  }, []);

  if (!isFirebaseConfigured && canUseLocalDevSession) {
    return renderChildren(children, state.session);
  }

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
        <section className="auth-panel">
          <p className="eyebrow">NewLeaf Admin</p>
          <h1>Checking session</h1>
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
          <button type="button" className="ghost" onClick={() => void signOutUser()}>
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
        <button type="button" className="ghost" onClick={() => void signOutUser()}>
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

function isLocalDevHost() {
  if (import.meta.env.DEV) {
    return true;
  }
  if (typeof window === "undefined") {
    return false;
  }
  return ["localhost", "127.0.0.1"].includes(window.location.hostname);
}
