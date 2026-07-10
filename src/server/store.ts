import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ImportBatchRecord,
  InventoryEvent,
  InventoryItem,
  PrintAsset,
  PrintingPayload,
  ReconcileRunRecord,
  ScheduleSettings,
  StoreData
} from "../shared/types";
import { config } from "./config";
import { SQLiteInventoryStore } from "./sqliteStore";

const now = () => new Date().toISOString();
const lockTimeoutMs = 60_000;
const staleLockMs = 15 * 60_000;

const defaultData = (): StoreData => ({ items: [], events: [], schedule: defaultSchedule(), syncRuns: [] });
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
  mutateChanges?<T>(mutator: (data: StoreData) => T | Promise<T>): Promise<T>;
  withLock<T>(callback: () => Promise<T>): Promise<T>;
  saveItem?(item: InventoryItem): Promise<void>;
  saveItemWithEvent?(item: InventoryItem, event: InventoryEvent): Promise<void>;
  saveSchedule?(schedule: ScheduleSettings): Promise<void>;
  recordImportBatch?(batch: ImportBatchRecord): Promise<void>;
  listImportBatches?(limit?: number): Promise<ImportBatchRecord[]>;
  readPrintingData?(): Promise<PrintingPayload>;
  mutatePrintingData?<T>(mutator: (data: PrintingPayload) => T | Promise<T>): Promise<T>;
  recordPrintAssets?(assets: PrintAsset[], options?: { replace?: boolean }): Promise<void>;
  listPrintAssetMetadata?(limit?: number): Promise<PrintAsset[]>;
  recordReconcileRun?(run: ReconcileRunRecord): Promise<void>;
  listReconcileRuns?(limit?: number): Promise<ReconcileRunRecord[]>;
  close?(): Promise<void>;
}

/** JSON compatibility store used only for migration and isolated tests. */
export class InventoryStore implements InventoryStoreDriver {
  private writeQueue = Promise.resolve();
  private readonly lockPath: string;
  private readonly lockContext = new AsyncLocalStorage<boolean>();

  constructor(private readonly filePath = config.dataFile) {
    this.lockPath = `${filePath}.lock`;
  }

  async read(): Promise<StoreData> {
    await this.ensureFile();
    return JSON.parse(await fs.readFile(this.filePath, "utf8")) as StoreData;
  }

  async mutate<T>(mutator: (data: StoreData) => T | Promise<T>): Promise<T> {
    const run = async () => this.withLock(async () => {
      const data = await this.read();
      const result = await mutator(data);
      await this.write(data);
      return result;
    });
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async withLock<T>(callback: () => Promise<T>): Promise<T> {
    if (this.lockContext.getStore()) return callback();
    const release = await this.acquireFileLock();
    return this.lockContext.run(true, async () => {
      try { return await callback(); } finally { await release(); }
    });
  }

  private async ensureFile() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try { await fs.access(this.filePath); } catch { await this.write(defaultData()); }
  }

  private async write(data: StoreData) {
    const temporaryPath = `${this.filePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, this.filePath);
  }

  private async acquireFileLock() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const startedAt = Date.now();
    const lockId = randomUUID();
    while (true) {
      try {
        await fs.writeFile(this.lockPath, JSON.stringify({ id: lockId, pid: process.pid, createdAt: now() }), { encoding: "utf8", flag: "wx" });
        return async () => this.releaseFileLock(lockId);
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        await this.removeStaleLock();
        if (Date.now() - startedAt > lockTimeoutMs) throw new Error(`Timed out waiting for inventory store lock at ${this.lockPath}.`);
        await delay(100);
      }
    }
  }

  private async releaseFileLock(lockId: string) {
    try {
      const current = JSON.parse(await fs.readFile(this.lockPath, "utf8")) as { id?: string };
      if (current.id === lockId) await fs.rm(this.lockPath, { force: true });
    } catch (error) { if (!isMissingFileError(error)) throw error; }
  }

  private async removeStaleLock() {
    try {
      const current = JSON.parse(await fs.readFile(this.lockPath, "utf8")) as { createdAt?: string };
      const createdAt = current.createdAt ? Date.parse(current.createdAt) : Number.NaN;
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleLockMs) await fs.rm(this.lockPath, { force: true });
    } catch (error) { if (!isMissingFileError(error)) throw error; }
  }
}

export const store: InventoryStoreDriver = config.storeDriver === "json" ? new InventoryStore() : new SQLiteInventoryStore();

export async function closeStore() {
  await store.close?.();
}

function isFileExistsError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
