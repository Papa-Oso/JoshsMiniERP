import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SalesOrder } from "../src/shared/types";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "joshs-erp-sales-"));
process.env.DATABASE_FILE = path.join(directory, "inventory.sqlite");
process.env.DATA_FILE = path.join(directory, "inventory.json");
process.env.SALES_DATABASE_FILE = path.join(directory, "legacy-sales.sqlite");
const {
  applySalesImport,
  loadSalesOrders,
  loadSalesRefunds,
  upsertSalesOrders,
  upsertSalesRefunds
} = await import("../src/server/salesStore.ts");
const { getSalesDashboard, aggregateProjectionHistory } = await import("../src/server/salesService.ts");
const { SQLiteInventoryStore } = await import("../src/server/sqliteStore.ts");
const { replaceReviewProductAliases } = await import("../src/server/ebayReviews/feedbackStore.ts");

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
  assert.equal(dashboard.financialSummaries.length, 0);
  assert.ok(dashboard.warnings.some((warning) => /1 included order does not yet have/.test(warning)));
  assert.ok(dashboard.warnings.some((warning) => /Shopify automated cost data has not been pulled yet/.test(warning)));
});

test("automated marketplace financial summary includes fees, labels, and API coverage", async () => {
  const financial = (
    overrides: Partial<Parameters<typeof applySalesImport>[3][number]> = {}
  ): Parameters<typeof applySalesImport>[3][number] => ({
    platform: "ebay",
    transactionKey: "financial-order",
    transactionDate: "2026-07-10T12:00:00.000Z",
    type: "SALE",
    orderId: "financial-order",
    feeAmount: -10,
    grossAmount: 100,
    refundAmount: 0,
    shippingLabelAmount: null,
    netAmount: 90,
    currency: "USD",
    ...overrides
  });
  await applySalesImport(
    "ebay",
    [
      {
        ...order(),
        platform: "ebay",
        orderId: "ebay-before-financial-coverage",
        createdAt: "2026-07-09T12:00:00.000Z",
        updatedAt: "2026-07-09T12:00:00.000Z"
      }
    ],
    [],
    [
      financial(),
      financial({
        transactionKey: "other-fee",
        transactionDate: "2026-07-11T12:00:00.000Z",
        type: "NON_SALE_CHARGE",
        feeAmount: -4,
        grossAmount: 0,
        netAmount: -4
      }),
      financial({
        transactionKey: "fee-credit",
        transactionDate: "2026-07-12T12:00:00.000Z",
        type: "REFUND",
        feeAmount: 2,
        grossAmount: 0,
        refundAmount: -18,
        netAmount: -18
      }),
      financial({
        transactionKey: "shipping-label",
        transactionDate: "2026-07-13T12:00:00.000Z",
        type: "SHIPPING_LABEL",
        feeAmount: 0,
        grossAmount: 0,
        shippingLabelAmount: -3,
        netAmount: -3
      })
    ],
    {
      status: "partial",
      message: "PayPal-funded labels are excluded.",
      coverageStart: "2026-07-10T00:00:00.000Z",
      coverageEnd: "2026-07-14T00:00:00.000Z",
      accountActivityAvailable: true,
      shippingLabelsAvailable: true
    }
  );
  await applySalesImport("ebay", [], [], [], {
    status: "partial",
    message: "PayPal-funded labels are excluded.",
    coverageStart: "2026-07-11T00:00:00.000Z",
    coverageEnd: "2026-07-15T00:00:00.000Z",
    accountActivityAvailable: true,
    shippingLabelsAvailable: true
  });
  const dashboard = await getSalesDashboard({ range: "all", platform: "all" });
  const summary = dashboard.financialSummaries.find((row) => row.platform === "ebay");
  assert.equal(summary?.fees, 12);
  assert.equal(summary?.shippingLabels, 3);
  assert.equal(summary?.netActivity, 65);
  assert.equal(summary?.coverageStart, "2026-07-10T00:00:00.000Z");
  assert.equal(summary?.coverageEnd, "2026-07-15T00:00:00.000Z");
  assert.equal(summary?.accountActivityAvailable, true);
  assert.deepEqual(summary?.limitations, ["PayPal-funded labels are excluded."]);
  assert.ok(
    dashboard.warnings.some((warning) =>
      /eBay automated costs begin .+; earlier orders in this selection/.test(warning)
    ),
    dashboard.warnings.join("\n")
  );
});

