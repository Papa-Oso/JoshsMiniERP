import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

test("forced migrate-sqlite preserves and verifies the previous SQLite target", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-sqlite-force-migration-"));
  const dataFile = path.join(tempDir, "inventory.json");
  const databaseFile = path.join(tempDir, "inventory.sqlite");
  const previousDataFile = config.dataFile;
  const previousDatabaseFile = config.databaseFile;

  try {
    config.dataFile = dataFile;
    config.databaseFile = databaseFile;
    const previous = seedStore();
    previous.items[0].sku = "PREVIOUS-SKU";
    previous.items[0].name = "Previous item";
    await new SQLiteInventoryStore(databaseFile).mutate((data) => Object.assign(data, previous));
    await writeFile(dataFile, `${JSON.stringify(seedStore(), null, 2)}\n`, "utf8");

    const result = await migrateJsonToSQLite({ force: true });
    const backup = await new SQLiteInventoryStore(result.targetBackupPath!).read();
    const migrated = await new SQLiteInventoryStore(databaseFile).read();

    assert.match(result.targetBackupPath ?? "", /inventory-pre-migration-\d+T\d+Z\.sqlite$/);
    assert.equal(backup.items[0].sku, "PREVIOUS-SKU");
    assert.equal(migrated.items[0].sku, "NEON-MUG");
  } finally {
    config.dataFile = previousDataFile;
    config.databaseFile = previousDatabaseFile;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("failed forced migration preserves the target and supports a clean retry", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-sqlite-failed-migration-"));
  const dataFile = path.join(tempDir, "inventory.json");
  const databaseFile = path.join(tempDir, "inventory.sqlite");
  const previousDataFile = config.dataFile;
  const previousDatabaseFile = config.databaseFile;

  try {
    config.dataFile = dataFile;
    config.databaseFile = databaseFile;
    const previous = seedStore();
    previous.items[0].sku = "PRESERVED-SKU";
    previous.items[0].name = "Preserved item";
    await new SQLiteInventoryStore(databaseFile).mutate((data) => Object.assign(data, previous));

    const invalid = seedStore();
    invalid.items[0].name = undefined as unknown as string;
    await writeFile(dataFile, `${JSON.stringify(invalid, null, 2)}\n`, "utf8");
    await assert.rejects(() => migrateJsonToSQLite({ force: true }));

    const backups = await readdir(path.join(tempDir, "backups"));
    assert.equal(backups.some((file) => /^inventory-pre-migration-.*\.sqlite$/.test(file)), true);
    let stored = await new SQLiteInventoryStore(databaseFile).read();
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0].sku, "PRESERVED-SKU");

    await writeFile(dataFile, `${JSON.stringify(seedStore(), null, 2)}\n`, "utf8");
    await migrateJsonToSQLite({ force: true });
    await migrateJsonToSQLite({ force: true });
    stored = await new SQLiteInventoryStore(databaseFile).read();
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0].sku, "NEON-MUG");
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

test("partial legacy sales schema upgrades idempotently with financial history incomplete", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-partial-sales-schema-"));
  const databaseFile = path.join(tempDir, "inventory.sqlite");
  const legacySalesFile = path.join(tempDir, "missing-legacy-sales.sqlite");
  const previousDatabaseFile = config.databaseFile;
  const previousLegacySalesFile = process.env.SALES_DATABASE_FILE;

  try {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), "node_modules", "sql.js", "dist", file)
    });
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE sales_orders (
        platform TEXT NOT NULL,
        order_id TEXT NOT NULL,
        order_number TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        currency TEXT NOT NULL DEFAULT 'USD',
        gross_amount REAL NOT NULL DEFAULT 0,
        net_amount REAL NOT NULL DEFAULT 0,
        country_code TEXT NOT NULL DEFAULT '',
        region_code TEXT NOT NULL DEFAULT '',
        item_count INTEGER NOT NULL DEFAULT 0,
        source_url TEXT NOT NULL DEFAULT '',
        last_seen_at TEXT NOT NULL,
        product_amount REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (platform, order_id)
      );
      INSERT INTO sales_orders (
        platform, order_id, order_number, created_at, updated_at, status,
        currency, gross_amount, net_amount, country_code, region_code,
        item_count, source_url, last_seen_at, product_amount
      ) VALUES (
        'ebay', 'legacy-order', 'legacy-order', '${timestamp}', '${timestamp}', 'PAID',
        'USD', 20, 15, 'US', 'IL', 1, '', '${timestamp}', 0
      );
    `);
    await writeFile(databaseFile, Buffer.from(db.export()));
    db.close();

    config.databaseFile = databaseFile;
    process.env.SALES_DATABASE_FILE = legacySalesFile;
    const { loadSalesOrders, upsertSalesOrders } = await import("../src/server/salesStore.ts");

    let orders = await loadSalesOrders();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].grossAmount, 20);
    assert.equal(orders[0].productAmount, 0);
    assert.equal(orders[0].comparableSalesAmount, 0);
    assert.equal(orders[0].financialsComplete, false);
    assert.equal(orders[0].reconciliationState, "incomplete");

    await upsertSalesOrders("ebay", orders);
    await upsertSalesOrders("ebay", orders);
    orders = await loadSalesOrders();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].grossAmount, 20);
    assert.equal(orders[0].financialsComplete, false);
    assert.equal(orders[0].reconciliationState, "incomplete");
  } finally {
    config.databaseFile = previousDatabaseFile;
    if (previousLegacySalesFile === undefined) delete process.env.SALES_DATABASE_FILE;
    else process.env.SALES_DATABASE_FILE = previousLegacySalesFile;
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
