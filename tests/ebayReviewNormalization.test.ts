import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFeedbackDate, normalizeFeedbackRow } from "../src/server/ebayReviews/normalization";

test("normalizes eBay feedback dates that include adjacent action text", () => {
  assert.equal(normalizeFeedbackDate("Past monthReply"), "Past month");
  assert.equal(normalizeFeedbackDate("Past 6 months Reply"), "Past 6 months");
  assert.equal(normalizeFeedbackDate("More than a year agoReplyRevision Closed"), "More than a year ago");
  assert.equal(normalizeFeedbackDate("Jan 4, 2026Reply"), "Jan 4, 2026");
});

test("normalizes feedback rows without changing other fields", () => {
  assert.deepEqual(
    normalizeFeedbackRow({
      feedback_date: "Past monthReply",
      feedback_text: "Great item."
    }),
    {
      feedback_date: "Past month",
      feedback_text: "Great item."
    }
  );
});
