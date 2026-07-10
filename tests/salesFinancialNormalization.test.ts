import assert from "node:assert/strict";
import test from "node:test";
import { ebayRefunds, etsyRefunds, toEbayOrder, toEtsyOrder } from "../src/server/salesImporters";

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

test("keeps authoritative eBay refund totals unresolved when components are unavailable", () => {
  const refunds = ebayRefunds({ orderId: "order-1", creationDate: "2026-07-10T00:00:00.000Z", paymentSummary: { refunds: [{ refundId: "refund-1", refundStatus: "COMPLETED", refundDate: "2026-07-11T00:00:00.000Z", amount: { value: "12.50", currency: "USD" } }] } });
  assert.equal(refunds[0].totalAmount, 12.5);
  assert.equal(refunds[0].componentsComplete, false);
  assert.equal(refunds[0].productAmount, 0);
});

test("splits recognized Etsy refund components and leaves unknown adjustments unresolved", () => {
  const complete = etsyRefunds({ payment_id: 1, receipt_id: 2, currency: "USD", payment_adjustments: [{ payment_adjustment_id: 3, status: "SUCCESS", is_success: true, total_adjustment_amount: 1200, create_timestamp: 1_752_105_600, payment_adjustment_items: [{ payment_adjustment_item_id: 4, adjustment_type: "transaction", amount: 900 }, { payment_adjustment_item_id: 5, adjustment_type: "shipping", amount: 200 }, { payment_adjustment_item_id: 6, adjustment_type: "tax", amount: 100 }] }] });
  assert.equal(complete[0].componentsComplete, true);
  assert.equal(complete[0].productAmount, 9);
  assert.equal(complete[0].shippingAmount, 2);
  assert.equal(complete[0].taxAmount, 1);
  const unresolved = etsyRefunds({ payment_id: 1, receipt_id: 2, currency: "USD", payment_adjustments: [{ payment_adjustment_id: 7, total_adjustment_amount: 500, payment_adjustment_items: [{ payment_adjustment_item_id: 8, adjustment_type: "other", amount: 500 }] }] });
  assert.equal(unresolved[0].componentsComplete, false);
  assert.equal(unresolved[0].totalAmount, 5);
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
