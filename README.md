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

For a built UI served by the API:

```powershell
npm run build
npm start
```

## Inventory Rules

- Add inventory only in this tool.
- Batch adds increase the local master count and are pushed to mapped stores on sync.
- Manual subtracts reduce the local master count for discards, personal use, damage, or corrections.
- Store sales are detected on sync by comparing each platform's current quantity to the last quantity this tool successfully pushed.
- First sync for a newly mapped store captures a baseline only. It does not push that store until a later sync, so you can confirm the local count before anything writes to the marketplace.

That last-synced baseline lets simultaneous sales subtract correctly. If Etsy drops from 15 to 14 and eBay drops from 15 to 13 before the next sync, the tool subtracts 3 total units from the master inventory, then pushes the new count to every mapped store.

## CLI

```powershell
npm run inv -- list
npm run inv -- create NEON-MUG "Neon Mug" 30
npm run inv -- add NEON-MUG 15 "July restock"
npm run inv -- subtract NEON-MUG 1 "personal use"
npm run inv -- sync
npm run inv -- shopify-lookup NEON-MUG
npm run inv -- shopify-map NEON-MUG --location "Main"
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

## Shopify CLI

This repo includes Shopify CLI as a local dev dependency. Use it through npm:

```powershell
npm run shopify -- app init --name joshs-mini-erp --path shopify-app --template reactRouter --flavor typescript --package-manager npm
npm run shopify:dev
npm run shopify:deploy
```

Shopify's current scaffold path is `shopify app init`. Shopify CLI can create app records, scaffold an app, run local development, and execute Admin GraphQL queries from an app context. If you already created the app record, pass its client ID with `--client-id <value>` to avoid the app selection prompt.

This inventory tool still runs as its own local ERP app. The Shopify app you create through CLI is the authorization bridge that gets installed on your store and grants inventory scopes.

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

Use the permanent `myshopify.com` shop domain for `SHOPIFY_SHOP_DOMAIN`, not a storefront custom domain like `joshswidgets.com`. Required app scopes are `read_inventory` and `write_inventory`.

After filling Shopify credentials in `.env`, test the real store connection before mapping inventory:

```powershell
npm run inv -- shopify-test
npm run inv -- shopify-lookup NEON-MUG
```

`shopify-lookup` prints the Shopify inventory item GID, location GID/name, and current available quantity for matching variants. Use those IDs in the Shopify mapping command.
`shopify-map` uses the same lookup and saves the Shopify mapping directly. If Shopify returns multiple locations, pass `--location` with the location name or ID.

eBay:
- `EBAY_ACCESS_TOKEN`
- `EBAY_MARKETPLACE_ID`
- Per SKU: eBay SKU, with offer ID recommended for live offers

Etsy:
- `ETSY_API_KEY` as `keystring:shared_secret`
- `ETSY_CLIENT_ID` as the keystring
- `ETSY_REDIRECT_URI` as the exact HTTPS redirect URI registered in Etsy
- `ETSY_ACCESS_TOKEN`, `ETSY_REFRESH_TOKEN`, or the local token file created by the CLI OAuth helper
- Per SKU: Etsy listing ID and SKU

Etsy inventory updates require a unique product match and a single offering for the mapped SKU inside the listing inventory. If Etsy has multiple offerings for one SKU, give each sellable variation its own SKU before syncing.

### Etsy OAuth

New Etsy apps start as pending and cannot authenticate until Etsy approves the key. After the app status is active, add the keystring/shared secret and redirect URI to `.env`:

```powershell
ETSY_API_KEY=keystring:shared_secret
ETSY_CLIENT_ID=keystring
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

## Platform API Notes

- Shopify adapter uses Admin GraphQL `inventoryItem` reads and `inventorySetQuantities` writes.
- eBay adapter uses Sell Inventory `GET /inventory_item/{sku}` and `POST /bulk_update_price_quantity`, and checks the per-SKU response before treating a push as successful.
- Etsy adapter reads and writes `GET/PUT /v3/application/listings/{listing_id}/inventory`, preserving the listing inventory payload and changing the matched SKU quantity.

Relevant docs:
- https://shopify.dev/docs/apps/build/cli-for-apps
- https://shopify.dev/docs/apps/build/scaffold-app
- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities
- https://shopify.dev/docs/api/admin-graphql/latest/objects/inventoryitem
- https://developer.ebay.com/api-docs/sell/static/inventory/bulk-updates.html
- https://developer.etsy.com/documentation/tutorials/listings

## Data

Inventory data is stored in `data/inventory.json` by default. Change it with `DATA_FILE` in `.env`.
