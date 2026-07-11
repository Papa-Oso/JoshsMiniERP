# Restore Rehearsal — 2026-07-11

## Scope

A fresh manifest-backed operational backup was restored into an ignored disposable directory. The live database and captured backup were not overwritten. No credentials, customer data, marketplace identifiers, or backup files are included in this record.

## Results

- Manifest inspection: restorable; all six captured paths existed.
- Restored SQLite integrity: `ok`.
- Inventory: 14 rows, matching the backup manifest count.
- Operational data groups present: mappings, inventory events, sync history, schedule and print settings, print assets and instructions, feedback history, sales orders and line items, and sales pull history.
- Captured printing metadata, printing-assets directory, and product-photos directory restored into the disposable tree.
- Disposable API startup: `GET /api/health` returned HTTP 200; the process was stopped afterward.
- Read-only Shopify reconciliation: completed with no warnings or errors.
- Read-only eBay reconciliation: completed with no warnings or errors; no listing writes were enabled or attempted.
- Read-only Etsy reconciliation: completed partially; three remote pulls were throttled with HTTP 429 per-second rate-limit responses. No marketplace quantities were written.

## Conclusion

The operational backup can reconstruct a healthy local ERP database and associated file tree. The rehearsal passed recovery verification. Etsy throttling remains an external reconciliation limitation and does not affect the restored data's integrity.
