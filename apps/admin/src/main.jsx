import React from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./AuthGate.jsx";
import App from "./App.jsx";
import { initializeFirebaseAnalytics } from "./firebaseClient.js";
import "./styles.css";

void initializeFirebaseAnalytics();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>
);
