import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StoreData } from "../src/shared/types";

const timestamp = "2026-01-01T00:00:00.000Z";
const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-data-tools-"));
const dataFile = path.join(tempDir, "inventory.json");

process.env.DATA_FILE = dataFile;
process.env.STORE_DRIVER = "json";

const { exportInventoryCsv, exportInventoryEventsCsv } = await import("../src/server/dataTools.ts");

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("inventory CSV export writes spreadsheet-friendly item and mapping columns", async () => {
  await writeStore(seedStore());

  const inline = await exportInventoryCsv();
  assert.equal(inline.itemCount, 1);
  assert.match(inline.csv ?? "", /^sku,name,description,quantity,safety_stock,max_inventory,active/m);
  assert.match(inline.csv ?? "", /MUG-1,"Mug, Blue","Bright ""blue"" mug",12,2,40,true/);
  assert.match(inline.csv ?? "", /true,SHOP-MUG-1,,gid:\/\/shopify\/InventoryItem\/1,gid:\/\/shopify\/Location\/1/);

  const outputPath = path.join(tempDir, "exports", "items.csv");
  const written = await exportInventoryCsv(outputPath);
  assert.equal(written.path, outputPath);
  assert.equal(written.itemCount, 1);
  assert.equal(await readFile(outputPath, "utf8"), inline.csv);
});

test("inventory event CSV export writes movement history rows", async () => {
  await writeStore(seedStore());

  const inline = await exportInventoryEventsCsv();
  assert.equal(inline.itemCount, 1);
  assert.match(inline.csv ?? "", /^id,created_at,sku,item_id,type,delta,quantity_after,source,platform,note/m);
  assert.match(inline.csv ?? "", /event-1,2026-01-01T00:00:00.000Z,MUG-1,item-1,batch_add,4,12,local,,"Restock, blue shelf"/);

  const outputPath = path.join(tempDir, "exports", "events.csv");
  const written = await exportInventoryEventsCsv(outputPath);
  assert.equal(written.path, outputPath);
  assert.equal(written.itemCount, 1);
  assert.equal(await readFile(outputPath, "utf8"), inline.csv);
});

function seedStore(): StoreData {
  return {
    items: [
      {
        id: "item-1",
        sku: "MUG-1",
        name: "Mug, Blue",
        description: 'Bright "blue" mug',
        quantity: 12,
        safetyStock: 2,
        maxInventory: 40,
        active: true,
        mappings: {
          shopify: {
            enabled: true,
            remoteSku: "SHOP-MUG-1",
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
        sku: "MUG-1",
        type: "batch_add",
        delta: 4,
        quantityAfter: 12,
        source: "local",
        note: "Restock, blue shelf",
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

async function writeStore(data: StoreData) {
  await writeFile(dataFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
