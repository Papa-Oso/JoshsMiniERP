import assert from "node:assert/strict";
import test from "node:test";
import { judgeMePictureUrls, reviewDate, toCsv } from "../src/client/EbayReviewsPage";

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

test("cleans eBay image query strings for Judge.me picture URLs", () => {
  const first = "https://i.ebayimg.com/00/s/OTAxWDE2MDA=/z/drwAAeSw~LpqUnz1/$_1.JPG?set_id=2";
  const second = "https://i.ebayimg.com/00/s/OTAxWDE2MDA=/z/U~AAAeSwg2pqUnz7/$_1.JPG?set_id=2";
  assert.equal(
    judgeMePictureUrls(`${first},${second}`),
    "https://i.ebayimg.com/00/s/OTAxWDE2MDA=/z/drwAAeSw~LpqUnz1/%24_1.jpg, https://i.ebayimg.com/00/s/OTAxWDE2MDA=/z/U~AAAeSwg2pqUnz7/%24_1.jpg"
  );
});
