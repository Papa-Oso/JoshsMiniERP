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
    feedback_date: normalizeFeedbackDate(row.feedback_date),
    ...(Object.hasOwn(row, "feedback_text") ? { feedback_text: decodeHtmlEntities(row.feedback_text) } : {}),
    ...(Object.hasOwn(row, "source_item_title") ? { source_item_title: decodeHtmlEntities(row.source_item_title) } : {}),
    ...(Object.hasOwn(row, "matched_item_title") ? { matched_item_title: decodeHtmlEntities(row.matched_item_title) } : {})
  };
}

export function decodeHtmlEntities(value: unknown) {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: "\u00a0",
    quot: '"'
  };

  return String(value ?? "").replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (entity, decimal, hexadecimal, named) => {
    if (decimal) return safeCodePoint(Number.parseInt(decimal, 10), entity);
    if (hexadecimal) return safeCodePoint(Number.parseInt(hexadecimal, 16), entity);
    return namedEntities[String(named).toLowerCase()] ?? entity;
  });
}

function safeCodePoint(codePoint: number, fallback: string) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
