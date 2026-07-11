import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SalesOrder } from "../src/shared/types";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "joshs-erp-sales-"));
process.env.DATABASE_FILE = path.join(directory, "inventory.sqlite");
process.env.SALES_DATABASE_FILE = path.join(directory, "legacy-sales.sqlite");
const { applySalesImport, loadSalesOrders, loadSalesRefunds, upsertSalesOrders, upsertSalesRefunds } = await import("../src/server/salesStore.ts");
const { getSalesDashboard } = await import("../src/server/salesService.ts");
const { SQLiteInventoryStore } = await import("../src/server/sqliteStore.ts");

test.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });

test("sales ledger upserts stable marketplace orders without duplicates", async () => {
  await upsertSalesOrders("shopify", [order({ grossAmount: 25, itemCount: 2 })]);
  await upsertSalesOrders("shopify", [order({ grossAmount: 30, itemCount: 3 })]);
  const rows = await loadSalesOrders();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].grossAmount, 30);
  assert.equal(rows[0].itemCount, 3);
  assert.equal(rows[0].countryCode, "US");
});

test("sales dashboard aggregates revenue, geography, products, and platform coverage", async () => {
  const dashboard = await getSalesDashboard({ range: "all", platform: "all" });
  assert.equal(dashboard.summary.orders, 1);
  assert.equal(dashboard.summary.revenue, 30);
  assert.equal(dashboard.countries[0].countryCode, "US");
  assert.equal(dashboard.locations[0].regionCode, "IL");
  assert.deepEqual(dashboard.dataQuality, { unknownGeographyOrders: 0, missingSkuLines: 0 });
  assert.equal(dashboard.products[0].sku, "SKU-1");
  assert.equal(dashboard.products[0].title, "Product");
  assert.equal(dashboard.platforms.find((row) => row.platform === "shopify")?.orders, 1);
});

test("inventory and sales share one SQLite file without overwriting each other", async () => {
  const inventory = new SQLiteInventoryStore(process.env.DATABASE_FILE);
  await inventory.mutate((data) => {
    data.items.push({
      id: "item-1", sku: "SKU-1", name: "Product", description: "", quantity: 4,
      safetyStock: 0, maxInventory: 20, active: true, mappings: {},
      createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z"
    });
  });
  await upsertSalesOrders("etsy", [{ ...order(), platform: "etsy", orderId: "etsy-1", lineItems: [] }]);
  assert.equal((await inventory.read()).items.some((item) => item.id === "item-1"), true);
  assert.equal((await loadSalesOrders()).some((row) => row.orderId === "etsy-1"), true);
});

test("Etsy revenue uses merchandise subtotal and excludes canceled receipts", async () => {
  await upsertSalesOrders("etsy", [
    { ...order(), platform: "etsy", orderId: "etsy-completed", status: "Completed", grossAmount: 27, netAmount: 20 },
    { ...order(), platform: "etsy", orderId: "etsy-canceled", status: "Canceled", grossAmount: 15, netAmount: 12 }
  ]);
  const dashboard = await getSalesDashboard({ range: "all", platform: "etsy" });
  assert.equal(dashboard.summary.orders, 2);
  assert.equal(dashboard.summary.revenue, 42);
  assert.equal(dashboard.platforms.find((row) => row.platform === "etsy")?.revenue, 42);
  assert.equal(dashboard.recentOrders.some((row) => row.orderId === "etsy-canceled"), false);
});

test("sales financial components persist and refunds upsert idempotently", async () => {
  await upsertSalesOrders("ebay", [{
    ...order(), platform: "ebay", orderId: "ebay-financial", productAmount: 30, shippingAmount: 8,
    discountAmount: 2, taxAmount: 3, refundedAmount: 0, comparableSalesAmount: 36,
    financialStatus: "paid", financialsComplete: true, financialsSource: "order_api"
  }]);
  const saved = (await loadSalesOrders()).find((row) => row.orderId === "ebay-financial");
  assert.equal(saved?.comparableSalesAmount, 36);
  assert.equal(saved?.taxAmount, 3);
  assert.equal(saved?.financialsComplete, true);

  const refund = { platform: "ebay" as const, orderId: "ebay-financial", refundId: "refund-1", refundedAt: "2026-07-10T13:00:00.000Z", productAmount: 5, shippingAmount: 0, taxAmount: 0.5, totalAmount: 5.5, status: "completed", currency: "USD", componentsComplete: true, source: "order_api", sourceUpdatedAt: "2026-07-10T13:00:00.000Z" };
  await upsertSalesRefunds([refund]);
  await upsertSalesRefunds([{ ...refund, productAmount: 6, totalAmount: 6.5 }]);
  const refunds = (await loadSalesRefunds()).filter((row) => row.orderId === "ebay-financial");
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].productAmount, 6);
});

