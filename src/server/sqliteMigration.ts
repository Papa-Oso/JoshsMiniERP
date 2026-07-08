import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { InventoryItem, Platform, StoreData, SyncRun } from "../shared/types";
import { platforms } from "../shared/types";
import { config } from "./config";
import { backupInventoryData } from "./dataTools";
import { sqliteSchema } from "./sqliteSchema";
import { store } from "./store";

export interface SqliteMigrationOptions {
  dryRun?: boolean;
  databaseFile?: string;
}

export interface SqliteMigrationSummary {
  databaseFile: string;
  dryRun: boolean;
  items: number;
  mappings: number;
  events: number;
  syncRuns: number;
  syncMessages: number;
  scheduleRows: number;
  backupPath?: string;
}

interface CountRow {
  count: number;
}

const now = () => new Date().toISOString();

export async function migrateJsonToSqlite(
  options: SqliteMigrationOptions = {}
): Promise<SqliteMigrationSummary> {
  const data = await store.withLock(() => store.read());
  const databaseFile = path.resolve(options.databaseFile ?? config.databaseFile);
  const summary = summarizeJsonData(data, databaseFile, Boolean(options.dryRun));

  if (options.dryRun) {
    return summary;
  }

  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  const backup = await backupInventoryData();
  const db = new Database(databaseFile);

  try {
    db.pragma("foreign_keys = ON");
    db.exec(sqliteSchema);
    assertDatabaseIsEmpty(db);
    writeJsonDataToSqlite(db, data);
    return { ...summary, backupPath: backup.path };
  } finally {
    db.close();
  }
}

export function sqliteStatus(databaseFile = config.databaseFile) {
  const resolved = path.resolve(databaseFile);
  if (!fs.existsSync(resolved)) {
    return {
      databaseFile: resolved,
      exists: false,
      items: 0,
      mappings: 0,
      events: 0,
      syncRuns: 0,
      importBatches: 0
    };
  }

  const db = new Database(resolved, { readonly: true, fileMustExist: true });
  try {
    return {
      databaseFile: resolved,
      exists: true,
      items: countRows(db, "inventory_items"),
      mappings: countRows(db, "platform_mappings"),
      events: countRows(db, "inventory_events"),
      syncRuns: countRows(db, "sync_runs"),
      importBatches: countRows(db, "import_batches")
    };
  } finally {
    db.close();
  }
}

function summarizeJsonData(data: StoreData, databaseFile: string, dryRun: boolean): SqliteMigrationSummary {
  const mappings = data.items.reduce(
    (total, item) => total + platforms.filter((platform) => Boolean(item.mappings[platform])).length,
    0
  );
  const syncMessages = data.syncRuns.reduce((total, run) => total + run.messages.length, 0);

  return {
    databaseFile,
    dryRun,
    items: data.items.length,
    mappings,
    events: data.events.length,
    syncRuns: data.syncRuns.length,
    syncMessages,
    scheduleRows: 1
  };
}

function writeJsonDataToSqlite(db: Database.Database, data: StoreData) {
  const insert = prepareStatements(db);

  const transaction = db.transaction(() => {
    for (const item of data.items) {
      insert.item.run({
        id: item.id,
        sku: item.sku,
        name: item.name,
        description: item.description ?? null,
        quantity: item.quantity,
        safety_stock: item.safetyStock,
        created_at: item.createdAt,
        updated_at: item.updatedAt
      });

      for (const platform of platforms) {
        const mapping = item.mappings[platform];
        if (!mapping) continue;
        insert.mapping.run({
          id: `${item.id}:${platform}`,
          item_id: item.id,
          platform,
          enabled: mapping.enabled ? 1 : 0,
          remote_sku: mapping.remoteSku ?? null,
          listing_id: mapping.listingId ?? null,
          inventory_item_id: mapping.inventoryItemId ?? null,
          location_id: mapping.locationId ?? null,
          offer_id: mapping.offerId ?? null,
          last_synced_quantity: mapping.lastSyncedQuantity ?? null,
          last_remote_quantity: mapping.lastRemoteQuantity ?? null,
          last_synced_at: mapping.lastSyncedAt ?? null,
          warning: mapping.warning ?? null,
          created_at: item.createdAt,
          updated_at: item.updatedAt
        });
      }
    }

    for (const event of data.events) {
      insert.event.run({
        id: event.id,
        item_id: event.itemId,
        sku: event.sku,
        type: event.type,
        delta: event.delta,
        quantity_after: event.quantityAfter,
        source: event.source,
        platform: event.platform ?? null,
        note: event.note ?? null,
        batch_id: null,
        created_at: event.createdAt
      });
    }

    for (const run of data.syncRuns) {
      insertSyncRun(insert, run);
    }

    insert.schedule.run({
      enabled: data.schedule.enabled ? 1 : 0,
      interval_minutes: data.schedule.intervalMinutes,
      last_run_at: data.schedule.lastRunAt ?? null,
      next_run_at: data.schedule.nextRunAt ?? null,
      updated_at: data.schedule.updatedAt
    });
  });

  transaction();
}

