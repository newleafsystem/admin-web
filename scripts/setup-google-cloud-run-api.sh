#!/usr/bin/env bash

# Build and deploy the NewLeaf API service to Google Cloud Run.
#
# Required:
#   GCP_PROJECT_ID
#
# Optional:
#   GCP_REGION=us-central1
#   SERVICE_NAME=newleaf-api
#   SERVICE_ACCOUNT_NAME=newleaf-api
#   GCS_BUCKET=<project-id>.appspot.com
#   PUBLIC_BASE_URL=https://admin.newleafsystem.com
#   ADMIN_BASE_URL=https://admin.newleafsystem.com
#   SOCIAL_CALLBACK_BASE_URL=https://admin.newleafsystem.com
#   CORS_ALLOWED_ORIGINS=https://admin.newleafsystem.com
#   MEDIA_RENDERER_URL=<cloud-run-renderer-url>
#   MAX_INSTANCES=3
#   MEMORY=1Gi
#   CPU=1
#   TIMEOUT=900
#
# Optional secret env values, if present locally, are copied into Secret Manager
# and mounted into Cloud Run:
#   HEYGEN_API_KEY OPENAI_API_KEY AI_API_KEY YOUTUBE_CLIENT_SECRET
#   X_CLIENT_SECRET LINKEDIN_CLIENT_SECRET META_APP_SECRET
#   MEDIA_RENDER_HMAC_SECRET SERVICE_API_KEY_HASHES TOKEN_ENCRYPTION_KEY

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=/dev/null
source "${ROOT_DIR}/scripts/load-env-file.sh"
load_env_file "${ENV_FILE:-${ROOT_DIR}/.env}"

GCP_PROJECT_ID="${GCP_PROJECT_ID:-${FIREBASE_PROJECT_ID:-}}"
GCP_REGION="${GCP_REGION:-${GOOGLE_CLOUD_RUN_REGION:-us-central1}}"
SERVICE_NAME="${SERVICE_NAME:-${GOOGLE_CLOUD_RUN_API_SERVICE:-newleaf-api}}"
SERVICE_ACCOUNT_NAME="${SERVICE_ACCOUNT_NAME:-newleaf-api}"
GCS_BUCKET="${GCS_BUCKET:-${GCP_PROJECT_ID:-}.appspot.com}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://admin.newleafsystem.com}"
ADMIN_BASE_URL="${ADMIN_BASE_URL:-https://admin.newleafsystem.com}"
SOCIAL_CALLBACK_BASE_URL="${SOCIAL_CALLBACK_BASE_URL:-${PUBLIC_BASE_URL}}"
CORS_ALLOWED_ORIGINS="${CORS_ALLOWED_ORIGINS:-${ADMIN_BASE_URL}}"
MAX_INSTANCES="${MAX_INSTANCES:-3}"
MEMORY="${MEMORY:-1Gi}"
CPU="${CPU:-1}"
TIMEOUT="${TIMEOUT:-900}"

if [[ "${ALLOW_LOCAL_DEPLOY_VALUES:-false}" != "true" ]]; then
  for pair in \
    "PUBLIC_BASE_URL=${PUBLIC_BASE_URL}" \
    "ADMIN_BASE_URL=${ADMIN_BASE_URL}" \
    "SOCIAL_CALLBACK_BASE_URL=${SOCIAL_CALLBACK_BASE_URL}" \
    "CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}"; do
    if [[ "${pair}" =~ localhost|127\.0\.0\.1 ]]; then
      echo "ERROR: Refusing to deploy Cloud Run API with local URL value: ${pair}" >&2
      echo "Use ENV_FILE=.env.production or set ALLOW_LOCAL_DEPLOY_VALUES=true for an intentional test service." >&2
      exit 1
    fi
  done
fi

if [[ -z "${GCP_PROJECT_ID:-}" ]]; then
  echo "ERROR: GCP_PROJECT_ID is required." >&2
  exit 1
fi

if [[ -z "${GCS_BUCKET}" || "${GCS_BUCKET}" == ".appspot.com" ]]; then
  echo "ERROR: GCS_BUCKET is required or GCP_PROJECT_ID must be set first." >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud is not installed or not in PATH." >&2
  exit 1
fi

echo "Using project: ${GCP_PROJECT_ID}"
gcloud config set project "${GCP_PROJECT_ID}" >/dev/null

echo "Enabling Google Cloud APIs..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  containerregistry.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  firestore.googleapis.com >/dev/null

SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "${SERVICE_ACCOUNT_EMAIL}" >/dev/null 2>&1; then
  echo "Creating service account: ${SERVICE_ACCOUNT_EMAIL}"
  gcloud iam service-accounts create "${SERVICE_ACCOUNT_NAME}" \
    --display-name="NewLeaf API" >/dev/null
