import fs from "node:fs/promises";
import path from "node:path";
import { platforms } from "../shared/types";
import { config } from "./config";
import { store } from "./store";

export interface DataFileResult {
  path: string;
  itemCount: number;
  files?: string[];
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
  await copyFileIfExists(feedbackDataFile(), path.join(backupDirectory, `feedback-${timestamp}.sqlite`), copiedFiles, missingSources);
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

function feedbackDataFile() {
  return path.resolve(process.env.FEEDBACK_DATA_FILE ?? "data/feedback.sqlite");
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
