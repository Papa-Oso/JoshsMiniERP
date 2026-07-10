# Architecture

## System Boundaries

Josh's Mini ERP has three deployable surfaces:

1. The root local ERP owns inventory, printing, operational history, synchronization, and the CLI.
2. The embedded Shopify app provides Shopify Admin controls and calls the ERP API.
3. The Cloudflare Worker receives eBay Marketplace Account Deletion notifications and exposes a protected notice feed to the ERP.

The local ERP is the inventory source of truth. Marketplace quantities are observations and synchronization targets, not independent masters.

## Storage Decisions

SQLite at `data/inventory.sqlite` is the normal local working database because it provides real SQL durability without a service or cloud cost.

JSON is used for portable exports, backup, and migration. It is not the preferred long-term working database.

The root ERP has one supported working database: SQLite at `data/inventory.sqlite`. JSON remains a portability format. The embedded Shopify app's hosted OAuth session database is a separate deployment concern and is not part of the ERP's operational data model.

Related local data:

- Print files remain under `data/printing/`; SQLite tracks their metadata.
- eBay and Etsy review history uses normalized tables in `data/inventory.sqlite` with a platform field on every review and pull record.
- Marketplace order reporting uses normalized tables in `data/inventory.sqlite`. It retains order totals, product lines, statuses, and country/region only; direct customer identifiers and street-level address data are discarded during import.
- OAuth token files and browser state remain under `data/` and must never be committed.

## Inventory and Sync Model

Local adjustments create inventory events. Marketplace sales are detected by comparing a successful previous remote baseline with the current remote quantity.

New mappings establish a baseline first. The first read must not subtract inventory or push local quantity. This prevents a newly connected marketplace from being mistaken for a sale.

After sales are detected, the ERP subtracts the combined sold quantity locally and may push the new canonical quantity to enabled, writable marketplace mappings. Failed pulls must not cause stale pushes, and failed pushes must not cause the same sale to be deducted twice.

Instruction inventory is consumed from item sales through SKU-to-instruction mappings. Printing product labels adds manufactured sellable inventory; printing instruction pages adds instruction inventory.

Sales reporting is deliberately separate from inventory reconciliation. Official order API pulls are read-only and idempotently update the reporting ledger; they never subtract inventory or push marketplace quantities. See [ADR 0001](adr/0001-local-sales-ledger.md).

## Marketplace Write Boundaries

- Shopify and supported Etsy/eBay Inventory API mappings may participate in reviewed sync workflows.
- Legacy eBay listings are readable through the Trading API but live quantity writes are disabled by default.
- A legacy eBay mapping apply changes only local ERP data.
- An eBay Inventory API migration requires one explicit listing confirmation after preview and backup.

See `docs/MARKETPLACES.md` for operator commands and `PLAN.md` for the current protected-work policy.

## API Security

The local API binds to `127.0.0.1` by default. Local development may run without an API token.

When `NODE_ENV=production`, startup fails unless `ERP_API_TOKEN` is configured. Clients send the token as a bearer token. Production secrets belong in Secret Manager, not source files or container images.

## Architecture Decisions

When changing a durable choice above, add a short record under `docs/adr/` with context, decision, consequences, and date. Do not use ADRs for routine implementation details.
