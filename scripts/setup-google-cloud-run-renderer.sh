#!/usr/bin/env bash

# Provision and deploy the NewLeaf FFmpeg renderer on Google Cloud Run using
# Google Cloud Storage / Firebase Storage for media IO.
#
# Required environment variables:
#   GCP_PROJECT_ID
#   MEDIA_RENDER_HMAC_SECRET
#
# Optional:
#   GCP_REGION=us-central1
#   SERVICE_NAME=newleaf-ffmpeg-renderer
#   SERVICE_ACCOUNT_NAME=newleaf-renderer
#   GCS_BUCKET=<project-id>.firebasestorage.app
#   MAX_INSTANCES=2
#   MEMORY=2Gi
#   CPU=2
#   TIMEOUT=3600
#   SKIP_ENABLE_APIS=true
#   SKIP_PROVISIONING=true
#   CLOUD_BUILD_SUPPRESS_LOGS=true

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=/dev/null
source "${ROOT_DIR}/scripts/load-env-file.sh"
load_env_file "${ENV_FILE:-${ROOT_DIR}/.env}"

GCP_PROJECT_ID="${GCP_PROJECT_ID:-${FIREBASE_PROJECT_ID:-}}"
GCP_REGION="${GCP_REGION:-${GOOGLE_CLOUD_RUN_REGION:-us-central1}}"
SERVICE_NAME="${SERVICE_NAME:-${GOOGLE_CLOUD_RUN_RENDERER_SERVICE:-newleaf-ffmpeg-renderer}}"
SERVICE_ACCOUNT_NAME="${SERVICE_ACCOUNT_NAME:-newleaf-renderer}"
GCS_BUCKET="${GCS_BUCKET:-${GCP_PROJECT_ID:-}.firebasestorage.app}"
MAX_INSTANCES="${MAX_INSTANCES:-2}"
MEMORY="${MEMORY:-2Gi}"
CPU="${CPU:-2}"
TIMEOUT="${TIMEOUT:-3600}"
SKIP_ENABLE_APIS="${SKIP_ENABLE_APIS:-true}"
SKIP_PROVISIONING="${SKIP_PROVISIONING:-true}"
CLOUD_BUILD_SUPPRESS_LOGS="${CLOUD_BUILD_SUPPRESS_LOGS:-true}"

required=(GCP_PROJECT_ID MEDIA_RENDER_HMAC_SECRET)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "ERROR: ${name} is required." >&2
    exit 1
  fi
done

if [[ -z "${GCS_BUCKET}" || "${GCS_BUCKET}" == ".appspot.com" || "${GCS_BUCKET}" == ".firebasestorage.app" ]]; then
  echo "ERROR: GCS_BUCKET is required or GCP_PROJECT_ID must be set first." >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud is not installed or not in PATH." >&2
  exit 1
fi

echo "Using project: ${GCP_PROJECT_ID}"
gcloud config set project "${GCP_PROJECT_ID}" >/dev/null

if [[ "${SKIP_ENABLE_APIS}" == "true" ]]; then
  echo "Skipping Google Cloud API enablement because SKIP_ENABLE_APIS=true."
else
  echo "Enabling Google Cloud APIs..."
  gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    secretmanager.googleapis.com \
    storage.googleapis.com >/dev/null
fi

SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

if [[ "${SKIP_PROVISIONING}" == "true" ]]; then
  echo "Skipping renderer prerequisite provisioning because SKIP_PROVISIONING=true."
else
  if ! gcloud iam service-accounts describe "${SERVICE_ACCOUNT_EMAIL}" >/dev/null 2>&1; then
    echo "Creating service account: ${SERVICE_ACCOUNT_EMAIL}"
    gcloud iam service-accounts create "${SERVICE_ACCOUNT_NAME}" \
      --display-name="NewLeaf FFmpeg Renderer" >/dev/null
  else
    echo "Service account already exists: ${SERVICE_ACCOUNT_EMAIL}"
  fi
fi

ensure_secret() {
  local name="$1"
  local value="$2"
  if ! gcloud secrets describe "${name}" >/dev/null 2>&1; then
    printf '%s' "${value}" | gcloud secrets create "${name}" \
      --replication-policy=automatic \
      --data-file=- >/dev/null
  else
    printf '%s' "${value}" | gcloud secrets versions add "${name}" \
      --data-file=- >/dev/null
  fi
}

if [[ "${SKIP_PROVISIONING}" != "true" ]]; then
  echo "Writing renderer HMAC secret to Secret Manager..."
  ensure_secret NEWLEAF_RENDER_HMAC_SECRET "${MEDIA_RENDER_HMAC_SECRET}"

  gcloud secrets add-iam-policy-binding NEWLEAF_RENDER_HMAC_SECRET \
    --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null

  echo "Granting renderer access to gs://${GCS_BUCKET}..."
  gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET}" \
    --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role="roles/storage.objectAdmin" >/dev/null
else
  echo "Using existing Secret Manager secret and IAM grants for renderer deploy."
fi

IMAGE_URI="gcr.io/${GCP_PROJECT_ID}/${SERVICE_NAME}:latest"

echo "Building renderer container: ${IMAGE_URI}"
build_args=(
  builds submit "${ROOT_DIR}"
  --config "${ROOT_DIR}/services/media-renderer/cloudbuild.yaml"
  --substitutions "_IMAGE_URI=${IMAGE_URI}"
)

if [[ "${CLOUD_BUILD_SUPPRESS_LOGS}" == "true" ]]; then
  build_args+=(--suppress-logs)
fi

gcloud "${build_args[@]}"

echo "Deploying Cloud Run service: ${SERVICE_NAME}"
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE_URI}" \
  --region "${GCP_REGION}" \
  --service-account "${SERVICE_ACCOUNT_EMAIL}" \
  --memory "${MEMORY}" \
  --cpu "${CPU}" \
  --timeout "${TIMEOUT}" \
  --min-instances 0 \
  --max-instances "${MAX_INSTANCES}" \
  --allow-unauthenticated \
  --set-env-vars "GCS_BUCKET=${GCS_BUCKET}" \
  --set-secrets "MEDIA_RENDER_HMAC_SECRET=NEWLEAF_RENDER_HMAC_SECRET:latest"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${GCP_REGION}" \
  --format='value(status.url)')"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "service_url=${SERVICE_URL}" >> "${GITHUB_OUTPUT}"
fi

cat <<EOF

Google Cloud Run renderer deployed:
  ${SERVICE_URL}

Use this value for the API service environment:
  MEDIA_RENDERER_URL=${SERVICE_URL}

EOF
