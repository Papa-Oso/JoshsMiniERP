import assert from "node:assert/strict";
import test from "node:test";

process.env.EBAY_ACCESS_TOKEN = "test-feedback-token";
process.env.EBAY_ENVIRONMENT = "production";
process.env.EBAY_MARKETPLACE_ID = "EBAY_US";

const { importEbayFeedback, toFeedbackRow } = await import("../src/server/ebayFeedback.ts");
const { feedbackKeyFor } = await import("../src/server/ebayReviews/feedbackStore.ts");

test("eBay Feedback API import paginates buyer feedback and preserves images", async () => {
  const offsets: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    offsets.push(url.searchParams.get("offset") || "");
    assert.equal(url.pathname, "/commerce/feedback/v1/feedback");
    assert.equal(url.searchParams.get("user_id"), "seller-name");
    assert.equal(url.searchParams.get("feedback_type"), "FEEDBACK_RECEIVED");
    assert.equal(url.searchParams.get("filter"), "role:SELLER");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-feedback-token");
    const offset = Number(url.searchParams.get("offset"));
    const feedbackEntries = offset === 0 ? [entry("1", "BUYER"), entry("seller-entry", "SELLER")] : [entry("2", "BUYER")];
    return new Response(
      JSON.stringify({
        feedbackEntries,
        pagination: {
          total: 3,
          count: feedbackEntries.length,
          limit: 100,
          offset,
          next: offset === 0 ? "/commerce/feedback/v1/feedback?offset=2" : undefined
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const result = await importEbayFeedback({ username: "seller-name", fetchImpl: fetchImpl as typeof fetch });

  assert.deepEqual(offsets, ["0", "2"]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].buyer_username, "eBay buyer buyer-1");
  assert.equal(result.rows[0].seller_username, "seller-name");
  assert.equal(result.rows[0].feedback_text, "Feedback 1");
  assert.equal(result.rows[0].feedback_image_urls, "https://images.example/ebay-review-1.jpg");
});

test("eBay Feedback API normalization maps neutral and negative ratings", () => {
  assert.equal(toFeedbackRow({ ...entry("neutral", "BUYER"), commentType: "NEUTRAL" }).star_rating, 2);
  assert.equal(toFeedbackRow({ ...entry("negative", "BUYER"), commentType: "NEGATIVE" }).rating, "negative");
});

test("official feedback IDs remain stable when eBay changes descriptive fields", () => {
  const row = toFeedbackRow(entry("stable", "BUYER"));
  assert.equal(feedbackKeyFor(row), feedbackKeyFor({ ...row, feedback_text: "Updated text", feedback_date: "later" }));
});

function entry(id: string, role: "BUYER" | "SELLER") {
  return {
    feedbackId: `feedback-${id}`,
    commentType: "POSITIVE",
    feedbackComment: { commentText: `Feedback ${id}`, state: "ENTERED" },
    providerUserDetail: { userId: role === "BUYER" ? `buyer-${id}` : "seller", role },
    orderLineItemSummary: {
      orderLineItemId: `line-${id}`,
      listingId: `listing-${id}`,
      listingTitle: `Listing ${id}`
    },
    feedbackEnteredDate: "2026-07-10T12:00:00.000Z",
    images: [{ url: `https://images.example/ebay-review-${id}.jpg` }],
    feedbackState: "ENTERED"
  };
}
