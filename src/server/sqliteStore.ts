import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Database, SqlValue } from "sql.js";
import type {
  ImportBatchRecord,
  ImportBatchRow,
  InventoryEvent,
  InventoryItem,
  Platform,
  PlatformMapping,
  PrintAsset,
  PrintEvent,
  PrintingPayload,
  ReconcileRunRecord,
  ReconcileRow,
  SkuInstructionMatch,
  ScheduleSettings,
  StoreData,
  SyncRun
} from "../shared/types";
import { defaultMaxInventory, platforms } from "../shared/types";
import { config } from "./config";
import { defaultPrintingData, normalizePrintingData } from "./printingData";
import type { InventoryStoreDriver } from "./store";
import { sqliteDatabase } from "./sqliteDatabase";

interface SqliteContext {
  db: Database;
  dirty: boolean;
}

const now = () => new Date().toISOString();
export class SQLiteInventoryStore implements InventoryStoreDriver {
  private readonly lockContext = new AsyncLocalStorage<SqliteContext>();
  private readonly database;

  constructor(private readonly databaseFile = config.databaseFile) {
    this.database = sqliteDatabase(databaseFile);
  }

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

    return this.database.write(async (db) => {
      this.createSchema(db);
      const context: SqliteContext = { db, dirty: false };
      return this.lockContext.run(context, async () => {
        return callback();
      });
    });
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

  async readPrintingData(): Promise<PrintingPayload> {
    return this.withLock(async () => {
      const context = this.requireContext();
      if (await this.ensurePrintingDataSeeded(context.db)) {
        context.dirty = true;
      }
      return this.readPrintingWithDatabase(context.db);
    });
  }

  async mutatePrintingData<T>(mutator: (data: PrintingPayload) => T | Promise<T>): Promise<T> {
    return this.withLock(async () => {
      const context = this.requireContext();
      if (await this.ensurePrintingDataSeeded(context.db)) {
        context.dirty = true;
      }
      const data = this.readPrintingWithDatabase(context.db);
      const result = await mutator(data);
      this.replacePrintingData(context.db, data);
      context.dirty = true;
      return result;
    });
  }

  async recordPrintAssets(assets: PrintAsset[], options: { replace?: boolean } = {}) {
    await this.withLock(async () => {
      const context = this.requireContext();
      this.recordPrintAssetMetadata(context.db, assets, Boolean(options.replace));
      context.dirty = true;
    });
  }

  async listPrintAssetMetadata(limit = 100): Promise<PrintAsset[]> {
    return this.withLock(async () => {
      const context = this.requireContext();
      return this.readPrintAssetMetadata(context.db, limit);
    });
  }

  async recordReconcileRun(run: ReconcileRunRecord) {
    await this.withLock(async () => {
      const context = this.requireContext();
      this.upsertReconcileRun(context.db, run);
      this.pruneReconcileRuns(context.db, 100);
      context.dirty = true;
    });
  }

  async listReconcileRuns(limit = 50): Promise<ReconcileRunRecord[]> {
    return this.withLock(async () => {
      const context = this.requireContext();
      return this.readReconcileRuns(context.db, limit);
    });
  }