function prepareStatements(db: Database.Database) {
  return {
    item: db.prepare(`
      INSERT INTO inventory_items (
        id, sku, name, description, quantity, safety_stock, created_at, updated_at
      ) VALUES (
        @id, @sku, @name, @description, @quantity, @safety_stock, @created_at, @updated_at
      )
    `),
    mapping: db.prepare(`
      INSERT INTO platform_mappings (
        id, item_id, platform, enabled, remote_sku, listing_id, inventory_item_id,
        location_id, offer_id, last_synced_quantity, last_remote_quantity,
        last_synced_at, warning, created_at, updated_at
      ) VALUES (
        @id, @item_id, @platform, @enabled, @remote_sku, @listing_id, @inventory_item_id,
        @location_id, @offer_id, @last_synced_quantity, @last_remote_quantity,
        @last_synced_at, @warning, @created_at, @updated_at
      )
    `),
    event: db.prepare(`
      INSERT INTO inventory_events (
        id, item_id, sku, type, delta, quantity_after, source, platform, note, batch_id, created_at
      ) VALUES (
        @id, @item_id, @sku, @type, @delta, @quantity_after, @source, @platform, @note, @batch_id, @created_at
      )
    `),
    syncRun: db.prepare(`
      INSERT INTO sync_runs (
        id, mode, status, items_checked, sales_detected, pushes, warnings,
        errors, started_at, finished_at
      ) VALUES (
        @id, @mode, @status, @items_checked, @sales_detected, @pushes, @warnings,
        @errors, @started_at, @finished_at
      )
    `),
    syncMessage: db.prepare(`
      INSERT INTO sync_run_messages (
        id, sync_run_id, message, created_at
      ) VALUES (
        @id, @sync_run_id, @message, @created_at
      )
    `),
    schedule: db.prepare(`
      INSERT INTO schedule_settings (
        id, enabled, interval_minutes, last_run_at, next_run_at, updated_at
      ) VALUES (
        1, @enabled, @interval_minutes, @last_run_at, @next_run_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        interval_minutes = excluded.interval_minutes,
        last_run_at = excluded.last_run_at,
        next_run_at = excluded.next_run_at,
        updated_at = excluded.updated_at
    `)
  };
}

function insertSyncRun(insert: ReturnType<typeof prepareStatements>, run: SyncRun) {
  insert.syncRun.run({
    id: run.id,
    mode: run.mode,
    status: run.status,
    items_checked: run.summary.itemsChecked,
    sales_detected: run.summary.salesDetected,
    pushes: run.summary.pushes,
    warnings: run.summary.warnings,
    errors: run.summary.errors,
    started_at: run.startedAt,
    finished_at: run.finishedAt ?? null
  });

  for (const message of run.messages) {
    insert.syncMessage.run({
      id: randomUUID(),
      sync_run_id: run.id,
      message,
      created_at: run.finishedAt ?? now()
    });
  }
}

function assertDatabaseIsEmpty(db: Database.Database) {
  const tables = [
    "inventory_items",
    "platform_mappings",
    "inventory_events",
    "import_batches",
    "import_batch_rows",
    "sync_runs",
    "sync_run_messages"
  ];

  const nonEmpty = tables.filter((table) => countRows(db, table) > 0);
  if (nonEmpty.length > 0) {
    throw new Error(`SQLite database is not empty (${nonEmpty.join(", ")}). Use a new DATABASE_FILE.`);
  }
}

function countRows(db: Database.Database, table: string) {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow).count;
}
