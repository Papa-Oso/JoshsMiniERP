import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import type { PoolClient } from "pg";
import type {
  InventoryEvent,
  InventoryItem,
  Platform,
  PlatformMapping,
  ScheduleSettings,
  StoreData,
  SyncRun
} from "../shared/types";
import { platforms } from "../shared/types";
import { config } from "./config";

const { Pool } = pg;

const now = () => new Date().toISOString();
const lockTimeoutMs = 60_000;
const staleLockMs = 15 * 60_000;

const defaultData = (): StoreData => ({
  items: [],
  events: [],
  schedule: defaultSchedule(),
  syncRuns: []
});

const defaultSchedule = (): ScheduleSettings => ({
  enabled: false,
  intervalMinutes: 60,
  lastRunAt: null,
  nextRunAt: null,
  updatedAt: now()
});

export interface InventoryStoreDriver {
  read(): Promise<StoreData>;
  mutate<T>(mutator: (data: StoreData) => T | Promise<T>): Promise<T>;
  withLock<T>(callback: () => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export class InventoryStore implements InventoryStoreDriver {
  private writeQueue = Promise.resolve();
  private readonly lockPath: string;
  private readonly lockContext = new AsyncLocalStorage<boolean>();

  constructor(private readonly filePath = config.dataFile) {
    this.lockPath = `${filePath}.lock`;
  }

  async read(): Promise<StoreData> {
    await this.ensureFile();
    const raw = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(raw) as StoreData;
  }

  async mutate<T>(mutator: (data: StoreData) => T | Promise<T>): Promise<T> {
    const run = async () => {
      return this.withLock(async () => {
        const data = await this.read();
        const result = await mutator(data);
        await this.write(data);
        return result;
      });
    };

    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async withLock<T>(callback: () => Promise<T>): Promise<T> {
    if (this.lockContext.getStore()) {
      return callback();
    }

    const release = await this.acquireFileLock();
    return this.lockContext.run(true, async () => {
      try {
        return await callback();
      } finally {
        await release();
      }
    });
  }

  private async ensureFile() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.write(defaultData());
    }
  }

  private async write(data: StoreData) {
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.filePath);
  }

  private async acquireFileLock() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const startedAt = Date.now();
    const lockId = randomUUID();

