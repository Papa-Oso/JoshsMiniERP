# Josh's Mini ERP Plan

This document captures the requested inventory work, what is already implemented, how to use it safely, and the authoritative work sequence for professional UI polish and database sustainability.

## Authoritative Direction

- Keep the working app stable. Inventory, printing, sync, and CSV workflows are already useful and should not be rewritten casually.
- Treat PostgreSQL as the growth database. JSON remains the local fallback/export format, and Cloud SQL for PostgreSQL remains the production target.
- Treat the old SQLite inventory plan as historical context only. `data/inventory.sqlite` may exist locally from earlier experiments, but it is not the current source of truth.
- Rework the local Vite UI as a professional operations tool: calm, compact, durable, and designer-grade.
- Keep the embedded Shopify app on Shopify's native Admin components. It should share product language and API contracts with the local ERP, not the local ERP's visual theme.

## Current Storage

The app is currently JSON-backed.

Default file:

```text
data/inventory.json
```

That JSON file currently stores:

- `items`: local SKUs, names, quantities, safety stock, and platform mappings.
- `events`: creates, batch adds, manual subtracts, corrections, platform-sale deductions, sync baselines, and sync pushes.
- `schedule`: local scheduler settings.
- `syncRuns`: recent sync run summaries and messages.

So today, batch entries and CSV adjustments are saved as inventory events in `data/inventory.json`. The next storage step is to complete and harden the PostgreSQL path, then move related operational data into the same backed-up system.

Related local data currently lives outside the main inventory store:

- `data/printing.json`: instruction inventory, print settings, instruction matches, and print events.
- `data/printing/`: label and instruction document assets.
- `data/feedback.sqlite`: eBay Reviews incremental scan history.
- `data/browser-profile/`: local browser session state for the eBay scraper.

## Requested Work

Status legend:

- Done: implemented in the current working tree.
- Planned: documented here for the SQL/storage follow-up.

| Request | Status | Notes |
| --- | --- | --- |
| Shopify import | Done | `shopify-import` scans Shopify SKUs, creates missing local SKUs, and maps existing SKUs. |
| Dry-run / reconcile mode | Done | `reconcile` and `sync --dry-run` show local vs marketplace differences without changing local data or pushing inventory. |
| CSV batch import | Done | `csv-import` can create SKUs, set quantities, apply batch deltas, update safety stock, and save event notes. |
| Backup/export | Done | `backup` and `export` operate on `data/inventory.json`. |
| eBay setup | Done | OAuth URL, callback, refresh, lookup, test, and mapping helpers are in place. |
| Scheduler polish | Done | Windows startup script preview/install and Task Scheduler command preview/install are in place. |
| Postgres storage | In progress | JSON remains the default local driver. `STORE_DRIVER=postgres`, `migrate-postgres`, and a Postgres store contract test are in place. Runtime behavior still uses a document-style store interface. |
| SKU pairing audit | Done | `sku-audit` compares local SKUs with Shopify and eBay SKU catalogs. |
| Shopify names/descriptions | In progress | App data model and refresh command are in place. Requires Shopify `read_products` scope approval and a fresh token before product details can populate. |
| Inventory max visualization | Done | Item inventory and instruction inventory use configurable max values, progress bars, status labels, and over-max warnings. |
| Printing workflow cleanup | Done | Product labels, instruction documents, instruction inventory, print activity, upload/print actions, and printer settings are separated into clearer panes. |
| Instruction consumption on sales | Done | Marketplace sales consume mapped instruction inventory through item-to-instruction mappings. |
| Printer settings | Done | Label and instruction printers can be saved separately from a centered Print Settings modal. |
| eBay reviews controls | Done | CSV buttons own the scrape/export actions, incremental is preferred, and early feedback prevents empty CSV creation. |
| UI consistency guide | Done | `UI_STYLE_GUIDE.md` captures page identity, settings, buttons, panels, feedback, inventory visuals, and verification rules. |
| Notification framework | Done | Topbar bell shows unread active alerts for inventory state, sync issues, and printer status problems. Stock state alerts are not dismissible; operational alerts can be dismissed locally. |

