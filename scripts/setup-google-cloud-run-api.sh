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
#   GCS_BUCKET=<project-id>.firebasestorage.app
#   PUBLIC_BASE_URL=https://admin.newleafsystem.com
#   ADMIN_BASE_URL=https://admin.newleafsystem.com
#   SOCIAL_CALLBACK_BASE_URL=https://admin.newleafsystem.com
#   CORS_ALLOWED_ORIGINS=https://admin.newleafsystem.com
#   MEDIA_RENDERER_URL=<cloud-run-renderer-url>
#   MIN_INSTANCES=1
#   MAX_INSTANCES=3
#   MEMORY=1Gi
#   CPU=1
#   CPU_THROTTLING=false
#   TIMEOUT=900
#   SKIP_ENABLE_APIS=true
#   SKIP_PROVISIONING=true
#   CLOUD_BUILD_SUPPRESS_LOGS=true
#
# Optional secret env values, if present locally, are copied into Secret Manager
# and mounted into Cloud Run:
#   HEYGEN_API_KEY OPENAI_API_KEY AI_API_KEY YOUTUBE_CLIENT_SECRET
#   X_CLIENT_SECRET LINKEDIN_CLIENT_SECRET META_APP_SECRET
#   HEYGEN_WEBHOOK_SECRET MEDIA_RENDER_HMAC_SECRET SERVICE_API_KEY_HASHES TOKEN_ENCRYPTION_KEY

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=/dev/null
source "${ROOT_DIR}/scripts/load-env-file.sh"
load_env_file "${ENV_FILE:-${ROOT_DIR}/.env}"

GCP_PROJECT_ID="${GCP_PROJECT_ID:-${FIREBASE_PROJECT_ID:-}}"
GCP_REGION="${GCP_REGION:-${GOOGLE_CLOUD_RUN_REGION:-us-central1}}"
SERVICE_NAME="${SERVICE_NAME:-${GOOGLE_CLOUD_RUN_API_SERVICE:-newleaf-api}}"
SERVICE_ACCOUNT_NAME="${SERVICE_ACCOUNT_NAME:-newleaf-api}"
GCS_BUCKET="${GCS_BUCKET:-${GCP_PROJECT_ID:-}.firebasestorage.app}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://admin.newleafsystem.com}"
ADMIN_BASE_URL="${ADMIN_BASE_URL:-https://admin.newleafsystem.com}"
SOCIAL_CALLBACK_BASE_URL="${SOCIAL_CALLBACK_BASE_URL:-${PUBLIC_BASE_URL}}"
CORS_ALLOWED_ORIGINS="${CORS_ALLOWED_ORIGINS:-${ADMIN_BASE_URL}}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"
MAX_INSTANCES="${MAX_INSTANCES:-3}"
MEMORY="${MEMORY:-1Gi}"
CPU="${CPU:-1}"
CPU_THROTTLING="${CPU_THROTTLING:-false}"
TIMEOUT="${TIMEOUT:-900}"
SKIP_ENABLE_APIS="${SKIP_ENABLE_APIS:-true}"
SKIP_PROVISIONING="${SKIP_PROVISIONING:-true}"
CLOUD_BUILD_SUPPRESS_LOGS="${CLOUD_BUILD_SUPPRESS_LOGS:-true}"
BIND_EXISTING_SECRETS="${BIND_EXISTING_SECRETS:-true}"

if [[ "${REQUIRE_AUTH:-true}" != "true" && "${ALLOW_UNAUTHENTICATED_API_DEPLOY:-false}" != "true" ]]; then
  echo "ERROR: Refusing to deploy Cloud Run API with REQUIRE_AUTH=${REQUIRE_AUTH:-unset}." >&2
  echo "Set REQUIRE_AUTH=true, or set ALLOW_UNAUTHENTICATED_API_DEPLOY=true for an intentional non-production test service." >&2
  exit 1
fi

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

if [[ -z "${GCS_BUCKET}" || "${GCS_BUCKET}" == ".appspot.com" || "${GCS_BUCKET}" == ".firebasestorage.app" ]]; then
  echo "ERROR: GCS_BUCKET is required or GCP_PROJECT_ID must be set first." >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud is not installed or not in PATH." >&2
  exit 1