  private createSchema(db: Database) {
    ensureColumn(db, "import_batch_rows", "position", "INTEGER NOT NULL DEFAULT 0");
    db.run(sqliteSchema);
    ensureColumn(db, "inventory_items", "description", "TEXT");
    ensureColumn(db, "inventory_items", "max_inventory", "INTEGER NOT NULL DEFAULT 100");
    ensureColumn(db, "inventory_items", "active", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "platform_mappings", "last_remote_quantity", "INTEGER");
    ensureColumn(db, "platform_mappings", "warning", "TEXT");
    ensureColumn(db, "sync_run_messages", "position", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "sync_run_messages", "created_at", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "import_batches", "file_name", "TEXT");
    ensureColumn(db, "import_batches", "rows_total", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "import_batches", "rows_created", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "import_batches", "rows_updated", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "import_batches", "rows_adjusted", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "import_batches", "rows_mapped", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "import_batches", "rows_skipped", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "import_batches", "rows_failed", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "import_batches", "variants_scanned", "INTEGER");
    ensureColumn(db, "import_batch_rows", "position", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "import_batch_rows", "line_number", "INTEGER");
    ensureColumn(db, "import_batch_rows", "previous_quantity", "INTEGER");
    ensureColumn(db, "import_batch_rows", "next_quantity", "INTEGER");
    ensureColumn(db, "import_batch_rows", "raw_json", "TEXT");
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

  private async ensurePrintingDataSeeded(db: Database) {
    const instructionCount = integer(queryRows(db, "SELECT COUNT(*) AS count FROM print_instructions")[0]?.count ?? 0);
    const settingsCount = integer(queryRows(db, "SELECT COUNT(*) AS count FROM print_settings")[0]?.count ?? 0);
    if (instructionCount > 0 && settingsCount > 0) return false;

    this.replacePrintingData(db, await this.readLegacyPrintingData());
    return true;
  }

  private async readLegacyPrintingData() {
    const printingFile = path.resolve(process.env.PRINTING_DATA_FILE ?? "data/printing.json");
    try {
      const raw = await fs.readFile(printingFile, "utf8");
      return normalizePrintingData(JSON.parse(raw) as Partial<PrintingPayload>);
    } catch (error) {
      if (isMissingFileError(error)) return defaultPrintingData();
      throw error;
    }
  }

  private readPrintingWithDatabase(db: Database): PrintingPayload {
    const instructionRows = queryRows(db, `
      SELECT id, label, match_terms_json, title, body, on_hand, low_alert,
        max_inventory, per_page, updated_at
      FROM print_instructions
      ORDER BY position ASC, label ASC
    `);

    const eventRows = queryRows(db, `
      SELECT id, instruction_id, type, delta, quantity_after, note, created_at
      FROM print_instruction_events
      ORDER BY created_at DESC, id DESC
      LIMIT 250
    `);

    const matchRows = queryRows(db, `
      SELECT sku, mode, instruction_id, updated_at
      FROM sku_instruction_matches
      ORDER BY sku ASC
    `);

    const settingsRow = queryRows(db, `
      SELECT label_batch_size, instruction_pages, instruction_per_page,
        label_printer_name, instruction_printer_name
      FROM print_settings
      WHERE id = 1
    `)[0];

    return normalizePrintingData({
      instructions: instructionRows.map(rowToPrintInstruction),
      events: eventRows.map(rowToPrintEvent),
      instructionMatches: matchRows.map(rowToInstructionMatch),
      defaults: settingsRow
        ? {
            labelBatchSize: integer(settingsRow.label_batch_size),
            instructionPages: integer(settingsRow.instruction_pages),
            instructionPerPage: integer(settingsRow.instruction_per_page),
            labelPrinterName: optionalString(settingsRow.label_printer_name),
            instructionPrinterName: optionalString(settingsRow.instruction_printer_name)
          }
        : undefined
    });
  }

  private replacePrintingData(db: Database, data: PrintingPayload) {
    const normalized = normalizePrintingData(data);

    db.run("DELETE FROM print_instruction_events");
    db.run("DELETE FROM sku_instruction_matches");
    db.run("DELETE FROM print_instructions");
    db.run("DELETE FROM print_settings");

    for (const [position, instruction] of normalized.instructions.entries()) {
      db.run(
        `
          INSERT INTO print_instructions (
            id, position, label, match_terms_json, title, body, on_hand,
            low_alert, max_inventory, per_page, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          instruction.id,
          position,
          instruction.label,
          JSON.stringify(instruction.matchTerms),
          instruction.title,
          instruction.body,
          instruction.onHand,
          instruction.lowAlert,
          instruction.maxInventory,
          instruction.perPage,
          instruction.updatedAt
        ]
      );
    }

    for (const event of normalized.events.slice(0, 250)) {
      db.run(
        `
          INSERT INTO print_instruction_events (
            id, instruction_id, type, delta, quantity_after, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          event.id,
          event.instructionId,
          event.type,
          event.delta,
          event.quantityAfter,
          event.note ?? null,
          event.createdAt
        ]
      );
    }

    for (const match of normalized.instructionMatches) {
      db.run(
        `
          INSERT INTO sku_instruction_matches (
            sku, mode, instruction_id, updated_at
          ) VALUES (?, ?, ?, ?)
        `,
        [match.sku, match.mode, match.instructionId ?? null, match.updatedAt]
      );
    }

    db.run(
      `
        INSERT INTO print_settings (
          id, label_batch_size, instruction_pages, instruction_per_page,
          label_printer_name, instruction_printer_name, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
      `,
      [
        normalized.defaults.labelBatchSize,
        normalized.defaults.instructionPages,
        normalized.defaults.instructionPerPage,
        normalized.defaults.labelPrinterName ?? null,
        normalized.defaults.instructionPrinterName ?? null,
        now()
      ]
    );
  }

  private recordPrintAssetMetadata(db: Database, assets: PrintAsset[], replace: boolean) {
    const timestamp = now();
    if (replace) {
      db.run("UPDATE print_assets SET exists_on_disk = 0, updated_at = ?", [timestamp]);
    }

    for (const asset of assets) {
      db.run(
        `
          INSERT INTO print_assets (
            id, kind, filename, display_name, relative_path, sku, instruction_id,
            exists_on_disk, discovered_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            filename = excluded.filename,
            display_name = excluded.display_name,
            relative_path = excluded.relative_path,
            sku = excluded.sku,
            instruction_id = excluded.instruction_id,
            exists_on_disk = excluded.exists_on_disk,
            updated_at = excluded.updated_at
        `,
        [
          asset.id,
          asset.kind,
          asset.filename,
          asset.displayName,
          asset.path,
          asset.sku ?? null,
          asset.instructionId ?? null,
          asset.exists ? 1 : 0,
          timestamp,
          timestamp
        ]
      );
    }
  }

  private readPrintAssetMetadata(db: Database, limit: number): PrintAsset[] {
    return queryRows(
      db,
      `
        SELECT id, kind, filename, display_name, relative_path, sku, instruction_id, exists_on_disk
        FROM print_assets
        ORDER BY kind ASC, display_name ASC, filename ASC
        LIMIT ?
      `,
      [Math.max(1, Math.floor(limit))]
    ).map(rowToPrintAsset);
  }

  private upsertReconcileRun(db: Database, run: ReconcileRunRecord) {
    db.run(
      `
        INSERT INTO reconcile_runs (
          id, platform, items_checked, sales_detected, pushes, warnings, errors, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          platform = excluded.platform,
          items_checked = excluded.items_checked,
          sales_detected = excluded.sales_detected,
          pushes = excluded.pushes,
          warnings = excluded.warnings,
          errors = excluded.errors,
          created_at = excluded.created_at
      `,
      [
        run.id,
        run.platform ?? null,
        run.summary.itemsChecked,
        run.summary.salesDetected,
        run.summary.pushes,
        run.summary.warnings,
        run.summary.errors,
        run.createdAt
      ]
    );

    db.run("DELETE FROM reconcile_rows WHERE run_id = ?", [run.id]);
    for (const [position, row] of run.rows.entries()) {
      db.run(
        `
          INSERT INTO reconcile_rows (
            id, run_id, position, sku, platform, status, local_quantity, remote_quantity,
            last_synced_quantity, projected_local_quantity, would_push_quantity, message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          `${run.id}:${position}`,
          run.id,
          position,
          row.sku,
          row.platform,
          row.status,
          row.localQuantity,
          row.remoteQuantity ?? null,
          row.lastSyncedQuantity ?? null,
          row.projectedLocalQuantity ?? null,
          row.wouldPushQuantity ?? null,
          row.message
        ]
      );
    }
  }

  private readReconcileRuns(db: Database, limit: number): ReconcileRunRecord[] {
    const runRows = queryRows(
      db,
      `
        SELECT id, platform, items_checked, sales_detected, pushes, warnings, errors, created_at
        FROM reconcile_runs
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `,
      [Math.max(1, Math.floor(limit))]
    );

    const runIds = runRows.map((row) => stringValue(row.id));
    const rowRows =
      runIds.length === 0
        ? []
        : queryRows(
            db,
            `
              SELECT run_id, sku, platform, status, local_quantity, remote_quantity,
                last_synced_quantity, projected_local_quantity, would_push_quantity, message
              FROM reconcile_rows
              WHERE run_id IN (${runIds.map(() => "?").join(", ")})
              ORDER BY run_id ASC, position ASC
            `,
            runIds
          );

    const rowsByRunId = new Map<string, ReconcileRow[]>();
    for (const row of rowRows) {
      const runId = stringValue(row.run_id);
      const rows = rowsByRunId.get(runId) ?? [];
      rows.push(rowToReconcileRow(row));
      rowsByRunId.set(runId, rows);
    }

    return runRows.map((row) => rowToReconcileRun(row, rowsByRunId.get(stringValue(row.id)) ?? []));
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

  private pruneReconcileRuns(db: Database, limit: number) {
    db.run(
      `
        DELETE FROM reconcile_runs
        WHERE id IN (
          SELECT id
          FROM reconcile_runs
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
  if (!result) return;
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

function rowToPrintInstruction(row: Record<string, SqlValue>) {
  return {
    id: stringValue(row.id),
    label: stringValue(row.label),
    matchTerms: parseStringArray(row.match_terms_json),
    title: stringValue(row.title),
    body: stringValue(row.body),
    onHand: integer(row.on_hand),
    lowAlert: integer(row.low_alert),
    maxInventory: storedMaxInventory(row.max_inventory),
    perPage: integer(row.per_page),
    updatedAt: isoString(row.updated_at)
  };
}

function rowToPrintEvent(row: Record<string, SqlValue>): PrintEvent {
  return {
    id: stringValue(row.id),
    instructionId: stringValue(row.instruction_id),
    type: stringValue(row.type) as PrintEvent["type"],
    delta: integer(row.delta),
    quantityAfter: integer(row.quantity_after),
    note: optionalString(row.note),
    createdAt: isoString(row.created_at)
  };
}

function rowToInstructionMatch(row: Record<string, SqlValue>): SkuInstructionMatch {
  return {
    sku: stringValue(row.sku),
    mode: stringValue(row.mode) as SkuInstructionMatch["mode"],
    instructionId: optionalString(row.instruction_id),
    updatedAt: isoString(row.updated_at)
  };
}

function rowToPrintAsset(row: Record<string, SqlValue>): PrintAsset {
  return {
    id: stringValue(row.id),
    kind: stringValue(row.kind) as PrintAsset["kind"],
    filename: stringValue(row.filename),
    displayName: stringValue(row.display_name),
    path: stringValue(row.relative_path),
    sku: optionalString(row.sku),
    instructionId: optionalString(row.instruction_id),
    exists: booleanValue(row.exists_on_disk)
  };
}

function rowToReconcileRow(row: Record<string, SqlValue>): ReconcileRow {
  return {
    sku: stringValue(row.sku),
    platform: stringValue(row.platform) as ReconcileRow["platform"],
    status: stringValue(row.status) as ReconcileRow["status"],
    localQuantity: integer(row.local_quantity),
    remoteQuantity: nullableInteger(row.remote_quantity) ?? undefined,
    lastSyncedQuantity: nullableInteger(row.last_synced_quantity),
    projectedLocalQuantity: nullableInteger(row.projected_local_quantity) ?? undefined,
    wouldPushQuantity: nullableInteger(row.would_push_quantity) ?? undefined,
    message: stringValue(row.message)
  };
}

function rowToReconcileRun(row: Record<string, SqlValue>, rows: ReconcileRow[]): ReconcileRunRecord {
  return {
    id: stringValue(row.id),
    platform: optionalString(row.platform) as ReconcileRunRecord["platform"],
    createdAt: isoString(row.created_at),
    summary: {
      itemsChecked: integer(row.items_checked),
      salesDetected: integer(row.sales_detected),
      pushes: integer(row.pushes),
      warnings: integer(row.warnings),
      errors: integer(row.errors)
    },
    rows
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

function parseStringArray(value: unknown) {
  const parsed = parseRawJson(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

CREATE TABLE IF NOT EXISTS print_instructions (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL,
  match_terms_json TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  on_hand INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  low_alert INTEGER NOT NULL DEFAULT 0 CHECK (low_alert >= 0),
  max_inventory INTEGER NOT NULL DEFAULT 100 CHECK (max_inventory >= 1),
  per_page INTEGER NOT NULL DEFAULT 4 CHECK (per_page >= 1),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS print_instruction_events (
  id TEXT PRIMARY KEY,
  instruction_id TEXT NOT NULL REFERENCES print_instructions(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('print_batch', 'package_use', 'correction')),
  delta INTEGER NOT NULL,
  quantity_after INTEGER NOT NULL CHECK (quantity_after >= 0),
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sku_instruction_matches (
  sku TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('instruction', 'none')),
  instruction_id TEXT REFERENCES print_instructions(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS print_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  label_batch_size INTEGER NOT NULL DEFAULT 15 CHECK (label_batch_size >= 1),
  instruction_pages INTEGER NOT NULL DEFAULT 10 CHECK (instruction_pages >= 1),
  instruction_per_page INTEGER NOT NULL DEFAULT 4 CHECK (instruction_per_page >= 1),
  label_printer_name TEXT,
  instruction_printer_name TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS print_assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('label', 'instruction')),
  filename TEXT NOT NULL,
  display_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sku TEXT,
  instruction_id TEXT,
  exists_on_disk INTEGER NOT NULL DEFAULT 1 CHECK (exists_on_disk IN (0, 1)),
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reconcile_runs (
  id TEXT PRIMARY KEY,
  platform TEXT CHECK (platform IN ('etsy', 'ebay', 'shopify')),
  items_checked INTEGER NOT NULL DEFAULT 0,
  sales_detected INTEGER NOT NULL DEFAULT 0,
  pushes INTEGER NOT NULL DEFAULT 0,
  warnings INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reconcile_rows (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES reconcile_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  sku TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('etsy', 'ebay', 'shopify')),
  status TEXT NOT NULL CHECK (
    status IN (
      'ok',
      'baseline',
      'different',
      'sale',
      'remote_increase',
      'missing_config',
      'missing_mapping',
      'error'
    )
  ),
  local_quantity INTEGER NOT NULL,
  remote_quantity INTEGER,
  last_synced_quantity INTEGER,
  projected_local_quantity INTEGER,
  would_push_quantity INTEGER,
  message TEXT NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_print_instruction_events_created
  ON print_instruction_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sku_instruction_matches_instruction
  ON sku_instruction_matches(instruction_id);

CREATE INDEX IF NOT EXISTS idx_print_assets_kind_display
  ON print_assets(kind, display_name);

CREATE INDEX IF NOT EXISTS idx_reconcile_runs_created
  ON reconcile_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reconcile_rows_run
  ON reconcile_rows(run_id, position);

`;
