#!/usr/bin/env bash

# Creates/verifies the Google service account used by GitHub Actions and binds
# the existing GitHub Workload Identity provider to it. Default mode is dry run.
# Pass --apply to make IAM changes.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-newleaf-trading}"
PROJECT_NUMBER="${GCP_PROJECT_NUMBER:-240392819045}"
POOL_ID="${GCP_WORKLOAD_IDENTITY_POOL_ID:-github}"
PROVIDER_ID="${GCP_WORKLOAD_IDENTITY_PROVIDER_ID:-github-newleaf}"
SERVICE_ACCOUNT_ID="${GCP_SERVICE_ACCOUNT_ID:-github-action-1228863292}"
REPOSITORY="${GITHUB_REPOSITORY:-newleafsystem/admin-web}"
APPLY=false

roles=(
  roles/firebasehosting.admin
  roles/cloudbuild.builds.editor
  roles/run.admin
  roles/artifactregistry.admin
  roles/secretmanager.admin
  roles/storage.admin
  roles/datastore.user
  roles/iam.serviceAccountUser
)

usage() {
  cat <<EOF
Usage:
  bash scripts/setup-github-oidc-deploy-access.sh [--apply]

Environment overrides:
  GCP_PROJECT_ID                         default: newleaf-trading
  GCP_PROJECT_NUMBER                     default: 240392819045
  GCP_WORKLOAD_IDENTITY_POOL_ID          default: github
  GCP_WORKLOAD_IDENTITY_PROVIDER_ID      default: github-newleaf
  GCP_SERVICE_ACCOUNT_ID                 default: github-action-1228863292
  GITHUB_REPOSITORY                      default: newleafsystem/admin-web

This script is dry-run by default. Pass --apply to create IAM resources/bindings.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud is required." >&2
  exit 1
fi

SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
PROVIDER_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
REPOSITORY_PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${REPOSITORY}"

run_or_print() {
  if [[ "${APPLY}" == "true" ]]; then
    "$@"
  else
    printf 'DRY RUN:'
    printf ' %q' "$@"
    printf '\n'
  fi
}

echo "Project: ${PROJECT_ID}"
echo "Provider: ${PROVIDER_NAME}"
echo "Deploy service account: ${SERVICE_ACCOUNT_EMAIL}"
echo "Repository principal: ${REPOSITORY_PRINCIPAL}"
if [[ "${APPLY}" != "true" ]]; then
  echo "Mode: dry run. Re-run with --apply to create/update IAM."
fi

gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --project "${PROJECT_ID}" \
  --location global \
  --workload-identity-pool "${POOL_ID}" \
  --format='value(name)' >/dev/null

if ! gcloud iam service-accounts describe "${SERVICE_ACCOUNT_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  run_or_print gcloud iam service-accounts create "${SERVICE_ACCOUNT_ID}" \
    --project "${PROJECT_ID}" \
    --display-name 'NewLeaf GitHub Deploy'
else
  echo "Service account already exists."
fi

for role in "${roles[@]}"; do
  run_or_print gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role "${role}" \
    --condition=None \
    --quiet
done

run_or_print gcloud iam service-accounts add-iam-policy-binding "${SERVICE_ACCOUNT_EMAIL}" \
  --project "${PROJECT_ID}" \
  --member "${REPOSITORY_PRINCIPAL}" \
  --role roles/iam.workloadIdentityUser \
  --quiet

echo "Use these GitHub repository secrets:"
echo "GCP_WORKLOAD_IDENTITY_PROVIDER=${PROVIDER_NAME}"
echo "GCP_SERVICE_ACCOUNT=${SERVICE_ACCOUNT_EMAIL}"
