import assert from "node:assert/strict";
import test from "node:test";
import { dedupeFeedbackRows } from "../src/server/ebayReviews/deduplication";

test("deduplicates marketplace feedback by its visible review identity", () => {
  const duplicate = {
    platform: "etsy",
    buyer_username: "Etsy buyer 123",
    source_item_id: "listing-1",
    feedback_date: "2024-05-01T10:16:03.000Z",
    feedback_text: "It took forever to get to me"
  };
  const rows = dedupeFeedbackRows([
    { ...duplicate, feedback_key: "old-key" },
    { ...duplicate, feedback_key: "official-key", feedback_acknowledged_at: "2026-07-10T12:00:00.000Z" },
    { ...duplicate, feedback_key: "different-review", feedback_text: "Different review" }
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].feedback_acknowledged_at, "2026-07-10T12:00:00.000Z");
});