test("automated financial availability distinguishes labels from account activity", async () => {
  await applySalesImport(
    "shopify",
    [],
    [],
    [
      {
        platform: "shopify",
        transactionKey: "label-only",
        transactionDate: "2026-07-10T12:00:00.000Z",
        type: "SHIPPING_LABEL",
        orderId: "",
        grossAmount: 0,
        feeAmount: 0,
        refundAmount: 0,
        shippingLabelAmount: -7,
        netAmount: -7,
        currency: "USD"
      }
    ],
    {
      status: "partial",
      message: "Shopify Payments activity is unavailable.",
      coverageStart: "2026-01-01T06:00:00.000Z",
      coverageEnd: "2026-07-29T12:00:00.000Z",
      accountActivityAvailable: false,
      shippingLabelsAvailable: true
    }
  );
  const dashboard = await getSalesDashboard({ range: "all", platform: "shopify" });
  assert.equal(dashboard.financialSummaries[0]?.accountActivityAvailable, false);
  assert.equal(dashboard.financialSummaries[0]?.shippingLabels, 7);
});

test("sales dashboard accepts an inclusive custom date period", async () => {
  await upsertSalesOrders("shopify", [
    order({
      orderId: "custom-period-order",
      orderNumber: "#CUSTOM",
      createdAt: "2025-02-03T23:59:59.000Z",
      updatedAt: "2025-02-03T23:59:59.000Z"
    })
  ]);
  const dashboard = await getSalesDashboard({
    range: "custom",
    platform: "shopify",
    startDate: "2025-02-03",
    endDate: "2025-02-03"
  });
  assert.equal(dashboard.summary.orders, 1);
  assert.equal(dashboard.trend[0]?.date, "2025-02-03");
  assert.deepEqual(dashboard.period, { startDate: "2025-02-03", endDate: "2025-02-03" });
});

test("sales dashboard last year covers the complete previous UTC calendar year", async () => {
  const year = new Date().getUTCFullYear() - 1;
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;
  await upsertSalesOrders("shopify", [
    order({
      orderId: "last-year-first-day",
      orderNumber: "#LAST-YEAR-START",
      createdAt: `${startDate}T00:00:00.000Z`,
      updatedAt: `${startDate}T00:00:00.000Z`
    }),
    order({
      orderId: "last-year-final-day",
      orderNumber: "#LAST-YEAR-END",
      createdAt: `${endDate}T23:59:59.999Z`,
      updatedAt: `${endDate}T23:59:59.999Z`
    }),
    order({
      orderId: "last-year-outside",
      orderNumber: "#LAST-YEAR-OUTSIDE",
      createdAt: `${year + 1}-01-01T00:00:00.000Z`,
      updatedAt: `${year + 1}-01-01T00:00:00.000Z`
    })
  ]);

  const dashboard = await getSalesDashboard({ range: "last_year", platform: "shopify" });
  const orderIds = new Set(dashboard.recentOrders.map((row) => row.orderId));
  assert.deepEqual(dashboard.period, { startDate, endDate });
  assert.equal(orderIds.has("last-year-first-day"), true);
  assert.equal(orderIds.has("last-year-final-day"), true);
  assert.equal(orderIds.has("last-year-outside"), false);
});

