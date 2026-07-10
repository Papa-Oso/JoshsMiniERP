import fs from "node:fs/promises";
import path from "node:path";
import { platforms } from "../shared/types";
import { config } from "./config";
import { getOperationsReport } from "./reportingService";
import { store } from "./store";

export interface DataFileResult {
  path: string;
  itemCount: number;
  files?: string[];
}

export interface BackupInspectionFile {
  path: string;
  exists: boolean;
  sizeBytes?: number;
}

export interface BackupInspectionResult {
  path: string;
  createdAt?: string;
  itemCount?: number;
  files: BackupInspectionFile[];
  missingSources: string[];
  restorable: boolean;
}

export async function exportInventoryData(outputPath?: string): Promise<DataFileResult & { json?: string }> {
  const data = await store.withLock(() => store.read());
  const json = `${JSON.stringify(data, null, 2)}\n`;

  if (!outputPath) {
    return {
      path: config.dataFile,
      itemCount: data.items.length,
      json
    };
  }

  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, json, "utf8");
  return {
    path: resolved,
    itemCount: data.items.length
  };
}

export async function exportInventoryCsv(outputPath?: string): Promise<DataFileResult & { csv?: string }> {
  const data = await store.withLock(() => store.read());
  const headers = [
    "sku",
    "name",
    "description",
    "quantity",
    "safety_stock",
    "max_inventory",
    "active",
    "created_at",
    "updated_at",
    ...platforms.flatMap((platform) => [
      `${platform}_enabled`,
      `${platform}_remote_sku`,
      `${platform}_listing_id`,
      `${platform}_inventory_item_id`,
      `${platform}_location_id`,
      `${platform}_offer_id`,
      `${platform}_last_synced_quantity`,
      `${platform}_last_remote_quantity`,
      `${platform}_last_synced_at`,
      `${platform}_warning`
    ])
  ];
  const rows = data.items.map((item) => {
    const row: Record<string, unknown> = {
      sku: item.sku,
      name: item.name,
      description: item.description,
      quantity: item.quantity,
      safety_stock: item.safetyStock,
      max_inventory: item.maxInventory,
      active: item.active,
      created_at: item.createdAt,
      updated_at: item.updatedAt
    };

    for (const platform of platforms) {
      const mapping = item.mappings[platform];
      row[`${platform}_enabled`] = Boolean(mapping?.enabled);
      row[`${platform}_remote_sku`] = mapping?.remoteSku;
      row[`${platform}_listing_id`] = mapping?.listingId;
      row[`${platform}_inventory_item_id`] = mapping?.inventoryItemId;
      row[`${platform}_location_id`] = mapping?.locationId;
      row[`${platform}_offer_id`] = mapping?.offerId;
      row[`${platform}_last_synced_quantity`] = mapping?.lastSyncedQuantity;
      row[`${platform}_last_remote_quantity`] = mapping?.lastRemoteQuantity;
      row[`${platform}_last_synced_at`] = mapping?.lastSyncedAt;
      row[`${platform}_warning`] = mapping?.warning;
    }

    return row;
  });
  const csv = toCsv(headers, rows);

  if (!outputPath) {
    return {
      path: config.dataFile,
      itemCount: data.items.length,
      csv
    };
  }

  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, csv, "utf8");
  return {
    path: resolved,
    itemCount: data.items.length
  };
}

export async function exportInventoryEventsCsv(outputPath?: string): Promise<DataFileResult & { csv?: string }> {
  const data = await store.withLock(() => store.read());
  const headers = ["id", "created_at", "sku", "item_id", "type", "delta", "quantity_after", "source", "platform", "note"];
  const rows = data.events.map((event) => ({
    id: event.id,
    created_at: event.createdAt,
    sku: event.sku,
    item_id: event.itemId,
    type: event.type,
    delta: event.delta,
    quantity_after: event.quantityAfter,
    source: event.source,
    platform: event.platform,
    note: event.note
  }));
  const csv = toCsv(headers, rows);

  if (!outputPath) {
    return {
      path: config.dataFile,
      itemCount: data.events.length,
      csv
    };
  }

  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, csv, "utf8");
  return {
    path: resolved,
    itemCount: data.events.length
  };
}

