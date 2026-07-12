# Changelog

Significant user-visible changes are recorded here. Dates use ISO `YYYY-MM-DD` format.

## Unreleased

### Sales, safety, and operations

- Required structural manifest validation before a backup can be considered restorable or trigger automatic cleanup, added stage-safe backup errors, and covered copy, retained-manifest, and mocked Windows Task Scheduler command failures.
- Rejected malformed or incomplete Shopify, eBay, and Etsy sales pages before persistence, with timeout and later-page failure coverage proving prior sales, refunds, and inventory remain intact.
- Prevented failed SQLite write callbacks from saving partial in-memory changes, with disposable forced-migration rollback, verified-target-backup, idempotent retry, and partial financial-schema coverage.
- Added isolated eBay and Etsy OAuth failure tests covering rejected callbacks, state mismatch, provider exchange errors, missing saved authorization, and refresh failure without persisting invalid token state.
- Pruned completed roadmap and audit prose, centralized every remaining work item in Plan and Kanban, and added the credential-rotation runbook.
- Added verified pre-mutation backups to historical eBay financial imports and SQLite migration, while preserving incomplete report rows without inventing comparable-sales components.
- Surfaced incomplete and unresolved financial-history counts on the Sales page and clarified how the legacy view labels mixed-currency selections.
- Completed the canonical comparable-sales invariant audit, including regression guards that prevent canceled-order refunds and currency-conflicting refunds from reducing comparable sales.

- Restored the eBay account-deletion notice feed under a 1,365-record backlog with bounded cursor pagination, drained 521 pending notices after a verified backup, and kept the protected feed within Cloudflare Worker subrequest limits.
- Reconciled eBay financial-report rows to saved API orders by exact order ID and currency, counting duplicate transaction keys once and excluding unmatched or conflicting rows with aggregate integrity warnings.
- Added durable sales financial provenance and field-presence tracking with enforced source precedence, allowing lower-priority imports to fill missing components without replacing authoritative values or mistaking legitimate zeroes for missing data.
- Added an in-app Sales calculation disclosure that explains the current headline measures and clearly distinguishes legacy Revenue from the pending comparable-net-sales rollout.
- Ensured duplicate refund identities affect comparable net sales exactly once while still producing an integrity warning, with focused reporting date-boundary coverage.
- Added the first release checklist covering focused scope, verification and dependency audit, backup and migration review, secret boundaries, deployment health, protected eBay behavior, and rollback.
- Completed a dated disposable restore rehearsal covering manifest and SQLite integrity, operational table groups, captured asset trees, API startup, and read-only marketplace reconciliation, and documented the repeatable recovery procedure.
- Hardened the eBay account-deletion Worker with an exact notification path, strict payload and size validation, cryptographic `X-EBAY-SIGNATURE` verification against cached eBay public keys, and idempotent notification storage so invalid traffic and duplicate deliveries do not consume KV writes.
- Disabled automatic eBay account-deletion notice polling to prevent repeated full-namespace KV reads; notice status remains available only through an explicit operator request while storage is redesigned.

- Fixed marketplace order refreshes to replace stale comparable-sales values, eliminating false Etsy impossible-total reconciliation warnings while preserving unresolved refunds whose component split is not provable.

- Added canonical local product-photo references, safe thumbnail serving, square Top Products thumbnails, and product-photo coverage in operational backups.

- Repaired Etsy payment and refund refreshes to use documented, bounded payment-account ledger requests, with stable payment deduplication and atomic provider-error handling.

- Added informational root test coverage reporting with text, JSON, and HTML output plus a non-thresholded CI artifact, and documented the initial safety-critical coverage gaps.

- Replaced the decorative Sales map with a locally bundled Natural Earth world map, order-volume country shading, approximate regional pins with accessible sales details, a clear legend, and an always-visible unknown-geography count.

- Changed Top Products to show the short canonical inventory name with SKU as secondary reference; long marketplace titles remain available in stored sales history and reports.
- Prevented marketplace placeholder SKU `--` from merging unrelated historical resale items into one Top Products row; manually reviewed historical catalog titles now aggregate under their current SKUs.
- Added a read-only sales reconciliation API that separates currencies and explains comparable sales, cancellations, refunds, tax, fees, shipping labels, net proceeds, and categorized integrity warnings without returning order-level identifiers.
- Added authoritative eBay refund and Etsy payment-adjustment imports with idempotent refund identities, atomic order/refund persistence, and explicit unresolved component handling.

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
