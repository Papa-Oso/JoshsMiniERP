# Josh's Mini ERP Plan

This document captures the requested inventory work, what is already implemented, how to use it safely, and the authoritative work sequence for professional UI polish and database sustainability.

## Authoritative Direction

- Keep the working app stable. Inventory, printing, sync, and CSV workflows are already useful and should not be rewritten casually.
- Keep this cheap and local by default. This is a personal store app, so avoid adding infrastructure unless it clearly pays for itself.
- Treat SQLite as the real day-to-day local database path. It is SQL, file-backed, cheap, and requires no server, Docker, or cloud service.
- Keep JSON as a portable backup/export/migration format, not the long-term working database.
- Keep PostgreSQL as an optional later deployment path only if the app moves beyond local single-user use.
- Do not install, start, or depend on Docker, local database services, cloud services, or extra background daemons unless Josh explicitly asks for that in the current task.
- Rework the local Vite UI as a professional operations tool: calm, compact, durable, and designer-grade.
- Keep the embedded Shopify app on Shopify's native Admin components. It should share product language and API contracts with the local ERP, not the local ERP's visual theme.

## Current Storage

The app now has a local SQLite inventory store and JSON fallback/export support.

Preferred local SQL file:

```text
data/inventory.sqlite
```

JSON fallback/export file:

```text
data/inventory.json
```

The SQLite inventory database stores:

- `items`: local SKUs, names, quantities, safety stock, and platform mappings.
- `events`: creates, batch adds, manual subtracts, corrections, platform-sale deductions, sync baselines, and sync pushes.
- `schedule`: local scheduler settings.
- `syncRuns`: recent sync run summaries and messages.
- `print_instructions`, `print_instruction_events`, `sku_instruction_matches`, and `print_settings`: instruction inventory, print activity, SKU instruction rules, and printer choices.
- `print_assets`: metadata for label and instruction document files that still live on disk.
- `import_batches` and `import_batch_rows`: applied CSV and Shopify import history.
- `reconcile_runs` and `reconcile_rows`: saved dry-run/reconcile snapshots for later review.

SQLite is the default real local database driver. Use `DATABASE_FILE=data/inventory.sqlite` for the database file. `migrate-sqlite` copies existing JSON inventory into SQLite and writes a JSON backup first. PostgreSQL remains available only as an optional deployment/growth path.

Related local file data currently lives outside the main inventory store:

- `data/printing.json`: legacy printing data source used to seed SQLite the first time SQLite printing storage is opened, and copied by backup when present.
- `data/printing/`: label and instruction document assets. The files stay on disk while SQLite tracks metadata.
- `data/feedback.sqlite`: eBay Reviews incremental scan history and scan-run summaries. Override with `FEEDBACK_DATA_FILE` when needed.
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
| Backup/export | Done | `backup` writes an operational manifest with inventory JSON, SQLite database copy, printing data/assets, and feedback scan history when present. `export` still writes portable inventory JSON. |
| eBay setup | Done | OAuth URL, callback, refresh, lookup, test, and mapping helpers are in place. |
| Scheduler polish | Done | Windows startup script preview/install and Task Scheduler command preview/install are in place. |
| SQLite storage | Done | SQLite is the default local driver. `DATABASE_FILE`, `migrate-sqlite`, and SQLite store contract tests are in place. This is the preferred real local database path. |
| Postgres storage | Optional | `STORE_DRIVER=postgres`, `migrate-postgres`, and optional Postgres tests exist for future hosted/deployment use only. |
| SKU pairing audit | Done | `sku-audit` compares local SKUs with Shopify and eBay SKU catalogs. |
| Shopify names/descriptions | Done | App data model, refresh command, docs, and tests are in place. Live population still requires Shopify `read_products` scope approval and a fresh token. |
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
npm run inv -- export-csv data/items.csv
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

Progress:

