# Marketplaces

## Shared Safety Model

- Map by stable SKU and platform identifiers.
- Establish a read-only baseline for every new mapping.
- Reconcile and dry-run before live sync.
- Back up before bulk mapping or migration work.
- Never place marketplace credentials in commands, screenshots, commits, or documentation.

## Shopify

Configure the permanent `myshopify.com` domain and either a fixed Admin token or client credentials. Required scopes are `read_inventory`, `write_inventory`, `read_products`, and `read_locations`.

```powershell
npm run inv -- shopify-test
npm run inv -- shopify-lookup EXAMPLE-SKU-001
npm run inv -- shopify-map EXAMPLE-SKU-001 --location "Main"
npm run inv -- shopify-import --location "Main" --dry-run
npm run inv -- shopify-import --location "Main"
npm run inv -- shopify-refresh-details --dry-run
```

Existing local SKUs retain their local quantity during Shopify import. Reconcile when local and Shopify counts differ.

For embedded app development:

```powershell
npm run shopify:dev:full
npm run shopify:export-session
```

Exported session credentials belong only in the root `.env`.

## Etsy

Configure `ETSY_KEYSTRING`, `ETSY_SHARED_SECRET`, and the exact registered HTTPS redirect URI.

```powershell
npm run inv -- etsy-auth-url
npm run inv -- etsy-auth-callback "https://example.invalid/etsy/callback?code=REDACTED&state=REDACTED"
npm run inv -- etsy-refresh
```

Etsy inventory updates require a unique product match and a single offering for the mapped SKU. Give each sellable variation its own unique SKU before enabling sync.

## eBay OAuth and Inspection

Configure the client ID, client secret, RuName, environment, marketplace, and ignored token-file path.

```powershell
npm run inv -- ebay-auth-url
npm run inv -- ebay-auth-callback "https://example.invalid/callback?code=REDACTED&state=REDACTED"
npm run inv -- ebay-refresh
npm run inv -- ebay-test
npm run inv -- ebay-lookup EXAMPLE-SKU-001
```

The RuName is eBay's OAuth `redirect_uri` value, not an ordinary HTTPS callback URL.

## Legacy eBay Listings

Existing listings are protected business assets. Their age, ranking, watchers, sales history, and Item IDs must not be lost merely to connect the ERP.

Allowed read-only/local workflow:

```powershell
npm run inv -- ebay-legacy-scan --output data/ebay-legacy-listings.csv
npm run inv -- ebay-legacy-map --output data/ebay-legacy-mapping-preview.csv
npm run inv -- ebay-legacy-map --apply --output data/ebay-legacy-mapping-applied.csv
```

The mapping apply changes local ERP data only. It must not revise the live listing.

Migration preview:

```powershell
npm run inv -- ebay-migrate EXAMPLE-SKU-001 --output data/ebay-migration-preview.csv
```

Live migration is a risky write and must remain one listing at a time:

```powershell
# EXAMPLE ONLY — LIVE WRITE WHEN REAL VALUES ARE USED
npm run inv -- ebay-migrate EXAMPLE-SKU-001 --apply --confirm-listing-id 123456789012
```

Run it only after backup, preview, Seller Hub review, and exact listing confirmation. Legacy quantity pushes remain disabled unless a separate write-safety plan is explicitly approved.

## Account Deletion Notices

The Cloudflare Worker under `workers/ebay-account-deletion` receives eBay deletion notifications. The local ERP polls its protected notice feed. Deployment and secret setup are documented in that component's README.
