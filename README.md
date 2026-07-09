# Josh's Mini ERP

Local inventory source of truth with scheduled/manual sync hooks for Etsy, eBay, and Shopify.

## Run It

Node `>=20.19 <22` or `>=22.12` is required for the Shopify app scaffold. The inventory app itself was initially built on Node `20.18.0`, but Shopify's template install will fail on that version.

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open `http://127.0.0.1:5175`. The API runs on `http://127.0.0.1:5174`.

No Docker, local database server, or cloud service is required for normal personal-store use. The intended local database is SQLite at `data/inventory.sqlite`: real SQL in one local file, with no background service or bill. JSON remains available for backup/export and migration.

If you already have inventory in `data/inventory.json`, migrate it once:

```powershell
npm run inv -- migrate-sqlite --dry-run
npm run inv -- migrate-sqlite
```

The default driver is now SQLite. Keep or set this in `.env`:

```text
STORE_DRIVER=sqlite
DATABASE_FILE=data/inventory.sqlite
```

For embedded Shopify app development, set `DATABASE_URL` to an existing Postgres database, then run:

```powershell
npm run shopify:dev:full
```

For a built UI served by the API:

```powershell
npm run build
npm start
```

## Quality Checks

Run the standard local checks before committing app changes:

```powershell
npm run check
npm run audit:all
```

`check` runs the root TypeScript/Vite build, the Node test suite, and the embedded Shopify app typecheck. `audit:all` checks both npm dependency trees. The Postgres store test is optional and requires `TEST_POSTGRES_DATABASE_URL`.

Do not install or start Docker just to run optional Postgres tests. SQLite tests run in the normal test suite and require no service. Use `npm run test:postgres` only when an existing test database URL is already available or Josh explicitly asks to set one up.

## UI Style Guide

Use [UI_STYLE_GUIDE.md](UI_STYLE_GUIDE.md) before changing app screens, buttons, panels, settings, or user-facing workflow copy.

## Roadmap

Use [PLAN.md](PLAN.md) as the authoritative execution roadmap. The current direction is:

- Keep the working inventory, printing, sync, and review workflows stable.
- Keep the app cheap and local by default; SQLite is the real personal-use database.
- Rework the local UI into a calmer professional operations workbench.
- Keep JSON as backup/export format and use PostgreSQL only as an optional later deployment path.
- Keep the embedded Shopify app on Shopify Admin UI components while sharing product language and API contracts.
- Consolidate related operational data, including instruction inventory and feedback history, after the SQLite path is fully trusted.

## Notifications

The topbar bell shows active alerts and tracks unread alerts locally in the browser. Current alert sources include low item inventory, low instruction inventory, sync errors or warnings, and printer status problems when Windows reports a saved printer as missing, offline, stopped, or unknown. Low and over-max inventory alerts are not dismissible; they clear only when the inventory state or threshold is fixed. Operational alerts such as printer and sync problems can be dismissed locally until they change.

## Inventory Rules

- Add inventory only in this tool.
- Batch adds increase the local master count and are pushed to mapped stores on sync.
- Manual subtracts reduce the local master count for discards, personal use, damage, or corrections.
- Item and instruction inventory both use configurable max inventory values for their visual status bars. Counts can go over max and should show an over-max warning.
- Printing product labels records a batch add for newly manufactured, sellable stock using the printed label quantity and the activity note `Manufactured and ready for sale`.
- Store sales are detected on sync by comparing each platform's current quantity to the last quantity this tool successfully pushed.
- First sync for a newly mapped store captures a baseline only. It does not push that store until a later sync, so you can confirm the local count before anything writes to the marketplace.

That last-synced baseline lets simultaneous sales subtract correctly. If Etsy drops from 15 to 14 and eBay drops from 15 to 13 before the next sync, the tool subtracts 3 total units from the master inventory, then pushes the new count to every mapped store.

## CLI

