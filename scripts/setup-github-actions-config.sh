#!/usr/bin/env bash

# Push the required GitHub Actions repository variables and secrets for NewLeaf
# deployment workflows. This script uses GitHub CLI and never prints secret
# values.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
REPO="${GITHUB_REPOSITORY:-}"
DRY_RUN=false
ALLOW_LOCAL_VALUES=false

usage() {
  cat <<EOF
Usage:
  ENV_FILE=.env.production bash scripts/setup-github-actions-config.sh --repo owner/repo

Options:
  --env-file <path>   Env file to read. Defaults to .env.production.
  --repo <owner/repo> GitHub repository. Defaults to GITHUB_REPOSITORY or gh repo view.
  --dry-run           Print variable/secret names that would be set.
  --allow-local-values Allow localhost URLs to be pushed intentionally.
  -h, --help          Show this help.

Required env values:
  GCS_BUCKET
  FIREBASE_SERVICE_ACCOUNT_FILE or existing FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING secret
  MEDIA_RENDER_HMAC_SECRET
  GCP_WORKLOAD_IDENTITY_PROVIDER
  GCP_SERVICE_ACCOUNT
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --allow-local-values)
      ALLOW_LOCAL_VALUES=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: Env file not found: ${ENV_FILE}" >&2
  echo "Create it first: copy .env.production.example .env.production" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${ROOT_DIR}/scripts/load-env-file.sh"
load_env_file "${ENV_FILE}"

find_gh() {
  local candidate
  if candidate="$(command -v gh 2>/dev/null)"; then
    printf '%s\n' "${candidate}"
    return 0
  fi

  for candidate in \
    "/c/Program Files/GitHub CLI/gh.exe" \
    "/mnt/c/Program Files/GitHub CLI/gh.exe" \
    "/c/Program Files (x86)/GitHub CLI/gh.exe" \
    "/mnt/c/Program Files (x86)/GitHub CLI/gh.exe"; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}

if ! GH_BIN="$(find_gh)"; then
  echo "ERROR: GitHub CLI 'gh' is not installed or not in PATH." >&2
  exit 1
fi

if [[ -z "${REPO}" ]]; then
  REPO="$("${GH_BIN}" repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
fi

if [[ -z "${REPO}" ]]; then
  echo "ERROR: GitHub repo is required. Pass --repo owner/repo or set GITHUB_REPOSITORY." >&2
  exit 1
fi

if [[ "${DRY_RUN}" != "true" ]]; then
  "${GH_BIN}" auth status >/dev/null
fi

has_value() {
  [[ -n "${1:-}" ]] && [[ ! "${1}" =~ ^(<.*>|your-|changeme|todo|undefined|null)$ ]]
}

require_value() {
  local name="$1"
  local value="${!name:-}"
  if ! has_value "${value}"; then
    echo "ERROR: ${name} is required in ${ENV_FILE} or the shell environment." >&2
    exit 1
  fi
}

set_variable() {
  local name="$1"
  local value="$2"
  if ! has_value "${value}"; then
    echo "Skipping empty repository variable: ${name}"
    return 0
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "DRY RUN: would set repository variable ${name}"
    return 0
  fi

  "${GH_BIN}" variable set "${name}" --repo "${REPO}" --body "${value}" >/dev/null
  echo "Set repository variable ${name}"
}

secret_exists() {
  local name="$1"
  "${GH_BIN}" secret list --repo "${REPO}" --json name --jq '.[].name' | grep -qx "${name}"
}

set_secret_value() {
  local name="$1"
  local value="$2"
  if ! has_value "${value}"; then
    echo "Skipping empty secret: ${name}"
    return 0
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "DRY RUN: would set secret ${name}"
    return 0
  fi

  "${GH_BIN}" secret set "${name}" --repo "${REPO}" --body "${value}" >/dev/null
  echo "Set secret ${name}"
}