test("Etsy ledger refresh removes legacy buyer-currency payment rows", async () => {
  const pull = {
    status: "partial" as const,
    message: "Transfers are excluded.",
    coverageStart: "2026-01-01T00:00:00.000Z",
    coverageEnd: "2026-08-26T00:00:00.000Z",
    accountActivityAvailable: true,
    shippingLabelsAvailable: true
  };
  await applySalesImport("etsy", [], [], [{
    platform: "etsy", transactionKey: "payment:legacy-buyer-currency", transactionDate: "2026-08-25T00:00:00.000Z",
    type: "PAYMENT", orderId: "", grossAmount: 50, feeAmount: -3, refundAmount: 0,
    shippingLabelAmount: null, netAmount: 47, currency: "CAD"
  }], pull);
  await applySalesImport("etsy", [], [], [{
    platform: "etsy", transactionKey: "ledger:usd-payment", transactionDate: "2026-08-25T00:00:00.000Z",
    type: "PAYMENT_GROSS", orderId: "", grossAmount: 36, feeAmount: 0, refundAmount: 0,
    shippingLabelAmount: null, netAmount: 36, currency: "USD"
  }], pull);

  const dashboard = await getSalesDashboard({ range: "all", platform: "etsy" });
  assert.deepEqual(dashboard.financialSummaries.map((row) => row.currency), ["USD"]);
  assert.equal(dashboard.financialSummaries[0]?.grossSales, 36);
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

test("incomplete historical reports preserve legacy totals without inventing comparable components", async () => {
  await upsertSalesOrders("ebay", [{
    ...order(), platform: "ebay", orderId: "historical-incomplete", grossAmount: 41, netAmount: 30,
    financialsComplete: false, financialsSource: "order_report", reconciliationState: "incomplete"
  }]);
  const saved = (await loadSalesOrders()).find((row) => row.orderId === "historical-incomplete");
  assert.equal(saved?.grossAmount, 41);
  assert.equal(saved?.netAmount, 30);
  assert.equal(saved?.productAmount, 0);
  assert.equal(saved?.shippingAmount, 0);
  assert.equal(saved?.comparableSalesAmount, 0);
  assert.equal(saved?.financialsComplete, false);
  assert.equal(saved?.reconciliationState, "incomplete");
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

test("sales financial upserts preserve authoritative values and fill only missing fields", async () => {
  const id = "source-precedence";
  await upsertSalesOrders("etsy", [{
    ...order(), platform: "etsy", orderId: id, productAmount: 30, shippingAmount: undefined,
    taxAmount: 3, comparableSalesAmount: 30, financialsComplete: false,
    financialsSource: "order_api", financialsUpdatedAt: "2026-07-10T12:00:00.000Z"
  }]);
  await upsertSalesOrders("etsy", [{
    ...order(), platform: "etsy", orderId: id, productAmount: 999, shippingAmount: 8,
    taxAmount: 999, comparableSalesAmount: 999, financialsComplete: true,
    financialsSource: "order_report", financialsUpdatedAt: "2026-07-11T12:00:00.000Z"
  }]);
  let saved = (await loadSalesOrders()).find((row) => row.orderId === id);
  assert.equal(saved?.productAmount, 30);
  assert.equal(saved?.shippingAmount, 8);
  assert.equal(saved?.taxAmount, 3);
  assert.equal(saved?.financialsSource, "order_api");
  assert.equal(saved?.financialsComplete, false);

  await upsertSalesOrders("etsy", [{
    ...order(), platform: "etsy", orderId: id, productAmount: 31, shippingAmount: 9,
    taxAmount: 4, comparableSalesAmount: 40, financialsComplete: true,
    financialsSource: "payment_api", financialsUpdatedAt: "2026-07-09T12:00:00.000Z",
    reconciliationState: "complete"
  }]);
  saved = (await loadSalesOrders()).find((row) => row.orderId === id);
  assert.equal(saved?.productAmount, 31);
  assert.equal(saved?.shippingAmount, 9);
  assert.equal(saved?.financialsSource, "payment_api");
  assert.equal(saved?.financialsComplete, true);
  assert.equal(saved?.reconciliationState, "complete");
});

test("atomic sales imports apply unresolved totals as capped full refunds", async () => {
  const base = { ...order(), platform: "etsy" as const, orderId: "etsy-refunds", productAmount: 30, shippingAmount: 8, comparableSalesAmount: 38, financialsComplete: true, reconciliationState: "complete" as const };
  const refund = { platform: "etsy" as const, orderId: base.orderId, refundedAt: "2026-07-10T14:00:00.000Z", status: "completed", currency: "USD", source: "payment_api", sourceUpdatedAt: "2026-07-10T14:00:00.000Z" };
  await applySalesImport("etsy", [base], [{ ...refund, refundId: "complete", productAmount: 5, shippingAmount: 2, taxAmount: 1, totalAmount: 8, componentsComplete: true }, { ...refund, refundId: "unresolved", productAmount: 0, shippingAmount: 0, taxAmount: 0, totalAmount: 4, componentsComplete: false }]);
  const saved = (await loadSalesOrders()).find((row) => row.orderId === base.orderId);
  assert.equal(saved?.refundedAmount, 11);
  assert.equal(saved?.reconciliationState, "complete");
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

test("Top Products resolves missing historical SKUs through product title aliases", async () => {
  const inventory = new SQLiteInventoryStore(process.env.DATABASE_FILE);
  await inventory.mutate((data) => {
    const item = data.items.find((row) => row.sku === "SKU-1");
    assert.ok(item);
    item.imagePath = "SKU-1.png";
  });
  await replaceReviewProductAliases([{ title: "Marketplace Product Title", sku: "SKU-1" }]);
  await upsertSalesOrders("ebay", [{
    ...order(), platform: "ebay", orderId: "historical-product-alias", lineItems: [{
      platform: "ebay", orderId: "historical-product-alias", lineId: "alias-line", sku: "", title: "Marketplace Product Title", quantity: 1, amount: 18
    }]
  }]);

  const dashboard = await getSalesDashboard({ range: "all", platform: "ebay" });
  const product = dashboard.products.find((row) => row.sku === "SKU-1");
  assert.equal(product?.title, "Product");
  assert.equal(product?.imageUrl, "/api/product-images/SKU-1.png");
});

test("Top Products uses short S-R7 names without photos while preserving canonical names and source titles", async () => {
  const inventory = new SQLiteInventoryStore(process.env.DATABASE_FILE);
  const before = await inventory.read();
  const title = "Alpinestars S-R7 Helmet Adapter for Cardo Packtalk Edge – 3D Printed Carbon Fiber Mount";
  const lines = ["JW-AR7-EDGE-001", "jw-ar7-freecom-001", "JW-AR7-EDGE-002"].map((sku) => ({
    platform: "etsy" as const, orderId: "short-names", lineId: sku, sku, title, quantity: 1, amount: 10
  }));
  await upsertSalesOrders("etsy", [order({ platform: "etsy", orderId: "short-names", lineItems: lines })]);
  let dashboard = await getSalesDashboard({ range: "all", platform: "etsy" });
  assert.equal(dashboard.products.find((row) => row.sku === lines[0].sku)?.title, "S-R7 Edge");
  assert.equal(dashboard.products.find((row) => row.sku === lines[1].sku)?.title, "S-R7 Freecom");
  assert.equal(dashboard.products.find((row) => row.sku === lines[2].sku)?.title, title);
  const savedLines = (await loadSalesOrders()).find((row) => row.orderId === "short-names")?.lineItems;
  assert.ok(savedLines);
  for (const line of lines) assert.deepEqual(savedLines.find((saved) => saved.lineId === line.lineId), line);
  assert.deepEqual(await inventory.read(), before);

  await inventory.mutate((data) => {
    data.items.push({ ...data.items[0], id: "short-name-override", sku: lines[0].sku, name: "Custom S-R7 Edge", active: true });
  });
  try {
    dashboard = await getSalesDashboard({ range: "all", platform: "etsy" });
    assert.equal(dashboard.products.find((row) => row.sku === lines[0].sku)?.title, "Custom S-R7 Edge");
  } finally {
    await inventory.mutate((data) => { data.items = data.items.filter((item) => item.id !== "short-name-override"); });
  }
});

test("Top Products uses exact SKU photos for new products without creating inventory", async () => {
  const photos = path.join(directory, "product photos");
  await fs.mkdir(photos, { recursive: true });
  await fs.writeFile(path.join(photos, "JW-AR7-EDGE-001-front.png"), "fixture");
  await fs.writeFile(path.join(photos, "JW-AR7-FREECOM-001.png"), "fixture");
  const inventory = new SQLiteInventoryStore(process.env.DATABASE_FILE);
  const before = await inventory.read();
  const skus = ["JW-AR7-EDGE-001", "JW-AR7-FREECOM-001", "JW-AR7-EDGE-002"];
  await upsertSalesOrders("shopify", [order({
    orderId: "new-products",
    lineItems: skus.map((sku) => ({
      platform: "shopify", orderId: "new-products", lineId: sku, sku,
      title: `Marketplace ${sku}`, quantity: 1, amount: 10
    }))
  })]);
  const dashboard = await getSalesDashboard({ range: "all", platform: "shopify" });
  assert.equal(dashboard.products.find((row) => row.sku === skus[0])?.imageUrl, "/api/product-images/JW-AR7-EDGE-001-front.png");
  assert.equal(dashboard.products.find((row) => row.sku === skus[1])?.imageUrl, "/api/product-images/JW-AR7-FREECOM-001.png");
  assert.equal(dashboard.products.find((row) => row.sku === skus[0])?.title, "S-R7 Edge");
  assert.equal(dashboard.products.find((row) => row.sku === skus[1])?.title, "S-R7 Freecom");
  assert.equal(dashboard.products.find((row) => row.sku === skus[2])?.imageUrl, undefined);
  assert.deepEqual(await inventory.read(), before);
});

test("projection baseline uses complete recent months, including zero-sale months and varying month lengths", () => {
  const history = aggregateProjectionHistory([
    order({ createdAt: "2026-05-15T12:00:00.000Z" }),
    order({ createdAt: "2026-07-10T12:00:00.000Z", grossAmount: 310, itemCount: 3 }),
    order({ createdAt: "2026-08-10T12:00:00.000Z", grossAmount: 620, itemCount: 6 }),
    order({ createdAt: "2026-09-02T12:00:00.000Z", grossAmount: 99999 })
  ], Date.parse("2026-09-03T12:00:00Z"));
  assert.deepEqual(history, [
    { month: "2026-06", days: 30, revenue: 0, orders: 0, units: 0 },
    { month: "2026-07", days: 31, revenue: 310, orders: 1, units: 3 },
    { month: "2026-08", days: 31, revenue: 620, orders: 1, units: 6 }
  ]);
  assert.deepEqual(aggregateProjectionHistory([order({ createdAt: "2026-08-10T12:00:00.000Z" })], Date.parse("2026-09-03")), []);
});

test("projection history remains available outside the selected period and respects the platform filter", async () => {
  const now = new Date();
  const createdAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 4, 1)).toISOString();
  await upsertSalesOrders("shopify", [order({ orderId: "projection-coverage", createdAt })]);
  const all = await getSalesDashboard({ range: "all", platform: "shopify" });
  const month = await getSalesDashboard({ range: "month", platform: "shopify" });
  assert.equal(month.projectionHistory?.length, 3);
  assert.deepEqual(month.projectionHistory, all.projectionHistory);
  const eligible = (await loadSalesOrders()).filter((row) => row.platform === "shopify");
  assert.deepEqual(month.projectionHistory, aggregateProjectionHistory(eligible));
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
