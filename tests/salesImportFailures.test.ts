import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Platform, SalesOrder } from "../src/shared/types";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-sales-import-failures-"));
process.env.STORE_DRIVER = "sqlite";
process.env.DATABASE_FILE = path.join(tempDir, "inventory.sqlite");
process.env.SALES_DATABASE_FILE = path.join(tempDir, "missing-legacy-sales.sqlite");
process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "test-shopify-token";
process.env.EBAY_ACCESS_TOKEN = "test-ebay-token";
process.env.ETSY_API_KEY = "test-etsy-key:test-etsy-secret";
process.env.ETSY_ACCESS_TOKEN = "test-etsy-token";
process.env.ETSY_SHOP_ID = "12345";

const originalFetch = globalThis.fetch;
const { refreshSales } = await import("../src/server/salesService.ts");
const { loadSalesOrders, loadSalesPulls, loadSalesRefunds, upsertSalesOrders } = await import(
  "../src/server/salesStore.ts"
);
const { SQLiteInventoryStore } = await import("../src/server/sqliteStore.ts");
const inventory = new SQLiteInventoryStore(process.env.DATABASE_FILE);

test.before(async () => {
  await inventory.mutate((data) => {
    data.items.push({
      id: "inventory-item",
      sku: "INVENTORY-SKU",
      name: "Inventory item",
      description: "",
      quantity: 7,
      safetyStock: 1,
      maxInventory: 20,
      active: true,
      mappings: {},
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z"
    });
  });
  for (const platform of ["ebay", "etsy", "shopify"] as const) {
    await upsertSalesOrders(platform, [savedOrder(platform)]);
  }
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await rm(tempDir, { recursive: true, force: true });
});

test("eBay timeout, malformed pages, and incomplete refund batches preserve prior state", async () => {
  const inventoryBefore = await inventory.read();

  globalThis.fetch = async () => {
    throw new Error("simulated eBay timeout");
  };
  await expectFailedRefresh("ebay", /timeout/);

  globalThis.fetch = async () => jsonResponse({});
  await expectFailedRefresh("ebay", /malformed page/);

  let page = 0;
  globalThis.fetch = async () => {
    page += 1;
    if (page === 1) {
      return jsonResponse({
        orders: [ebayOrder("new-ebay-order")],
        next: "/sell/fulfillment/v1/order?limit=200&offset=200"
      });
    }
    return jsonResponse({ orders: [ebayOrder("bad-refund-order", { refunds: {} })] });
  };
  await expectFailedRefresh("ebay", /malformed refund batch/);
  await assertPreserved("ebay", ["new-ebay-order", "bad-refund-order"], inventoryBefore);
});

test("Etsy malformed receipts and refund-page failure do not persist buffered orders", async () => {
  const inventoryBefore = await inventory.read();

  globalThis.fetch = async () => jsonResponse({});
  await expectFailedRefresh("etsy", /malformed page/);

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/receipts")) {
      return jsonResponse({ count: 1, results: [etsyReceipt(98765)] });
    }
    if (url.pathname.endsWith("/payment-account/ledger-entries")) {
      return jsonResponse({ count: 1 });
    }
    throw new Error("Unexpected Etsy request in failure test.");
  };
  await expectFailedRefresh("etsy", /payment ledger returned a malformed page/);
  await assertPreserved("etsy", ["98765"], inventoryBefore);
});

test("Shopify malformed and later-page failures do not persist earlier pages", async () => {
  const inventoryBefore = await inventory.read();

  globalThis.fetch = async () => jsonResponse({ data: { orders: {} } });
  await expectFailedRefresh("shopify", /malformed page/);

  let page = 0;
  globalThis.fetch = async () => {
    page += 1;
    if (page === 1) return jsonResponse({ data: shopifyPage("new-shopify-order", true) });
    throw new Error("simulated Shopify pagination timeout");
  };
  await expectFailedRefresh("shopify", /pagination timeout/);
  await assertPreserved("shopify", ["new-shopify-order"], inventoryBefore);
});

async function expectFailedRefresh(platform: Platform, message: RegExp) {
  const result = await refreshSales([platform]);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].platform, platform);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].ordersSeen, 0);
  assert.match(result.results[0].message, message);

  const pull = (await loadSalesPulls()).find((row) => row.platform === platform);
  assert.equal(pull?.status, "error");
  assert.equal(Number(pull?.orders_seen), 0);
  assert.match(String(pull?.message), message);
}

async function assertPreserved(platform: Platform, rejectedOrderIds: string[], inventoryBefore: unknown) {
  const orders = (await loadSalesOrders()).filter((order) => order.platform === platform);
  assert.equal(orders.some((order) => order.orderId === `saved-${platform}-order`), true);
  for (const orderId of rejectedOrderIds) assert.equal(orders.some((order) => order.orderId === orderId), false);
  assert.equal((await loadSalesRefunds()).some((refund) => rejectedOrderIds.includes(refund.orderId)), false);
  assert.deepEqual(await inventory.read(), inventoryBefore);
}

function savedOrder(platform: Platform): SalesOrder {
  return {
    platform,
    orderId: `saved-${platform}-order`,
    orderNumber: `saved-${platform}-order`,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    status: "PAID",
    currency: "USD",
    grossAmount: 10,
    netAmount: 10,
    financialsComplete: false,
    reconciliationState: "incomplete",
    countryCode: "US",
    regionCode: "IL",
    itemCount: 1,
    sourceUrl: "",
    lineItems: []
  };
}

function ebayOrder(orderId: string, paymentSummary?: unknown) {
  return {
    orderId,
    creationDate: "2026-07-12T00:00:00.000Z",
    lastModifiedDate: "2026-07-12T00:00:00.000Z",
    orderPaymentStatus: "PAID",
    orderFulfillmentStatus: "NOT_STARTED",
    pricingSummary: {
      total: { value: "10", currency: "USD" },
      priceSubtotal: { value: "10", currency: "USD" },
      deliveryCost: { value: "0", currency: "USD" },
      tax: { value: "0", currency: "USD" }
    },
    paymentSummary,
    lineItems: []
  };
}

function etsyReceipt(receiptId: number) {
  const money = (amount: number) => ({ amount, divisor: 100, currency_code: "USD" });
  return {
    receipt_id: receiptId,
    create_timestamp: 1_752_278_400,
    update_timestamp: 1_752_278_400,
    status: "Completed",
    total_price: money(1000),
    subtotal: money(1000),
    total_shipping_cost: money(0),
    total_tax_cost: money(0),
    transactions: []
  };
}

function shopifyPage(orderId: string, hasNextPage: boolean) {
  return {
    orders: {
      pageInfo: { hasNextPage, endCursor: hasNextPage ? "next-page" : null },
      nodes: [
        {
          id: `gid://shopify/Order/${orderId}`,
          legacyResourceId: orderId,
          name: "#1001",
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:00.000Z",
          displayFinancialStatus: "PAID",
          displayFulfillmentStatus: "UNFULFILLED",
          currentTotalPriceSet: { shopMoney: { amount: "10", currencyCode: "USD" } },
          currentSubtotalPriceSet: { shopMoney: { amount: "10", currencyCode: "USD" } },
          shippingAddress: null,
          lineItems: { nodes: [] }
        }
      ]
    }
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}
