# Data Model

The root ERP has one live working database: `data/inventory.sqlite`. All modules coordinate access through `src/server/sqliteDatabase.ts`, which serializes whole-file `sql.js` reads and writes so one module cannot overwrite another module's changes.

JSON files are export, backup, or migration formats. Timestamped `*.sqlite.migrated-*` files are migration archives, not live databases.

## Table Groups

| Module         | Primary tables                                                                                                | Stable identity                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Inventory      | `inventory_items`, `platform_mappings`, `inventory_events`                                                    | Internal item ID; case-insensitive SKU uniqueness                 |
| Sync           | `sync_runs`, `sync_run_messages`, `schedule_settings`                                                         | Run ID                                                            |
| Imports        | `import_batches`, `import_batch_rows`                                                                         | Batch ID and row position                                         |
| Reconciliation | `reconcile_runs`, `reconcile_rows`                                                                            | Run ID and row position                                           |
| Printing       | `print_settings`, `print_instructions`, `print_instruction_events`, `sku_instruction_matches`, `print_assets` | Instruction, SKU, and asset IDs                                   |
| Reviews        | `scanned_feedback`, `feedback_scan_runs`                                                                      | Platform plus marketplace feedback ID, hashed into `feedback_key` |
| Sales          | `sales_orders`, `sales_line_items`, `sales_pulls`                                                             | Platform plus marketplace order/line ID                           |

## Data Practices

- Marketplace IDs are stored as text because providers can change formatting and numeric IDs can exceed JavaScript's safe integer range.
- Timestamps are stored as ISO-8601 UTC text.
- Money is stored as normalized decimal values plus an explicit currency code. Mixed currencies are never silently combined without a warning.
- Sales geography is limited to country and region. Customer names, emails, phone numbers, street addresses, cities, and postal codes are discarded during import.
- Marketplace pulls use upserts with stable compound identities, making repeated pulls idempotent.
- Foreign keys and indexes support common joins and dashboard filters.
- Bulk imports and migrations require a backup and post-write row-count/integrity checks.

## Useful Queries

```sql
SELECT platform, currency, COUNT(*) AS orders, ROUND(SUM(gross_amount), 2) AS revenue
FROM sales_orders GROUP BY platform, currency ORDER BY revenue DESC;

SELECT sku, MAX(title) AS title, SUM(quantity) AS units, ROUND(SUM(amount), 2) AS revenue
FROM sales_line_items GROUP BY sku ORDER BY revenue DESC;

SELECT country_code, COUNT(*) AS orders, ROUND(SUM(gross_amount), 2) AS revenue
FROM sales_orders GROUP BY country_code ORDER BY orders DESC;

SELECT platform, rating, COUNT(*) AS reviews
FROM scanned_feedback GROUP BY platform, rating ORDER BY platform, rating;

SELECT i.sku, i.name, i.quantity, m.platform, m.remote_sku, m.listing_id
FROM inventory_items AS i
LEFT JOIN platform_mappings AS m ON m.item_id = i.id
ORDER BY i.sku, m.platform;
```

Run `npm run inv -- db-status` for a content-free integrity and row-count summary.