## Recent UI and Fulfillment Work

- Inventory charts no longer assume a hard-coded max of 100; each item can define its own max inventory.
- Instruction inventory now follows the same visualization pattern as item inventory: count, status, progress bar, max label, and over-max warning.
- Instruction max inventory and low alert are editable from the Instruction Inventory pane.
- Printing product labels records a batch add for newly manufactured, sellable stock using the printed label quantity and the activity note `Manufactured and ready for sale`.
- Instruction inventory is reduced automatically when marketplace sales are detected for SKUs mapped to an instruction type.
- Printing now separates product labels, instruction documents, instruction inventory, print activity, and printer settings.
- Print Settings opens as the same centered modal pattern used by Inventory store settings.
- Printer settings support separate saved printers for labels and instruction documents.
- Uploaded instruction documents can be printed from the instruction documents workflow.
- Printing instruction pages adds instruction inventory based on pages times instructions per page.
- eBay Reviews uses the CSV buttons as the scrape/export actions, with Incremental emphasized over Full.
- A topbar notification bell tracks unread active alerts for inventory lows, instruction lows, sync problems, and printer status issues.
- `UI_STYLE_GUIDE.md` is the UI consistency reference for future screen changes.

## Implemented Command Reference

Basic inventory:

```powershell
npm run inv -- list
npm run inv -- create NEON-MUG "Neon Mug" 30
npm run inv -- add NEON-MUG 15 "July restock"
npm run inv -- subtract NEON-MUG 1 "personal use"
```

Shopify:

```powershell
npm run inv -- shopify-test
npm run inv -- shopify-lookup NEON-MUG
npm run inv -- shopify-map NEON-MUG --location "Main"
npm run inv -- shopify-import --location "Main" --dry-run
npm run inv -- shopify-import --location "Main"
npm run inv -- shopify-refresh-details --dry-run
npm run inv -- shopify-refresh-details
```

Reconcile before live sync:

```powershell
npm run inv -- reconcile shopify
npm run inv -- sync --dry-run --platform shopify
npm run inv -- sync
```

CSV import:

```powershell
npm run inv -- csv-import inventory-batch.csv --dry-run
npm run inv -- csv-import inventory-batch.csv
```

CSV columns:

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | Yes | Local SKU. Converted to uppercase. |
| `name` | New SKUs only | Item name/title. |
| `quantity` or `qty` | No | Absolute on-hand count. |
| `add`, `delta`, `adjustment`, or `received` | No | Batch adjustment. Positive adds stock, negative subtracts stock. |
| `safety_stock` or `safety` | No | Safety stock value. |
| `max_inventory`, `max_stock`, or `capacity` | No | Visual max inventory value. Counts can exceed max and should warn visually. |
| `note` | No | Saved on the inventory event. |

Use either an absolute quantity or a delta on one CSV row, not both.

Backup/export:

```powershell
npm run inv -- export
npm run inv -- export data/export.json
npm run inv -- backup
npm run inv -- backup D:\InventoryBackups
```

SKU pairing audit:

```powershell
npm run inv -- sku-audit --location "Main"
npm run inv -- sku-audit --location "Main" --output data/sku-audit.csv
npm run inv -- sku-audit --platform shopify --location "Main"
npm run inv -- sku-audit --platform ebay
```

Postgres foundation:

```powershell
$env:DATABASE_URL="postgresql://erp_user:<password>@127.0.0.1:5432/erp"
npm run inv -- migrate-postgres --dry-run
npm run inv -- migrate-postgres
```

eBay OAuth and helpers:

