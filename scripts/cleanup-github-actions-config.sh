#!/usr/bin/env bash

# Removes GitHub Actions repository variables and secrets that were used by
# older deployment shapes but are no longer consumed by current workflows.
# Default mode is a dry run. Pass --apply to delete.

set -euo pipefail

REPO="${GITHUB_REPOSITORY:-}"
APPLY=false

obsolete_variables=(
  ASSET_STORAGE_PROVIDER
  ASSET_STORAGE_BUCKET
  FIREBASE_STORAGE_BUCKET
  MEDIA_STORAGE_BUCKET
  GCP_WORKLOAD_IDENTITY_PROVIDER
  GCP_SERVICE_ACCOUNT
  FIREBASE_CREDENTIALS_JSON
  GOOGLE_APPLICATION_CREDENTIALS
  GOOGLE_CLOUD_RUN_REGION
  CLOUD_TASKS_LOCATION
  CLOUD_TASKS_QUEUE
  SERVICE_API_RATE_LIMIT_PER_MINUTE
  SERVICE_API_SIGNATURE_TOLERANCE_SEC
  MAX_RENDER_REQUEST_BYTES
  KEEP_RENDER_TEMP
  YOUTUBE_UPLOAD_CHUNK_BYTES
  X_UPLOAD_CHUNK_BYTES
  LINKEDIN_REDIRECT_URI
  LINKEDIN_SCOPES
  LINKEDIN_API_VERSION
  META_REDIRECT_URI
  META_GRAPH_VERSION
  META_FACEBOOK_SCOPES
  META_INSTAGRAM_SCOPES
  TIKTOK_REDIRECT_URI
  HEYGEN_API_BASE_URL
  HEYGEN_SIGNATURE_HEADER
  HEYGEN_TIMESTAMP_HEADER
  FFMPEG_PATH
  FFPROBE_PATH
  FFMPEG_FONT_FILE
)

obsolete_secrets=(
  FIREBASE_SERVICE_ACCOUNT_NEWLEAF_TRADING
  FIREBASE_CREDENTIALS_JSON
  GOOGLE_APPLICATION_CREDENTIALS
  AI_API_KEY
  LINKEDIN_CLIENT_SECRET
  META_APP_SECRET
  TIKTOK_CLIENT_SECRET
)

usage() {
  cat <<EOF
Usage:
  bash scripts/cleanup-github-actions-config.sh --repo owner/repo [--apply]

Options:
  --repo <owner/repo> GitHub repository. Defaults to GITHUB_REPOSITORY or gh repo view.
  --apply             Delete obsolete variables/secrets. Without this, only prints what would be deleted.
  -h, --help          Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    --apply)
      APPLY=true
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

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI 'gh' is required for repository variable/secret cleanup." >&2
  exit 1
fi

if [[ -z "${REPO}" ]]; then
  REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
fi
if [[ -z "${REPO}" ]]; then
  echo "ERROR: GitHub repository is required. Pass --repo owner/repo." >&2
  exit 1
fi

gh auth status >/dev/null

mapfile -t current_variables < <(gh variable list --repo "${REPO}" --json name --jq '.[].name')
mapfile -t current_secrets < <(gh secret list --repo "${REPO}" --json name --jq '.[].name')

contains() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    [[ "${item}" == "${needle}" ]] && return 0
  done
  return 1
}

delete_variable() {
  local name="$1"
  if ! contains "${name}" "${current_variables[@]}"; then
    return
  fi
  if [[ "${APPLY}" == "true" ]]; then
    gh variable delete "${name}" --repo "${REPO}"
    echo "Deleted repository variable ${name}"
  else
    echo "DRY RUN: would delete repository variable ${name}"
  fi
}

delete_secret() {
  local name="$1"
  if ! contains "${name}" "${current_secrets[@]}"; then
    return
  fi
  if [[ "${APPLY}" == "true" ]]; then
    gh secret delete "${name}" --repo "${REPO}"
    echo "Deleted repository secret ${name}"
  else
    echo "DRY RUN: would delete repository secret ${name}"
  fi
}

echo "Repository: ${REPO}"
if [[ "${APPLY}" != "true" ]]; then
  echo "Mode: dry run. Re-run with --apply to delete obsolete entries."
fi

for name in "${obsolete_variables[@]}"; do
  delete_variable "${name}"
done

for name in "${obsolete_secrets[@]}"; do
  delete_secret "${name}"
done

echo "GitHub Actions config cleanup complete."
