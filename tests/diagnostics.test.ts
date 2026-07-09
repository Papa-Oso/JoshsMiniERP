import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StoreData } from "../src/shared/types";

const timestamp = "2026-01-01T00:00:00.000Z";
const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-doctor-"));
const dataFile = path.join(tempDir, "inventory.json");

process.env.DATA_FILE = dataFile;
process.env.STORE_DRIVER = "json";
process.env.NODE_ENV = "";
process.env.ERP_API_TOKEN = "";
process.env.SHOPIFY_SHOP_DOMAIN = "";
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "";
process.env.SHOPIFY_CLIENT_ID = "";
process.env.SHOPIFY_CLIENT_SECRET = "";
process.env.EBAY_CLIENT_ID = "";
process.env.EBAY_CLIENT_SECRET = "";
process.env.EBAY_REFRESH_TOKEN = "";
process.env.ETSY_KEYSTRING = "";
process.env.ETSY_SHARED_SECRET = "";
process.env.ETSY_ACCESS_TOKEN = "";
process.env.ETSY_REFRESH_TOKEN = "";

const { runDoctor } = await import("../src/server/diagnostics.ts");

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("doctor reports local store, inventory, backup, and marketplace health", async () => {
  await writeStore(seedStore());
  await mkdir(path.join(tempDir, "backups"), { recursive: true });
  await writeFile(path.join(tempDir, "backups", "operational-backup-20260101T000000Z.json"), "{}\n", "utf8");

  const result = await runDoctor();

  assert.equal(result.status, "warn");
  assert.equal(result.summary.error, 0);
  assert.equal(hasCheck(result, "Storage", "driver", "warn"), true);
  assert.equal(hasCheck(result, "Inventory", "read", "ok"), true);
  assert.equal(hasCheck(result, "Inventory", "sku uniqueness", "ok"), true);
  assert.equal(hasCheck(result, "Inventory", "low stock", "warn"), true);
  assert.equal(hasCheck(result, "Backup", "manifest", "ok"), true);
  assert.equal(hasCheck(result, "Marketplace", "shopify", "warn"), true);
});

test("doctor flags duplicate active SKUs as an error", async () => {
  const data = seedStore();
  data.items.push({
    ...data.items[0],
    id: "item-2",
    quantity: 5,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await writeStore(data);

  const result = await runDoctor();
  assert.equal(result.status, "error");
  assert.equal(hasCheck(result, "Inventory", "sku uniqueness", "error"), true);
});

function hasCheck(
  result: Awaited<ReturnType<typeof runDoctor>>,
  area: string,
  check: string,
  status: "ok" | "warn" | "error"
) {
  return result.checks.some((candidate) => candidate.area === area && candidate.check === check && candidate.status === status);
}

function seedStore(): StoreData {
  return {
    items: [
      {
        id: "item-1",
        sku: "LOCAL-SKU",
        name: "Local SKU",
        quantity: 1,
        safetyStock: 2,
        maxInventory: 50,
        active: true,
        mappings: {},
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    events: [],
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
