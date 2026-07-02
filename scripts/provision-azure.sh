#!/usr/bin/env bash
#
# Provisions the Azure resources for the Rust Wind Hills MCP engine:
#   - resource group
#   - storage account (blob) for run persistence
#   - Windows consumption Function App on Node 24
# then wires the app settings the engine reads.
#
# Auth stays "simple": the app uses the platform default key-based auth —
# no AAD/Easy Auth. The MCP endpoint itself (POST /api/mcp) is registered
# with authLevel "anonymous" — no function key needed to call it.
#
# Usage:
#   az login
#   ./scripts/provision-azure.sh            # random suffix, uksouth
#   LOCATION=westeurope SUFFIX=dev1 ./scripts/provision-azure.sh
set -euo pipefail

LOCATION="${LOCATION:-uksouth}"
SUFFIX="${SUFFIX:-$RANDOM}"                    # storage names must be globally unique
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-rust-wind-hills}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-strwhills${SUFFIX}}"   # 3-24 chars, lowercase alphanumeric
FUNCTION_APP="${FUNCTION_APP:-func-rust-wind-hills-${SUFFIX}}"

echo "==> Resource group ${RESOURCE_GROUP} (${LOCATION})"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

echo "==> Storage account ${STORAGE_ACCOUNT}"
az storage account create \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false \
  --output none

CONNECTION_STRING=$(az storage account show-connection-string \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --query connectionString --output tsv)

# The engine creates this container on first use; pre-creating it just makes
# the account inspectable immediately.
echo "==> Blob container adventure-runs"
az storage container create \
  --name adventure-runs \
  --connection-string "$CONNECTION_STRING" \
  --output none

echo "==> Function app ${FUNCTION_APP} (Windows consumption, Node 24, Functions v4)"
# --storage-account also sets AzureWebJobsStorage in the app settings.
# If your az version doesn't accept --runtime-version 24 yet, use 22 here;
# WEBSITE_NODE_DEFAULT_VERSION below is what actually pins Node on Windows.
az functionapp create \
  --name "$FUNCTION_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --storage-account "$STORAGE_ACCOUNT" \
  --consumption-plan-location "$LOCATION" \
  --os-type Windows \
  --runtime node \
  --runtime-version 24 \
  --functions-version 4 \
  --https-only true \
  --output none

echo "==> App settings"
# ADVENTURE_STORAGE_CONNECTION_STRING is the dedicated connection string the
# engine prefers; it falls back to AzureWebJobsStorage (already set) if absent.
# WEBSITE_RUN_FROM_PACKAGE=1 tells the host to mount whatever Kudu zipdeploy
# last stored as a read-only package rather than extracting it onto disk —
# required by .github/workflows/main_func-*.yml's deploy step.
az functionapp config appsettings set \
  --name "$FUNCTION_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --output none \
  --settings \
    "ADVENTURE_STORAGE_CONNECTION_STRING=$CONNECTION_STRING" \
    "WEBSITE_NODE_DEFAULT_VERSION=~24" \
    "WEBSITE_RUN_FROM_PACKAGE=1"

cat <<EOF

Provisioned:
  resource group:   $RESOURCE_GROUP
  storage account:  $STORAGE_ACCOUNT (container: adventure-runs)
  function app:     $FUNCTION_APP (WEBSITE_RUN_FROM_PACKAGE=1)

Next steps:
  1. Wire up CI deployment (one-time): the GitHub Actions workflow deploys
     via Kudu zipdeploy using the app's publish profile, no Azure login
     needed in the pipeline. Get it and add it as a GitHub Actions repo
     secret named to match what the workflow reads
     (AZUREAPPSERVICE_PUBLISHPROFILE_...):
       az functionapp deployment list-publishing-profiles \\
         --name $FUNCTION_APP --resource-group $RESOURCE_GROUP --xml
     Every push to main then builds, smoke-tests, zips and deploys as a
     read-only run-from-package mount — never extracted onto disk.
  2. Or deploy once by hand while testing:
       func azure functionapp publish $FUNCTION_APP
  3. Point an MCP client at the single consolidated endpoint (anonymous,
     JSON-RPC 2.0 over HTTP POST — no function key needed):
       https://$FUNCTION_APP.azurewebsites.net/api/mcp
  4. Anonymous health/readiness check (used by the deploy workflow too):
       https://$FUNCTION_APP.azurewebsites.net/api/health
EOF
