import assert from "node:assert/strict";
import test from "node:test";
import { reviewDate, toCsv } from "../src/client/EbayReviewsPage";

test("formats ISO and marketplace dates for Judge.me CSV imports", () => {
  assert.equal(reviewDate("2026-07-10T14:30:00.000Z"), "10/07/2026");
  assert.equal(reviewDate("Jan 4, 2026"), "04/01/2026");
  assert.match(reviewDate(""), /^\d{2}\/\d{2}\/\d{4}$/);
});

test("includes an explicit product SKU column in review CSV exports", () => {
  const csv = toCsv([
    {
      feedback_text: "Great product",
      feedback_date: "2026-07-10T14:30:00.000Z",
      star_rating: 5,
      product_handle: "kayak-seat-clip",
      product_sku: "KAYAK-CLIP-001"
    }
  ]);
  const [header, row] = csv.split("\n");
  assert.match(header, /product_handle,product_sku/);
  assert.match(row, /kayak-seat-clip,KAYAK-CLIP-001/);
});

test("omits generic eBay delivery filler from review CSV exports", () => {
  const csv = toCsv([
    {
      platform: "ebay",
      feedback_text: "Order delivered on time with no issues.",
      feedback_date: "2026-07-10T14:30:00.000Z",
      star_rating: 5,
      product_sku: "SKU-001"
    },
    {
      platform: "ebay",
      feedback_text: "Exactly what I needed.",
      feedback_date: "2026-07-10T14:30:00.000Z",
      star_rating: 5,
      product_sku: "SKU-001"
    }
  ]);
  assert.doesNotMatch(csv, /Order delivered on time/i);
  assert.match(csv, /Exactly what I needed/);
});
