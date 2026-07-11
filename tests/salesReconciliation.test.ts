import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSales } from "../src/server/salesService";
import type { SalesOrder, SalesRefund } from "../src/shared/types";

const now = Date.parse("2026-07-10T12:00:00.000Z");

test("reconciles comparable sales without tax or canceled orders", () => {
  const orders = [
    order({ orderId: "paid", productAmount: 30, shippingAmount: 8, discountAmount: 2, taxAmount: 3, comparableSalesAmount: 36, financialsComplete: true, reconciliationState: "complete" }),
    order({ orderId: "canceled", productAmount: 20, shippingAmount: 5, taxAmount: 2, comparableSalesAmount: 25, status: "Canceled", canceledAt: "2026-07-10T11:00:00.000Z", financialsComplete: true })
  ];
  const refunds = [refund({ orderId: "paid", productAmount: 5, shippingAmount: 1, taxAmount: 0.5, totalAmount: 6.5, componentsComplete: true })];
  const payload = reconcileSales({ orders, refunds, pulls: [{ platform: "etsy", pulled_at: "2026-07-10T11:00:00.000Z" }], financials: [], range: "30d", platform: "etsy", now });
  assert.equal(payload.rows[0].importedOrders, 2);
  assert.equal(payload.rows[0].includedOrders, 1);
  assert.equal(payload.rows[0].excludedTax, 3);
  assert.equal(payload.rows[0].refunds, 6);
  assert.equal(payload.rows[0].comparableNetSales, 32);
});

test("applies full and partial Etsy refunds once and leaves unresolved totals excluded", () => {
  const orders = [
    order({ orderId: "full", productAmount: 20, shippingAmount: 5, comparableSalesAmount: 25 }),
    order({ orderId: "partial", productAmount: 30, shippingAmount: 4, comparableSalesAmount: 34 })
  ];
  const refunds = [
    refund({ orderId: "full", refundId: "full", productAmount: 20, shippingAmount: 5, taxAmount: 2, totalAmount: 27 }),
    refund({ orderId: "partial", refundId: "partial", productAmount: 6, shippingAmount: 0, taxAmount: 0.5, totalAmount: 6.5 }),
    refund({ orderId: "partial", refundId: "unresolved", totalAmount: 3, componentsComplete: false })
  ];
  const payload = reconcileSales({ orders, refunds, pulls: [{ platform: "etsy", pulled_at: "2026-07-10T11:00:00.000Z" }], financials: [], range: "30d", platform: "etsy", now });
  assert.equal(payload.rows[0].refunds, 31);
  assert.equal(payload.rows[0].comparableNetSales, 28);
  assert.equal(payload.warnings.find((warning) => warning.code === "unresolved_refund")?.count, 1);
});

test("separates currencies and reports unresolved integrity categories without identifiers", () => {
  const orders = [order({ orderId: "usd", financialsComplete: false, reconciliationState: "unresolved" }), order({ orderId: "eur", currency: "EUR", financialsComplete: true, comparableSalesAmount: -1 })];
  const refunds = [refund({ orderId: "usd", refundId: "unresolved", totalAmount: 4, componentsComplete: false }), refund({ orderId: "missing", refundId: "unmatched", totalAmount: 2, refundedAt: "2026-07-10T10:00:00.000Z", componentsComplete: false })];
  const payload = reconcileSales({ orders, refunds, pulls: [], financials: [], range: "30d", platform: "etsy", now });
  assert.deepEqual(payload.rows.map((row) => row.currency), ["EUR", "USD"]);
  assert.ok(payload.warnings.some((warning) => warning.code === "mixed_currency"));
  assert.ok(payload.warnings.some((warning) => warning.code === "unmatched_refund"));
  assert.ok(payload.warnings.some((warning) => warning.code === "unresolved_refund"));
  assert.ok(payload.warnings.some((warning) => warning.code === "missing_breakdown"));
  assert.ok(payload.warnings.some((warning) => warning.code === "impossible_total"));
  assert.ok(payload.warnings.some((warning) => warning.code === "stale_pull"));
  assert.equal("orderId" in payload.rows[0], false);
  assert.equal("refundId" in payload.warnings[0], false);
});

test("reports eBay fees, labels, net proceeds, and API/report disagreement", () => {
  const payload = reconcileSales({ orders: [order({ platform: "ebay", orderId: "api-order" })], refunds: [], pulls: [{ platform: "ebay", pulled_at: "2026-07-10T11:00:00.000Z" }], financials: [
    { transactionDate: "2026-07-10T10:00:00.000Z", type: "Order", orderId: "report-order", feeAmount: -3, grossAmount: 30, netAmount: 27, currency: "USD" },
    { transactionDate: "2026-07-10T10:00:00.000Z", type: "Shipping label", orderId: "api-order", feeAmount: 0, grossAmount: -4, netAmount: -4, currency: "USD" }
  ], range: "30d", platform: "ebay", currency: "USD", now });
  assert.equal(payload.rows[0].fees, 3);
  assert.equal(payload.rows[0].shippingLabels, 4);
  assert.equal(payload.rows[0].netProceeds, 23);
  assert.ok(payload.warnings.some((warning) => warning.code === "api_report_disagreement"));
});

function order(overrides: Partial<SalesOrder> = {}): SalesOrder {
  return { platform: "etsy", orderId: "order", orderNumber: "order", createdAt: "2026-07-10T09:00:00.000Z", updatedAt: "2026-07-10T09:00:00.000Z", status: "Completed", currency: "USD", grossAmount: 41, netAmount: 30, productAmount: 30, shippingAmount: 8, discountAmount: 0, taxAmount: 3, refundedAmount: 0, comparableSalesAmount: 38, financialsComplete: true, financialsSource: "order_api", financialsUpdatedAt: "2026-07-10T09:00:00.000Z", reconciliationState: "complete", countryCode: "US", regionCode: "IL", itemCount: 1, sourceUrl: "", lineItems: [], ...overrides };
}
function refund(overrides: Partial<SalesRefund> = {}): SalesRefund {
  return { platform: "etsy", orderId: "order", refundId: "refund", refundedAt: "2026-07-10T10:00:00.000Z", productAmount: 0, shippingAmount: 0, taxAmount: 0, totalAmount: 0, status: "completed", currency: "USD", componentsComplete: true, source: "payment_api", sourceUpdatedAt: "2026-07-10T10:00:00.000Z", ...overrides };
}
