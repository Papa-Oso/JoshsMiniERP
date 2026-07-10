# Changelog

Significant user-visible changes are recorded here. Dates use ISO `YYYY-MM-DD` format.

## Unreleased

### Documentation and quality

- Reorganized repository guidance by development, architecture, operations, marketplaces, deployment, testing, and troubleshooting concerns.
- Added contribution, security, and license documentation.
- Added root linting, formatting checks, focused component checks, and pull-request CI.
- Removed transient production connection state and real marketplace identifiers from examples.

### Existing application baseline

- Local SQLite inventory and operational history with JSON export/migration support.
- Optional Postgres storage for hosted deployment.
- Inventory, printing, Review Center, CSV import/export, backup, restore inspection, and scheduler workflows.
- Shopify, Etsy, and eBay integration helpers with reconcile and dry-run safety.
- Read-only legacy eBay scanning, local-only mapping, and guarded one-listing migration.
- Embedded Shopify Admin app and eBay account-deletion Worker.