```powershell
npm run inv -- list
npm run inv -- create NEON-MUG "Neon Mug" 30
npm run inv -- add NEON-MUG 15 "July restock"
npm run inv -- subtract NEON-MUG 1 "personal use"
npm run inv -- reconcile shopify
npm run inv -- sync --dry-run --platform shopify
npm run inv -- sync
npm run inv -- csv-import inventory-batch.csv --dry-run
npm run inv -- csv-import inventory-batch.csv
npm run inv -- backup
npm run inv -- export data/export.json
npm run inv -- sku-audit --location "Main" --output data/sku-audit.csv
npm run inv -- migrate-sqlite --dry-run
npm run inv -- migrate-sqlite
npm run inv -- migrate-postgres --dry-run
npm run inv -- migrate-postgres
npm run inv -- shopify-lookup NEON-MUG
npm run inv -- shopify-map NEON-MUG --location "Main"
npm run inv -- shopify-import --location "Main" --dry-run
npm run inv -- shopify-import --location "Main"
npm run inv -- shopify-refresh-details --dry-run
npm run inv -- shopify-refresh-details
npm run inv -- schedule on 30
npm run inv -- schedule off
```

Mapping examples:

```powershell
npm run inv -- map NEON-MUG etsy --listing-id 1234567890 --remote-sku NEON-MUG --enable
npm run inv -- map NEON-MUG ebay --remote-sku NEON-MUG --offer-id 9876543210 --enable
npm run inv -- map NEON-MUG shopify --inventory-item-id 123456789 --location-id 987654321 --enable
```

For Shopify, the helper command can find and save those IDs for a local SKU:

```powershell
npm run inv -- shopify-map NEON-MUG
npm run inv -- shopify-map LOCAL-SKU SHOPIFY-SKU --location "Main"
```

To import Shopify variants in bulk, use:

```powershell
npm run inv -- shopify-import --location "Main" --dry-run
npm run inv -- shopify-import --location "Main"
```

`shopify-import` scans Shopify variants with SKUs. Missing local SKUs are created with Shopify's available quantity. Existing local SKUs keep their local count and get a Shopify mapping, so run `reconcile` before syncing when local and Shopify differ. If a SKU exists on multiple Shopify variants, the importer skips it until the SKU is unique.

To refresh local names/descriptions from Shopify product details:

```powershell
npm run inv -- shopify-refresh-details --dry-run
npm run inv -- shopify-refresh-details
```

This requires Shopify app scopes `read_products` plus the existing inventory scopes. By default it updates names only when the local name is still the SKU; pass `--overwrite` to replace custom local names.

If the command says `read_products` is required, approve the updated Shopify app scopes and export a fresh token:

```powershell
npm run shopify:dev
npm run shopify:export-session
```

Copy the new `SHOPIFY_ADMIN_ACCESS_TOKEN` into the root `.env`, then rerun `shopify-refresh-details`.

Dry-run/reconcile commands pull live marketplace quantities and show what a sync would do without changing `data/inventory.json` or pushing inventory:

```powershell
npm run inv -- reconcile shopify
npm run inv -- sync --dry-run --platform shopify
```

CSV batch import supports these columns:

- `sku` is required.
- `name` is required only for new SKUs.
- `quantity` or `qty` sets an absolute on-hand count.
- `add`, `delta`, `adjustment`, or `received` applies a batch quantity change.
- `safety_stock` or `safety` updates safety stock.
- `max_inventory`, `max_stock`, or `capacity` updates the visual max inventory level.
- `note` is saved on inventory events.

Use either an absolute `quantity` or an adjustment column on a row, not both.

Data export and backup commands:

```powershell
npm run inv -- export
npm run inv -- export data/export.json
npm run inv -- backup
npm run inv -- backup D:\InventoryBackups
```

`export` prints JSON when no output path is supplied. `backup` writes a timestamped copy under `data/backups` unless you pass a directory.

SKU pairing audit:

