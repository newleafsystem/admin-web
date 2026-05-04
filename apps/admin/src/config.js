function getDefaultApiBaseUrl() {
  if (import.meta.env.PROD) {
    return "/api/v1";
  }

  if (typeof window === "undefined") {
    return "http://localhost:8080/api/v1";
  }

  const localHosts = new Set(["localhost", "127.0.0.1"]);
  if (localHosts.has(window.location.hostname)) {
    return "http://localhost:8080/api/v1";
  }

  return `${window.location.origin}/api/v1`;
}

function getConfiguredApiBaseUrl() {
  const value = import.meta.env.VITE_API_BASE_URL?.trim();
  return value || getDefaultApiBaseUrl();
}

export const API_BASE_URL = getConfiguredApiBaseUrl().replace(/\/$/, "");
