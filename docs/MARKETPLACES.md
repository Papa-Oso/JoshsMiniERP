# Marketplaces

## Shared Safety Model

- Map by stable SKU and platform identifiers.
- Establish a read-only baseline for every new mapping.
- Reconcile and dry-run before live sync.
- Back up before bulk mapping or migration work.
- Never place marketplace credentials in commands, screenshots, commits, or documentation.

## Shopify

Configure the permanent `myshopify.com` domain and either a fixed Admin token or client credentials. Required scopes are `read_inventory`, `write_inventory`, `read_products`, `read_locations`, and `read_orders`.

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

Configure `ETSY_KEYSTRING`, `ETSY_SHARED_SECRET`, and the exact registered HTTPS redirect URI. `ETSY_SHOP_ID` is optional when the saved OAuth token contains the numeric owner ID; set it explicitly if automatic shop lookup is unavailable.

```powershell
npm run inv -- etsy-auth-url
npm run inv -- etsy-auth-callback "https://example.invalid/etsy/callback?code=REDACTED&state=REDACTED"
npm run inv -- etsy-refresh
```

Etsy inventory updates require a unique product match and a single offering for the mapped SKU. Give each sellable variation its own unique SKU before enabling sync.

### Etsy reviews

Marketplace Reviews imports Etsy reviews through the official `GET /v3/application/shops/{shop_id}/reviews` API. Etsy prohibits screen scraping, so this workflow must not be replaced with a browser scraper.

The import is paginated and stores Etsy reviews in the canonical local database alongside eBay reviews with `platform=etsy`, preserves exact star ratings and `image_url_fullxfull`, and matches reviews to local products through Etsy listing IDs when mappings exist.

`Refresh All` in Review Center updates saved reviews through both official marketplace APIs. On Marketplace Reviews, `Incremental CSV` exports saved reviews not included in a previous CSV download, while `Full CSV` exports all saved reviews. CSV creation does not contact either marketplace; either download advances the export checkpoint. `Reset incremental` clears only that checkpoint, so the next incremental CSV contains every saved review without deleting the database. The platform filter affects only the on-screen review list.

Judge.me CSV exports use Judge.me's required `dd/mm/yyyy` review-date format, include `source_platform` and `product_sku` for operator reference and import mapping, and include up to five direct `.jpg`, `.jpeg`, or `.png` `picture_urls` for review photos. Query strings and fragments are removed from exported photo URLs so Judge.me recognizes their image formats. Exported reviewer names are prefixed as `eBay buyer <identifier>` or `Etsy buyer <buyer_user_id>` so imported Shopify reviews retain visible source context. Judge.me's import wizard can map or skip the reference columns. Rating-only Etsy reviews and eBay's generic `Order delivered on time with no issues` delivery message remain visible locally but are omitted from the Judge.me CSV because they are not substantive written reviews.

Review Center shows the six most recent substantive reviews. Unacknowledged negative reviews stay pinned even when older than the normal six-row window; use the eye action to mark one seen. Acknowledged negatives remain softly highlighted while recent, then age out normally. Acknowledgment is stored in SQLite and is preserved by later marketplace refreshes.

`Refresh All` in Review Center pulls marketplace sales, refreshes saved eBay and Etsy review history, runs a live inventory sync, and then reloads the operations report. It asks for confirmation because supported marketplace quantities may be updated. The review refresh does not create a CSV or advance either export checkpoint, and protected legacy eBay quantity writes remain skipped.

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

### eBay reviews

Marketplace Reviews imports seller feedback through eBay's official `GET /commerce/feedback/v1/feedback` endpoint with `role:SELLER`. The authorization requires both inventory access and `https://api.ebay.com/oauth/api_scope/commerce.feedback`; existing tokens created before feedback support must be authorized again.

The import is paginated and upserts the complete API response into shared review history. It stores stable feedback IDs, buyer public IDs, listing IDs/titles, rating type, comment text, dates, and `images[].url` values. Browser scraping is no longer part of the supported workflow. Incremental behavior applies to the CSV export checkpoint, not to whether the database is refreshed.

## Sales Reporting

The local Sales page reads official order APIs and stores normalized reporting tables in `data/inventory.sqlite`. Pulling sales is read-only and does not change inventory or marketplace quantities.

- Shopify requires `read_orders`. Without approved `read_all_orders`, Shopify normally limits order access to the most recent 60 days.
- eBay requires `https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly`. Re-run the documented eBay authorization flow after adding this scope.
- The Fulfillment API supplies the ongoing 90-day eBay window. Backfill older Seller Hub order-report CSV files with `npm run inv -- ebay-sales-import <file.csv> --dry-run`, then rerun without `--dry-run`; the apply path creates and inspects an operational backup before mutation, and stable eBay order IDs make the import repeat-safe.
- Import overlapping Payments transaction reports with `npm run inv -- ebay-transactions-import <directory> --dry-run`. The apply path creates and inspects an operational backup before mutation. Exact financial events are deduplicated by a stable content key, while order rows are grouped by eBay order number; customer names and street-level details are not stored.
- Historical order and transaction reports preserve their legacy gross and subtotal values but remain financially incomplete until an authoritative source proves the product, shipping, discount, tax, and refund components. The ERP does not manufacture comparable-sales components from missing report fields.
- Etsy requires `transactions_r`. Re-run the Etsy authorization flow after adding this scope.

Sales refresh also reads authoritative refund data. eBay supplies order- and line-level refund totals through Fulfillment order payment details. Etsy supplies payment adjustments through bounded, read-only payment-account ledger windows and their associated payments. When a provider does not expose a provable product/shipping/tax split, the ERP stores the authoritative refund total as unresolved and does not guess a pre-tax comparable-sales deduction.

`GET /api/sales/reconciliation` requires a marketplace and accepts the normal range plus an optional three-letter currency. It returns aggregate-only financial components and categorized integrity counts. Currencies remain separate, tax is excluded from comparable sales, and no order or refund identifiers are returned.

For eBay, fees, purchased shipping labels, and net proceeds are included only from financial-report rows whose order ID and currency exactly match a saved order in the selected period. Exact duplicate transaction keys are counted once. Unmatched rows and currency conflicts are excluded rather than guessed and appear only as aggregate warnings.

The ledger stores country and region for geographic reporting, but discards names, email addresses, phone numbers, street addresses, cities, and postal codes.

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

Run it only after backup, preview, Seller Hub review, and exact listing confirmation. Legacy quantity pushes remain disabled unless a separate write-safety plan is explicitly approved. Normal sync runs continue to read these listings for reconciliation and sale detection, but skip their protected quantity writes without counting the expected skip as a sync issue.

## Account Deletion Notices

The Cloudflare Worker under `workers/ebay-account-deletion` receives eBay deletion notifications. The local ERP polls its protected notice feed. Deployment and secret setup are documented in that component's README.
