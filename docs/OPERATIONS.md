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

CSV files used for imports are transient staging files. Preview, back up, import, verify SQLite row counts, and then delete the source CSV. Do not make application behavior depend on a CSV remaining under `data/`.

## Backup and Recovery

```powershell
npm run inv -- backup
npm run inv -- backup D:\InventoryBackups
npm run inv -- backup-prune
npm run inv -- backup-prune --apply
npm run inv -- restore-dry-run
npm run inv -- restore-dry-run data/backups/operational-backup-EXAMPLE.json
```

The app keeps the latest five manifest-backed operational backups. After a successful backup, it verifies those five retained backup sets and removes older sets. Backups include the canonical database, printing assets, and local product photos. Loose files and one-time migration safety copies are not removed automatically.

Use `backup-prune` to preview cleanup of existing backups, including the space it would reclaim. Add `--apply` only after reviewing the preview. Cleanup refuses to run if one of the five retained manifests is not restorable or if a manifest points outside the selected backup directory.

`restore-dry-run` verifies a manifest without overwriting anything. A real recovery should restore the canonical operational database and print assets together, then start the API and reconcile before any live sync.

### Disposable Restore Rehearsal

At least periodically, go beyond `restore-dry-run` using an ignored disposable directory under `data/` or a separate temporary location:

1. Create a fresh operational backup and verify its manifest with `restore-dry-run`.
2. Copy the manifest's SQLite database, printing metadata, printing assets, and product photos into a new disposable directory. Never copy them over the working `data/inventory.sqlite` or working asset directories.
3. Set `STORE_DRIVER=sqlite` and `DATABASE_FILE` only for the rehearsal process so they point to the disposable database.
4. Run `db-status`, require SQLite integrity `ok`, and compare aggregate table counts with the backup manifest and expected operational modules.
5. Start the API on an unused loopback port, require a successful `/api/health` response, and stop the rehearsal process.
6. Run read-only marketplace reconciliation against the disposable copy. Treat provider throttling as an external limitation, but do not run a live sync to compensate.
7. Record the date and aggregate results without credentials, customer data, listing identifiers, or files from `data/`.

The latest recorded rehearsal is [Restore Rehearsal — 2026-07-11](recovery/2026-07-11-restore-rehearsal.md).

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

Migration writes and verifies a JSON source backup and refuses to overwrite a non-empty SQLite database unless explicitly forced. Before opening the target for any schema upgrade, an apply run also creates and byte-verifies a pre-migration copy of an existing SQLite target. Review both reported backup paths and do not use `--force` without a clear reason.
