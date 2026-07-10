import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-feedback-"));
const feedbackFile = path.join(tempDir, "feedback.sqlite");
const databaseFile = path.join(tempDir, "inventory.sqlite");
process.env.DATABASE_FILE = databaseFile;

process.env.FEEDBACK_DATA_FILE = feedbackFile;

const { anonymizeFeedbackUsernames, applyFeedbackHistory, loadFeedbackHistory, loadFeedbackScanRuns, resetFeedbackHistory } =
  await import("../src/server/ebayReviews/feedbackStore.ts");

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("feedback store tracks rows and scan runs in the configured SQLite file", async () => {
  const full = await applyFeedbackHistory([feedbackRow("1"), feedbackRow("2")], { scanMode: "full" });
  assert.equal(full.stats.database_path, databaseFile);
  assert.equal(full.stats.rows_seen, 2);
  assert.equal(full.stats.rows_exported, 2);
  assert.equal(full.stats.new_rows, 2);

  const incremental = await applyFeedbackHistory([feedbackRow("1"), feedbackRow("3")], { scanMode: "incremental" });
  assert.equal(incremental.stats.rows_seen, 2);
  assert.equal(incremental.stats.rows_exported, 1);
  assert.equal(incremental.stats.new_rows, 1);
  assert.equal(incremental.stats.skipped_existing_rows, 1);

  const history = await loadFeedbackHistory();
  const scanRuns = await loadFeedbackScanRuns();

  assert.equal(history.length, 3);
  assert.equal(scanRuns.length, 2);
  assert.equal(scanRuns[0].scan_mode, "incremental");
  assert.equal(scanRuns[0].rows_exported, 1);
  assert.equal(scanRuns[1].scan_mode, "full");
  assert.equal(scanRuns[1].platform, "ebay");

  const etsy = await applyFeedbackHistory(
    [{ ...feedbackRow("etsy-1"), platform: "etsy", star_rating: 2, rating: "negative" }],
    { scanMode: "incremental", platform: "etsy" }
  );
  assert.equal(etsy.stats.platform, "etsy");
  assert.equal((await loadFeedbackHistory()).find((row) => row.feedback_id === "etsy-1")?.platform, "etsy");

  const anonymized = await anonymizeFeedbackUsernames(["buyer-2"], {
    replacementFactory: () => "deleted-silver-river-test"
  });
  assert.equal(anonymized.checkedUsernames, 1);
  assert.equal(anonymized.matchedRows, 1);
  assert.equal(anonymized.changedRows, 1);

  const anonymizedHistory = await loadFeedbackHistory();
  assert.equal(anonymizedHistory.find((row) => row.feedback_id === "2")?.buyer_username, "deleted-silver-river-test");
  assert.equal(anonymizedHistory.find((row) => row.feedback_id === "1")?.buyer_username, "buyer-1");

  const noMatch = await anonymizeFeedbackUsernames(["missing-buyer"]);
  assert.equal(noMatch.matchedRows, 0);
  assert.equal(noMatch.changedRows, 0);

  const reset = await resetFeedbackHistory();
  assert.equal(reset.deleted_rows, 4);
  assert.equal((await loadFeedbackHistory()).length, 0);
  assert.equal((await loadFeedbackScanRuns()).length, 0);
});

function feedbackRow(id: string) {
  return {
    feedback_id: id,
    seller_username: "seller",
    source_item_id: `item-${id}`,
    source_item_title: `Item ${id}`,
    matched_item_id: `item-${id}`,
    matched_item_title: `Item ${id}`,
    rating: "positive",
    buyer_username: `buyer-${id}`,
    feedback_date: "Jan 1, 2026",
    feedback_text: `Great item ${id}`,
    source_listing_url: `https://www.ebay.com/itm/${id}`,
    matched_item_url: `https://www.ebay.com/itm/${id}`,
    feedback_profile_url: "https://feedback.ebay.com/fdbk/feedback_profile/seller",
    match_type: "exact"
  };
}