set_secret_file() {
  local name="$1"
  local file_path="$2"
  if [[ -z "${file_path}" ]]; then
    return 1
  fi
  if [[ ! -f "${file_path}" ]]; then
    echo "ERROR: Secret file not found for ${name}: ${file_path}" >&2
    exit 1
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "DRY RUN: would set secret ${name} from file"
    return 0
  fi

  "${GH_BIN}" secret set "${name}" --repo "${REPO}" < "${file_path}" >/dev/null
  echo "Set secret ${name} from file"
}

set_firebase_hosting_secret() {
  local secret_name="FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING"
  local json_value="${FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING:-${FIREBASE_SERVICE_ACCOUNT_JSON:-}}"
  local file_path="${FIREBASE_SERVICE_ACCOUNT_FILE:-${FIREBASE_SERVICE_ACCOUNT_JSON_FILE:-}}"

  if has_value "${json_value}"; then
    set_secret_value "${secret_name}" "${json_value}"
    return 0
  fi

  if [[ -n "${file_path}" ]]; then
    set_secret_file "${secret_name}" "${file_path}"
    return 0
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "DRY RUN: Firebase Hosting requires ${secret_name}; provide FIREBASE_SERVICE_ACCOUNT_FILE or keep the existing repository secret."
    return 0
  fi

  if secret_exists "${secret_name}"; then
    echo "Keeping existing secret ${secret_name}"
    return 0
  fi

  echo "ERROR: ${secret_name} is required for Firebase Hosting deploy." >&2
  echo "Set FIREBASE_SERVICE_ACCOUNT_FILE to a service-account JSON file path, or create the ${secret_name} repository secret first." >&2
  exit 1
}

derive_defaults() {
  local project_id="${GCP_PROJECT_ID:-${FIREBASE_PROJECT_ID:-newleaf-trading}}"
  if [[ -z "${GCS_BUCKET:-}" && -n "${project_id}" ]]; then
    GCS_BUCKET="${project_id}.firebasestorage.app"
  fi
  local callback_base="${SOCIAL_CALLBACK_BASE_URL:-${PUBLIC_BASE_URL:-${ADMIN_BASE_URL:-https://admin.newleafsystem.com}}}"
  if [[ -z "${YOUTUBE_REDIRECT_URI:-}" ]]; then
    YOUTUBE_REDIRECT_URI="${callback_base}/api/v1/social/youtube/oauth/callback"
  fi
  if [[ -z "${X_REDIRECT_URI:-}" ]]; then
    X_REDIRECT_URI="${callback_base}/api/v1/social/x/oauth/callback"
  fi
  if [[ -z "${LINKEDIN_REDIRECT_URI:-}" ]]; then
    LINKEDIN_REDIRECT_URI="${callback_base}/api/v1/social/linkedin/oauth/callback"
  fi
  if [[ -z "${META_REDIRECT_URI:-}" ]]; then
    META_REDIRECT_URI="${callback_base}/api/v1/social/meta/oauth/callback"
  fi
  if [[ -z "${TIKTOK_REDIRECT_URI:-}" ]]; then
    TIKTOK_REDIRECT_URI="${callback_base}/api/v1/social/tiktok/oauth/callback"
  fi
}

derive_defaults

require_value GCS_BUCKET
require_value MEDIA_RENDER_HMAC_SECRET
require_value GCP_WORKLOAD_IDENTITY_PROVIDER
require_value GCP_SERVICE_ACCOUNT

if [[ "${ALLOW_LOCAL_VALUES}" != "true" ]]; then
  for pair in \
    "PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-}" \
    "ADMIN_BASE_URL=${ADMIN_BASE_URL:-}" \
    "SOCIAL_CALLBACK_BASE_URL=${SOCIAL_CALLBACK_BASE_URL:-}" \
    "CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS:-}" \
    "YOUTUBE_REDIRECT_URI=${YOUTUBE_REDIRECT_URI:-}" \
    "X_REDIRECT_URI=${X_REDIRECT_URI:-}" \
    "LINKEDIN_REDIRECT_URI=${LINKEDIN_REDIRECT_URI:-}" \
    "META_REDIRECT_URI=${META_REDIRECT_URI:-}" \
    "TIKTOK_REDIRECT_URI=${TIKTOK_REDIRECT_URI:-}"; do
    if [[ "${pair}" =~ localhost|127\.0\.0\.1 ]]; then
      echo "ERROR: Refusing to push local URL value to GitHub Actions: ${pair%%=*}" >&2
      echo "Use .env.production values or pass --allow-local-values for an intentional test setup." >&2
      exit 1
    fi
  done