```powershell
npm run inv -- sku-audit --location "Main"
npm run inv -- sku-audit --location "Main" --output data/sku-audit.csv
npm run inv -- sku-audit --platform shopify --location "Main"
npm run inv -- sku-audit --platform ebay
```

`sku-audit` compares local SKUs with Shopify variant SKUs and eBay Sell Inventory SKUs. It reports whether each SKU pairs cleanly, is missing locally, is missing on a marketplace, has duplicate remote records, or has quantity differences that should be reviewed with `reconcile`.

SQLite storage:

```powershell
npm run inv -- migrate-sqlite --dry-run
npm run inv -- migrate-sqlite
```

SQLite is the default local driver. Keep `STORE_DRIVER=sqlite` and `DATABASE_FILE=data/inventory.sqlite` to run the local ERP on SQLite. This is the preferred personal-store database path because it is real SQL without Docker, a database server, or cloud cost. `migrate-sqlite` copies the current JSON inventory into SQLite and writes a JSON backup first. It refuses to overwrite a non-empty SQLite database unless you pass `--force`.

Postgres storage, optional later:

```powershell
$env:DATABASE_URL="postgresql://erp_user:<password>@127.0.0.1:5432/erp"
npm run inv -- migrate-postgres --dry-run
npm run inv -- migrate-postgres
```

Set `STORE_DRIVER=postgres` and `DATABASE_URL` only when you intentionally want to use an existing Postgres database. `migrate-postgres` copies the current JSON inventory into Postgres and writes a JSON backup first. It refuses to overwrite a non-empty Postgres database unless you pass `--force`.

To run the Postgres store contract test against a disposable/local database:

```powershell
$env:TEST_POSTGRES_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/joshs_mini_erp_erp?schema=public"
npm run test:postgres
```

## Shopify CLI

This repo includes Shopify CLI as a local dev dependency. Use it through npm:

```powershell
npm run shopify -- app init --name joshs-mini-erp --path shopify-app --template reactRouter --flavor typescript --package-manager npm
npm run shopify:dev
npm run shopify:deploy
```

Shopify's current scaffold path is `shopify app init`. Shopify CLI can create app records, scaffold an app, run local development, and execute Admin GraphQL queries from an app context. If you already created the app record, pass its client ID with `--client-id <value>` to avoid the app selection prompt.

This inventory tool still runs as its own local ERP app. The Shopify app is now the embedded App Home surface for running sync and basic inventory controls from Shopify admin. During local Shopify development, keep the ERP API running too:

```powershell
npm run shopify:dev:full
```

The embedded app proxies to `http://127.0.0.1:5174/api` by default. Set `ERP_API_BASE_URL` in the Shopify app environment if the ERP API runs somewhere else, for example `https://inventory.example.com/api`.

## Production Deployment

Production target: **Google Cloud Run** for compute and **Cloud SQL for PostgreSQL** for persistence.

Production needs two Cloud Run services:

1. **ERP API service** from the repo root. This owns inventory data and runs the marketplace sync engine.
2. **Shopify app service** from `shopify-app/joshs-mini-erp`. This is the embedded Shopify Admin UI and calls the ERP API.

The local Cloudflare URL from `shopify app dev` is only for development. For production, deploy both services to stable HTTPS Cloud Run URLs, then optionally map Cloudflare subdomains later.

For this personal-store deploy, the helper script performs the Google Cloud setup/deploy steps after you authenticate with `gcloud`:

```powershell
gcloud auth login
.\scripts\deploy-personal-shopify-app.ps1 `
  -ProjectId <google-cloud-project-id> `
  -ShopifyClientId <shopify-client-id> `
  -ShopifyClientSecret <shopify-client-secret>