| Phase | Status | Notes |
| --- | --- | --- |
| Phase 1: Documentation Alignment | Complete | Roadmap, README, and UI guide now agree that SQLite is the real local database path and Postgres is optional later. |
| Phase 2: Professional UI Rework | Complete | Design tokens, shared UI helpers, calmer page visuals, graphite/teal color pass, accessibility basics, and persistent UI smoke screenshots are in place. `npm run build`, `npm test`, and `npm run smoke:ui` pass. |
| Phase 3: Local SQL Store Hardening | Complete | SQLite is the default local SQL database; migration, contract tests, and end-to-end workflow coverage pass. Postgres remains optional for future deployment. |
| Phase 4: Operational Data Consolidation | Complete | Operational backups, import batch history, printing workflows, feedback scan history, and reconcile snapshots are now SQL-backed. |
| Phase 5: Reporting And Review Workflows | Complete | Review Center now surfaces import, reconcile, sync, movement, instruction trends, mapping, and feedback history. |
| Phase 6: Production Readiness | Complete | Production startup, Secret Manager-backed deploys, Cloud SQL docs, restore rehearsal, helper script, and smoke checklist are aligned. |
| Phase 7: Data Portability And Analysis | In progress | Starting with spreadsheet-friendly CSV export for inventory and marketplace mappings. |

Phase 2 progress:

| Step | Status | Notes |
| --- | --- | --- |
| Design tokens | Complete | Added a neutral operational token layer in `src/client/styles.css`. |
| Color palette pass | Complete | Retuned the local ERP from blue/neon accents to graphite surfaces, teal UI accents, green success, amber warning, and red danger. |
| Shell/topbar visual pass | Complete | Reduced glow/ornament, softened background, and improved mobile settings/notification placement. |
| Shared component/helpers | Complete | `src/client/ui.tsx` centralizes panel, header, metric, and mini-stat helpers used across the local ERP. |
| Inventory visual pass | Complete | Inventory uses the calmer foundation and passed desktop/mobile screenshot review. |
| Printing visual pass | Complete | Printing uses the calmer foundation and passed desktop screenshot review. |
| Item Management visual pass | Complete | Added visible SKU Print Setup column labels and passed desktop screenshot review. |
| eBay Reviews visual pass | Complete | Clarified scan/export actions and passed desktop screenshot review. |
| Accessibility pass | Complete | Focus-visible styling is in place, disabled states are clearer, and Escape closes open topbar dialogs/drawers. |
| Playwright smoke checks | Complete | `npm run smoke:ui` captures desktop screenshots for Inventory, Item Management, Printing, eBay Reviews, plus mobile Inventory. |

Phase 3 progress:

| Step | Status | Notes |
| --- | --- | --- |
| Store contract review | Complete | Shared store contract now covers nested locking, mapping removal, event pruning, sync-run pruning, and schedule updates. |
| SQLite runtime store | Complete | `SQLiteInventoryStore` persists items, mappings, events, sync runs, messages, and schedule settings in `data/inventory.sqlite` with no extra service. SQLite is now the default driver. |
| SQLite migration | Complete | `npm run inv -- migrate-sqlite` copies JSON inventory into SQLite and writes a JSON backup first. |
| SQLite verification | Complete | SQLite store contract and migration tests pass in the normal `npm test` suite. |
| SQLite workflow verification | Complete | Added coverage for create, add, subtract, map baseline behavior, CSV import, Shopify import, reconcile, sync, backup, and export on a temp SQLite database. |
| Focused Postgres tests | Complete | Added an optional row-delete audit test that proves routine item updates do not delete the item row when a test database is available. |
| Row-preserving Postgres writes | Complete | `PostgresInventoryStore` now upserts items, mappings, events, sync runs, and schedule settings, deleting only rows missing from the current bounded store view. |
| Live Postgres verification | Optional | `npm run test:postgres` was run locally and skipped both tests because `TEST_POSTGRES_DATABASE_URL` is not set. Do not install or start Docker just for this personal app; rerun only if Josh provides an existing test database URL or explicitly asks for hosted/deployment setup. |
| Core inventory service SQL hooks | Complete | Item create/update/disable, mapping updates, inventory adjustments with events, and schedule updates use direct Postgres hooks when available, with JSON fallback unchanged. |
| Sync/import targeted mutation hooks | Complete | CSV import, Shopify import, Shopify detail refresh, sync sale/baseline application, failed-run logging, and final sync-run persistence use the Postgres `mutateChanges` path when available, with JSON fallback unchanged. |

