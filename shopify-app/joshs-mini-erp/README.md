# Josh's Mini ERP — Shopify App

Embedded Shopify Admin surface for Josh's Mini ERP. It provides inventory and review controls inside Shopify while the root ERP remains the inventory source of truth.

This app owns Shopify OAuth sessions. It does not own inventory data; authenticated server routes call the ERP through `ERP_API_BASE_URL` using the shared `ERP_API_TOKEN`.

## Prerequisites

- Node `>=22.18`
- A Shopify app and development store
- The root ERP API running locally for integrated development

## Setup

From this directory:

```powershell
npm ci
Copy-Item .env.example .env
npm run setup
```

The embedded app uses its own Prisma-managed session database configured by `DATABASE_URL`. This database is separate from the root ERP's operational SQLite database.

## Development

From the repository root, start both the ERP API and Shopify development process:

```powershell
npm run shopify:dev:full
```

The embedded app calls `http://127.0.0.1:5174/api` by default. Override `ERP_API_BASE_URL` only when the API intentionally runs elsewhere.

After the embedded app has loaded and created an offline session:

```powershell
npm run shopify:export-session
```

Copy the exported shop domain and access token into the ignored root `.env`. Never commit or paste exported sessions into documentation or issues.

## Required Scopes

```text
read_inventory,write_inventory,read_products,read_locations,read_orders
```

## Checks

```powershell
npm run typecheck
npm run lint
npm run build
```

The repository root `npm run check` includes this app's typecheck. Root `npm run check:all` includes linting as well.

## Production

Required runtime settings include:

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL`
- `SCOPES`
- `DATABASE_URL`
- `ERP_API_BASE_URL`
- `ERP_API_TOKEN`
- `NODE_ENV=production`

Use the hosting platform's secret manager for secret values. The Shopify session database must be durable and separate from the ERP inventory database. See the root `docs/DEPLOYMENT.md` for the supported deployment boundaries.

## Safety Boundaries

- Do not duplicate ERP inventory ownership in this app.
- Keep UI components native to Shopify Admin rather than applying the local ERP theme.
- Do not expose `ERP_API_TOKEN` to browser code; ERP calls belong in authenticated server code.
- Reconcile and review marketplace quantities before live synchronization.
