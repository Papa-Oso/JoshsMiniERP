# Operations

## Safe Daily Sequence

1. Check local health without changing inventory:

   ```powershell
   npm run inv -- doctor
   ```

2. Back up before a bulk or credential-sensitive change:

   ```powershell
   npm run inv -- backup
   ```

3. Preview an import, mapping, migration, or sync.
4. Review SKU identity and quantity differences.
5. Apply only the reviewed operation.
6. Reconcile again before a live marketplace push.

## Inventory

```powershell
npm run inv -- list
npm run inv -- create EXAMPLE-SKU-001 "Example Item" 30
npm run inv -- add EXAMPLE-SKU-001 15 "Restock"
npm run inv -- subtract EXAMPLE-SKU-001 1 "Damaged"
```

Inventory adjustments create durable events. Do not edit SQLite or exported JSON manually to perform ordinary inventory work.

## CSV Import

```powershell
npm run inv -- csv-import inventory-batch.csv --dry-run
npm run inv -- csv-import inventory-batch.csv
```

`sku` is required. New items also require `name`. Use either `quantity`/`qty` for an absolute count or one of `add`, `delta`, `adjustment`, or `received` for a change—not both. Optional columns include `safety_stock`, `max_inventory`, and `note`.

## Reconcile and Sync

```powershell
npm run inv -- reconcile shopify
npm run inv -- sync --dry-run --platform shopify
npm run inv -- sync
```

Reconcile and dry-run operations may pull live quantities and save review snapshots, but they do not change inventory quantities or push marketplace quantities. Run a live sync only after reviewing the preview.

## Export and Review

```powershell
npm run inv -- export data/export.json
npm run inv -- export-csv data/items.csv
npm run inv -- export-events-csv data/events.csv
npm run inv -- export-review-csv data/review-export
```

JSON is the portable migration/backup representation. CSV exports are intended for review and analysis, not as a second source of truth.

## Backup and Recovery

```powershell
npm run inv -- backup
npm run inv -- backup D:\InventoryBackups
npm run inv -- restore-dry-run
npm run inv -- restore-dry-run data/backups/operational-backup-EXAMPLE.json
```

Keep at least the latest ten operational backups and one monthly copy outside the repo. Before deleting an older backup, verify a newer manifest and open its captured files.

`restore-dry-run` verifies a manifest without overwriting anything. A real recovery should restore inventory, print assets, and feedback history together, then start the API and reconcile before any live sync.

## Scheduler

```powershell
npm run inv -- schedule on 30
npm run inv -- schedule off
npm run inv -- schedule-windows startup
npm run inv -- schedule-windows task 30
```

The Windows automation commands preview their changes by default. Add `--install` only after reviewing the generated startup or Task Scheduler command. Enable automatic sync only after mappings, credentials, baselines, and dry-run results are trusted.

## SQLite Migration

```powershell
npm run inv -- migrate-sqlite --dry-run
npm run inv -- migrate-sqlite
```

Migration writes a JSON backup first and refuses to overwrite a non-empty SQLite database unless explicitly forced. Do not use `--force` without a reviewed backup and clear reason.
