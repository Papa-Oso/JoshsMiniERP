import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { SalesOrder } from "../src/shared/types";

const directory = await mkdtemp(path.join(os.tmpdir(), "erp-product-catalog-"));
process.env.STORE_DRIVER = "sqlite";
process.env.DATABASE_FILE = path.join(directory, "inventory.sqlite");
process.env.DATA_FILE = path.join(directory, "inventory.json");
process.env.SALES_DATABASE_FILE = path.join(directory, "sales.sqlite");
process.env.FEEDBACK_DATA_FILE = path.join(directory, "feedback.sqlite");
process.env.PRINTING_DATA_FILE = path.join(directory, "printing.json");
process.env.PRODUCT_PHOTO_DIR = path.join(directory, "photos");
const { findMissingInventoryProducts, listMissingInventoryProducts } = await import("../src/server/productCatalog.ts");
const { createItem, listData, updateItem, adjustInventory } = await import("../src/server/inventoryService.ts");
const { upsertSalesOrders, loadSalesOrders } = await import("../src/server/salesStore.ts");
const { getSalesDashboard } = await import("../src/server/salesService.ts");
const { closeStore } = await import("../src/server/store.ts");
after(async () => {
  await closeStore();
  await rm(directory, { recursive: true, force: true });
});

test("discovery deduplicates exact SKUs, excludes owned and missing SKUs, and keeps variants distinct", () => {
  assert.deepEqual(findMissingInventoryProducts([{ sku: " owned " }], [
    { sku: "OWNED", title: "Existing" },
    { sku: " ", title: "Unknown" },
    { sku: "--", title: "Unknown" },
    { sku: " jw-ar7-edge-001 ", title: "Long marketplace title" },
    { sku: "JW-AR7-EDGE-001", title: "Duplicate" },
    { sku: "JW-AR7-FREECOM-001", title: "Freecom title" },
    { sku: "JW-AR7-EDGE-002", title: "Another variant" }
  ]), [
    { sku: "JW-AR7-EDGE-001", name: "S-R7 Edge" },
    { sku: "JW-AR7-EDGE-002", name: "Another variant" },
    { sku: "JW-AR7-FREECOM-001", name: "S-R7 Freecom" }
  ]);
});

test("saved sales stay read-only until enrollment; zero-stock enrollment is shared and inactive SKUs stay owned", async () => {
  const order: SalesOrder = {
    platform: "shopify", orderId: "old-order", orderNumber: "1", status: "PAID", currency: "USD",
    createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z",
    grossAmount: 30, netAmount: 30, countryCode: "US", regionCode: "IL", itemCount: 30, sourceUrl: "",
    lineItems: Array.from({ length: 30 }, (_, index) => ({
      platform: "shopify", orderId: "old-order", lineId: String(index), sku: `NEW-${index}`,
      title: `Marketplace ${index}`, quantity: 1, amount: 1
    }))
  };
  await upsertSalesOrders("shopify", [order]);
  const before = await listData();
  const salesBefore = await loadSalesOrders();
  assert.equal((await listMissingInventoryProducts()).length, 30, "includes old sales beyond the Top Products limit");
  assert.deepEqual(await listData(), before, "discovery must not enroll stock or mappings");
  const item = await createItem({ sku: "NEW-0", name: "Canonical product", quantity: 0 });
  assert.equal(item.active, true);
  assert.deepEqual(item.mappings, {});
  assert.equal((await listData()).items.find((candidate) => candidate.id === item.id)?.quantity, 0);
  assert.equal((await listMissingInventoryProducts()).some((product) => product.sku === item.sku), false);
  assert.equal((await getSalesDashboard({ range: "all" })).products.find((product) => product.sku === item.sku)?.title, "Canonical product");
  await adjustInventory(item.id, { delta: 3, type: "batch_add" });
  assert.equal((await listData()).items.find((candidate) => candidate.id === item.id)?.quantity, 3);
  await updateItem(item.id, { active: false });
  assert.equal((await listMissingInventoryProducts()).some((product) => product.sku === item.sku), false);
  await assert.rejects(createItem({ sku: " new-0 ", name: "Duplicate", quantity: 0 }), /already exists/);
  assert.deepEqual(await loadSalesOrders(), salesBefore, "enrollment and adjustments preserve the sales ledger");
});