    while (true) {
      try {
        await fs.writeFile(this.lockPath, JSON.stringify({ id: lockId, pid: process.pid, createdAt: now() }), {
          encoding: "utf8",
          flag: "wx"
        });
        return async () => {
          await this.releaseFileLock(lockId);
        };
      } catch (error) {
        if (!isFileExistsError(error)) {
          throw error;
        }

        await this.removeStaleLock();
        if (Date.now() - startedAt > lockTimeoutMs) {
          throw new Error(`Timed out waiting for inventory store lock at ${this.lockPath}.`);
        }
        await delay(100);
      }
    }
  }

  private async releaseFileLock(lockId: string) {
    try {
      const raw = await fs.readFile(this.lockPath, "utf8");
      const current = JSON.parse(raw) as { id?: string };
      if (current.id === lockId) {
        await fs.rm(this.lockPath, { force: true });
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  private async removeStaleLock() {
    try {
      const raw = await fs.readFile(this.lockPath, "utf8");
      const current = JSON.parse(raw) as { createdAt?: string };
      const createdAt = current.createdAt ? Date.parse(current.createdAt) : Number.NaN;
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleLockMs) {
        await fs.rm(this.lockPath, { force: true });
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }
}

export class PostgresInventoryStore implements InventoryStoreDriver {
  private readonly pool: pg.Pool;
  private readonly transactionContext = new AsyncLocalStorage<PoolClient>();
  private schemaReady?: Promise<void>;

  constructor(databaseUrl = config.databaseUrl) {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when STORE_DRIVER=postgres.");
    }

    this.pool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.DATABASE_POOL_MAX ?? 5)
    });
  }

  async read(): Promise<StoreData> {
    const activeClient = this.transactionContext.getStore();
    if (activeClient) {
      return this.readWithClient(activeClient);
    }

    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      return await this.readWithClient(client);
    } finally {
      client.release();
    }
  }

  async mutate<T>(mutator: (data: StoreData) => T | Promise<T>): Promise<T> {
    const activeClient = this.transactionContext.getStore();
    if (activeClient) {
      const data = await this.readWithClient(activeClient);
      const result = await mutator(data);
      await this.replaceData(activeClient, data);
      return result;
    }

    return this.inTransaction(async () => {
      const client = this.transactionContext.getStore();
      if (!client) throw new Error("Postgres transaction was not initialized.");

      const data = await this.readWithClient(client);
      const result = await mutator(data);
      await this.replaceData(client, data);
      return result;
    });
  }

  async withLock<T>(callback: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) {
      return callback();
    }

    return this.inTransaction(callback);
  }

  async close() {
    await this.pool.end();
  }

  private async inTransaction<T>(callback: () => Promise<T>): Promise<T> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    let committed = false;

    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('joshs-mini-erp-inventory-store')::bigint)");
      const result = await this.transactionContext.run(client, callback);
      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (!committed) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private ensureSchema() {
    this.schemaReady ??= this.createSchema();
    return this.schemaReady;
  }

  private async createSchema() {
    await this.pool.query(postgresSchema);
  }

  private async readWithClient(client: PoolClient): Promise<StoreData> {
    const itemRows = (
      await client.query<ItemRow>(`
        SELECT id, sku, name, description, quantity, safety_stock, created_at, updated_at
        FROM inventory_items
        ORDER BY created_at DESC, sku ASC
      `)
    ).rows;

    const mappingRows = (
      await client.query<MappingRow>(`
        SELECT item_id, platform, enabled, remote_sku, listing_id, inventory_item_id,
          location_id, offer_id, last_synced_quantity, last_remote_quantity,
          last_synced_at, warning
        FROM platform_mappings
        ORDER BY created_at ASC
      `)
    ).rows;

    const eventRows = (
      await client.query<EventRow>(`
        SELECT id, item_id, sku, type, delta, quantity_after, source, platform, note, created_at
        FROM inventory_events
        ORDER BY created_at DESC
        LIMIT 500
      `)
    ).rows;

    const runRows = (
      await client.query<SyncRunRow>(`
        SELECT id, mode, status, items_checked, sales_detected, pushes, warnings, errors,
          started_at, finished_at
        FROM sync_runs
        ORDER BY started_at DESC
        LIMIT 100
      `)
    ).rows;

    const runIds = runRows.map((run) => run.id);
    const messageRows =
      runIds.length === 0
        ? []
        : (
            await client.query<SyncRunMessageRow>(
              `
                SELECT sync_run_id, message
                FROM sync_run_messages
                WHERE sync_run_id = ANY($1)
                ORDER BY sync_run_id ASC, position ASC, created_at ASC
              `,
              [runIds]
            )
          ).rows;

    const scheduleRow = (
      await client.query<ScheduleRow>(`
        SELECT enabled, interval_minutes, last_run_at, next_run_at, updated_at
        FROM schedule_settings
        WHERE id = 1
      `)
    ).rows[0];

    const itemsById = new Map<string, InventoryItem>();
    const items = itemRows.map((row) => {
      const item: InventoryItem = {
        id: row.id,
        sku: row.sku,
        name: row.name,
        description: optionalString(row.description),
        quantity: integer(row.quantity),
        safetyStock: integer(row.safety_stock),
        mappings: {},
        createdAt: isoString(row.created_at),
        updatedAt: isoString(row.updated_at)
      };
      itemsById.set(item.id, item);
      return item;
    });

    for (const row of mappingRows) {
      const item = itemsById.get(row.item_id);
      if (!item) continue;
      item.mappings[row.platform] = rowToMapping(row);
    }

    const messagesByRunId = new Map<string, string[]>();
    for (const row of messageRows) {
      const messages = messagesByRunId.get(row.sync_run_id) ?? [];
      messages.push(row.message);
      messagesByRunId.set(row.sync_run_id, messages);
    }

    return {
      items,
      events: eventRows.map(rowToEvent),
      schedule: scheduleRow ? rowToSchedule(scheduleRow) : defaultSchedule(),
      syncRuns: runRows.map((row) => rowToSyncRun(row, messagesByRunId.get(row.id) ?? []))
    };
  }

  private async replaceData(client: PoolClient, data: StoreData) {
    await client.query("DELETE FROM sync_run_messages");
    await client.query("DELETE FROM sync_runs");
    await client.query("DELETE FROM inventory_events");
    await client.query("DELETE FROM platform_mappings");
    await client.query("DELETE FROM inventory_items");

    for (const item of data.items) {
      await client.query(
        `
          INSERT INTO inventory_items (
            id, sku, name, description, quantity, safety_stock, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          item.id,
          item.sku,
          item.name,
          item.description ?? null,
          item.quantity,
          item.safetyStock,
          item.createdAt,
          item.updatedAt
        ]
      );

      for (const platform of platforms) {
        const mapping = item.mappings[platform];
        if (!mapping) continue;
        await this.insertMapping(client, item, platform, mapping);
      }
    }

    for (const event of data.events) {
      await client.query(
        `
          INSERT INTO inventory_events (
            id, item_id, sku, type, delta, quantity_after, source, platform, note, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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

    for (const run of data.syncRuns) {
      await client.query(
        `
          INSERT INTO sync_runs (
            id, mode, status, items_checked, sales_detected, pushes, warnings,
            errors, started_at, finished_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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

      for (const [position, message] of run.messages.entries()) {
        await client.query(
          `
            INSERT INTO sync_run_messages (
              id, sync_run_id, position, message, created_at
            ) VALUES ($1, $2, $3, $4, $5)
          `,
          [randomUUID(), run.id, position, message, run.finishedAt ?? now()]
        );
      }
    }

    await client.query(
      `
        INSERT INTO schedule_settings (
          id, enabled, interval_minutes, last_run_at, next_run_at, updated_at
        ) VALUES (1, $1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          interval_minutes = EXCLUDED.interval_minutes,
          last_run_at = EXCLUDED.last_run_at,
          next_run_at = EXCLUDED.next_run_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        data.schedule.enabled,
        data.schedule.intervalMinutes,
        data.schedule.lastRunAt ?? null,
        data.schedule.nextRunAt ?? null,
        data.schedule.updatedAt
      ]
    );
  }

  private async insertMapping(
    client: PoolClient,
    item: InventoryItem,
    platform: Platform,
    mapping: PlatformMapping
  ) {
    await client.query(
      `
        INSERT INTO platform_mappings (
          id, item_id, platform, enabled, remote_sku, listing_id, inventory_item_id,
          location_id, offer_id, last_synced_quantity, last_remote_quantity,
          last_synced_at, warning, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
        )
      `,
      [
        `${item.id}:${platform}`,
        item.id,
        platform,
        mapping.enabled,
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
}

export const store: InventoryStoreDriver =
  config.storeDriver === "postgres" ? new PostgresInventoryStore() : new InventoryStore();

export async function closeStore() {
  await store.close?.();
}

interface ItemRow {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  quantity: number;
  safety_stock: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MappingRow {
  item_id: string;
  platform: Platform;
  enabled: boolean;
  remote_sku: string | null;
  listing_id: string | null;
  inventory_item_id: string | null;
  location_id: string | null;
  offer_id: string | null;
  last_synced_quantity: number | null;
  last_remote_quantity: number | null;
  last_synced_at: Date | string | null;
  warning: string | null;
}

interface EventRow {
  id: string;
  item_id: string;
  sku: string;
  type: InventoryEvent["type"];
  delta: number;
  quantity_after: number;
  source: InventoryEvent["source"];
  platform: Platform | null;
  note: string | null;
  created_at: Date | string;
}

interface SyncRunRow {
  id: string;
  mode: SyncRun["mode"];
  status: SyncRun["status"];
  items_checked: number;
  sales_detected: number;
  pushes: number;
  warnings: number;
  errors: number;
  started_at: Date | string;
  finished_at: Date | string | null;
}

interface SyncRunMessageRow {
  sync_run_id: string;
  message: string;
}

interface ScheduleRow {
  enabled: boolean;
  interval_minutes: number;
  last_run_at: Date | string | null;
  next_run_at: Date | string | null;
  updated_at: Date | string;
}

function rowToMapping(row: MappingRow): PlatformMapping {
  return {
    enabled: row.enabled,
    remoteSku: optionalString(row.remote_sku),
    listingId: optionalString(row.listing_id),
    inventoryItemId: optionalString(row.inventory_item_id),
    locationId: optionalString(row.location_id),
    offerId: optionalString(row.offer_id),
    lastSyncedQuantity: nullableInteger(row.last_synced_quantity),
    lastRemoteQuantity: nullableInteger(row.last_remote_quantity),
    lastSyncedAt: nullableIsoString(row.last_synced_at),
    warning: row.warning
  };
}

function rowToEvent(row: EventRow): InventoryEvent {
  return {
    id: row.id,
    itemId: row.item_id,
    sku: row.sku,
    type: row.type,
    delta: integer(row.delta),
    quantityAfter: integer(row.quantity_after),
    source: row.source,
    platform: row.platform ?? undefined,
    note: optionalString(row.note),
    createdAt: isoString(row.created_at)
  };
}

function rowToSyncRun(row: SyncRunRow, messages: string[]): SyncRun {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
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

function rowToSchedule(row: ScheduleRow): ScheduleSettings {
  return {
    enabled: row.enabled,
    intervalMinutes: integer(row.interval_minutes),
    lastRunAt: nullableIsoString(row.last_run_at),
    nextRunAt: nullableIsoString(row.next_run_at),
    updatedAt: isoString(row.updated_at)
  };
}

function integer(value: unknown) {
  return typeof value === "number" ? value : Number(value);
}

function nullableInteger(value: unknown) {
  return value === null || value === undefined ? null : integer(value);
}

function optionalString(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
}

function isoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIsoString(value: Date | string | null) {
  return value === null ? undefined : isoString(value);
}

function nullableIsoString(value: Date | string | null) {
  return value === null ? null : isoString(value);
}

function isFileExistsError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const postgresSchema = `
CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  safety_stock INTEGER NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_sku_lower
  ON inventory_items (LOWER(sku));

CREATE TABLE IF NOT EXISTS platform_mappings (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('etsy', 'ebay', 'shopify')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  remote_sku TEXT,
  listing_id TEXT,
  inventory_item_id TEXT,
  location_id TEXT,
  offer_id TEXT,
  last_synced_quantity INTEGER,
  last_remote_quantity INTEGER,
  last_synced_at TIMESTAMPTZ,
  warning TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
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
  created_at TIMESTAMPTZ NOT NULL
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
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sync_run_messages (
  id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (interval_minutes BETWEEN 5 AND 1440),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_events_item_created
  ON inventory_events(item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_mappings_platform_enabled
  ON platform_mappings(platform, enabled);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started
  ON sync_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_run_messages_run_position
  ON sync_run_messages(sync_run_id, position);
`;
