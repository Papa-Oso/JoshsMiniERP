import fs from "node:fs/promises";
import path from "node:path";
import type { StoreData } from "../shared/types";
import { config } from "./config";

const now = () => new Date().toISOString();

const defaultData = (): StoreData => ({
  items: [],
  events: [],
  schedule: {
    enabled: false,
    intervalMinutes: 60,
    lastRunAt: null,
    nextRunAt: null,
    updatedAt: now()
  },
  syncRuns: []
});

export class InventoryStore {
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath = config.dataFile) {}

  async read(): Promise<StoreData> {
    await this.ensureFile();
    const raw = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(raw) as StoreData;
  }

  async mutate<T>(mutator: (data: StoreData) => T | Promise<T>): Promise<T> {
    const run = async () => {
      const data = await this.read();
      const result = await mutator(data);
      await this.write(data);
      return result;
    };

    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
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
}

export const store = new InventoryStore();