```powershell
npm run inv -- ebay-auth-url
npm run inv -- ebay-auth-callback "https://your-accept-url?code=...&state=..."
npm run inv -- ebay-refresh
npm run inv -- ebay-test
npm run inv -- ebay-lookup NEON-MUG
npm run inv -- ebay-map NEON-MUG --offer-id 9876543210
```

Windows automation:

```powershell
npm run inv -- schedule on 30
npm start
npm run inv -- schedule-windows startup
npm run inv -- schedule-windows startup --install
npm run inv -- schedule-windows task 30
npm run inv -- schedule-windows task 30 --install
```

Run Windows helper commands without `--install` first to preview what will be created.

## Safe Operating Workflow

1. Back up the current data.

```powershell
npm run inv -- backup
```

2. Import or map marketplace SKUs.

```powershell
npm run inv -- shopify-import --location "Main" --dry-run
npm run inv -- shopify-import --location "Main"
```

3. Import batch spreadsheet changes with a dry run first.

```powershell
npm run inv -- csv-import inventory-batch.csv --dry-run
npm run inv -- csv-import inventory-batch.csv
```

4. Reconcile before any push.

```powershell
npm run inv -- reconcile shopify
npm run inv -- sync --dry-run --platform shopify
```

5. Push only after the review looks correct.

```powershell
npm run inv -- sync
```

6. Keep automated sync running only after credentials and mappings are trusted.

```powershell
npm run inv -- schedule on 30
npm start
```

## Execution Roadmap

This is the sequence to follow when you tell Codex to continue without further planning. Complete one phase at a time, run the verification listed for that phase, and avoid broad refactors outside the phase.

### Phase 1: Documentation Alignment

Goal: make the repository tell one consistent story.

- Update `PLAN.md` so PostgreSQL is the official growth database and SQLite is historical only.
- Update `UI_STYLE_GUIDE.md` with the professional redesign direction and component rules.
- Keep `README.md` focused on operator setup, command reference, production deployment, and links to the planning docs.
- Remove or archive claims that `migrate-sqlite`, `sqlite-status`, or `STORE_DRIVER=sqlite` are current supported commands unless those commands are intentionally restored later.

Acceptance:

- `PLAN.md`, `README.md`, and `UI_STYLE_GUIDE.md` no longer disagree about the database direction.
- The next implementation phase can be followed from this file without guessing.

### Phase 2: Professional UI Rework

Goal: preserve the working workflows while making the local ERP feel like a professional operations product.

Design direction:

- Calm operational UI, not neon dashboard.
- Dense but readable work surfaces.
- Neutral base colors with restrained accents for status, focus, and primary actions.
- Clear hierarchy through spacing, typography, and alignment instead of glow or heavy gradients.
- Consistent button states, panel headers, tables, modals, notices, and stock indicators across all pages.

Implementation sequence:

1. Create design tokens in CSS for color, typography, borders, elevation, spacing, and status tones.
2. Rework the global shell/topbar: smaller title treatment, quieter background, stable settings/notification placement, and cleaner mobile layout.
3. Extract shared UI components or local component helpers for panel frames, panel headers, metrics, stock meters, notices, modals, empty states, and toolbar buttons.
4. Rework Inventory using the shared pieces.
5. Rework Printing using the shared pieces while preserving product label, instruction document, instruction inventory, and print activity workflows.
6. Rework Item Management, including visible headers for the SKU Print Setup columns.
7. Rework eBay Reviews so scan/export actions are explicit and the review table is easier to scan.
8. Add accessible focus states, dialog close behavior, keyboard navigation checks, and clear disabled states.
9. Add Playwright screenshots or smoke tests for desktop and mobile.

Acceptance:

- `npm run build` passes.
- Affected behavior tests pass.
- Inventory, Printing, Item Management, and eBay Reviews are visually consistent.
- Desktop and mobile screenshots show no overlapping text, broken buttons, or unclear disabled states.
- The app still opens directly to the working tool, not a landing page.

