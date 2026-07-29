import assert from "node:assert/strict";
import test from "node:test";
import { buildEtsyInventoryUpdatePayload } from "../src/server/adapters/etsy";

test("Etsy inventory updates omit provider-managed response fields", () => {
  const payload = buildEtsyInventoryUpdatePayload({
    products: [
      {
        product_id: 101,
        sku: "TEST-SKU",
        is_deleted: false,
        offerings: [
          {
            offering_id: 202,
            quantity: 7,
            is_enabled: true,
            is_deleted: false,
            price: { amount: 1299, divisor: 100, currency_code: "USD" },
            readiness_state_id: 303
          }
        ],
        property_values: [
          {
            property_id: 404,
            property_name: "Size",
            scale_id: 505,
            scale_name: "US",
            value_ids: [606],
            values: ["Large"],
            value_pairs: [{ value_id: 606, value: "Large" }]
          }
        ]
      }
    ],
    price_on_property: [],
    quantity_on_property: [404],
    sku_on_property: [404],
    readiness_state_on_property: []
  });

  assert.deepEqual(payload, {
    products: [
      {
        sku: "TEST-SKU",
        offerings: [
          {
            quantity: 7,
            price: 12.99,
            is_enabled: true,
            readiness_state_id: 303
          }
        ],
        property_values: [
          {
            property_id: 404,
            property_name: "Size",
            scale_id: 505,
            value_ids: [606],
            values: ["Large"]
          }
        ]
      }
    ],
    price_on_property: [],
    quantity_on_property: [404],
    sku_on_property: [404],
    readiness_state_on_property: []
  });
});
