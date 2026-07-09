import express from "express";
import { z } from "zod";
import { applyFeedbackHistory, loadFeedbackHistory, resetFeedbackHistory } from "./ebayReviews/feedbackStore";
import { enrichRowsWithProducts, productCatalogStatus } from "./ebayReviews/productCatalog";
import { scrapeEbayFeedback } from "./ebayReviews/scraper";

export const ebayReviewsRouter = express.Router();

const scrapeSchema = z.object({
  url: z.string().min(1),
  mode: z.enum(["auto", "listing", "seller", "store"]).default("auto"),
  maxItems: z.coerce.number().int().min(1).max(250).default(25),
  maxPages: z.coerce.number().int().min(1).max(100).default(8),
  allowManualVerification: z.coerce.boolean().default(true),
  scanMode: z.enum(["full", "incremental"]).default("full"),
  useSavedSession: z.coerce.boolean().default(true)
});

ebayReviewsRouter.get("/feedback-history", asyncHandler(async (_req, res) => {
  const rows = await enrichRowsWithProducts(await loadFeedbackHistory());
  const payload = {
    mode: "history",
    listings: [],
    rows: rows.map((row: Record<string, unknown>) => ({ ...row, is_latest: false })),
    latestRows: [],
    warnings: [],
    history: {
      scan_mode: "history",
      rows_seen: rows.length,
      rows_exported: 0,
      new_rows: 0,
      skipped_existing_rows: 0
    }
  };

  await appendCatalogWarning(payload);
  res.json(payload);
}));

ebayReviewsRouter.post("/scrape", asyncHandler(async (req, res) => {
  const input = scrapeSchema.parse(req.body ?? {});

  const result: Record<string, unknown> & { rows: Record<string, unknown>[] } = await scrapeEbayFeedback({
    inputUrl: input.url,
    mode: input.mode,
    maxItems: input.maxItems,
    maxPages: input.maxPages,
    allowManualVerification: input.allowManualVerification,
    useSavedSession: input.useSavedSession
  });

  const history = await applyFeedbackHistory(result.rows, { scanMode: input.scanMode });
  const latestRows = await enrichRowsWithProducts(history.rows);
  const latestKeys = new Set(latestRows.map((row: Record<string, unknown>) => row.feedback_key).filter(Boolean));
  const allRows = await enrichRowsWithProducts(await loadFeedbackHistory());

  result.latestRows = latestRows.map((row: Record<string, unknown>) => ({ ...row, is_latest: true }));
  result.rows = allRows.map((row: Record<string, unknown>) => ({ ...row, is_latest: latestKeys.has(row.feedback_key) }));
  result.history = history.stats;
  await appendCatalogWarning(result);
  res.json(result);
}));

ebayReviewsRouter.post("/feedback-history/reset", asyncHandler(async (_req, res) => {
  res.json(await resetFeedbackHistory());
}));

async function appendCatalogWarning(payload: Record<string, unknown> & { warnings?: string[] }) {
  const catalog = await productCatalogStatus();
  if (!catalog.missing) return;

  payload.warnings = [
    ...(payload.warnings || []),
    "Product catalog CSV was not found, so product_handle values are blank."
  ];
}

function asyncHandler(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res, next).catch(next);
  };
}