fi

echo "Using project: ${GCP_PROJECT_ID}"

if [[ "${SKIP_ENABLE_APIS}" == "true" ]]; then
  echo "Skipping Google Cloud API enablement because SKIP_ENABLE_APIS=true."
else
  echo "Enabling Google Cloud APIs..."
  gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    containerregistry.googleapis.com \
    artifactregistry.googleapis.com \
    secretmanager.googleapis.com \
    storage.googleapis.com \
    firestore.googleapis.com \
    --project "${GCP_PROJECT_ID}" >/dev/null
fi

SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

if [[ "${SKIP_PROVISIONING}" == "true" ]]; then
  echo "Skipping API prerequisite provisioning because SKIP_PROVISIONING=true."
else
  if ! gcloud iam service-accounts describe "${SERVICE_ACCOUNT_EMAIL}" \
    --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
    echo "Creating service account: ${SERVICE_ACCOUNT_EMAIL}"
    gcloud iam service-accounts create "${SERVICE_ACCOUNT_NAME}" \
      --display-name="NewLeaf API" \
      --project "${GCP_PROJECT_ID}" >/dev/null
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
    --role="roles/storage.objectAdmin" \
    --project "${GCP_PROJECT_ID}" >/dev/null
fi

ensure_secret() {
  local name="$1"
  local value="$2"
  if ! gcloud secrets describe "${name}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
    printf '%s' "${value}" | gcloud secrets create "${name}" \
      --replication-policy=automatic \
      --project "${GCP_PROJECT_ID}" \
      --data-file=- >/dev/null
  else
    printf '%s' "${value}" | gcloud secrets versions add "${name}" \
      --project "${GCP_PROJECT_ID}" \
      --data-file=- >/dev/null
  fi
}

secret_specs=()
add_secret_if_present() {
  local env_name="$1"
  local secret_name="$2"
  local value="${!env_name:-}"
  if [[ -n "${value}" ]]; then
    if [[ "${SKIP_PROVISIONING}" != "true" ]]; then
      ensure_secret "${secret_name}" "${value}"
    fi
    secret_specs+=("${env_name}=${secret_name}:latest")
  elif [[ "${BIND_EXISTING_SECRETS}" == "true" ]] && \
    gcloud secrets describe "${secret_name}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
    secret_specs+=("${env_name}=${secret_name}:latest")
  fi
}

add_secret_if_present HEYGEN_API_KEY NEWLEAF_HEYGEN_API_KEY
add_secret_if_present HEYGEN_WEBHOOK_SECRET NEWLEAF_HEYGEN_WEBHOOK_SECRET
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
build_args=(
  builds submit "${ROOT_DIR}"
  --config "${ROOT_DIR}/services/api/cloudbuild.yaml"
  --substitutions "_IMAGE_URI=${IMAGE_URI}"
  --project "${GCP_PROJECT_ID}"
)

if [[ "${CLOUD_BUILD_SUPPRESS_LOGS}" == "true" ]]; then
  echo "Submitting Cloud Build without log streaming."
  build_output="$(gcloud "${build_args[@]}" --async --format='value(id)' 2>&1)"
  echo "${build_output}"
  build_id="$(printf '%s\n' "${build_output}" | grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' | tail -n 1 || true)"
  if [[ -z "${build_id}" ]]; then
    echo "ERROR: Cloud Build was submitted, but the build id could not be resolved." >&2
    exit 1
  fi

  echo "Waiting for Cloud Build ${build_id} to complete..."
  while true; do
    build_status="$(gcloud builds describe "${build_id}" \
      --project "${GCP_PROJECT_ID}" \
      --format='value(status)')"

    case "${build_status}" in
      SUCCESS)
        echo "Cloud Build ${build_id} completed successfully."
        break
        ;;
      FAILURE|INTERNAL_ERROR|TIMEOUT|CANCELLED|EXPIRED)
        echo "ERROR: Cloud Build ${build_id} ended with status ${build_status}." >&2
        echo "Open Cloud Build logs: https://console.cloud.google.com/cloud-build/builds/${build_id}?project=${GCP_PROJECT_ID}" >&2
        exit 1
        ;;
      *)
        echo "Cloud Build ${build_id} status: ${build_status}"
        sleep 5
        ;;
    esac
  done
