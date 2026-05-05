import React, { useEffect, useState } from "react";
import {
  isFirebaseConfigured,
  signInWithGoogle,
  signOutUser,
  subscribeToAuth
} from "./firebaseClient.js";

export function AuthGate({ children }) {
  const [state, setState] = useState({ loading: isFirebaseConfigured, user: null, error: null });

  useEffect(() => {
    if (!isFirebaseConfigured) {
      return undefined;
    }
    return subscribeToAuth((user) => setState({ loading: false, user, error: null }));
  }, []);

  if (!isFirebaseConfigured) {
    return children;
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

  if (!state.user) {
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
                setState({ loading: false, user: null, error: error.message });
              }
            }}
          >
            Sign in with Google
          </button>
        </section>
      </main>
    );
  }

  return (
    <>
      <div className="auth-session-bar">
        <span>{state.user.email}</span>
        <button type="button" className="ghost" onClick={() => void signOutUser()}>
          Sign out
        </button>
      </div>
      {children}
    </>
  );
}
