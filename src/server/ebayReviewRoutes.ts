import express from "express";
import { z } from "zod";
import {
  applyFeedbackHistory,
  acknowledgeFeedback,
  loadFeedbackHistory,
  loadUnexportedFeedbackHistory,
  markFeedbackExported,
  resetFeedbackExportHistory,
  resetFeedbackHistory
} from "./ebayReviews/feedbackStore";
import { enrichRowsWithProducts, productCatalogStatus } from "./ebayReviews/productCatalog";
import { dedupeFeedbackRows } from "./ebayReviews/deduplication";
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

const refreshSchema = z.object({
  maxPages: z.coerce.number().int().min(1).max(100).default(100),
  exportMode: z.enum(["incremental", "full"]).default("incremental")
});

ebayReviewsRouter.get("/feedback-history", asyncHandler(async (_req, res) => {
  const rows = await enrichReviewRows(await loadFeedbackHistory());
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
  const latestRows = await enrichReviewRows(history.rows);
  const latestKeys = new Set(latestRows.map((row: Record<string, unknown>) => row.feedback_key).filter(Boolean));
  const allRows = await enrichReviewRows(await loadFeedbackHistory());
  const result: Record<string, unknown> & { rows: Record<string, unknown>[] } = {
    mode: "etsy",
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
  const latestRows = await enrichReviewRows(history.rows);
  const latestKeys = new Set(latestRows.map((row: Record<string, unknown>) => row.feedback_key).filter(Boolean));
  const allRows = await enrichReviewRows(await loadFeedbackHistory());
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

ebayReviewsRouter.post("/refresh", asyncHandler(async (req, res) => {
  const input = refreshSchema.parse(req.body ?? {});
  const savedRows = await loadFeedbackHistory();
  const warnings: string[] = [];
  const newRows: Array<Record<string, unknown>> = [];
  let rowsSeen = 0;
  let skippedRows = 0;
  let successfulPlatforms = 0;

  try {
    const sellerUsername = ebaySellerUsername(savedRows);
    const imported = await importEbayFeedback({ username: sellerUsername, maxPages: input.maxPages });
    const prepared = await enrichMarketplaceRowsWithInventory(imported.rows, "ebay");
    const history = await applyFeedbackHistory(prepared, { scanMode: "incremental", platform: "ebay" });
    newRows.push(...history.rows);
    rowsSeen += history.stats.rows_seen;
    skippedRows += history.stats.skipped_existing_rows;
    successfulPlatforms += 1;
  } catch (error) {
    warnings.push(`eBay refresh failed: ${errorMessage(error)}`);
  }

  try {
    const imported = await importEtsyReviews({ maxPages: input.maxPages });
    const prepared = await enrichMarketplaceRowsWithInventory(imported.rows, "etsy");
    const history = await applyFeedbackHistory(prepared, { scanMode: "incremental", platform: "etsy" });
    newRows.push(...history.rows);
    rowsSeen += history.stats.rows_seen;
    skippedRows += history.stats.skipped_existing_rows;
    successfulPlatforms += 1;
  } catch (error) {
    warnings.push(`Etsy refresh failed: ${errorMessage(error)}`);
  }

  if (!successfulPlatforms) throw new Error(warnings.join(" "));

  const newlyDiscoveredRows = await enrichReviewRows(newRows);
  const allRows = await enrichReviewRows(await loadFeedbackHistory());
  const selectedRows = input.exportMode === "full"
    ? allRows
    : await enrichReviewRows(await loadUnexportedFeedbackHistory());
  const exportRows = dedupeFeedbackRows(selectedRows).filter(isCsvEligibleReview);
  const latestKeys = new Set(exportRows.map((row: Record<string, unknown>) => row.feedback_key).filter(Boolean));
  await markFeedbackExported(selectedRows.map((row: Record<string, unknown>) => row.feedback_key));
  const result: Record<string, unknown> & { rows: Record<string, unknown>[] } = {
    mode: "marketplaces",
    listings: [],
    exportMode: input.exportMode,
    exportRows,
    latestRows: exportRows.map((row: Record<string, unknown>) => ({ ...row, is_latest: true })),
    rows: allRows.map((row: Record<string, unknown>) => ({ ...row, is_latest: latestKeys.has(row.feedback_key) })),
    warnings,
    history: {
      scan_mode: "incremental",
      rows_seen: rowsSeen,
      rows_exported: exportRows.length,
      new_rows: newlyDiscoveredRows.length,
      skipped_existing_rows: skippedRows
    }
  };
  await appendCatalogWarning(result);
  res.json(result);
}));

function ebaySellerUsername(savedRows: Array<Record<string, unknown>>) {
  const usernames = [
    ...new Set(
      savedRows
        .filter((row) => row.platform === "ebay")
        .map((row) => String(row.seller_username || "").trim())
        .filter(Boolean)
    )
  ];
  if (usernames.length !== 1) {
    throw new Error(
      usernames.length === 0
        ? "No saved eBay seller username is available for the Feedback API import."
        : "Multiple saved eBay seller usernames were found; the Feedback API import requires one seller account."
    );
  }
  return usernames[0];
}

function isCsvEligibleReview(row: Record<string, unknown>) {
  return Boolean(String(row.feedback_text ?? "").trim()) && !isGenericEbayFeedback(row);
}

function isGenericEbayFeedback(row: Record<string, unknown>) {
  if ((row.platform || "ebay") !== "ebay") return false;
  const text = String(row.feedback_text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return text === "order delivered on time with no issues";
}

ebayReviewsRouter.post("/feedback-history/reset", asyncHandler(async (_req, res) => {
  res.json(await resetFeedbackHistory());
}));

ebayReviewsRouter.post("/export-history/reset", asyncHandler(async (_req, res) => {
  res.json(await resetFeedbackExportHistory());
}));

ebayReviewsRouter.post("/feedback/:feedbackKey/acknowledge", asyncHandler(async (req, res) => {
  res.json(await acknowledgeFeedback(req.params.feedbackKey));
}));

async function appendCatalogWarning(payload: Record<string, unknown> & { warnings?: string[] }) {
  const catalog = await productCatalogStatus();
  const warnings = [...(payload.warnings || [])];
  if (catalog.missing) warnings.push("Inventory has no products available for review-to-SKU matching.");
  payload.warnings = warnings;
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

async function enrichReviewRows(rows: Array<Record<string, unknown>>) {
  const ebayRows = rows.filter((row) => (row.platform || "ebay") === "ebay");
  const etsyRows = rows.filter((row) => row.platform === "etsy");
  const [ebayEnriched, etsyEnriched] = await Promise.all([
    enrichMarketplaceRowsWithInventory(ebayRows, "ebay"),
    enrichMarketplaceRowsWithInventory(etsyRows, "etsy")
  ]);
  const byFeedbackKey = new Map(
    [...ebayEnriched, ...etsyEnriched].map((row) => [String(row.feedback_key || ""), row])
  );
  const inventoryEnriched = rows.map((row) => byFeedbackKey.get(String(row.feedback_key || "")) || row);
  return enrichRowsWithProducts(inventoryEnriched);
}

function asyncHandler(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
