# Changelog

Significant user-visible changes are recorded here. Dates use ISO `YYYY-MM-DD` format.

## Unreleased

- Added a local-first Sales page with marketplace order pulls, revenue and order metrics, daily trends, platform and product analysis, recent orders, and country-level world-map visualization.
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

- Added official Etsy API review import with pagination, incremental deduplication, exact star ratings, and review photo URLs.
- Added shared eBay/Etsy review storage, platform filters, combined Judge.me CSV export, and Etsy negative reviews in Review Center.
- Prefixed exported reviewer identifiers with eBay or Etsy so imported Shopify reviews retain their marketplace source.
- Renamed the local tool to Marketplace Reviews and replaced browser scraping with eBay's authenticated Feedback API.
- Added eBay feedback IDs, buyer public IDs, listing details, exact comments, dates, and `images[].url` support through the official API.
