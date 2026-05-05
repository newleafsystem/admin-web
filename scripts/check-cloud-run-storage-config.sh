#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=/dev/null
source "${ROOT_DIR}/scripts/load-env-file.sh"
load_env_file "${ENV_FILE:-${ROOT_DIR}/.env}"

GCP_PROJECT_ID="${GCP_PROJECT_ID:-${FIREBASE_PROJECT_ID:-}}"
GCP_REGION="${GCP_REGION:-${GOOGLE_CLOUD_RUN_REGION:-us-central1}}"
SERVICE_NAME="${SERVICE_NAME:-${GOOGLE_CLOUD_RUN_API_SERVICE:-newleaf-api}}"

if [[ -z "${GCP_PROJECT_ID:-}" ]]; then
  echo "ERROR: GCP_PROJECT_ID or FIREBASE_PROJECT_ID is required." >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud is not installed or not in PATH." >&2
  exit 1
fi

echo "Cloud Run service: ${SERVICE_NAME}"
echo "Project: ${GCP_PROJECT_ID}"
echo "Region: ${GCP_REGION}"
echo

echo "Runtime storage environment:"
gcloud run services describe "${SERVICE_NAME}" \
  --project "${GCP_PROJECT_ID}" \
  --region "${GCP_REGION}" \
  --format='table(spec.template.spec.containers[0].env[].name,spec.template.spec.containers[0].env[].value)' \
  | grep -E '^(GCS_BUCKET|LOCAL_DATA_DIR|REPOSITORY_PROVIDER|FIRESTORE_DATABASE_ID)[[:space:]]' \
  || true

echo
echo "Configured buckets in project:"
gcloud storage buckets list \
  --project "${GCP_PROJECT_ID}" \
  --format='value(name)' \
  | sed 's#^#  #'