else
  echo "Service account already exists: ${SERVICE_ACCOUNT_EMAIL}"
fi

for role in roles/datastore.user roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role="${role}" >/dev/null
done

echo "Granting API access to gs://${GCS_BUCKET}..."
gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET}" \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role="roles/storage.objectAdmin" >/dev/null

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

secret_specs=()
add_secret_if_present() {
  local env_name="$1"
  local secret_name="$2"
  local value="${!env_name:-}"
  if [[ -n "${value}" ]]; then
    ensure_secret "${secret_name}" "${value}"
    secret_specs+=("${env_name}=${secret_name}:latest")
  fi
}

add_secret_if_present HEYGEN_API_KEY NEWLEAF_HEYGEN_API_KEY
add_secret_if_present OPENAI_API_KEY NEWLEAF_OPENAI_API_KEY
add_secret_if_present AI_API_KEY NEWLEAF_AI_API_KEY
add_secret_if_present YOUTUBE_CLIENT_SECRET NEWLEAF_YOUTUBE_CLIENT_SECRET
add_secret_if_present X_CLIENT_SECRET NEWLEAF_X_CLIENT_SECRET
add_secret_if_present LINKEDIN_CLIENT_SECRET NEWLEAF_LINKEDIN_CLIENT_SECRET
add_secret_if_present META_APP_SECRET NEWLEAF_META_APP_SECRET
add_secret_if_present MEDIA_RENDER_HMAC_SECRET NEWLEAF_RENDER_HMAC_SECRET
add_secret_if_present SERVICE_API_KEY_HASHES NEWLEAF_SERVICE_API_KEY_HASHES
add_secret_if_present TOKEN_ENCRYPTION_KEY NEWLEAF_TOKEN_ENCRYPTION_KEY

IMAGE_URI="gcr.io/${GCP_PROJECT_ID}/${SERVICE_NAME}:latest"

echo "Building API container: ${IMAGE_URI}"
gcloud builds submit "${ROOT_DIR}" \
  --config "${ROOT_DIR}/services/api/cloudbuild.yaml" \
  --substitutions "_IMAGE_URI=${IMAGE_URI}"

env_vars=(
  "NODE_ENV=production"
  "NEWLEAF_SKIP_DOTENV=1"
  "REQUIRE_AUTH=${REQUIRE_AUTH:-true}"
  "FIREBASE_PROJECT_ID=${GCP_PROJECT_ID}"
  "FIRESTORE_DATABASE_ID=${FIRESTORE_DATABASE_ID:-newleafdb}"
  "FIREBASE_USE_APPLICATION_DEFAULT=true"
  "FIREBASE_ADMIN_DISABLED=false"
  "REPOSITORY_PROVIDER=firestore"
  "PUBLIC_BASE_URL=${PUBLIC_BASE_URL}"
  "ADMIN_BASE_URL=${ADMIN_BASE_URL}"
  "SOCIAL_CALLBACK_BASE_URL=${SOCIAL_CALLBACK_BASE_URL}"
  "CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}"
  "LOCAL_DATA_DIR=/tmp/newleaf-api"
  "ASSET_STORAGE_PROVIDER=gcs"
  "ASSET_STORAGE_BUCKET=${GCS_BUCKET}"
  "FIREBASE_STORAGE_BUCKET=${GCS_BUCKET}"
  "VIDEO_STORAGE_DIR=/tmp/newleaf-video-assembler"
)

if [[ -n "${MEDIA_RENDERER_URL:-}" ]]; then
  env_vars+=("MEDIA_RENDERER_URL=${MEDIA_RENDERER_URL}")
fi

deploy_args=(
  run deploy "${SERVICE_NAME}"
  --image "${IMAGE_URI}"
  --region "${GCP_REGION}"
  --service-account "${SERVICE_ACCOUNT_EMAIL}"
  --memory "${MEMORY}"
  --cpu "${CPU}"
  --timeout "${TIMEOUT}"
  --min-instances 0
  --max-instances "${MAX_INSTANCES}"
  --allow-unauthenticated
  --set-env-vars "$(IFS=,; echo "${env_vars[*]}")"
)

if (( ${#secret_specs[@]} > 0 )); then
  deploy_args+=(--set-secrets "$(IFS=,; echo "${secret_specs[*]}")")
fi

echo "Deploying Cloud Run API service: ${SERVICE_NAME}"
gcloud "${deploy_args[@]}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${GCP_REGION}" \
  --format='value(status.url)')"

cat <<EOF

Google Cloud Run API deployed:
  ${SERVICE_URL}

Use Firebase Hosting rewrites or Cloud Run custom domains for:
  ${PUBLIC_BASE_URL}

EOF
