import fs from "node:fs/promises";
import path from "node:path";
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
