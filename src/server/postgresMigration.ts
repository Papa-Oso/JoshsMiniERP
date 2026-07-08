import fs from "node:fs/promises";
import path from "node:path";
import type { StoreData } from "../shared/types";
import { platforms } from "../shared/types";
import { config } from "./config";
import { InventoryStore, PostgresInventoryStore } from "./store";

export interface PostgresMigrationOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface PostgresMigrationSummary {
  databaseUrl: string;
  dryRun: boolean;
  force: boolean;
  items: number;
  mappings: number;
  events: number;
  syncRuns: number;
  syncMessages: number;
  scheduleRows: number;
  backupPath?: string;
}

export async function migrateJsonToPostgres(
  options: PostgresMigrationOptions = {}
): Promise<PostgresMigrationSummary> {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required for migrate-postgres.");
  }

  const sourceStore = new InventoryStore(config.dataFile);
  const data = await sourceStore.withLock(() => sourceStore.read());
  const summary = summarizeData(data, Boolean(options.dryRun), Boolean(options.force));

  if (options.dryRun) {
    return summary;
  }

  const postgresStore = new PostgresInventoryStore();
  try {
    const existing = await postgresStore.read();
    if (!options.force && !isEmptyStore(existing)) {
      throw new Error("Postgres inventory tables are not empty. Rerun with --force to overwrite them.");
    }

    const backupPath = await backupJsonSource(data);
    await postgresStore.mutate((target) => {
      target.items = clone(data.items);
      target.events = clone(data.events);
      target.schedule = clone(data.schedule);
      target.syncRuns = clone(data.syncRuns);
    });

    return { ...summary, backupPath };
  } finally {
    await postgresStore.close();
  }
}

function summarizeData(data: StoreData, dryRun: boolean, force: boolean): PostgresMigrationSummary {
  const mappings = data.items.reduce(
    (total, item) => total + platforms.filter((platform) => Boolean(item.mappings[platform])).length,
    0
  );
  const syncMessages = data.syncRuns.reduce((total, run) => total + run.messages.length, 0);

  return {
    databaseUrl: maskedDatabaseUrl(),
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
  await fs.writeFile(backupPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return backupPath;
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function maskedDatabaseUrl() {
  if (!config.databaseUrl) return "";

  try {
    const url = new URL(config.databaseUrl);
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return "DATABASE_URL";
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