Phase 4 progress:

| Step | Status | Notes |
| --- | --- | --- |
| Operational backup manifest | Complete | `backup` now creates a manifest and captures inventory JSON, the SQLite database file, printing JSON, printing assets, and feedback SQLite history when those sources exist. |
| Printing state SQL consolidation | Complete | Instruction inventory, print settings, print events, and SKU instruction matches now use SQLite tables through the existing store lock, with legacy JSON seeding on first use. |
| Print asset metadata consolidation | Complete | Asset scans and uploads now upsert label/instruction document metadata into SQLite while keeping the actual files under `data/printing/`. |
| Feedback scan history consolidation | Complete | eBay review history remains in a cheap local SQLite file, now honors `FEEDBACK_DATA_FILE`, records scan-run summaries, and is covered by operational backup. |
| Import batch history | Complete | CSV and Shopify applied imports now write `import_batches` and `import_batch_rows` records in SQLite, including row actions and summaries. |
| Reconcile snapshot history | Complete | Reconcile/dry-run results now write saved run and row snapshots in SQLite for later review/reporting. |

Phase 5 progress:

| Step | Status | Notes |
| --- | --- | --- |
| Review Center foundation | Complete | Added `/api/reports/operations` and a local Review tool that surfaces import history, reconcile snapshots, sync runs, inventory movement, instruction movement, mapping health, and feedback scan runs. |
| Import history view | Complete | The Review tool shows recent CSV and Shopify import batches with row outcome totals. |
| Reconcile history view | Complete | The Review tool shows saved reconcile snapshots with sales, pushes, warnings, errors, and first row message. |
| Sync history view | Complete | The Review tool shows recent sync runs with mode, status, sales, pushes, and issue counts. |
| Inventory movement by SKU | Complete | The Review tool shows recent inventory events by SKU, delta, source, and note. |
| Instruction usage trend | Complete | The Review tool shows current instruction stock, low/max thresholds, recent movement delta, and low/over-max status. |
| Marketplace mapping health view | Complete | The Review tool lists enabled marketplace mappings, missing config, missing mapping fields, and mapping warnings. |
| eBay review export history | Complete | The Review tool shows feedback scan-run history from the local feedback SQLite database. |

Phase 6 progress:

| Step | Status | Notes |
| --- | --- | --- |
| Production API token requirement | Complete | Server startup fails when `NODE_ENV=production` and `ERP_API_TOKEN` is missing. Local development remains no-token by default. |
| Secret Manager integration | Complete | Helper script stores database URLs, marketplace tokens, Shopify secrets, and `ERP_API_TOKEN` in Secret Manager and exposes them to Cloud Run as secret-backed environment variables. |
| Cloud SQL connection strings | Complete | README and helper script use the same Cloud SQL socket-style Postgres URLs for ERP and Shopify session databases. |
| Backup/restore documentation | Complete | README now includes a restore rehearsal path for ERP data, print assets, feedback history, and reconcile-before-sync review. |
| Deploy helper verification | Complete | Helper script and README now both set `NODE_ENV=production` for the ERP API and share the same service/database assumptions. |
| Post-deploy smoke checklist | Complete | README now includes authenticated health, unauthenticated rejection, Shopify app load, dashboard sanity, and reconcile-before-sync checks. |

Phase 7 progress:

| Step | Status | Notes |
| --- | --- | --- |
| Inventory CSV export | Complete | `export-csv` writes one spreadsheet-friendly row per SKU with inventory fields and marketplace mapping columns. |
| Event CSV export | Pending | Add exportable inventory movement/event rows for deeper analysis. |
| Review report export | Pending | Add CSV export for Review Center report tables after item/event exports are stable. |

### Phase 1: Documentation Alignment

Goal: make the repository tell one consistent story.

- Update `PLAN.md` so SQLite is the official local SQL database and PostgreSQL is optional for later deployment.
- Update `UI_STYLE_GUIDE.md` with the professional redesign direction and component rules.
- Keep `README.md` focused on operator setup, command reference, production deployment, and links to the planning docs.
- Keep unsupported commands out of docs. `migrate-sqlite` and `STORE_DRIVER=sqlite` are current; `sqlite-status` is not implemented.

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

