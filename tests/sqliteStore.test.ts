import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import initSqlJs from "sql.js";
import type { StoreData } from "../src/shared/types";
import { config } from "../src/server/config";
import { migrateJsonToSQLite } from "../src/server/sqliteMigration";
import { SQLiteInventoryStore } from "../src/server/sqliteStore";
import { assertInventoryStoreContract } from "./storeContract";

const timestamp = "2026-01-01T00:00:00.000Z";

test("SQLite inventory store persists the inventory store contract", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-sqlite-store-"));
  try {
    await assertInventoryStoreContract(new SQLiteInventoryStore(path.join(tempDir, "inventory.sqlite")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("migrate-sqlite copies JSON inventory into a SQLite database", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-sqlite-migration-"));
  const dataFile = path.join(tempDir, "inventory.json");
  const databaseFile = path.join(tempDir, "inventory.sqlite");
  const previousDataFile = config.dataFile;
  const previousDatabaseFile = config.databaseFile;

  try {
    config.dataFile = dataFile;
    config.databaseFile = databaseFile;
    await writeFile(dataFile, `${JSON.stringify(seedStore(), null, 2)}\n`, "utf8");

    const result = await migrateJsonToSQLite();
    const stored = await new SQLiteInventoryStore(databaseFile).read();

    assert.equal(result.items, 1);
    assert.equal(result.events, 1);
    assert.equal(stored.items[0].sku, "NEON-MUG");
    assert.equal(stored.items[0].mappings.shopify?.enabled, true);
    assert.equal(stored.events[0].note, "Initial count");
    assert.match(result.backupPath ?? "", /inventory-\d+T\d+Z\.json$/);
    assert.ok(await readFile(result.backupPath!, "utf8"));
  } finally {
    config.dataFile = previousDataFile;
    config.databaseFile = previousDatabaseFile;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SQLite schema upgrade adds import history columns used by Review Center", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-sqlite-import-upgrade-"));
  const databaseFile = path.join(tempDir, "inventory.sqlite");

  try {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), "node_modules", "sql.js", "dist", file)
    });
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE import_batches (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        rows_total INTEGER NOT NULL DEFAULT 0,
        rows_created INTEGER NOT NULL DEFAULT 0,
        rows_updated INTEGER NOT NULL DEFAULT 0,
        rows_adjusted INTEGER NOT NULL DEFAULT 0,
        rows_skipped INTEGER NOT NULL DEFAULT 0,
        rows_failed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE import_batch_rows (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        sku TEXT,
        action TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO import_batches (
        id, source, status, rows_total, rows_created, rows_updated,
        rows_adjusted, rows_skipped, rows_failed, created_at
      ) VALUES (
        'batch-1', 'csv', 'applied', 1, 1, 0, 0, 0, 0, '${timestamp}'
      );
      INSERT INTO import_batch_rows (
        id, batch_id, sku, action, message, created_at
      ) VALUES (
        'row-1', 'batch-1', 'NEON-MUG', 'create', 'Created row', '${timestamp}'
      );
    `);
    await writeFile(databaseFile, Buffer.from(db.export()));
    db.close();

    const batches = await new SQLiteInventoryStore(databaseFile).listImportBatches();

    assert.equal(batches.length, 1);
    assert.equal(batches[0].summary.mapped, 0);
    assert.equal(batches[0].summary.variantsScanned, undefined);
    assert.equal(batches[0].rows[0].sku, "NEON-MUG");
    assert.equal(batches[0].rows[0].message, "Created row");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function seedStore(): StoreData {
  return {
    items: [
      {
        id: "item-1",
        sku: "NEON-MUG",
        name: "Neon Mug",
        description: "Bright mug",
        quantity: 12,
        safetyStock: 2,
        maxInventory: 100,
        active: true,
        mappings: {
          shopify: {
            enabled: true,
            remoteSku: "NEON-MUG",
            inventoryItemId: "gid://shopify/InventoryItem/1",
            locationId: "gid://shopify/Location/1",
            lastSyncedQuantity: 12,
            lastRemoteQuantity: 12,
            lastSyncedAt: timestamp,
            warning: null
          }
        },
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    events: [
      {
        id: "event-1",
        itemId: "item-1",
        sku: "NEON-MUG",
        type: "create",
        delta: 12,
        quantityAfter: 12,
        source: "local",
        note: "Initial count",
        createdAt: timestamp
      }
    ],
    schedule: {
      enabled: false,
      intervalMinutes: 60,
      lastRunAt: null,
      nextRunAt: null,
      updatedAt: timestamp
    },
    syncRuns: []
  };
}