export async function exportOperationsReportCsv(outputDirectory?: string): Promise<DataFileResult> {
  const report = await getOperationsReport();
  const reportDirectory = path.resolve(
    outputDirectory ?? path.join(path.dirname(config.dataFile), "reports", `operations-${backupTimestamp()}`)
  );
  const tables = [
    {
      fileName: "import-batches.csv",
      headers: [
        "created_at",
        "id",
        "source",
        "status",
        "rows_total",
        "created",
        "updated",
        "adjusted",
        "mapped",
        "skipped",
        "failed",
        "variants_scanned",
        "file_name"
      ],
      rows: report.importBatches.map((batch) => ({
        created_at: batch.createdAt,
        id: batch.id,
        source: batch.source,
        status: batch.status,
        rows_total: batch.summary.rowsTotal,
        created: batch.summary.created,
        updated: batch.summary.updated,
        adjusted: batch.summary.adjusted,
        mapped: batch.summary.mapped,
        skipped: batch.summary.skipped,
        failed: batch.summary.failed,
        variants_scanned: batch.summary.variantsScanned,
        file_name: batch.fileName
      }))
    },
    {
      fileName: "reconcile-runs.csv",
      headers: ["created_at", "id", "platform", "sales_detected", "pushes", "warnings", "errors", "first_message"],
      rows: report.reconcileRuns.map((run) => ({
        created_at: run.createdAt,
        id: run.id,
        platform: run.platform,
        sales_detected: run.summary.salesDetected,
        pushes: run.summary.pushes,
        warnings: run.summary.warnings,
        errors: run.summary.errors,
        first_message: run.rows[0]?.message
      }))
    },
    {
      fileName: "sync-runs.csv",
      headers: [
        "started_at",
        "finished_at",
        "id",
        "mode",
        "status",
        "items_checked",
        "sales_detected",
        "pushes",
        "warnings",
        "errors",
        "first_message"
      ],
      rows: report.syncRuns.map((run) => ({
        started_at: run.startedAt,
        finished_at: run.finishedAt,
        id: run.id,
        mode: run.mode,
        status: run.status,
        items_checked: run.summary.itemsChecked,
        sales_detected: run.summary.salesDetected,
        pushes: run.summary.pushes,
        warnings: run.summary.warnings,
        errors: run.summary.errors,
        first_message: run.messages[0]
      }))
    },
    {
      fileName: "recent-inventory-events.csv",
      headers: ["created_at", "id", "sku", "item_id", "type", "delta", "quantity_after", "source", "platform", "note"],
      rows: report.inventoryEvents.map((event) => ({
        created_at: event.createdAt,
        id: event.id,
        sku: event.sku,
        item_id: event.itemId,
        type: event.type,
        delta: event.delta,
        quantity_after: event.quantityAfter,
        source: event.source,
        platform: event.platform,
        note: event.note
      }))
    },
    {
      fileName: "low-inventory.csv",
      headers: ["sku", "name", "quantity", "safety_stock", "max_inventory"],
      rows: report.lowInventory.map((row) => ({
        sku: row.sku,
        name: row.name,
        quantity: row.quantity,
        safety_stock: row.safetyStock,
        max_inventory: row.maxInventory
      }))
    },
    {
      fileName: "instruction-trends.csv",
      headers: ["instruction_id", "label", "on_hand", "low_alert", "max_inventory", "recent_delta", "event_count", "status"],
      rows: report.instructionTrends.map((row) => ({
        instruction_id: row.instructionId,
        label: row.label,
        on_hand: row.onHand,
        low_alert: row.lowAlert,
        max_inventory: row.maxInventory,
        recent_delta: row.recentDelta,
        event_count: row.eventCount,
        status: row.status
      }))
    },
    {
      fileName: "print-events.csv",
      headers: ["created_at", "id", "instruction_id", "type", "delta", "quantity_after", "note"],
      rows: report.printEvents.map((event) => ({
        created_at: event.createdAt,
        id: event.id,
        instruction_id: event.instructionId,
        type: event.type,
        delta: event.delta,
        quantity_after: event.quantityAfter,
        note: event.note
      }))
    },
    {
      fileName: "negative-feedback.csv",
      headers: ["platform", "rating", "buyer_username", "item_title", "feedback_date", "last_seen_at", "feedback_text", "photo_url"],
      rows: report.feedbackConcerns.map((row) => ({
        platform: row.platform,
        rating: row.rating,
        buyer_username: row.buyerUsername,
        item_title: row.itemTitle,
        feedback_date: row.feedbackDate,
        last_seen_at: row.lastSeenAt,
        feedback_text: row.feedbackText,
        photo_url: row.photoUrl
      }))
    },
    {
      fileName: "mapping-health.csv",
      headers: ["sku", "name", "platform", "status", "message"],
      rows: report.mappingHealth.map((row) => ({
        sku: row.sku,
        name: row.name,
        platform: row.platform,
        status: row.status,
        message: row.message
      }))
    },
    {
      fileName: "feedback-scans.csv",
      headers: ["created_at", "id", "platform", "scan_mode", "rows_seen", "rows_exported", "new_rows", "skipped_existing_rows"],
      rows: report.feedbackScanRuns.map((run) => ({
        created_at: run.createdAt,
        id: run.id,
        platform: run.platform,
        scan_mode: run.scanMode,
        rows_seen: run.rowsSeen,
        rows_exported: run.rowsExported,
        new_rows: run.newRows,
        skipped_existing_rows: run.skippedExistingRows
      }))
    }
  ];

  await fs.mkdir(reportDirectory, { recursive: true });
  const files: string[] = [];
  let rowCount = 0;
  for (const table of tables) {
    const outputPath = path.join(reportDirectory, table.fileName);
    await fs.writeFile(outputPath, toCsv(table.headers, table.rows), "utf8");
    files.push(outputPath);
    rowCount += table.rows.length;
  }

  return {
    path: reportDirectory,
    itemCount: rowCount,
    files
  };
}

