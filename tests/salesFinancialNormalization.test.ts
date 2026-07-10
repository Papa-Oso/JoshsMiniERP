import assert from "node:assert/strict";
import test from "node:test";
import { toEbayOrder, toEtsyOrder } from "../src/server/salesImporters";

test("normalizes eBay product, discounted shipping, tax, and comparable sales", () => {
  const order = toEbayOrder({
    orderId: "order-1", creationDate: "2026-07-10T00:00:00.000Z", orderPaymentStatus: "PAID", orderFulfillmentStatus: "FULFILLED",
    pricingSummary: {
      total: { value: "41", currency: "USD" }, priceSubtotal: { value: "30", currency: "USD" },
      deliveryCost: { value: "10", currency: "USD" }, deliveryDiscount: { value: "-2", currency: "USD" },
      priceDiscount: { value: "-1", currency: "USD" }, tax: { value: "4", currency: "USD" }
    }, lineItems: []
  });
  assert.equal(order.shippingAmount, 8);
  assert.equal(order.discountAmount, 1);
  assert.equal(order.taxAmount, 4);
  assert.equal(order.comparableSalesAmount, 37);
});

test("normalizes Etsy buyer-paid shipping while excluding tax from comparable sales", () => {
  const money = (amount: number) => ({ amount, divisor: 100, currency_code: "USD" });
  const order = toEtsyOrder({
    receipt_id: 1, create_timestamp: 1_752_105_600, status: "Completed",
    total_price: money(4_100), subtotal: money(3_000), total_shipping_cost: money(800),
    total_tax_cost: money(300), total_vat_cost: money(0), discount_amt: money(100), transactions: []
  });
  assert.equal(order.productAmount, 30);
  assert.equal(order.shippingAmount, 8);
  assert.equal(order.taxAmount, 3);
  assert.equal(order.comparableSalesAmount, 38);
});