### Phase 3: Postgres Store Hardening

Goal: move from JSON-compatible document replacement toward durable relational storage without breaking current workflows.

Current bridge:

- `InventoryStoreDriver` supports `read`, `mutate`, and `withLock`.
- `PostgresInventoryStore` exists and uses advisory locks.
- `migrate-postgres` copies JSON inventory into Postgres and writes a JSON backup first.
- The current Postgres driver still replaces document-shaped data by deleting and reinserting core rows during mutation.

Implementation sequence:

1. Keep the existing store contract while adding focused Postgres tests.
2. Run the optional Postgres contract test with `TEST_POSTGRES_DATABASE_URL`.
3. Add targeted SQL methods behind the service layer for item create/update, inventory adjustment, mapping update, sync run insert, schedule update, and event insert.
4. Stop deleting/reinserting all core tables for routine mutations.
5. Keep JSON export as a portable backup format.
6. Confirm `STORE_DRIVER=json` and `STORE_DRIVER=postgres` both work during the transition.

Acceptance:

- `npm run build` passes.
- `npm test` passes.
- `npm run test:postgres` passes when `TEST_POSTGRES_DATABASE_URL` is set.
- `list`, `create`, `add`, `subtract`, `map`, `shopify-import`, `csv-import`, `reconcile`, `sync`, `backup`, and `export` work with `STORE_DRIVER=postgres`.

### Phase 4: Operational Data Consolidation

Goal: make backup, reporting, and recovery cover the whole business workflow, not just item inventory.

Move or formalize these data sets:

- Instruction inventory and print events from `data/printing.json`.
- Print defaults and printer choices.
- SKU-to-instruction matches.
- Print asset metadata for files under `data/printing/`.
- eBay Reviews scan history from `data/feedback.sqlite`.
- CSV and Shopify import batch history.
- Reconcile review snapshots.

Suggested Postgres tables:

- `print_instructions`
- `print_instruction_events`
- `sku_instruction_matches`
- `print_settings`
- `print_assets`
- `import_batches`
- `import_batch_rows`
- `reconcile_runs`
- `reconcile_rows`
- `feedback_scan_runs`
- `feedback_rows`

Acceptance:

- One backup/export workflow covers inventory, instruction inventory, print metadata, and feedback scan history.
- Marketplace sales and instruction consumption are transactionally safe enough for the current business scale.
- Local file assets remain on disk, but their metadata is tracked in the database.

### Phase 5: Reporting And Review Workflows

Goal: turn operational history into useful review screens and safer decision points.

Build after the data model is stable:

- Import history view.
- Reconcile history view.
- Sync history view.
- Inventory movement by SKU.
- Instruction usage and low-stock trend.
- Marketplace mapping health view.
- eBay review export history.

Acceptance:

- Users can answer "what changed, when, why, and from where" without opening raw JSON or database files.

### Phase 6: Production Readiness

Goal: make the Cloud Run and Shopify deployment path repeatable.

- Verify `ERP_API_TOKEN` is required in production.
- Use Secret Manager for database passwords, marketplace tokens, Shopify secrets, and API tokens.
- Confirm Cloud SQL connection strings.
- Add backup/restore documentation for Postgres plus local file assets.
- Confirm deploy helper scripts still match README instructions.
- Add a smoke-test checklist after deployment.

Acceptance:

- Production setup can be repeated from README without hidden local assumptions.
- A restore can be rehearsed from backup files and database dump.

## Historical SQLite Notes (Not Current Direction)

The following SQLite notes are preserved as context from an earlier local-storage plan. They are not the current implementation direction. Current growth work should target PostgreSQL, as described in the execution roadmap above and in `README.md`.

Move from one JSON document to a small SQLite database:

```text
data/inventory.sqlite
```

Why SQLite:

