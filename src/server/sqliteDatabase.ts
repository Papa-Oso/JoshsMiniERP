import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

interface DatabaseContext { db: Database; dirty: boolean }
let SQL: SqlJsStatic | undefined;
const managers = new Map<string, SQLiteDatabaseManager>();

export function sqliteDatabase(databaseFile: string) {
  const resolved = path.resolve(databaseFile);
  let manager = managers.get(resolved);
  if (!manager) {
    manager = new SQLiteDatabaseManager(resolved);
    managers.set(resolved, manager);
  }
  return manager;
}

export class SQLiteDatabaseManager {
  private readonly context = new AsyncLocalStorage<DatabaseContext>();
  private queue = Promise.resolve();
  constructor(readonly databaseFile: string) {}

  async read<T>(callback: (db: Database) => T | Promise<T>) {
    return this.run(callback, false);
  }

  async write<T>(callback: (db: Database) => T | Promise<T>) {
    return this.run(callback, true);
  }

  private async run<T>(callback: (db: Database) => T | Promise<T>, write: boolean): Promise<T> {
    const active = this.context.getStore();
    if (active) {
      if (write) active.dirty = true;
      return callback(active.db);
    }

    const execute = async () => {
      const db = await this.open();
      const context: DatabaseContext = { db, dirty: write };
      return this.context.run(context, async () => {
        try { return await callback(db); }
        finally {
          if (context.dirty) await this.save(db);
          db.close();
        }
      });
    };
    const next = this.queue.then(execute, execute);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async open() {
    SQL ??= await initSqlJs({ locateFile: (file) => path.resolve("node_modules", "sql.js", "dist", file) });
    await fs.mkdir(path.dirname(this.databaseFile), { recursive: true });
    try { return new SQL.Database(await fs.readFile(this.databaseFile)); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code !== "ENOENT") throw error;
      return new SQL.Database();
    }
  }

  private async save(db: Database) {
    const temporaryPath = `${this.databaseFile}.tmp`;
    await fs.writeFile(temporaryPath, Buffer.from(db.export()));
    await fs.rename(temporaryPath, this.databaseFile);
  }
}
