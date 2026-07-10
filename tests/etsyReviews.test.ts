import assert from "node:assert/strict";
import test from "node:test";

process.env.ETSY_KEYSTRING = "test-key";
process.env.ETSY_SHARED_SECRET = "test-secret";
process.env.ETSY_SHOP_ID = "12345";

const { importEtsyReviews, toFeedbackRow } = await import("../src/server/etsyReviews.ts");

test("Etsy review import uses the official paginated API and preserves review photos", async () => {
  const requestedOffsets: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requestedOffsets.push(url.searchParams.get("offset") || "");
    assert.equal(url.pathname, "/v3/application/shops/12345/reviews");
    const offset = Number(url.searchParams.get("offset"));
    const results = offset === 0 ? [review(1), review(2)] : [];
    return new Response(JSON.stringify({ count: 2, results }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const result = await importEtsyReviews({ fetchImpl: fetchImpl as typeof fetch });

  assert.deepEqual(requestedOffsets, ["0"]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].platform, "etsy");
  assert.equal(result.rows[0].star_rating, 2);
  assert.equal(result.rows[0].rating, "negative");
  assert.equal(result.rows[0].feedback_image_urls, "https://images.example/review-1.jpg");
  assert.equal(result.rows[0].source_listing_url, "https://www.etsy.com/listing/101");
});

test("Etsy review normalization categorizes three stars as neutral and four stars as positive", () => {
  assert.equal(toFeedbackRow({ ...review(3), rating: 3 }).rating, "neutral");
  assert.equal(toFeedbackRow({ ...review(4), rating: 4 }).rating, "positive");
});

function review(id: number) {
  return {
    shop_id: 12345,
    listing_id: 100 + id,
    transaction_id: 200 + id,
    buyer_user_id: 300 + id,
    rating: id === 1 ? 2 : 5,
    review: `Etsy review ${id}`,
    image_url_fullxfull: `https://images.example/review-${id}.jpg`,
    created_timestamp: 1_767_225_600 + id
  };
}
