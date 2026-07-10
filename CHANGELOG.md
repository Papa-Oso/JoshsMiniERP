# Changelog

Significant user-visible changes are recorded here. Dates use ISO `YYYY-MM-DD` format.

## Unreleased

- Added a local-first Sales page with marketplace order pulls, revenue and order metrics, daily trends, platform and product analysis, recent orders, and country-level world-map visualization.
- Added a repeat-safe Seller Hub order-report CSV importer for historical eBay sales backfills.
- Added overlap-safe eBay transaction-report imports for historical orders and a separate financial ledger of fees, refunds, labels, payouts, charges, and holds.
- Added eBay gross sales, fees, refunds, shipping-label costs, and net proceeds to the Sales page.
- Migrated review title aliases and marketplace CSV history into SQLite, then removed all runtime and staging CSV files from `data/`.
- Added an idempotent sales ledger inside `data/inventory.sqlite` that intentionally excludes direct customer identifiers and street-level address data.
- Removed the unused root PostgreSQL driver, migration command, dependency, and optional tests; SQLite is now the single supported ERP working database.

### Documentation and quality

- Reorganized repository guidance by development, architecture, operations, marketplaces, deployment, testing, and troubleshooting concerns.
- Added contribution, security, and license documentation.
- Added root linting, formatting checks, focused component checks, and pull-request CI.
- Removed transient production connection state and real marketplace identifiers from examples.

### Existing application baseline

- Local SQLite inventory and operational history with JSON export/migration support.
- Inventory, printing, Review Center, CSV import/export, backup, restore inspection, and scheduler workflows.
- Shopify, Etsy, and eBay integration helpers with reconcile and dry-run safety.
- Read-only legacy eBay scanning, local-only mapping, and guarded one-listing migration.
- Embedded Shopify Admin app and eBay account-deletion Worker.

### Marketplace reviews

- Show review dates without timestamps across Review Center and marketplace review tables.
- Add source-review links and clickable customer-photo thumbnails to Recent Feedback and Marketplace Reviews.
- Deduplicate legacy and official-API copies of the same marketplace review in Recent Feedback and CSV exports without deleting raw source history.
- Replace the negative-only Review Center pane with a six-item recent-feedback queue; unseen negatives remain pinned and urgent until acknowledged with the eye action, then age out normally.
- Stop presenting expected rating-only, generic-message, and unmatched-SKU omissions as export errors.
- Exclude eBay's generic `Order delivered on time with no issues` delivery filler from Judge.me CSV exports while retaining source rows locally.
- Add an explicit `product_sku` column to local and embedded Shopify review CSV exports.
- Format all marketplace review dates as `dd/mm/yyyy` for valid Judge.me CSV imports.
- Decode HTML entities in marketplace review text and product titles so apostrophes and other characters display and export normally.
- Simplified review exports to `Incremental CSV`, `Full CSV`, and `Reset incremental`; every export refreshes both marketplaces while the independent CSV checkpoint prevents duplicate uploads without deleting saved reviews.
- Added official Etsy API review import with pagination, incremental deduplication, exact star ratings, and review photo URLs.
- Added shared eBay/Etsy review storage, platform filters, combined Judge.me CSV export, and Etsy negative reviews in Review Center.
- Prefixed exported reviewer identifiers with eBay or Etsy so imported Shopify reviews retain their marketplace source.
- Renamed the local tool to Marketplace Reviews and replaced browser scraping with eBay's authenticated Feedback API.
- Added eBay feedback IDs, buyer public IDs, listing details, exact comments, dates, and `images[].url` support through the official API.
