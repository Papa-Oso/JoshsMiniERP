import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic, SqlValue } from "sql.js";
import type {
  ImportBatchRecord,
  ImportBatchRow,
  InventoryEvent,
  InventoryItem,
  Platform,
  PlatformMapping,
  ScheduleSettings,
  StoreData,
  SyncRun
} from "../shared/types";
import { defaultMaxInventory, platforms } from "../shared/types";
import { config } from "./config";
import type { InventoryStoreDriver } from "./store";

interface SqliteContext {
  db: Database;
  dirty: boolean;
}

const now = () => new Date().toISOString();
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let SQL: SqlJsStatic | undefined;

export class SQLiteInventoryStore implements InventoryStoreDriver {
  private readonly lockContext = new AsyncLocalStorage<SqliteContext>();
  private queue = Promise.resolve();

  constructor(private readonly databaseFile = config.databaseFile) {}

  async read(): Promise<StoreData> {
    const active = this.lockContext.getStore();
    if (active) {
      return this.readWithDatabase(active.db);
    }

    return this.withLock(async () => {
      const context = this.requireContext();
      return this.readWithDatabase(context.db);
    });
  }

  async mutate<T>(mutator: (data: StoreData) => T | Promise<T>): Promise<T> {
    return this.withLock(async () => {
      const context = this.requireContext();
      const data = this.readWithDatabase(context.db);
      const result = await mutator(data);
      this.replaceData(context.db, data);
      context.dirty = true;
      return result;
    });
  }

  async mutateChanges<T>(mutator: (data: StoreData) => T | Promise<T>): Promise<T> {
    return this.mutate(mutator);
  }

