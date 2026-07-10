import assert from "node:assert/strict";
import test from "node:test";
import { parseEbaySalesCsv } from "../src/server/ebaySalesCsv";

test("parses and groups eBay Seller Hub order report rows", () => {
  const csv = [
    ",,,,,,,,,,,,,",
    '"Order Number","Transaction ID","Item Number","Item Title","Custom Label","Quantity","Sold For","Total Price","Sale Date","Paid On Date","Shipped On Date","Ship To Country","Ship To State"',
    '"order-1","transaction-1","item-1","First item","SKU-1","2","$5.00","$13.00","Jul 1, 2024 10:00:00 AM","Jul 1, 2024","Jul 2, 2024","United States","CA"',
    '"","transaction-2","item-2","Second item","SKU-2","1","$3.00","$13.00","Jul 1, 2024 10:00:00 AM","Jul 1, 2024","Jul 2, 2024","United States","CA"'
  ].join("\n");
  const orders = parseEbaySalesCsv(csv);
  assert.equal(orders.length, 1); assert.equal(orders[0].lineItems.length, 2); assert.equal(orders[0].itemCount, 3);
  assert.equal(orders[0].grossAmount, 13); assert.equal(orders[0].netAmount, 13); assert.equal(orders[0].countryCode, "US");
});
