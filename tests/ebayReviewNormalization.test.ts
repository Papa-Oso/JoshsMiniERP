import assert from "node:assert/strict";
import test from "node:test";
import { decodeHtmlEntities, normalizeFeedbackDate, normalizeFeedbackRow } from "../src/server/ebayReviews/normalization";

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

test("decodes HTML entities in marketplace review content", () => {
  assert.equal(
    decodeHtmlEntities("So far so good! We&#39;ve shared it &amp; it&#x27;s useful."),
    "So far so good! We've shared it & it's useful."
  );
  assert.equal(
    normalizeFeedbackRow({ feedback_text: "I&#39;ve used it", source_item_title: "Kayak &amp; seat clip" }).feedback_text,
    "I've used it"
  );
});
