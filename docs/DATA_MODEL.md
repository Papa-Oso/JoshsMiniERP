# Data Model

The root ERP has one live working database: `data/inventory.sqlite`. All modules coordinate access through `src/server/sqliteDatabase.ts`, which serializes whole-file `sql.js` reads and writes so one module cannot overwrite another module's changes.

JSON files are export, backup, or migration formats. Timestamped `*.sqlite.migrated-*` files are migration archives, not live databases.

## Table Groups

| Module         | Primary tables                                                                                                | Stable identity                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Inventory      | `inventory_items`, `platform_mappings`, `inventory_events`                                                    | Internal item ID; case-insensitive SKU uniqueness                           |
| Sync           | `sync_runs`, `sync_run_messages`, `schedule_settings`                                                         | Run ID                                                                      |
| Imports        | `import_batches`, `import_batch_rows`                                                                         | Batch ID and row position                                                   |
| Reconciliation | `reconcile_runs`, `reconcile_rows`                                                                            | Run ID and row position                                                     |
| Printing       | `print_settings`, `print_instructions`, `print_instruction_events`, `sku_instruction_matches`, `print_assets` | Instruction, SKU, and asset IDs                                             |
| Reviews        | `scanned_feedback`, `feedback_scan_runs`, `review_product_aliases`                                            | Platform plus marketplace feedback ID, hashed into `feedback_key`           |
| Sales          | `sales_orders`, `sales_line_items`, `sales_refunds`, `sales_pulls`, `ebay_financial_transactions`             | Platform plus marketplace order/line/refund ID; hashed eBay financial event |

## Data Practices

- Marketplace IDs are stored as text because providers can change formatting and numeric IDs can exceed JavaScript's safe integer range.
- Timestamps are stored as ISO-8601 UTC text.
- Money is stored as normalized decimal values plus an explicit currency code. Mixed currencies are never silently combined without a warning.
- Sales geography is limited to country and region. Customer names, emails, phone numbers, street addresses, cities, and postal codes are discarded during import.
- Comparable net sales are product revenue after seller discounts, plus buyer-paid shipping, minus refunded pre-tax product and shipping revenue. Discounts remain separately reportable but are already reflected in normalized product revenue. Canceled orders and marketplace-collected tax/VAT contribute zero.
- Marketplace fees and purchased shipping labels remain separate from comparable sales and contribute only to expense and net-proceeds reporting.
- Financial completeness, source, source update time, reconciliation state, and the set of supplied financial fields are stored explicitly. Field presence distinguishes a legitimate zero from a missing value.
- Financial sources follow the ADR precedence order. Higher-priority sources replace supplied components; equal-priority newer pulls refresh them; lower-priority sources may fill only components not supplied by the authoritative source.
- Refunds retain authoritative totals plus separate product, shipping, and tax components when the provider proves that breakdown. `components_complete=0` means the total is known but its pre-tax components must not be guessed or applied to comparable sales.
- Order/refund imports commit atomically and record source update time and reconciliation state. Repeated provider pulls update stable refund identities instead of duplicating them.
- Marketplace pulls use upserts with stable compound identities, making repeated pulls idempotent.
- Foreign keys and indexes support common joins and dashboard filters.
- Bulk imports and migrations require a backup and post-write row-count/integrity checks.
- Inventory items may store a safe relative `image_path`; product photo files remain under `data/product photos/` and are included in operational backups.
- CSV files are transient import/export artifacts, never working storage. Successful marketplace-history imports are retained in SQLite and their source CSVs may be deleted after verification.

## Useful Queries

```sql
SELECT platform, currency, COUNT(*) AS orders, ROUND(SUM(gross_amount), 2) AS revenue
FROM sales_orders GROUP BY platform, currency ORDER BY revenue DESC;

SELECT sku, MAX(title) AS title, SUM(quantity) AS units, ROUND(SUM(amount), 2) AS revenue
FROM sales_line_items GROUP BY sku ORDER BY revenue DESC;

SELECT country_code, COUNT(*) AS orders, ROUND(SUM(gross_amount), 2) AS revenue
FROM sales_orders GROUP BY country_code ORDER BY orders DESC;

SELECT type, COUNT(*) AS transactions, ROUND(SUM(net_amount), 2) AS net_amount
FROM ebay_financial_transactions GROUP BY type ORDER BY transactions DESC;

SELECT platform, rating, COUNT(*) AS reviews
FROM scanned_feedback GROUP BY platform, rating ORDER BY platform, rating;

SELECT i.sku, i.name, i.quantity, m.platform, m.remote_sku, m.listing_id
FROM inventory_items AS i
LEFT JOIN platform_mappings AS m ON m.item_id = i.id
ORDER BY i.sku, m.platform;
```

Run `npm run inv -- db-status` for a content-free integrity and row-count summary.