fi

echo "Configuring GitHub Actions for ${REPO}"
echo "Using env file: ${ENV_FILE}"

set_variable GCP_PROJECT_ID "${GCP_PROJECT_ID:-${FIREBASE_PROJECT_ID:-newleaf-trading}}"
set_variable GCP_REGION "${GCP_REGION:-${GOOGLE_CLOUD_RUN_REGION:-us-central1}}"
set_variable GOOGLE_CLOUD_RUN_API_SERVICE "${GOOGLE_CLOUD_RUN_API_SERVICE:-newleaf-api}"
set_variable GOOGLE_CLOUD_RUN_RENDERER_SERVICE "${GOOGLE_CLOUD_RUN_RENDERER_SERVICE:-newleaf-ffmpeg-renderer}"
set_variable GCS_BUCKET "${GCS_BUCKET}"
set_variable SKIP_ENABLE_APIS "${SKIP_ENABLE_APIS:-true}"
set_variable SKIP_PROVISIONING "${SKIP_PROVISIONING:-true}"
set_variable CLOUD_BUILD_SUPPRESS_LOGS "${CLOUD_BUILD_SUPPRESS_LOGS:-true}"
set_variable REQUIRE_AUTH "${REQUIRE_AUTH:-true}"
set_variable AUTH_ADMIN_EMAILS "${AUTH_ADMIN_EMAILS:-}"
set_variable AUTH_SESSION_COOKIE_NAME "${AUTH_SESSION_COOKIE_NAME:-newleaf_session}"
set_variable AUTH_SESSION_COOKIE_DOMAIN "${AUTH_SESSION_COOKIE_DOMAIN:-.newleafsystem.com}"
set_variable AUTH_SESSION_COOKIE_PATH "${AUTH_SESSION_COOKIE_PATH:-/api/v1}"
set_variable AUTH_SESSION_COOKIE_MAX_AGE_SEC "${AUTH_SESSION_COOKIE_MAX_AGE_SEC:-432000}"
set_variable AUTH_SESSION_COOKIE_SAME_SITE "${AUTH_SESSION_COOKIE_SAME_SITE:-lax}"
set_variable AUTH_SESSION_COOKIE_SECURE "${AUTH_SESSION_COOKIE_SECURE:-true}"
set_variable FIRESTORE_DATABASE_ID "${FIRESTORE_DATABASE_ID:-newleafdb}"
set_variable PUBLIC_BASE_URL "${PUBLIC_BASE_URL:-https://admin.newleafsystem.com}"
set_variable ADMIN_BASE_URL "${ADMIN_BASE_URL:-https://admin.newleafsystem.com}"
set_variable SOCIAL_CALLBACK_BASE_URL "${SOCIAL_CALLBACK_BASE_URL:-${PUBLIC_BASE_URL:-https://admin.newleafsystem.com}}"
set_variable CORS_ALLOWED_ORIGINS "${CORS_ALLOWED_ORIGINS:-${ADMIN_BASE_URL:-https://admin.newleafsystem.com}}"
set_variable VITE_FIREBASE_API_KEY "${VITE_FIREBASE_API_KEY:-}"
set_variable VITE_FIREBASE_AUTH_DOMAIN "${VITE_FIREBASE_AUTH_DOMAIN:-}"
set_variable VITE_FIREBASE_PROJECT_ID "${VITE_FIREBASE_PROJECT_ID:-${FIREBASE_PROJECT_ID:-}}"
set_variable VITE_FIREBASE_STORAGE_BUCKET "${VITE_FIREBASE_STORAGE_BUCKET:-${GCS_BUCKET:-}}"
set_variable VITE_FIREBASE_MESSAGING_SENDER_ID "${VITE_FIREBASE_MESSAGING_SENDER_ID:-}"
set_variable VITE_FIREBASE_APP_ID "${VITE_FIREBASE_APP_ID:-}"
set_variable VITE_FIREBASE_MEASUREMENT_ID "${VITE_FIREBASE_MEASUREMENT_ID:-}"
set_variable YOUTUBE_CLIENT_ID "${YOUTUBE_CLIENT_ID:-}"
if has_value "${YOUTUBE_REDIRECT_URI:-}"; then
  set_variable YOUTUBE_REDIRECT_URI "${YOUTUBE_REDIRECT_URI}"