else
  gcloud "${build_args[@]}"
fi

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
  "GCS_BUCKET=${GCS_BUCKET}"
  "VIDEO_STORAGE_DIR=/tmp/newleaf-api/video-assembler"
)

add_env_if_present() {
  local name="$1"
  local value="${!name:-}"
  if [[ -n "${value}" ]]; then
    env_vars+=("${name}=${value}")
  fi
}

if [[ -n "${AUTH_ADMIN_EMAILS:-}" ]]; then
  env_vars+=("AUTH_ADMIN_EMAILS=${AUTH_ADMIN_EMAILS}")
fi

if [[ -n "${MEDIA_RENDERER_URL:-}" ]]; then
  env_vars+=("MEDIA_RENDERER_URL=${MEDIA_RENDERER_URL}")
fi

add_env_if_present HEYGEN_API_BASE_URL
add_env_if_present HEYGEN_CALLBACK_URL
add_env_if_present HEYGEN_SIGNATURE_HEADER
add_env_if_present HEYGEN_TIMESTAMP_HEADER
add_env_if_present YOUTUBE_CLIENT_ID
add_env_if_present YOUTUBE_REDIRECT_URI
add_env_if_present YOUTUBE_SCOPES
add_env_if_present YOUTUBE_DEFAULT_PRIVACY_STATUS
add_env_if_present YOUTUBE_DEFAULT_CATEGORY_ID
add_env_if_present YOUTUBE_UPLOAD_CHUNK_BYTES
add_env_if_present YOUTUBE_AUTO_RESUME_QUEUED_UPLOADS
add_env_if_present SOCIAL_PUBLICATION_SYNC_ENABLED
add_env_if_present SOCIAL_PUBLICATION_SYNC_INTERVAL_MS
add_env_if_present SOCIAL_PUBLICATION_SYNC_MAX_RESULTS
add_env_if_present X_CLIENT_ID
add_env_if_present X_REDIRECT_URI
add_env_if_present X_SCOPES
add_env_if_present X_UPLOAD_CHUNK_BYTES
add_env_if_present LINKEDIN_CLIENT_ID
add_env_if_present LINKEDIN_REDIRECT_URI
add_env_if_present LINKEDIN_SCOPES
add_env_if_present LINKEDIN_API_VERSION
add_env_if_present META_APP_ID
add_env_if_present META_REDIRECT_URI
add_env_if_present META_GRAPH_VERSION
add_env_if_present META_FACEBOOK_SCOPES
add_env_if_present META_INSTAGRAM_SCOPES

deploy_args=(
  run deploy "${SERVICE_NAME}"
  --image "${IMAGE_URI}"
  --region "${GCP_REGION}"
  --service-account "${SERVICE_ACCOUNT_EMAIL}"
  --memory "${MEMORY}"
  --cpu "${CPU}"
  --timeout "${TIMEOUT}"
  --min-instances "${MIN_INSTANCES}"
  --max-instances "${MAX_INSTANCES}"
  --allow-unauthenticated
  --set-env-vars "$(IFS=,; echo "${env_vars[*]}")"
  --project "${GCP_PROJECT_ID}"
)

if [[ "${CPU_THROTTLING}" == "false" ]]; then
  deploy_args+=(--no-cpu-throttling)
elif [[ "${CPU_THROTTLING}" == "true" ]]; then
  deploy_args+=(--cpu-throttling)
else
  echo "ERROR: CPU_THROTTLING must be true or false." >&2
  exit 1
fi

if (( ${#secret_specs[@]} > 0 )); then
  deploy_args+=(--set-secrets "$(IFS=,; echo "${secret_specs[*]}")")
fi

echo "Deploying Cloud Run API service: ${SERVICE_NAME}"
gcloud "${deploy_args[@]}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${GCP_REGION}" \
  --project "${GCP_PROJECT_ID}" \
  --format='value(status.url)')"

cat <<EOF

Google Cloud Run API deployed:
  ${SERVICE_URL}

Use Firebase Hosting rewrites or Cloud Run custom domains for:
  ${PUBLIC_BASE_URL}

EOF
