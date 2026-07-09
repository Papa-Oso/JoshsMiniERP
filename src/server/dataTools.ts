import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { store } from "./store";

export interface DataFileResult {
  path: string;
  itemCount: number;
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
  const backupPath = path.join(backupDirectory, `inventory-${backupTimestamp()}.json`);

  await fs.mkdir(backupDirectory, { recursive: true });
  await fs.writeFile(backupPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  return {
    path: backupPath,
    itemCount: data.items.length
  };
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