export async function backupInventoryData(outputDirectory?: string): Promise<DataFileResult> {
  const data = await store.withLock(() => store.read());
  const backupDirectory = path.resolve(outputDirectory ?? path.join(path.dirname(config.dataFile), "backups"));
  const timestamp = backupTimestamp();
  const inventoryBackupPath = path.join(backupDirectory, `inventory-${timestamp}.json`);
  const manifestPath = path.join(backupDirectory, `operational-backup-${timestamp}.json`);
  const copiedFiles: string[] = [];
  const missingSources: string[] = [];

  await fs.mkdir(backupDirectory, { recursive: true });
  await fs.writeFile(inventoryBackupPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  copiedFiles.push(inventoryBackupPath);

  await copyFileIfExists(config.databaseFile, path.join(backupDirectory, `inventory-${timestamp}.sqlite`), copiedFiles, missingSources);
  await copyFileIfExists(printingDataFile(), path.join(backupDirectory, `printing-${timestamp}.json`), copiedFiles, missingSources);
  await copyDirectoryIfExists(printingAssetDirectory(), path.join(backupDirectory, `printing-assets-${timestamp}`), copiedFiles, missingSources);

  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        itemCount: data.items.length,
        files: copiedFiles,
        missingSources
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  copiedFiles.push(manifestPath);

  return {
    path: manifestPath,
    itemCount: data.items.length,
    files: copiedFiles
  };
}

export async function inspectOperationalBackup(manifestPath?: string): Promise<BackupInspectionResult> {
  const resolved = manifestPath ? path.resolve(manifestPath) : await latestBackupManifest();
  const raw = JSON.parse(await fs.readFile(resolved, "utf8")) as {
    createdAt?: string;
    itemCount?: number;
    files?: unknown[];
    missingSources?: unknown[];
  };
  const manifestDirectory = path.dirname(resolved);
  const filePaths = Array.isArray(raw.files) ? raw.files.map((file) => String(file)) : [];
  const files = await Promise.all(
    filePaths.map(async (file) => {
      const candidate = path.isAbsolute(file) ? file : path.resolve(manifestDirectory, file);
      try {
        const stats = await fs.stat(candidate);
        return {
          path: candidate,
          exists: true,
          sizeBytes: stats.size
        } satisfies BackupInspectionFile;
      } catch (cause) {
        if (isMissingFileError(cause)) {
          return {
            path: candidate,
            exists: false
          } satisfies BackupInspectionFile;
        }
        throw cause;
      }
    })
  );

  return {
    path: resolved,
    createdAt: raw.createdAt,
    itemCount: typeof raw.itemCount === "number" ? raw.itemCount : undefined,
    files,
    missingSources: Array.isArray(raw.missingSources) ? raw.missingSources.map((source) => String(source)) : [],
    restorable: files.length > 0 && files.every((file) => file.exists)
  };
}

async function latestBackupManifest() {
  const backupDirectory = path.resolve(path.join(path.dirname(config.dataFile), "backups"));
  const files = await fs.readdir(backupDirectory);
  const manifests = await Promise.all(
    files
      .filter((file) => file.startsWith("operational-backup-") && file.endsWith(".json"))
      .map(async (file) => ({
        path: path.join(backupDirectory, file),
        stats: await fs.stat(path.join(backupDirectory, file))
      }))
  );
  const newest = manifests.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)[0];
  if (!newest) throw new Error(`No operational backup manifest found in ${backupDirectory}.`);
  return newest.path;
}

function toCsv(headers: string[], rows: Array<Record<string, unknown>>) {
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")).join("\n")}\n`;
}

function csvCell(value: unknown) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function copyFileIfExists(source: string, destination: string, copiedFiles: string[], missingSources: string[]) {
  try {
    const stats = await fs.stat(source);
    if (!stats.isFile()) return;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    copiedFiles.push(destination);
  } catch (error) {
    if (isMissingFileError(error)) {
      missingSources.push(source);
      return;
    }
    throw error;
  }
}

async function copyDirectoryIfExists(source: string, destination: string, copiedFiles: string[], missingSources: string[]) {
  try {
    const stats = await fs.stat(source);
    if (!stats.isDirectory()) return;
    await fs.cp(source, destination, { recursive: true });
    copiedFiles.push(destination);
  } catch (error) {
    if (isMissingFileError(error)) {
      missingSources.push(source);
      return;
    }
    throw error;
  }
}

function printingDataFile() {
  return path.resolve(process.env.PRINTING_DATA_FILE ?? "data/printing.json");
}

function printingAssetDirectory() {
  return path.resolve(process.env.PRINTING_ASSET_DIR ?? "data/printing");
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