  async withLock<T>(callback: () => Promise<T>): Promise<T> {
    if (this.lockContext.getStore()) {
      return callback();
    }

    const run = async () => {
      const db = await this.openDatabase();
      const context: SqliteContext = { db, dirty: false };

      return this.lockContext.run(context, async () => {
        try {
          return await callback();
        } finally {
          if (context.dirty) {
            await this.saveDatabase(db);
          }
          db.close();
        }
      });
    };

    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async saveItem(item: InventoryItem) {
    await this.withLock(async () => {
      const context = this.requireContext();
      this.upsertItem(context.db, item);
      this.syncMappings(context.db, item);
      context.dirty = true;
    });
  }

  async saveItemWithEvent(item: InventoryItem, event: InventoryEvent) {
    await this.withLock(async () => {
      const context = this.requireContext();
      this.upsertItem(context.db, item);
      this.syncMappings(context.db, item);
      this.upsertInventoryEvent(context.db, event);
      this.pruneInventoryEvents(context.db, 500);
      context.dirty = true;
    });
  }

  async saveSchedule(schedule: ScheduleSettings) {
    await this.withLock(async () => {
      const context = this.requireContext();
      this.upsertSchedule(context.db, schedule);
      context.dirty = true;
    });
  }

  async recordImportBatch(batch: ImportBatchRecord) {
    await this.withLock(async () => {
      const context = this.requireContext();
      this.upsertImportBatch(context.db, batch);
      this.pruneImportBatches(context.db, 200);
      context.dirty = true;
    });
  }

  async listImportBatches(limit = 50): Promise<ImportBatchRecord[]> {
    return this.withLock(async () => {
      const context = this.requireContext();
      return this.readImportBatches(context.db, limit);
    });
  }

  private async openDatabase() {
    SQL ??= await initSqlJs({
      locateFile: (file) => path.join(rootDir, "node_modules", "sql.js", "dist", file)
    });

    await fs.mkdir(path.dirname(this.databaseFile), { recursive: true });

    let db: Database;
    try {
      db = new SQL.Database(await fs.readFile(this.databaseFile));
    } catch {
      db = new SQL.Database();
    }

    this.createSchema(db);
    return db;
  }

  private async saveDatabase(db: Database) {
    const tempPath = `${this.databaseFile}.tmp`;
    await fs.mkdir(path.dirname(this.databaseFile), { recursive: true });
    await fs.writeFile(tempPath, Buffer.from(db.export()));
    await fs.rename(tempPath, this.databaseFile);
  }

  private createSchema(db: Database) {
    db.run(sqliteSchema);
    ensureColumn(db, "inventory_items", "description", "TEXT");
    ensureColumn(db, "inventory_items", "max_inventory", "INTEGER NOT NULL DEFAULT 100");
    ensureColumn(db, "inventory_items", "active", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "platform_mappings", "last_remote_quantity", "INTEGER");
    ensureColumn(db, "platform_mappings", "warning", "TEXT");
    ensureColumn(db, "sync_run_messages", "position", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "sync_run_messages", "created_at", "TEXT NOT NULL DEFAULT ''");
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_sync_run_messages_run_position
        ON sync_run_messages(sync_run_id, position)
    `);
    db.run(
      `
        INSERT INTO schedule_settings (id, enabled, interval_minutes, updated_at)
        VALUES (1, 0, 60, ?)
        ON CONFLICT(id) DO NOTHING
      `,
      [now()]
    );
  }

  private readWithDatabase(db: Database): StoreData {
    const itemRows = queryRows(db, `
      SELECT id, sku, name, description, quantity, safety_stock, max_inventory, active, created_at, updated_at
      FROM inventory_items
      ORDER BY created_at DESC, sku ASC
    `);

    const mappingRows = queryRows(db, `
      SELECT item_id, platform, enabled, remote_sku, listing_id, inventory_item_id,
        location_id, offer_id, last_synced_quantity, last_remote_quantity,
        last_synced_at, warning
      FROM platform_mappings
      ORDER BY created_at ASC
    `);

    const eventRows = queryRows(db, `
      SELECT id, item_id, sku, type, delta, quantity_after, source, platform, note, created_at
      FROM inventory_events
      ORDER BY created_at DESC
      LIMIT 500
    `);

    const runRows = queryRows(db, `
      SELECT id, mode, status, items_checked, sales_detected, pushes, warnings, errors,
        started_at, finished_at
      FROM sync_runs
      ORDER BY started_at DESC
      LIMIT 100
    `);

    const messageRows = queryRows(db, `
      SELECT sync_run_id, message
      FROM sync_run_messages
      ORDER BY sync_run_id ASC, position ASC, created_at ASC
    `);

    const scheduleRow = queryRows(db, `
      SELECT enabled, interval_minutes, last_run_at, next_run_at, updated_at
      FROM schedule_settings
      WHERE id = 1
    `)[0];

    const itemsById = new Map<string, InventoryItem>();
    const items = itemRows.map((row) => {
      const item: InventoryItem = {
        id: stringValue(row.id),
        sku: stringValue(row.sku),
        name: stringValue(row.name),
        description: optionalString(row.description),
        quantity: integer(row.quantity),
        safetyStock: integer(row.safety_stock),
        maxInventory: storedMaxInventory(row.max_inventory),
        active: booleanValue(row.active),
        mappings: {},
        createdAt: isoString(row.created_at),
        updatedAt: isoString(row.updated_at)
      };
      itemsById.set(item.id, item);
      return item;
    });

    for (const row of mappingRows) {
      const item = itemsById.get(stringValue(row.item_id));
      if (!item) continue;
      const platform = stringValue(row.platform) as Platform;
      item.mappings[platform] = rowToMapping(row);
    }

    const messagesByRunId = new Map<string, string[]>();
    for (const row of messageRows) {
      const runId = stringValue(row.sync_run_id);
      const messages = messagesByRunId.get(runId) ?? [];
      messages.push(stringValue(row.message));
      messagesByRunId.set(runId, messages);
    }

    return {
      items,
      events: eventRows.map(rowToEvent),
      schedule: scheduleRow ? rowToSchedule(scheduleRow) : defaultSchedule(),
      syncRuns: runRows.map((row) => rowToSyncRun(row, messagesByRunId.get(stringValue(row.id)) ?? []))
    };
  }

  private replaceData(db: Database, data: StoreData) {
    db.run("DELETE FROM sync_run_messages");
    db.run("DELETE FROM sync_runs");
    db.run("DELETE FROM inventory_events");
    db.run("DELETE FROM platform_mappings");
    db.run("DELETE FROM inventory_items");

    for (const item of data.items) {
      this.upsertItem(db, item);
      this.syncMappings(db, item);
    }

    for (const event of data.events) {
      this.upsertInventoryEvent(db, event);
    }

    for (const run of data.syncRuns) {
      this.upsertSyncRun(db, run);
    }

    this.upsertSchedule(db, data.schedule);
  }

  private upsertItem(db: Database, item: InventoryItem) {
    db.run(
      `
        INSERT INTO inventory_items (
          id, sku, name, description, quantity, safety_stock, max_inventory, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          sku = excluded.sku,
          name = excluded.name,
          description = excluded.description,
          quantity = excluded.quantity,
          safety_stock = excluded.safety_stock,
          max_inventory = excluded.max_inventory,
          active = excluded.active,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
      [
        item.id,
        item.sku,
        item.name,
        item.description ?? null,
        item.quantity,
        item.safetyStock,
        storedMaxInventory(item.maxInventory),
        item.active === false ? 0 : 1,
        item.createdAt,
        item.updatedAt
      ]
    );
  }

  private syncMappings(db: Database, item: InventoryItem) {
    const mappedPlatforms = platforms.filter((platform) => Boolean(item.mappings[platform]));
    const placeholders = mappedPlatforms.map(() => "?").join(", ");

    if (mappedPlatforms.length === 0) {
      db.run("DELETE FROM platform_mappings WHERE item_id = ?", [item.id]);
    } else {
      db.run(
        `DELETE FROM platform_mappings WHERE item_id = ? AND platform NOT IN (${placeholders})`,
        [item.id, ...mappedPlatforms]
      );
    }

    for (const platform of platforms) {
      const mapping = item.mappings[platform];
      if (!mapping) continue;
      this.upsertMapping(db, item, platform, mapping);
    }
  }

  private upsertMapping(db: Database, item: InventoryItem, platform: Platform, mapping: PlatformMapping) {
    db.run(
      `
        INSERT INTO platform_mappings (
          id, item_id, platform, enabled, remote_sku, listing_id, inventory_item_id,
          location_id, offer_id, last_synced_quantity, last_remote_quantity,
          last_synced_at, warning, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id, platform) DO UPDATE SET
          id = excluded.id,
          enabled = excluded.enabled,
          remote_sku = excluded.remote_sku,
          listing_id = excluded.listing_id,
          inventory_item_id = excluded.inventory_item_id,
          location_id = excluded.location_id,
          offer_id = excluded.offer_id,
          last_synced_quantity = excluded.last_synced_quantity,
          last_remote_quantity = excluded.last_remote_quantity,
          last_synced_at = excluded.last_synced_at,
          warning = excluded.warning,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
      [
        `${item.id}:${platform}`,
        item.id,
        platform,
        mapping.enabled ? 1 : 0,
        mapping.remoteSku ?? null,
        mapping.listingId ?? null,
        mapping.inventoryItemId ?? null,
        mapping.locationId ?? null,
        mapping.offerId ?? null,
        mapping.lastSyncedQuantity ?? null,
        mapping.lastRemoteQuantity ?? null,
        mapping.lastSyncedAt ?? null,
        mapping.warning ?? null,
        item.createdAt,
        item.updatedAt
      ]
    );
  }

  private upsertInventoryEvent(db: Database, event: InventoryEvent) {
    db.run(
      `
        INSERT INTO inventory_events (
          id, item_id, sku, type, delta, quantity_after, source, platform, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          item_id = excluded.item_id,
          sku = excluded.sku,
          type = excluded.type,
          delta = excluded.delta,
          quantity_after = excluded.quantity_after,
          source = excluded.source,
          platform = excluded.platform,
          note = excluded.note,
          created_at = excluded.created_at
      `,
      [
        event.id,
        event.itemId,
        event.sku,
        event.type,
        event.delta,
        event.quantityAfter,
        event.source,
        event.platform ?? null,
        event.note ?? null,
        event.createdAt
      ]
    );
  }

  private upsertSyncRun(db: Database, run: SyncRun) {
    db.run(
      `
        INSERT INTO sync_runs (
          id, mode, status, items_checked, sales_detected, pushes, warnings,
          errors, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          mode = excluded.mode,
          status = excluded.status,
          items_checked = excluded.items_checked,
          sales_detected = excluded.sales_detected,
          pushes = excluded.pushes,
          warnings = excluded.warnings,
          errors = excluded.errors,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at
      `,
      [
        run.id,
        run.mode,
        run.status,
        run.summary.itemsChecked,
        run.summary.salesDetected,
        run.summary.pushes,
        run.summary.warnings,
        run.summary.errors,
        run.startedAt,
        run.finishedAt ?? null
      ]
    );

    db.run("DELETE FROM sync_run_messages WHERE sync_run_id = ?", [run.id]);
    for (const [position, message] of run.messages.entries()) {
      db.run(
        `
          INSERT INTO sync_run_messages (
            id, sync_run_id, position, message, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
        [randomUUID(), run.id, position, message, run.finishedAt ?? now()]
      );
    }
  }

  private upsertSchedule(db: Database, schedule: ScheduleSettings) {
    db.run(
      `
        INSERT INTO schedule_settings (
          id, enabled, interval_minutes, last_run_at, next_run_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          enabled = excluded.enabled,
          interval_minutes = excluded.interval_minutes,
          last_run_at = excluded.last_run_at,
          next_run_at = excluded.next_run_at,
          updated_at = excluded.updated_at
      `,
      [
        schedule.enabled ? 1 : 0,
        schedule.intervalMinutes,
        schedule.lastRunAt ?? null,
        schedule.nextRunAt ?? null,
        schedule.updatedAt
      ]
    );
  }

  private upsertImportBatch(db: Database, batch: ImportBatchRecord) {
    db.run(
      `
        INSERT INTO import_batches (
          id, source, file_name, status, rows_total, rows_created, rows_updated,
          rows_adjusted, rows_mapped, rows_skipped, rows_failed, variants_scanned, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source = excluded.source,
          file_name = excluded.file_name,
          status = excluded.status,
          rows_total = excluded.rows_total,
          rows_created = excluded.rows_created,
          rows_updated = excluded.rows_updated,
          rows_adjusted = excluded.rows_adjusted,
          rows_mapped = excluded.rows_mapped,
          rows_skipped = excluded.rows_skipped,
          rows_failed = excluded.rows_failed,
          variants_scanned = excluded.variants_scanned,
          created_at = excluded.created_at
      `,
      [
        batch.id,
        batch.source,
        batch.fileName ?? null,
        batch.status,
        batch.summary.rowsTotal,
        batch.summary.created,
        batch.summary.updated,
        batch.summary.adjusted,
        batch.summary.mapped,
        batch.summary.skipped,
        batch.summary.failed,
        batch.summary.variantsScanned ?? null,
        batch.createdAt
      ]
    );

    db.run("DELETE FROM import_batch_rows WHERE batch_id = ?", [batch.id]);
    for (const [position, row] of batch.rows.entries()) {
      this.insertImportBatchRow(db, batch.id, row, position, batch.createdAt);
    }
  }

  private insertImportBatchRow(db: Database, batchId: string, row: ImportBatchRow, position: number, createdAt: string) {
    db.run(
      `
        INSERT INTO import_batch_rows (
          id, batch_id, position, line_number, sku, action, previous_quantity,
          next_quantity, message, raw_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        row.id,
        batchId,
        position,
        row.lineNumber ?? null,
        row.sku ?? null,
        row.action,
        row.previousQuantity ?? null,
        row.nextQuantity ?? null,
        row.message,
        row.raw === undefined ? null : JSON.stringify(row.raw),
        createdAt
      ]
    );
  }

  private readImportBatches(db: Database, limit: number): ImportBatchRecord[] {
    const batchRows = queryRows(
      db,
      `
        SELECT id, source, file_name, status, rows_total, rows_created, rows_updated,
          rows_adjusted, rows_mapped, rows_skipped, rows_failed, variants_scanned, created_at
        FROM import_batches
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `,
      [Math.max(1, Math.floor(limit))]
    );

    const batchIds = batchRows.map((row) => stringValue(row.id));
    const rowRows =
      batchIds.length === 0
        ? []
        : queryRows(
            db,
            `
              SELECT batch_id, id, line_number, sku, action, previous_quantity, next_quantity,
                message, raw_json
              FROM import_batch_rows
              WHERE batch_id IN (${batchIds.map(() => "?").join(", ")})
              ORDER BY batch_id ASC, position ASC
            `,
            batchIds
          );

    const rowsByBatchId = new Map<string, ImportBatchRow[]>();
    for (const row of rowRows) {
      const batchId = stringValue(row.batch_id);
      const rows = rowsByBatchId.get(batchId) ?? [];
      rows.push(rowToImportBatchRow(row));
      rowsByBatchId.set(batchId, rows);
    }

    return batchRows.map((row) => rowToImportBatch(row, rowsByBatchId.get(stringValue(row.id)) ?? []));
  }

  private pruneInventoryEvents(db: Database, limit: number) {
    db.run(
      `
        DELETE FROM inventory_events
        WHERE id IN (
          SELECT id
          FROM inventory_events
          ORDER BY created_at DESC, id DESC
          LIMIT -1 OFFSET ?
        )
      `,
      [limit]
    );
  }

  private pruneImportBatches(db: Database, limit: number) {
    db.run(
      `
        DELETE FROM import_batches
        WHERE id IN (
          SELECT id
          FROM import_batches
          ORDER BY created_at DESC, id DESC
          LIMIT -1 OFFSET ?
        )
      `,
      [limit]
    );
  }

  private requireContext() {
    const context = this.lockContext.getStore();
    if (!context) throw new Error("SQLite inventory store context was not initialized.");
    return context;
  }
}

function queryRows(db: Database, sql: string, params: SqlValue[] = []) {
  const statement = db.prepare(sql, params);
  const rows: Record<string, SqlValue>[] = [];
  try {
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
  } finally {
    statement.free();
  }
  return rows;
}

function ensureColumn(db: Database, tableName: string, columnName: string, definition: string) {
  const result = db.exec(`PRAGMA table_info(${tableName})`)[0];
  const hasColumn = result?.values.some((row) => row[1] === columnName);
  if (!hasColumn) {
    db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function defaultSchedule(): ScheduleSettings {
  return {
    enabled: false,
    intervalMinutes: 60,
    lastRunAt: null,
    nextRunAt: null,
    updatedAt: now()
  };
}

function rowToMapping(row: Record<string, SqlValue>): PlatformMapping {
  return {
    enabled: booleanValue(row.enabled),
    remoteSku: optionalString(row.remote_sku),
    listingId: optionalString(row.listing_id),
    inventoryItemId: optionalString(row.inventory_item_id),
    locationId: optionalString(row.location_id),
    offerId: optionalString(row.offer_id),
    lastSyncedQuantity: nullableInteger(row.last_synced_quantity),
    lastRemoteQuantity: nullableInteger(row.last_remote_quantity),
    lastSyncedAt: nullableIsoString(row.last_synced_at),
    warning: optionalString(row.warning) ?? null
  };
}

function rowToEvent(row: Record<string, SqlValue>): InventoryEvent {
  return {
    id: stringValue(row.id),
    itemId: stringValue(row.item_id),
    sku: stringValue(row.sku),
    type: stringValue(row.type) as InventoryEvent["type"],
    delta: integer(row.delta),
    quantityAfter: integer(row.quantity_after),
    source: stringValue(row.source) as InventoryEvent["source"],
    platform: optionalString(row.platform) as Platform | undefined,
    note: optionalString(row.note),
    createdAt: isoString(row.created_at)
  };
}

function rowToSyncRun(row: Record<string, SqlValue>, messages: string[]): SyncRun {
  return {
    id: stringValue(row.id),
    mode: stringValue(row.mode) as SyncRun["mode"],
    status: stringValue(row.status) as SyncRun["status"],
    startedAt: isoString(row.started_at),
    finishedAt: optionalIsoString(row.finished_at),
    summary: {
      itemsChecked: integer(row.items_checked),
      salesDetected: integer(row.sales_detected),
      pushes: integer(row.pushes),
      warnings: integer(row.warnings),
      errors: integer(row.errors)
    },
    messages
  };
}

function rowToImportBatch(row: Record<string, SqlValue>, rows: ImportBatchRow[]): ImportBatchRecord {
  return {
    id: stringValue(row.id),
    source: stringValue(row.source) as ImportBatchRecord["source"],
    fileName: optionalString(row.file_name),
    status: stringValue(row.status) as ImportBatchRecord["status"],
    createdAt: isoString(row.created_at),
    summary: {
      rowsTotal: integer(row.rows_total),
      created: integer(row.rows_created),
      updated: integer(row.rows_updated),
      adjusted: integer(row.rows_adjusted),
      mapped: integer(row.rows_mapped),
      skipped: integer(row.rows_skipped),
      failed: integer(row.rows_failed),
      variantsScanned: nullableInteger(row.variants_scanned) ?? undefined
    },
    rows
  };
}

function rowToImportBatchRow(row: Record<string, SqlValue>): ImportBatchRow {
  return {
    id: stringValue(row.id),
    lineNumber: nullableInteger(row.line_number) ?? undefined,
    sku: optionalString(row.sku),
    action: stringValue(row.action),
    previousQuantity: nullableInteger(row.previous_quantity) ?? undefined,
    nextQuantity: nullableInteger(row.next_quantity) ?? undefined,
    message: stringValue(row.message),
    raw: parseRawJson(row.raw_json)
  };
}

function rowToSchedule(row: Record<string, SqlValue>): ScheduleSettings {
  return {
    enabled: booleanValue(row.enabled),
    intervalMinutes: integer(row.interval_minutes),
    lastRunAt: nullableIsoString(row.last_run_at),
    nextRunAt: nullableIsoString(row.next_run_at),
    updatedAt: isoString(row.updated_at)
  };
}

function stringValue(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

function integer(value: unknown) {
  return typeof value === "number" ? value : Number(value);
}

function nullableInteger(value: unknown) {
  return value === null || value === undefined ? null : integer(value);
}

function storedMaxInventory(value: unknown) {
  const maxInventory = integer(value);
  return Number.isInteger(maxInventory) && maxInventory >= 1 ? maxInventory : defaultMaxInventory;
}

function booleanValue(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function optionalString(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
}

function isoString(value: unknown) {
  return new Date(stringValue(value)).toISOString();
}

function optionalIsoString(value: unknown) {
  return value === null || value === undefined ? undefined : isoString(value);
}

function nullableIsoString(value: unknown) {
  return value === null || value === undefined ? null : isoString(value);
}

function parseRawJson(value: unknown) {
  const text = optionalString(value);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const sqliteSchema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  safety_stock INTEGER NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
  max_inventory INTEGER NOT NULL DEFAULT 100 CHECK (max_inventory >= 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_sku_lower
  ON inventory_items (LOWER(sku));

CREATE TABLE IF NOT EXISTS platform_mappings (
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

CREATE TABLE IF NOT EXISTS inventory_events (
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
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
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

CREATE TABLE IF NOT EXISTS sync_run_messages (
  id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (interval_minutes BETWEEN 5 AND 1440),
  last_run_at TEXT,
  next_run_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('csv', 'shopify')),
  file_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('applied', 'dry_run', 'failed')),
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

CREATE TABLE IF NOT EXISTS import_batch_rows (
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

CREATE INDEX IF NOT EXISTS idx_inventory_events_item_created
  ON inventory_events(item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_mappings_platform_enabled
  ON platform_mappings(platform, enabled);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started
  ON sync_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_import_batches_created
  ON import_batches(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_import_batch_rows_batch
  ON import_batch_rows(batch_id, position);

`;
