# Troubleshooting

## The local app does not start

Confirm the supported Node version and installed dependencies:

```powershell
node --version
npm ci
npm run dev
```

Ports `5174` and `5175` must be available. Keep `NODE_ENV` unset for ordinary local use. If it is `production`, `ERP_API_TOKEN` is required.

## The UI opens but API requests fail

Confirm the API is listening at `http://127.0.0.1:5174` and Vite is running at `http://127.0.0.1:5175`. In development, Vite proxies `/api` to the API. Check the server output for validation or storage errors without copying environment values into logs or support requests.

## SQLite cannot be opened

- Confirm `STORE_DRIVER=sqlite` and `DATABASE_FILE=data/inventory.sqlite`.
- Confirm the current user can read and write `data/`.
- Stop duplicate application processes that may be using the same file.
- Run `npm run inv -- doctor`.
- Do not delete or replace the database until a backup manifest has been inspected.

## A marketplace is not configured

Run:

```powershell
npm run inv -- doctor
```

Compare the reported missing variable names with `.env.example`. Do not print or paste the populated `.env`. OAuth token files normally live under ignored `data/` paths.

## Quantities differ between local and a marketplace

Do not immediately run a live sync. Use:

```powershell
npm run inv -- reconcile shopify
npm run inv -- sync --dry-run --platform shopify
```

Review whether the mapping is new and still needs a baseline, whether sales occurred since the previous successful sync, and whether a prior pull or push failed.

## Shopify product details cannot refresh

The Shopify app needs `read_products` in addition to inventory and location scopes. Approve the updated scopes, load the embedded app once so an offline session exists, export the session, and update the ignored root `.env`.

## eBay legacy listing behavior is blocked

This is usually intentional. Legacy quantity writes are disabled by default. Use the read-only scan, local mapping preview, and reconcile workflow in `docs/MARKETPLACES.md`. Do not bypass the guard or recreate a listing to make synchronization work.

## Optional Postgres tests skip

This is expected without `TEST_POSTGRES_DATABASE_URL`. Do not install Docker or a database service just to remove the skip. Run the tests only against an intentionally provided disposable test database.

## UI smoke checks fail

Start the local app first with `npm run dev`, ensure Playwright Chromium is installed, and rerun `npm run check:ui`. Screenshots are placed under ignored `data/ui-smoke/` for review.
