export function normalizeFeedbackDate(value: unknown) {
  const text = cleanText(value);
  if (!text) return "";

  const withoutActions = text.replace(/\s*(?:Reply|Revision Closed|Follow[-\s]?up).*$/i, "").trim();
  const explicitDate = withoutActions.match(
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i
  );
  if (explicitDate) return explicitDate[0];

  const relativeDate = withoutActions.match(
    /\b(?:Past\s+(?:month|6 months|year|\d+\s+(?:days?|weeks?|months?|years?))|More than a year ago)\b/i
  );
  if (relativeDate) return relativeDate[0];

  return withoutActions;
}

export function normalizeFeedbackRow<T extends Record<string, unknown>>(row: T) {
  return {
    ...row,
    feedback_date: normalizeFeedbackDate(row.feedback_date)
  };
}

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
