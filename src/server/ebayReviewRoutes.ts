import express from "express";
import { z } from "zod";
import { applyFeedbackHistory, loadFeedbackHistory, resetFeedbackHistory } from "./ebayReviews/feedbackStore";
import { enrichRowsWithProducts, productCatalogStatus } from "./ebayReviews/productCatalog";
import { importEbayFeedback } from "./ebayFeedback";
import { importEtsyReviews } from "./etsyReviews";
import { listData } from "./inventoryService";

export const ebayReviewsRouter = express.Router();

const etsyImportSchema = z.object({
  maxPages: z.coerce.number().int().min(1).max(100).default(100),
  scanMode: z.enum(["full", "incremental"]).default("incremental")
});

const ebayImportSchema = z.object({
  maxPages: z.coerce.number().int().min(1).max(100).default(100),
  scanMode: z.enum(["full", "incremental"]).default("incremental")
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

ebayReviewsRouter.post("/etsy-import", asyncHandler(async (req, res) => {
  const input = etsyImportSchema.parse(req.body ?? {});
  const imported = await importEtsyReviews({ maxPages: input.maxPages });
  const preparedRows = await enrichMarketplaceRowsWithInventory(imported.rows, "etsy");
  const history = await applyFeedbackHistory(preparedRows, { scanMode: input.scanMode, platform: "etsy" });
  const latestRows = await enrichRowsWithProducts(history.rows);
  const latestKeys = new Set(latestRows.map((row: Record<string, unknown>) => row.feedback_key).filter(Boolean));
  const allRows = await enrichRowsWithProducts(await loadFeedbackHistory());
  const result: Record<string, unknown> & { rows: Record<string, unknown>[] } = {
    mode: "etsy",
    listings: [],
    latestRows: latestRows.map((row: Record<string, unknown>) => ({ ...row, is_latest: true })),
    rows: allRows.map((row: Record<string, unknown>) => ({ ...row, is_latest: latestKeys.has(row.feedback_key) })),
    warnings: ratingOnlyWarning(imported.rows),
    history: history.stats,
    totalAvailable: imported.totalAvailable
  };
  await appendCatalogWarning(result);
  res.json(result);
}));

ebayReviewsRouter.post("/ebay-import", asyncHandler(async (req, res) => {
  const input = ebayImportSchema.parse(req.body ?? {});
  const savedRows = await loadFeedbackHistory();
  const sellerUsernames = [
    ...new Set(
      savedRows
        .filter((row: Record<string, unknown>) => row.platform === "ebay")
        .map((row: Record<string, unknown>) => String(row.seller_username || "").trim())
        .filter(Boolean)
    )
  ];
  if (sellerUsernames.length !== 1) {
    throw new Error(
      sellerUsernames.length === 0
        ? "No saved eBay seller username is available for the Feedback API import."
        : "Multiple saved eBay seller usernames were found; the Feedback API import requires one seller account."
    );
  }
  const imported = await importEbayFeedback({ username: String(sellerUsernames[0]), maxPages: input.maxPages });
  const preparedRows = await enrichMarketplaceRowsWithInventory(imported.rows, "ebay");
  const history = await applyFeedbackHistory(preparedRows, { scanMode: input.scanMode, platform: "ebay" });
  const latestRows = await enrichRowsWithProducts(history.rows);
  const latestKeys = new Set(latestRows.map((row: Record<string, unknown>) => row.feedback_key).filter(Boolean));
  const allRows = await enrichRowsWithProducts(await loadFeedbackHistory());
  const result: Record<string, unknown> & { rows: Record<string, unknown>[] } = {
    mode: "ebay-api",
    listings: [],
    latestRows: latestRows.map((row: Record<string, unknown>) => ({ ...row, is_latest: true })),
    rows: allRows.map((row: Record<string, unknown>) => ({ ...row, is_latest: latestKeys.has(row.feedback_key) })),
    warnings: [],
    history: history.stats,
    totalAvailable: imported.totalAvailable
  };
  await appendCatalogWarning(result);
  res.json(result);
}));

function ratingOnlyWarning(rows: Array<Record<string, unknown>>) {
  const count = rows.filter((row) => !String(row.feedback_text ?? "").trim()).length;
  return count
    ? [`Etsy returned ${count} rating-only review${count === 1 ? "" : "s"}. They are saved locally but omitted from Judge.me CSV because Judge.me requires review text.`]
    : [];
}

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

async function enrichMarketplaceRowsWithInventory(rows: Array<Record<string, unknown>>, platform: "etsy" | "ebay") {
  const data = await listData();
  const byListingId = new Map<string, (typeof data.items)[number]>();
  for (const item of data.items) {
    const listingId = item.mappings[platform]?.listingId;
    if (listingId) byListingId.set(String(listingId), item);
  }

  return rows.map((row) => {
    const item = byListingId.get(String(row.source_item_id ?? ""));
    return item
      ? {
          ...row,
          source_item_title: item.name,
          matched_item_id: item.sku,
          matched_item_title: item.name,
          product_sku: item.sku,
          match_type: "listing-id"
        }
      : row;
  });
}

function asyncHandler(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res, next).catch(next);
  };
}