```

The script prompts for database passwords, generates `ERP_API_TOKEN` if you do not provide one, deploys both Cloud Run services, updates `shopify.app.toml` to the Cloud Run app URL, and can release Shopify config too when run with `-ReleaseShopifyConfig`. It also forwards known Etsy/eBay values from your local `.env` into the ERP API service when those values are present, and forwards the local Etsy OAuth refresh token after the helper saves one.

Enable the core Google APIs:

```powershell
gcloud services enable run.googleapis.com sqladmin.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

Create one Cloud SQL for PostgreSQL instance, then create two databases in it:

```powershell
gcloud sql instances create joshs-mini-erp --database-version=POSTGRES_16 --region=us-central1 --tier=db-f1-micro
gcloud sql databases create erp --instance=joshs-mini-erp
gcloud sql databases create shopify_sessions --instance=joshs-mini-erp
```

Create database users/passwords in the Cloud SQL console or with `gcloud sql users create`. Save the instance connection name; it looks like:

```text
PROJECT_ID:us-central1:joshs-mini-erp
```

When you deploy each Cloud Run service, add that Cloud SQL connection to the service. Google mounts the Cloud SQL socket under `/cloudsql/<instance-connection-name>`.

ERP API production environment:

```text
HOST=0.0.0.0
ERP_API_TOKEN=<long random shared secret>
STORE_DRIVER=postgres
DATABASE_URL=postgresql://erp_user:<password>@localhost/erp?host=/cloudsql/PROJECT_ID:us-central1:joshs-mini-erp
SHOPIFY_SHOP_DOMAIN=aqrqyf-uw.myshopify.com
SHOPIFY_CLIENT_ID=<Shopify app client ID>
SHOPIFY_CLIENT_SECRET=<Shopify app client secret>
SHOPIFY_API_VERSION=2026-07
```

Add Etsy/eBay credentials to this service too if those sync targets are enabled. If the database password has special characters, URL-encode it in `DATABASE_URL`.

Shopify app production environment:

```text
SHOPIFY_API_KEY=<Shopify app client ID>
SHOPIFY_API_SECRET=<Shopify app client secret>
SHOPIFY_APP_URL=https://your-shopify-app.example.com
SCOPES=read_inventory,write_inventory,read_products,read_locations
DATABASE_URL=postgresql://shopify_user:<password>@localhost/shopify_sessions?host=/cloudsql/PROJECT_ID:us-central1:joshs-mini-erp
ERP_API_BASE_URL=https://your-erp-api-url.run.app/api
ERP_API_TOKEN=<same shared secret as ERP API service>
NODE_ENV=production
```

Deploy the ERP API from the repo root:

```powershell
gcloud run deploy joshs-erp-api --source . --region us-central1 --allow-unauthenticated --add-cloudsql-instances PROJECT_ID:us-central1:joshs-mini-erp
```

Deploy the embedded Shopify app from its app directory:

```powershell
cd shopify-app/joshs-mini-erp
gcloud run deploy joshs-shopify-app --source . --region us-central1 --allow-unauthenticated --add-cloudsql-instances PROJECT_ID:us-central1:joshs-mini-erp
```

Set the environment variables above in each Cloud Run service. Prefer Secret Manager for passwords, Shopify secrets, marketplace tokens, and `ERP_API_TOKEN`.

If you already have local JSON inventory data, migrate it once after the ERP database exists:

```powershell
$env:DATABASE_URL="postgresql://erp_user:<password>@127.0.0.1:5432/erp"
npm run inv -- migrate-postgres --dry-run
npm run inv -- migrate-postgres
```

For Cloud SQL, run the migration from a machine that can reach the database, or use the Cloud SQL Auth Proxy locally.

Before installing on the real store:

```powershell
cd shopify-app/joshs-mini-erp
npm run config:link
npm run env
```

Set `application_url` in the production Shopify app config to the hosted `SHOPIFY_APP_URL`, and set the auth redirect URL to the same host with the generated app's auth path. Then release the Shopify app config:

```powershell
npm run deploy
```

After the hosted Shopify app is deployed and the app config is released, install/open it from the real store's admin:

```text
https://admin.shopify.com/store/aqrqyf-uw/apps
```

If you do not see **Distribution** or **App distribution**, use the merchant/owned-store flow instead:

1. Open the app in the Shopify Dev Dashboard.
2. Go to **Home**.
3. Click **Install app**.
4. Select the real store and install it.
5. Go to **Settings** and copy the Client ID and Client Secret into the root `.env`.

For your own organization's stores, Shopify supports the client credentials grant. The inventory sync adapter can use `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` to request short-lived Admin API tokens automatically.

After `npm run shopify:dev` installs the app on your store, export the offline session token:

```powershell
npm run shopify:export-session
```

If export says no offline session was found, keep `shopify:dev` running, open the Preview URL that Shopify printed, and let App Home load once. That triggers the generated app's OAuth/session storage path.

Copy the printed `SHOPIFY_SHOP_DOMAIN` and `SHOPIFY_ADMIN_ACCESS_TOKEN` lines into the root `.env` file. You can also pass a shop explicitly:

```powershell
npm run shopify:export-session -- your-shop.myshopify.com
```

This repo pins Shopify CLI `3.92.1` for repeatable installs. Shopify's app template requires Node `>=20.19 <22` or `>=22.12`, so upgrade Node before running `shopify app init`.

## Store Credentials

Copy `.env.example` to `.env` and fill in credentials.

Shopify:

- `SHOPIFY_SHOP_DOMAIN`
- `SHOPIFY_ADMIN_ACCESS_TOKEN`, or `SHOPIFY_CLIENT_ID` plus `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_API_VERSION`
- Per SKU: Shopify inventory item ID/GID and location ID/GID

Use the permanent `myshopify.com` shop domain for `SHOPIFY_SHOP_DOMAIN`, not a storefront custom domain like `joshswidgets.com`. Required app scopes are `read_inventory`, `write_inventory`, `read_products`, and `read_locations`.

After filling Shopify credentials in `.env`, test the real store connection before mapping inventory:

```powershell
npm run inv -- shopify-test
npm run inv -- shopify-lookup NEON-MUG
```

`shopify-lookup` prints the Shopify inventory item GID, location GID/name, and current available quantity for matching variants. Use those IDs in the Shopify mapping command.
`shopify-map` uses the same lookup and saves the Shopify mapping directly. If Shopify returns multiple locations, pass `--location` with the location name or ID.

eBay:

- `EBAY_ACCESS_TOKEN`, or the local token file created by the CLI OAuth helper
- `EBAY_REFRESH_TOKEN` if you want to seed the OAuth helper manually
- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `EBAY_RUNAME` as the RuName redirect_uri value from eBay, not a normal HTTPS URL
- `EBAY_ENVIRONMENT` as `production` or `sandbox`
- `EBAY_MARKETPLACE_ID`
- `EBAY_TOKEN_FILE`
- Per SKU: eBay SKU, with offer ID recommended for live offers

Etsy:

- `ETSY_KEYSTRING`
- `ETSY_SHARED_SECRET`
- `ETSY_REDIRECT_URI` as the exact HTTPS redirect URI registered in Etsy
- `ETSY_ACCESS_TOKEN`, `ETSY_REFRESH_TOKEN`, or the local token file created by the CLI OAuth helper
- Per SKU: Etsy listing ID and SKU

Etsy inventory updates require a unique product match and a single offering for the mapped SKU inside the listing inventory. If Etsy has multiple offerings for one SKU, give each sellable variation its own SKU before syncing.

### Etsy OAuth

New Etsy apps start as pending and cannot authenticate until Etsy approves the key. After the app status is active, add the keystring/shared secret and redirect URI to `.env`:

```powershell
ETSY_KEYSTRING=your-keystring
ETSY_SHARED_SECRET=your-shared-secret
ETSY_REDIRECT_URI=https://joshswidgets.com/etsy/callback
```

Then run:

```powershell
npm run inv -- etsy-auth-url
```

Open the printed URL, approve `listings_r listings_w`, then copy the full final redirect URL from your browser and run:

```powershell
npm run inv -- etsy-auth-callback "https://joshswidgets.com/etsy/callback?code=...&state=..."
```

The tool saves Etsy tokens to `data/etsy-auth.json`, which is ignored by git. Refresh manually any time with:

```powershell
npm run inv -- etsy-refresh
```

### eBay OAuth

The eBay Sell Inventory API uses user access tokens for seller inventory. Add these values to `.env`:

```powershell
EBAY_ENVIRONMENT=production
EBAY_CLIENT_ID=your-app-id
EBAY_CLIENT_SECRET=your-cert-id
EBAY_RUNAME=your-ru-name
EBAY_MARKETPLACE_ID=EBAY_US
```

Then run:

```powershell
npm run inv -- ebay-auth-url
```

Open the printed URL, approve the seller account, then copy the full final redirect URL from your browser and run:

```powershell
npm run inv -- ebay-auth-callback "https://your-accept-url?code=...&state=..."
```

The tool saves eBay tokens to `data/ebay-auth.json`, which is ignored by git. Refresh manually any time with:

```powershell
npm run inv -- ebay-refresh
```

Useful eBay helpers:

```powershell
npm run inv -- ebay-test
npm run inv -- ebay-lookup NEON-MUG
npm run inv -- ebay-map NEON-MUG --offer-id 9876543210
```

## Windows Automation

The built-in scheduler runs while the server is running:

```powershell
npm run inv -- schedule on 30
npm start
```

To start the app automatically when you sign in to Windows:

```powershell
npm run inv -- schedule-windows startup
npm run inv -- schedule-windows startup --install
```

To use Windows Task Scheduler to run a sync command directly every 30 minutes:

```powershell
npm run inv -- schedule-windows task 30
npm run inv -- schedule-windows task 30 --install
```

Run without `--install` first to preview the startup script or `schtasks` command.

## Platform API Notes

- Shopify adapter uses Admin GraphQL `inventoryItem` reads and `inventorySetQuantities` writes.
- eBay adapter uses OAuth user tokens with Sell Inventory `GET /inventory_item/{sku}` and `POST /bulk_update_price_quantity`, and checks the per-SKU response before treating a push as successful.
- Etsy adapter reads and writes `GET/PUT /v3/application/listings/{listing_id}/inventory`, preserving the listing inventory payload and changing the matched SKU quantity.

Relevant docs:

- https://shopify.dev/docs/apps/build/cli-for-apps
- https://shopify.dev/docs/apps/build/scaffold-app
- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities
- https://shopify.dev/docs/api/admin-graphql/latest/objects/inventoryitem
- https://shopify.dev/docs/api/admin-graphql/latest/queries/productVariants
- https://developer.ebay.com/develop/guides-v2/authorization
- https://developer.ebay.com/api-docs/static/oauth-token-types.html
- https://developer.ebay.com/api-docs/sell/static/inventory/bulk-updates.html
- https://developer.etsy.com/documentation/tutorials/listings

## Data

Inventory data should live in `data/inventory.sqlite` for normal personal use. SQLite is the default driver; change the file with `DATABASE_FILE` in `.env`.

`data/inventory.json` remains the portable backup/export and migration format. Change its location with `DATA_FILE` in `.env`.

Instruction inventory and print settings are currently stored in `data/printing.json`, and uploaded print assets live under `data/printing/`.

The eBay Reviews scraper also stores local-only browser session data and feedback history under `data/`. That directory is ignored by git, and the Vite dev server is configured not to watch it because Chromium session files can be locked while a scrape is running.

The growth roadmap in [PLAN.md](PLAN.md) moves the app toward SQLite-backed local operational data while keeping JSON export available for portability and backups. PostgreSQL remains optional for a future hosted deployment.
