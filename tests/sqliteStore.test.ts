import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
