# Deployment

Production is optional. The normal personal-store installation remains local SQLite with no cloud services.

## Target Architecture

Hosted deployment uses:

- One Cloud Run service for the root ERP API
- One Cloud Run service for the embedded Shopify app
- One Cloud SQL PostgreSQL instance with separate ERP and Shopify session databases
- Secret Manager for database URLs, API tokens, Shopify credentials, and marketplace credentials

Both services share the same `ERP_API_TOKEN`. The ERP service must use `NODE_ENV=production`, `STORE_DRIVER=postgres`, and a stable HTTPS URL.

## Recommended Deployment

Authenticate with Google Cloud, then use the reviewed helper:

```powershell
gcloud auth login
.\scripts\deploy-personal-shopify-app.ps1 `
  -ProjectId <project-id> `
  -ShopifyClientId <client-id> `
  -ShopifyClientSecret <client-secret>
```

The helper prompts for sensitive values, stores runtime secrets in Secret Manager, deploys both services, and aligns Shopify configuration. Review the script and its proposed cloud changes before running it. Use `-ReleaseShopifyConfig` only when intentionally releasing Shopify app configuration.

Do not place production secrets directly in documentation, shell history, source files, container images, or `shopify.app.toml`.

## Required ERP Environment

```text
NODE_ENV=production
HOST=0.0.0.0
ERP_API_TOKEN=<secret reference>
STORE_DRIVER=postgres
DATABASE_URL=<Cloud SQL secret reference>
SHOPIFY_SHOP_DOMAIN=<permanent myshopify domain>
SHOPIFY_CLIENT_ID=<secret/reference>
SHOPIFY_CLIENT_SECRET=<secret reference>
SHOPIFY_API_VERSION=<supported version>
```

Add Etsy and eBay settings only when those integrations are enabled.

## Required Shopify App Environment

```text
NODE_ENV=production
SHOPIFY_API_KEY=<client id>
SHOPIFY_API_SECRET=<secret reference>
SHOPIFY_APP_URL=<stable HTTPS app URL>
SCOPES=read_inventory,write_inventory,read_products,read_locations
DATABASE_URL=<Shopify session database secret reference>
ERP_API_BASE_URL=<ERP HTTPS URL>/api
ERP_API_TOKEN=<same ERP token secret>
```

## Pre-Deployment Checklist

- `npm run check:all` passes.
- `npm run audit:all` passes or findings are reviewed and documented.
- A current operational backup exists and its manifest passes `restore-dry-run`.
- Database migration and rollback paths are reviewed.
- Marketplace mappings and live-write behavior have not changed unexpectedly.
- No local data or secrets appear in the Git diff.

## Post-Deployment Smoke Checks

1. An unauthenticated ERP `/api/health` request returns `401`.
2. An authenticated health request returns `{ "ok": true }`.
3. The embedded Shopify app loads without an ERP connection error.
4. A known SKU count matches the expected ERP value.
5. Run and review a reconcile or dry-run before any live sync.

## Recovery

Restore the ERP database from the approved backup/export, restore print assets and feedback history, start the ERP API, and reconcile every enabled marketplace before allowing live writes. Record the date and outcome of restore rehearsals without recording secrets or customer data.
