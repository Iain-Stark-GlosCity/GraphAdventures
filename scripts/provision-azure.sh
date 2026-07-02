#!/usr/bin/env bash
#
# Provisions the Azure resources for the Rust Wind Hills MCP engine:
#   - resource group
#   - storage account (blob) for run persistence
#   - Windows consumption Function App on Node 24
# then wires the app settings the engine reads.
#
# Auth stays "simple": the app uses the platform default key-based auth —
# no AAD/Easy Auth. The MCP endpoint is guarded by the mcp_extension
# system key (printed at the end, once the app has been deployed).
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
az functionapp config appsettings set \
  --name "$FUNCTION_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --output none \
  --settings \
    "ADVENTURE_STORAGE_CONNECTION_STRING=$CONNECTION_STRING" \
    "WEBSITE_NODE_DEFAULT_VERSION=~24"

cat <<EOF

Provisioned:
  resource group:   $RESOURCE_GROUP
  storage account:  $STORAGE_ACCOUNT (container: adventure-runs)
  function app:     $FUNCTION_APP

Next steps:
  1. Deploy the app:
       func azure functionapp publish $FUNCTION_APP
  2. Fetch the MCP system key (exists only after a deployment that includes
     the MCP trigger):
       az functionapp keys list --name $FUNCTION_APP --resource-group $RESOURCE_GROUP \\
         --query systemKeys.mcp_extension --output tsv
  3. Point an MCP client at:
       https://$FUNCTION_APP.azurewebsites.net/runtime/webhooks/mcp
     with header  x-functions-key: <mcp_extension key>
     (or /runtime/webhooks/mcp/sse for the SSE transport).
EOF