fi
if has_value "${YOUTUBE_SCOPES:-}"; then
  set_variable YOUTUBE_SCOPES "${YOUTUBE_SCOPES}"
fi
if has_value "${YOUTUBE_DEFAULT_PRIVACY_STATUS:-}"; then
  set_variable YOUTUBE_DEFAULT_PRIVACY_STATUS "${YOUTUBE_DEFAULT_PRIVACY_STATUS}"
fi
if has_value "${YOUTUBE_DEFAULT_CATEGORY_ID:-}"; then
  set_variable YOUTUBE_DEFAULT_CATEGORY_ID "${YOUTUBE_DEFAULT_CATEGORY_ID}"
fi
set_variable X_CLIENT_ID "${X_CLIENT_ID:-}"
if has_value "${X_REDIRECT_URI:-}"; then
  set_variable X_REDIRECT_URI "${X_REDIRECT_URI}"
fi
if has_value "${X_SCOPES:-}"; then
  set_variable X_SCOPES "${X_SCOPES}"
fi
if has_value "${X_UPLOAD_CHUNK_BYTES:-}"; then
  set_variable X_UPLOAD_CHUNK_BYTES "${X_UPLOAD_CHUNK_BYTES}"
fi
set_variable LINKEDIN_CLIENT_ID "${LINKEDIN_CLIENT_ID:-}"
if has_value "${LINKEDIN_REDIRECT_URI:-}"; then
  set_variable LINKEDIN_REDIRECT_URI "${LINKEDIN_REDIRECT_URI}"
fi
if has_value "${LINKEDIN_SCOPES:-}"; then
  set_variable LINKEDIN_SCOPES "${LINKEDIN_SCOPES}"
fi
if has_value "${LINKEDIN_API_VERSION:-}"; then
  set_variable LINKEDIN_API_VERSION "${LINKEDIN_API_VERSION}"
fi
set_variable META_APP_ID "${META_APP_ID:-}"
if has_value "${META_REDIRECT_URI:-}"; then
  set_variable META_REDIRECT_URI "${META_REDIRECT_URI}"
fi
if has_value "${META_GRAPH_VERSION:-}"; then
  set_variable META_GRAPH_VERSION "${META_GRAPH_VERSION}"
fi
if has_value "${META_FACEBOOK_SCOPES:-}"; then
  set_variable META_FACEBOOK_SCOPES "${META_FACEBOOK_SCOPES}"
fi
if has_value "${META_INSTAGRAM_SCOPES:-}"; then
  set_variable META_INSTAGRAM_SCOPES "${META_INSTAGRAM_SCOPES}"
fi

if has_value "${MEDIA_RENDERER_URL:-}"; then
  set_variable MEDIA_RENDERER_URL "${MEDIA_RENDERER_URL}"
fi

set_secret_value GCP_WORKLOAD_IDENTITY_PROVIDER "${GCP_WORKLOAD_IDENTITY_PROVIDER}"
set_secret_value GCP_SERVICE_ACCOUNT "${GCP_SERVICE_ACCOUNT}"
set_firebase_hosting_secret
set_secret_value MEDIA_RENDER_HMAC_SECRET "${MEDIA_RENDER_HMAC_SECRET}"
set_secret_value YOUTUBE_CLIENT_SECRET "${YOUTUBE_CLIENT_SECRET:-}"
set_secret_value X_CLIENT_SECRET "${X_CLIENT_SECRET:-}"
set_secret_value LINKEDIN_CLIENT_SECRET "${LINKEDIN_CLIENT_SECRET:-}"
set_secret_value META_APP_SECRET "${META_APP_SECRET:-}"

echo "GitHub Actions configuration complete."
