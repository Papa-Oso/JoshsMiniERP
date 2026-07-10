export function dedupeFeedbackRows(rows: Array<Record<string, unknown>>) {
  const unique = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const key = feedbackIdentity(row);
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, row);
      continue;
    }

    if (!existing.feedback_acknowledged_at && row.feedback_acknowledged_at) {
      unique.set(key, { ...existing, feedback_acknowledged_at: row.feedback_acknowledged_at });
    }
  }

  return [...unique.values()];
}

function feedbackIdentity(row: Record<string, unknown>) {
  return [
    row.platform || "ebay",
    row.buyer_username,
    row.source_item_id || row.matched_item_id,
    row.feedback_date,
    row.feedback_text
  ].map(normalizedIdentityPart).join("|");
}

function normalizedIdentityPart(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}