- Local single-file database, easy to back up.
- Safer concurrent reads/writes than a JSON document.
- Real audit tables for batches, imports, events, and sync runs.
- Easier reports later: sales by SKU, import history, marketplace differences, and adjustments by date.
- Keeps the app local and simple.

Old assumption: the current JSON store could stay as a fallback/export format while SQLite became the source of truth. This is no longer the active direction.

## Proposed SQLite Schema

Initial schema:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE inventory_items (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  safety_stock INTEGER NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE platform_mappings (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('etsy', 'ebay', 'shopify')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  remote_sku TEXT,
  listing_id TEXT,
  inventory_item_id TEXT,
  location_id TEXT,
  offer_id TEXT,
  last_synced_quantity INTEGER,
  last_remote_quantity INTEGER,
  last_synced_at TEXT,
  warning TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (item_id, platform)
);

CREATE TABLE inventory_events (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  type TEXT NOT NULL CHECK (
    type IN (
      'create',
      'batch_add',
      'manual_subtract',
      'platform_sale',
      'sync_baseline',
      'sync_push',
      'correction'
    )
  ),
  delta INTEGER NOT NULL,
  quantity_after INTEGER NOT NULL CHECK (quantity_after >= 0),
  source TEXT NOT NULL CHECK (source IN ('local', 'sync', 'etsy', 'ebay', 'shopify')),
  platform TEXT CHECK (platform IN ('etsy', 'ebay', 'shopify')),
  note TEXT,
  batch_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('csv', 'shopify', 'manual')),
  file_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('dry_run', 'applied', 'failed')),
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_created INTEGER NOT NULL DEFAULT 0,
  rows_updated INTEGER NOT NULL DEFAULT 0,
  rows_adjusted INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE import_batch_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  line_number INTEGER,
  sku TEXT,
  action TEXT NOT NULL,
  previous_quantity INTEGER,
  next_quantity INTEGER,
  message TEXT NOT NULL,
  raw_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'scheduled', 'cli')),
  status TEXT NOT NULL CHECK (
    status IN ('running', 'completed', 'completed_with_warnings', 'failed')
  ),
  items_checked INTEGER NOT NULL DEFAULT 0,
  sales_detected INTEGER NOT NULL DEFAULT 0,
  pushes INTEGER NOT NULL DEFAULT 0,
  warnings INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE sync_run_messages (
  id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE schedule_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (interval_minutes BETWEEN 5 AND 1440),
  last_run_at TEXT,
  next_run_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO schedule_settings (id, enabled, interval_minutes, updated_at)
VALUES (1, 0, 60, datetime('now'))
ON CONFLICT(id) DO NOTHING;

CREATE INDEX idx_inventory_events_item_created
  ON inventory_events(item_id, created_at DESC);

CREATE INDEX idx_inventory_events_batch
  ON inventory_events(batch_id);

CREATE INDEX idx_platform_mappings_platform_enabled
  ON platform_mappings(platform, enabled);

CREATE INDEX idx_import_batch_rows_batch
  ON import_batch_rows(batch_id);

CREATE INDEX idx_sync_runs_started
  ON sync_runs(started_at DESC);
```

Optional later tables:

- `reconcile_runs`: store dry-run snapshots for review history.
- `reconcile_rows`: store each local vs remote comparison.
- `oauth_tokens`: only if token storage is wanted in SQLite. Keep file-based token storage unless we also add encryption.
- `app_settings`: generic key/value settings after schedule grows beyond one row.

## Historical SQLite Implementation Plan

### Step 1: Add SQLite storage alongside JSON

Create:

```text
src/server/sqliteStore.ts
src/server/migrations/001_initial.sql
src/server/migrateJsonToSqlite.ts
```

Add env:

```text
DATABASE_FILE=data/inventory.sqlite
STORE_DRIVER=json
```

Initial behavior:

- `STORE_DRIVER=json` keeps current behavior. This is currently implemented.
- `DATABASE_FILE=data/inventory.sqlite` points at the SQLite database file. This is currently implemented.
- `migrate-sqlite --dry-run`, `migrate-sqlite`, and `sqlite-status` are currently implemented.
- `STORE_DRIVER=sqlite` is the next implementation step. The schema and migration exist, but runtime reads/writes still use JSON.

### Step 2: Create a store interface

The current `InventoryStore` exposes:

- `read()`
- `mutate()`
- `withLock()`

Create an interface both JSON and SQLite stores can satisfy. Keep service code mostly unchanged at first.

Target:

```ts
export interface InventoryDataStore {
  read(): Promise<StoreData>;
  mutate<T>(mutator: (data: StoreData) => T | Promise<T>): Promise<T>;
  withLock<T>(callback: () => Promise<T>): Promise<T>;
}
```

This is the fastest low-risk bridge. A later pass can move services from document-style mutation to direct SQL queries.

### Step 3: Build JSON to SQLite migration

Migration command:

```powershell
npm run inv -- migrate-sqlite --dry-run
npm run inv -- migrate-sqlite
```

Migration behavior:

1. Read `data/inventory.json`.
2. Create `data/inventory.sqlite` if missing.
3. Insert `items`.
4. Insert `platform_mappings`.
5. Insert `inventory_events`.
6. Insert `sync_runs` and `sync_run_messages`.
7. Insert `schedule_settings`.
8. Verify row counts.
9. Write a fresh JSON backup before switching drivers.

### Step 4: Move batch/import history to SQL rows

Once SQLite is active, update:

- `csv-import` to create `import_batches` and `import_batch_rows`.
- `shopify-import` to create `import_batches` and `import_batch_rows`.
- Inventory quantity changes to continue creating `inventory_events`.

Expected benefit:

- You can see one import as a batch.
- You can see every row outcome in that batch.
- You can tie actual quantity changes to the batch that caused them.

### Step 5: Move reconcile history to SQL

Current reconcile is preview-only. Later, add:

```text
reconcile_runs
reconcile_rows
```

That allows saving a review snapshot before pushing live inventory.

Commands:

```powershell
npm run inv -- reconcile shopify --save
npm run inv -- reconcile-show <run-id>
```

### Step 6: Update backup/export

After SQLite:

- `backup` copies both `data/inventory.sqlite` and a JSON export.
- `export` still produces JSON for portability.
- Add optional CSV exports later.

Commands:

```powershell
npm run inv -- backup
npm run inv -- export data/export.json
npm run inv -- export-csv data/items.csv
```

### Step 7: Cut over default storage

After migration is tested:

```text
STORE_DRIVER=sqlite
```

Then later, once stable, make SQLite the default and keep JSON as an import/export format.

## Historical SQLite Acceptance Checklist

Before calling the SQL migration complete:

- `npm run build` passes.
- `npm test` passes.
- JSON store tests still pass when `STORE_DRIVER=json`.
- SQLite tests pass when `STORE_DRIVER=sqlite`.
- `migrate-sqlite --dry-run` shows row counts and makes no changes.
- `migrate-sqlite` creates a database from existing JSON.
- `list`, `create`, `add`, `subtract`, `map`, `shopify-import`, `csv-import`, `reconcile`, `sync`, `backup`, and `export` work on SQLite.
- A backup is created before any migration writes.
- No marketplace tokens are committed or printed.

## Historical SQLite Work Order

Do not use this as the current work order. The current sequence is the `Execution Roadmap` above.

Former SQLite sequence:

1. Finish the SQLite/Postgres storage decision and keep JSON as the local fallback/export format.
2. Switch runtime services fully onto the chosen store interface.
3. Add import batch tables to CSV and Shopify import flows.
4. Add reconcile history only after the database cutover is stable.
5. Add focused UI regression checks for Printing, Inventory, and eBay Reviews workflows.
6. Keep `README.md` and `UI_STYLE_GUIDE.md` updated as workflow rules change.
