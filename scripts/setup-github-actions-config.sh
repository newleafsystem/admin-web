#!/usr/bin/env bash

# Push the required GitHub Actions repository variables and secrets for NewLeaf
# deployment workflows. This script uses GitHub CLI and never prints secret
# values.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
REPO="${GITHUB_REPOSITORY:-}"
DRY_RUN=false

usage() {
  cat <<EOF
Usage:
  ENV_FILE=.env.production bash scripts/setup-github-actions-config.sh --repo owner/repo

Options:
  --env-file <path>   Env file to read. Defaults to .env.production.
  --repo <owner/repo> GitHub repository. Defaults to GITHUB_REPOSITORY or gh repo view.
  --dry-run           Print variable/secret names that would be set.
  -h, --help          Show this help.

Required env values:
  GCS_BUCKET
  MEDIA_RENDER_HMAC_SECRET
  GCP_WORKLOAD_IDENTITY_PROVIDER
  GCP_SERVICE_ACCOUNT

Firebase Hosting secret:
  FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING_FILE=/path/to/firebase-service-account.json
  or FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING='{"type":"service_account",...}'
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

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI 'gh' is not installed or not in PATH." >&2
  exit 1
fi

if [[ -z "${REPO}" ]]; then
  REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
fi

if [[ -z "${REPO}" ]]; then
  echo "ERROR: GitHub repo is required. Pass --repo owner/repo or set GITHUB_REPOSITORY." >&2
  exit 1
fi

if [[ "${DRY_RUN}" != "true" ]]; then
  gh auth status >/dev/null
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

  gh variable set "${name}" --repo "${REPO}" --body "${value}" >/dev/null
  echo "Set repository variable ${name}"
}

secret_exists() {
  local name="$1"
  gh secret list --repo "${REPO}" --json name --jq '.[].name' | grep -qx "${name}"
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

  gh secret set "${name}" --repo "${REPO}" --body "${value}" >/dev/null
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

  gh secret set "${name}" --repo "${REPO}" < "${file_path}" >/dev/null
  echo "Set secret ${name} from file"
}

require_value GCS_BUCKET
require_value MEDIA_RENDER_HMAC_SECRET
require_value GCP_WORKLOAD_IDENTITY_PROVIDER
require_value GCP_SERVICE_ACCOUNT

echo "Configuring GitHub Actions for ${REPO}"
echo "Using env file: ${ENV_FILE}"

set_variable GCP_PROJECT_ID "${GCP_PROJECT_ID:-${FIREBASE_PROJECT_ID:-newleaf-trading}}"
set_variable GCP_REGION "${GCP_REGION:-${GOOGLE_CLOUD_RUN_REGION:-us-central1}}"
set_variable GOOGLE_CLOUD_RUN_API_SERVICE "${GOOGLE_CLOUD_RUN_API_SERVICE:-newleaf-api}"
set_variable GOOGLE_CLOUD_RUN_RENDERER_SERVICE "${GOOGLE_CLOUD_RUN_RENDERER_SERVICE:-newleaf-ffmpeg-renderer}"
set_variable GCS_BUCKET "${GCS_BUCKET}"
set_variable SKIP_ENABLE_APIS "${SKIP_ENABLE_APIS:-true}"
set_variable SKIP_PROVISIONING "${SKIP_PROVISIONING:-true}"
set_variable REQUIRE_AUTH "${REQUIRE_AUTH:-true}"
set_variable FIRESTORE_DATABASE_ID "${FIRESTORE_DATABASE_ID:-newleafdb}"
set_variable PUBLIC_BASE_URL "${PUBLIC_BASE_URL:-https://admin.newleafsystem.com}"
set_variable ADMIN_BASE_URL "${ADMIN_BASE_URL:-https://admin.newleafsystem.com}"
set_variable SOCIAL_CALLBACK_BASE_URL "${SOCIAL_CALLBACK_BASE_URL:-${PUBLIC_BASE_URL:-https://admin.newleafsystem.com}}"
set_variable CORS_ALLOWED_ORIGINS "${CORS_ALLOWED_ORIGINS:-${ADMIN_BASE_URL:-https://admin.newleafsystem.com}}"

if has_value "${MEDIA_RENDERER_URL:-}"; then
  set_variable MEDIA_RENDERER_URL "${MEDIA_RENDERER_URL}"
fi

set_secret_value GCP_WORKLOAD_IDENTITY_PROVIDER "${GCP_WORKLOAD_IDENTITY_PROVIDER}"
set_secret_value GCP_SERVICE_ACCOUNT "${GCP_SERVICE_ACCOUNT}"
set_secret_value MEDIA_RENDER_HMAC_SECRET "${MEDIA_RENDER_HMAC_SECRET}"

firebase_secret_name="FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING"
if has_value "${FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING_FILE:-}"; then
  set_secret_file "${firebase_secret_name}" "${FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING_FILE}"
elif has_value "${FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING:-}"; then
  set_secret_value "${firebase_secret_name}" "${FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING}"
elif [[ "${DRY_RUN}" == "true" ]]; then
  echo "DRY RUN: would keep or require secret ${firebase_secret_name}"
elif secret_exists "${firebase_secret_name}"; then
  echo "Secret ${firebase_secret_name} already exists; keeping existing value."
else
  echo "ERROR: ${firebase_secret_name} is required." >&2
  echo "Set FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING_FILE or run Firebase CLI hosting:github setup." >&2
  exit 1
fi

echo "GitHub Actions configuration complete."