### Phase 3: Local SQL Store Hardening

Goal: move from JSON-compatible document storage toward a durable local SQL database without breaking current workflows or adding a background service.

Current bridge:

- `InventoryStoreDriver` supports `read`, `mutate`, and `withLock`.
- `SQLiteInventoryStore` exists and writes a real SQLite database at `data/inventory.sqlite`.
- `migrate-sqlite` copies JSON inventory into SQLite and writes a JSON backup first.
- `PostgresInventoryStore` still exists as an optional hosted/deployment path, but it is not required for normal personal use.

Implementation sequence:

1. Keep the existing store contract while adding focused SQLite tests.
2. Add `STORE_DRIVER=sqlite` and `DATABASE_FILE=data/inventory.sqlite`.
3. Add `migrate-sqlite --dry-run` and `migrate-sqlite`.
4. Confirm `list`, item edits, inventory adjustments, imports, sync, backup, and export work with SQLite.
5. Keep JSON export as a portable backup format.
6. Keep Postgres support optional for later hosted deployment.

Acceptance:

- `npm run build` passes.
- `npm test` passes.
- SQLite store contract and migration tests pass in the normal test suite.
- `list`, `create`, `add`, `subtract`, `map`, `shopify-import`, `csv-import`, `reconcile`, `sync`, `backup`, and `export` work with `STORE_DRIVER=sqlite`.

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

Suggested SQLite tables:

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

## SQLite Local Database Notes

The following SQLite notes are now the active local database direction for personal-store use.

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

JSON stays as a fallback/export format while SQLite becomes the real local source of truth.

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
  source TEXT NOT NULL CHECK (source IN ('csv', 'shopify')),
  file_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('dry_run', 'applied', 'failed')),
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_created INTEGER NOT NULL DEFAULT 0,
  rows_updated INTEGER NOT NULL DEFAULT 0,
  rows_adjusted INTEGER NOT NULL DEFAULT 0,
  rows_mapped INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  variants_scanned INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE import_batch_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
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
  ON import_batch_rows(batch_id, position);

CREATE INDEX idx_sync_runs_started
  ON sync_runs(started_at DESC);
```

Implemented now:

- `import_batches` stores applied CSV and Shopify import summaries.
- `import_batch_rows` stores row-level actions, messages, quantities, and raw row context.
- Dry-runs still preview without changing inventory; applied imports create durable history for future reporting screens.

Optional later tables:

- `reconcile_runs`: store dry-run snapshots for review history.
- `reconcile_rows`: store each local vs remote comparison.
- `oauth_tokens`: only if token storage is wanted in SQLite. Keep file-based token storage unless we also add encryption.
- `app_settings`: generic key/value settings after schedule grows beyond one row.

## SQLite Implementation Plan

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
STORE_DRIVER=sqlite
```

Initial behavior:

- `STORE_DRIVER=sqlite` runs the local ERP against `data/inventory.sqlite`. This is currently implemented.
- `DATABASE_FILE=data/inventory.sqlite` points at the SQLite database file. This is currently implemented.
- `migrate-sqlite --dry-run` and `migrate-sqlite` are currently implemented.
- `STORE_DRIVER=json` remains available as a fallback/export bridge.

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

- `backup` copies `data/inventory.sqlite`, a portable JSON inventory export, printing data/assets, and feedback scan history into one manifest-backed operational backup.
- `export` still produces JSON for portability.
- `export-csv` writes spreadsheet-friendly item and marketplace mapping rows for analysis.

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

## SQLite Acceptance Checklist

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

## SQLite Work Order

Current SQLite sequence:

1. Finish the SQLite/Postgres storage decision and keep JSON as the local fallback/export format.
2. Switch runtime services fully onto the chosen store interface.
3. Add import batch tables to CSV and Shopify import flows.
4. Add reconcile history only after the database cutover is stable.
5. Add focused UI regression checks for Printing, Inventory, and eBay Reviews workflows.
6. Keep `README.md` and `UI_STYLE_GUIDE.md` updated as workflow rules change.
