#!/usr/bin/env bash
#
# One-time setup for the read-only blob deployment workflow
# (.github/workflows/main_func-rust-wind-hills-26487.yml):
#
#   - creates (or reuses) an Azure AD app registration federated to this
#     GitHub repo via OIDC — no client secret is generated or stored
#   - grants that identity the least-privilege roles it needs: read/write
#     the release blobs, mint SAS URLs for them, and update the Function
#     App's settings and triggers
#   - creates the deployment container if it doesn't already exist
#   - prints the five values to paste into the repo's GitHub secrets
#
# Run this once per repo, as a user with Owner/User Access Administrator
# on the resource group (role assignment requires that).
#
# Usage:
#   az login
#   GITHUB_REPO="Iain-Stark-GlosCity/GraphAdventures" \
#   RESOURCE_GROUP="rg-rust-wind-hills" \
#   STORAGE_ACCOUNT="strwhillsxxxx" \
#   FUNCTION_APP="func-rust-wind-hills-26487" \
#     ./scripts/setup-github-oidc.sh
set -euo pipefail

: "${GITHUB_REPO:?set GITHUB_REPO=owner/repo}"
: "${RESOURCE_GROUP:?set RESOURCE_GROUP to the resource group holding the storage account and function app}"
: "${STORAGE_ACCOUNT:?set STORAGE_ACCOUNT to the deployment storage account name}"
: "${FUNCTION_APP:?set FUNCTION_APP to the target Function App name}"
APP_NAME="${APP_NAME:-github-actions-${FUNCTION_APP}}"
BRANCH="${BRANCH:-main}"
DEPLOY_CONTAINER="${DEPLOY_CONTAINER:-function-releases}"

SUBSCRIPTION_ID=$(az account show --query id --output tsv)
TENANT_ID=$(az account show --query tenantId --output tsv)

echo "==> App registration ${APP_NAME}"
APP_ID=$(az ad app list --display-name "$APP_NAME" --query '[0].appId' --output tsv)
if [[ -z "$APP_ID" ]]; then
  APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId --output tsv)
fi

echo "==> Service principal for ${APP_ID}"
az ad sp show --id "$APP_ID" --output none 2>/dev/null || az ad sp create --id "$APP_ID" --output none

echo "==> Federated credential (repo: ${GITHUB_REPO}, branch: ${BRANCH})"
CRED_NAME="github-${BRANCH}"
if ! az ad app federated-credential list --id "$APP_ID" --query "[?name=='$CRED_NAME']" --output tsv | grep -q .; then
  az ad app federated-credential create --id "$APP_ID" --parameters "$(cat <<EOF
{
  "name": "$CRED_NAME",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:${GITHUB_REPO}:ref:refs/heads/${BRANCH}",
  "audiences": ["api://AzureADTokenExchange"]
}
EOF
)" --output none
fi

STORAGE_ID=$(az storage account show --name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" --query id --output tsv)
FUNCTIONAPP_ID=$(az functionapp show --name "$FUNCTION_APP" --resource-group "$RESOURCE_GROUP" --query id --output tsv)

echo "==> Deployment container ${DEPLOY_CONTAINER}"
az storage container create \
  --name "$DEPLOY_CONTAINER" \
  --account-name "$STORAGE_ACCOUNT" \
  --auth-mode login \
  --output none

echo "==> Role assignments (least privilege, scoped to specific resources)"
# Read/write the release blobs.
az role assignment create --assignee "$APP_ID" --role "Storage Blob Data Contributor" --scope "$STORAGE_ID" --output none
# Mint the user-delegated SAS the workflow hands to WEBSITE_RUN_FROM_PACKAGE.
az role assignment create --assignee "$APP_ID" --role "Storage Blob Delegator" --scope "$STORAGE_ID" --output none
# Update app settings and call sync-triggers.
az role assignment create --assignee "$APP_ID" --role "Website Contributor" --scope "$FUNCTIONAPP_ID" --output none

cat <<EOF

Add these as GitHub Actions repo secrets (Settings > Secrets and variables > Actions):

  AZURE_CLIENT_ID        $APP_ID
  AZURE_TENANT_ID        $TENANT_ID
  AZURE_SUBSCRIPTION_ID  $SUBSCRIPTION_ID
  AZURE_RESOURCE_GROUP   $RESOURCE_GROUP
  AZURE_STORAGE_ACCOUNT  $STORAGE_ACCOUNT

None of these are secret credentials by themselves (no client secret was
created) — GitHub exchanges its own OIDC token for an Azure access token at
run time, scoped to the ${BRANCH} branch of ${GITHUB_REPO} only.
EOF