test("sales order refreshes replace stale comparable sales amounts", async () => {
  const stale = {
    ...order(),
    platform: "etsy" as const,
    orderId: "etsy-refreshed-financials",
    productAmount: 0,
    shippingAmount: 0,
    comparableSalesAmount: 0,
    financialsComplete: false
  };
  await upsertSalesOrders("etsy", [stale]);
  await upsertSalesOrders("etsy", [
    {
      ...stale,
      productAmount: 30,
      shippingAmount: 8,
      comparableSalesAmount: 38,
      financialsComplete: true
    }
  ]);
  const saved = (await loadSalesOrders()).find((row) => row.orderId === stale.orderId);
  assert.equal(saved?.productAmount, 30);
  assert.equal(saved?.shippingAmount, 8);
  assert.equal(saved?.comparableSalesAmount, 38);
});

test("atomic sales imports apply only complete pre-tax refund components to orders", async () => {
  const base = { ...order(), platform: "etsy" as const, orderId: "etsy-refunds", productAmount: 30, shippingAmount: 8, comparableSalesAmount: 38 };
  const refund = { platform: "etsy" as const, orderId: base.orderId, refundedAt: "2026-07-10T14:00:00.000Z", status: "completed", currency: "USD", source: "payment_api", sourceUpdatedAt: "2026-07-10T14:00:00.000Z" };
  await applySalesImport("etsy", [base], [{ ...refund, refundId: "complete", productAmount: 5, shippingAmount: 2, taxAmount: 1, totalAmount: 8, componentsComplete: true }, { ...refund, refundId: "unresolved", productAmount: 0, shippingAmount: 0, taxAmount: 0, totalAmount: 4, componentsComplete: false }]);
  const saved = (await loadSalesOrders()).find((row) => row.orderId === base.orderId);
  assert.equal(saved?.refundedAmount, 7);
  assert.equal(saved?.reconciliationState, "unresolved");
});

test("Top Products treats marketplace placeholder SKUs as missing instead of merging unrelated titles", async () => {
  await upsertSalesOrders("ebay", [{ ...order(), platform: "ebay", orderId: "placeholder-products", lineItems: [
    { platform: "ebay", orderId: "placeholder-products", lineId: "one", sku: "--", title: "First resale item", quantity: 1, amount: 20 },
    { platform: "ebay", orderId: "placeholder-products", lineId: "two", sku: "--", title: "Second resale item", quantity: 1, amount: 15 }
  ] }]);
  const dashboard = await getSalesDashboard({ range: "all", platform: "ebay" });
  assert.equal(dashboard.products.some((row) => row.sku === "--"), false);
  assert.ok(dashboard.products.some((row) => row.title === "First resale item"));
  assert.ok(dashboard.products.some((row) => row.title === "Second resale item"));
});

function order(overrides: Partial<SalesOrder> = {}): SalesOrder {
  return {
    platform: "shopify", orderId: "order-1", orderNumber: "#1001",
    createdAt: "2026-07-10T12:00:00.000Z", updatedAt: "2026-07-10T12:00:00.000Z",
    status: "PAID", currency: "USD", grossAmount: 25, netAmount: 22,
    countryCode: "US", regionCode: "IL", itemCount: 2, sourceUrl: "",
    lineItems: [{ platform: "shopify", orderId: "order-1", lineId: "line-1", sku: "SKU-1", title: "Product", quantity: 2, amount: 22 }],
    ...overrides
  };
}
