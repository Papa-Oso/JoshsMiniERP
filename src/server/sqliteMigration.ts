import fs from "node:fs/promises";
import path from "node:path";
import type { StoreData } from "../shared/types";
import { platforms } from "../shared/types";
import { config } from "./config";
import { SQLiteInventoryStore } from "./sqliteStore";
import { InventoryStore } from "./store";

export interface SQLiteMigrationOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface SQLiteMigrationSummary {
  databaseFile: string;
  dryRun: boolean;
  force: boolean;
  items: number;
  mappings: number;
  events: number;
  syncRuns: number;
  syncMessages: number;
  scheduleRows: number;
  backupPath?: string;
  targetBackupPath?: string;
}

export async function migrateJsonToSQLite(
  options: SQLiteMigrationOptions = {}
): Promise<SQLiteMigrationSummary> {
  const sourceStore = new InventoryStore(config.dataFile);
  const data = await sourceStore.withLock(() => sourceStore.read());
  const summary = summarizeData(data, Boolean(options.dryRun), Boolean(options.force));

  if (options.dryRun) {
    return summary;
  }

  const targetStore = new SQLiteInventoryStore(config.databaseFile);
  const targetBackupPath = await backupSQLiteTarget();
  const existing = await targetStore.read();
  if (!options.force && !isEmptyStore(existing)) {
    throw new Error("SQLite inventory tables are not empty. Rerun with --force to overwrite them.");
  }

  const backupPath = await backupJsonSource(data);
  await targetStore.mutate((target) => {
    target.items = clone(data.items);
    target.events = clone(data.events);
    target.schedule = clone(data.schedule);
    target.syncRuns = clone(data.syncRuns);
  });

  return { ...summary, backupPath, targetBackupPath };
}

function summarizeData(data: StoreData, dryRun: boolean, force: boolean): SQLiteMigrationSummary {
  const mappings = data.items.reduce(
    (total, item) => total + platforms.filter((platform) => Boolean(item.mappings[platform])).length,
    0
  );
  const syncMessages = data.syncRuns.reduce((total, run) => total + run.messages.length, 0);

  return {
    databaseFile: config.databaseFile,
    dryRun,
    force,
    items: data.items.length,
    mappings,
    events: data.events.length,
    syncRuns: data.syncRuns.length,
    syncMessages,
    scheduleRows: 1
  };
}

function isEmptyStore(data: StoreData) {
  return data.items.length === 0 && data.events.length === 0 && data.syncRuns.length === 0;
}

async function backupJsonSource(data: StoreData) {
  const backupDirectory = path.resolve(path.join(path.dirname(config.dataFile), "backups"));
  const backupPath = path.join(backupDirectory, `inventory-${backupTimestamp()}.json`);
  await fs.mkdir(backupDirectory, { recursive: true });
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(backupPath, json, "utf8");
  if ((await fs.readFile(backupPath, "utf8")) !== json) throw new Error(`JSON migration backup verification failed: ${backupPath}`);
  return backupPath;
}

async function backupSQLiteTarget() {
  const backupDirectory = path.resolve(path.join(path.dirname(config.databaseFile), "backups"));
  const backupPath = path.join(backupDirectory, `inventory-pre-migration-${backupTimestamp()}.sqlite`);
  let source: Buffer;
  try {
    source = await fs.readFile(config.databaseFile);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  await fs.mkdir(backupDirectory, { recursive: true });
  await fs.writeFile(backupPath, source);
  const copied = await fs.readFile(backupPath);
  if (!source.equals(copied)) throw new Error(`SQLite migration backup verification failed: ${backupPath}`);
  return backupPath;
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
