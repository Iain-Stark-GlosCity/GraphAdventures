#!/usr/bin/env bash
#
# Points the Function App back at a previously deployed release blob.
# Every push leaves its zip in the deployment container named by commit
# SHA (release-<sha>.zip), so rollback is just re-pointing
# WEBSITE_RUN_FROM_PACKAGE at an older one and re-syncing triggers —
# nothing is rebuilt or redeployed.
#
# Usage:
#   az login
#   RESOURCE_GROUP=rg-rust-wind-hills STORAGE_ACCOUNT=strwhillsxxxx \
#   FUNCTION_APP=func-rust-wind-hills-26487 \
#     ./scripts/rollback-release.sh <git-sha>
set -euo pipefail

SHA="${1:?usage: rollback-release.sh <git-sha>}"
: "${RESOURCE_GROUP:?set RESOURCE_GROUP}"
: "${STORAGE_ACCOUNT:?set STORAGE_ACCOUNT}"
: "${FUNCTION_APP:?set FUNCTION_APP}"
DEPLOY_CONTAINER="${DEPLOY_CONTAINER:-function-releases}"
BLOB_NAME="release-${SHA}.zip"

az storage blob show \
  --account-name "$STORAGE_ACCOUNT" --container-name "$DEPLOY_CONTAINER" \
  --name "$BLOB_NAME" --auth-mode login --output none \
  || { echo "No such release blob: $BLOB_NAME" >&2; exit 1; }

expiry=$(date -u -d '+10 years' '+%Y-%m-%dT%H:%MZ')
sas=$(az storage blob generate-sas \
  --account-name "$STORAGE_ACCOUNT" --container-name "$DEPLOY_CONTAINER" \
  --name "$BLOB_NAME" --permissions r --https-only --expiry "$expiry" \
  --auth-mode login --as-user --output tsv)
url="https://${STORAGE_ACCOUNT}.blob.core.windows.net/${DEPLOY_CONTAINER}/${BLOB_NAME}?${sas}"

az functionapp config appsettings set \
  --name "$FUNCTION_APP" --resource-group "$RESOURCE_GROUP" \
  --settings WEBSITE_RUN_FROM_PACKAGE="$url" --output none

az functionapp sync-triggers --name "$FUNCTION_APP" --resource-group "$RESOURCE_GROUP"

echo "Rolled back to release-${SHA}.zip"
