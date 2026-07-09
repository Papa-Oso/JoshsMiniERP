import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StoreData } from "../src/shared/types";

const timestamp = "2026-01-01T00:00:00.000Z";
const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-data-tools-"));
const dataFile = path.join(tempDir, "inventory.json");
const printingFile = path.join(tempDir, "printing.json");
const feedbackFile = path.join(tempDir, "feedback.sqlite");

process.env.DATA_FILE = dataFile;
process.env.PRINTING_DATA_FILE = printingFile;
process.env.FEEDBACK_DATA_FILE = feedbackFile;
process.env.STORE_DRIVER = "json";
process.env.SHOPIFY_SHOP_DOMAIN = "";
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "";
process.env.SHOPIFY_CLIENT_ID = "";
process.env.SHOPIFY_CLIENT_SECRET = "";

const { exportInventoryCsv, exportInventoryEventsCsv, exportOperationsReportCsv, inspectOperationalBackup } = await import(
  "../src/server/dataTools.ts"
);

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

test("operations report CSV export writes review tables", async () => {
  await writeStore(seedStore());

  const outputDirectory = path.join(tempDir, "reports", "review");
  const result = await exportOperationsReportCsv(outputDirectory);
  assert.equal(result.path, outputDirectory);
  assert.equal(result.files?.length, 10);
  assert.equal(result.itemCount >= 2, true);

  const mappingHealth = await readFile(path.join(outputDirectory, "mapping-health.csv"), "utf8");
  const inventoryEvents = await readFile(path.join(outputDirectory, "recent-inventory-events.csv"), "utf8");
  const lowInventory = await readFile(path.join(outputDirectory, "low-inventory.csv"), "utf8");
  const instructionTrends = await readFile(path.join(outputDirectory, "instruction-trends.csv"), "utf8");
  const negativeFeedback = await readFile(path.join(outputDirectory, "negative-feedback.csv"), "utf8");

  assert.match(mappingHealth, /^sku,name,platform,status,message/m);
  assert.match(mappingHealth, /MUG-1,"Mug, Blue",shopify,missing_config/);
  assert.match(inventoryEvents, /2026-01-01T00:00:00.000Z,event-1,MUG-1,item-1,batch_add,4,12,local/);
  assert.match(lowInventory, /^sku,name,quantity,safety_stock,max_inventory/m);
  assert.match(instructionTrends, /^instruction_id,label,on_hand,low_alert,max_inventory,recent_delta,event_count,status/m);
  assert.match(negativeFeedback, /^platform,rating,buyer_username,item_title,feedback_date,last_seen_at,feedback_text/m);
});

test("backup inspection checks manifest files without restoring", async () => {
  const backupDirectory = path.join(tempDir, "backups");
  await mkdir(backupDirectory, { recursive: true });
  const inventoryBackup = path.join(backupDirectory, "inventory.json");
  const sqliteBackup = path.join(backupDirectory, "inventory.sqlite");
  await writeFile(inventoryBackup, "{}\n", "utf8");
  await writeFile(sqliteBackup, "sqlite", "utf8");
  const manifestPath = path.join(backupDirectory, "operational-backup-20260101T000000Z.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        createdAt: timestamp,
        itemCount: 1,
        files: [inventoryBackup, sqliteBackup],
        missingSources: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const restorable = await inspectOperationalBackup();
  assert.equal(restorable.path, manifestPath);
  assert.equal(restorable.restorable, true);
  assert.equal(restorable.files.length, 2);
  assert.equal(restorable.files.every((file) => file.exists), true);

  await unlink(sqliteBackup);
  const missingFile = await inspectOperationalBackup(manifestPath);
  assert.equal(missingFile.restorable, false);
  assert.equal(missingFile.files.some((file) => !file.exists && file.path === sqliteBackup), true);
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
