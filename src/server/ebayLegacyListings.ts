import fs from "node:fs/promises";
import path from "node:path";
import type { InventoryItem, StoreData } from "../shared/types";
import { EbayAdapter, type EbayLegacyListing } from "./adapters/ebay";
import { listData } from "./inventoryService";
import { store } from "./store";

export type EbayLegacyOutputFormat = "csv" | "json";

export interface EbayLegacyListingReader {
  isConfigured(): boolean;
  missingEnv(): string[];
  listLegacyActiveListings(): Promise<EbayLegacyListing[]>;
}

export interface EbayLegacyListingScanOptions {
  adapter?: EbayLegacyListingReader;
  outputPath?: string;
  format?: EbayLegacyOutputFormat;
}

export interface EbayLegacyListingScanResult {
  generatedAt: string;
  listings: EbayLegacyListing[];
  summary: {
    listings: number;
    withSku: number;
    withoutSku: number;
    duplicateSkus: number;
  };
  outputPath?: string;
}

export type EbayLegacyMappingStatus =
  | "exact_match"
  | "already_mapped"
  | "missing_local"
  | "missing_ebay"
  | "duplicate_ebay_sku"
  | "duplicate_local_sku"
  | "blank_ebay_sku"
  | "title_mismatch"
  | "mapping_conflict";

export interface EbayLegacyMappingOptions {
  adapter?: EbayLegacyListingReader;
  outputPath?: string;
  format?: EbayLegacyOutputFormat;
}

export interface EbayLegacyMappingRow {
  sku: string;
  status: EbayLegacyMappingStatus;
  localSku?: string;
  localName?: string;
  localQuantity?: number;
  currentRemoteSku?: string;
  currentListingId?: string;
  ebaySku?: string;
  ebayItemId?: string;
  ebayTitle?: string;
  ebayQuantity?: number;
  ebayQuantityAvailable?: number;
  ebayQuantitySold?: number;
  ebayWatchCount?: number;
  ebayUrl?: string;
  applyEligible: boolean;
  applied: boolean;
  message: string;
}

export interface EbayLegacyMappingResult {
  generatedAt: string;
  applied: boolean;
  rows: EbayLegacyMappingRow[];
  summary: {
    localSkus: number;
    ebayListings: number;
    exactMatches: number;
    alreadyMapped: number;
    applied: number;
    missingLocal: number;
    missingEbay: number;
    duplicateEbaySkus: number;
    duplicateLocalSkus: number;
    blankEbaySkus: number;
    titleMismatches: number;
    mappingConflicts: number;
    skipped: number;
  };
  outputPath?: string;
}

const legacyBaselineWarning = "eBay legacy listing mapped; next sync will capture a fresh baseline.";

export async function scanEbayLegacyListings(
  options: EbayLegacyListingScanOptions = {}
): Promise<EbayLegacyListingScanResult> {
  const listings = await loadLegacyListings(options.adapter);
  const sorted = sortListings(listings);
  const result: EbayLegacyListingScanResult = {
    generatedAt: new Date().toISOString(),
    listings: sorted,
    summary: summarizeListings(sorted)
  };

  if (options.outputPath) {
    result.outputPath = await writeOutput(
      options.outputPath,
      options.format,
      () => legacyListingsToCsv(sorted),
      () => JSON.stringify(result, null, 2)
    );
  }

  return result;
}

export async function previewEbayLegacyMappings(
  options: EbayLegacyMappingOptions = {}
): Promise<EbayLegacyMappingResult> {
  const [data, listings] = await Promise.all([listData(), loadLegacyListings(options.adapter)]);
  const result = mappingResult(data, listings, false);
  if (options.outputPath) {
    result.outputPath = await writeMappingOutput(result, options.outputPath, options.format);
  }
  return result;
}

export async function applyEbayLegacyMappings(
  options: EbayLegacyMappingOptions = {}
): Promise<EbayLegacyMappingResult> {
  const listings = await loadLegacyListings(options.adapter);
  const mutate = store.mutateChanges?.bind(store) ?? store.mutate.bind(store);

  const result = await mutate((data) => {
    const next = mappingResult(data, listings, true);
    const now = new Date().toISOString();

    for (const row of next.rows) {
      if (!row.applyEligible || !row.localSku || !row.ebaySku || !row.ebayItemId) continue;
      const item = findItemBySku(data.items, row.localSku);
      if (!item) continue;

      item.mappings = {
        ...item.mappings,
        ebay: {
          enabled: true,
          remoteSku: row.ebaySku.trim(),
          listingId: row.ebayItemId.trim(),
          lastSyncedQuantity: null,
          lastRemoteQuantity: null,
          lastSyncedAt: null,
          warning: legacyBaselineWarning
        }
      };
      item.updatedAt = now;
      row.applied = true;
    }

    next.summary.applied = next.rows.filter((row) => row.applied).length;
    next.summary.skipped = next.rows.filter((row) => !row.applied).length;
    return next;
  });

  if (options.outputPath) {
    result.outputPath = await writeMappingOutput(result, options.outputPath, options.format);
  }
  return result;
}

export function buildEbayLegacyMappingRows(
  items: InventoryItem[],
  listings: EbayLegacyListing[],
  applied = false
) {
  const activeItems = items.filter((item) => item.active !== false);
  const localBySku = groupBySku(activeItems, (item) => item.sku);
  const listingsBySku = groupBySku(listings, (listing) => listing.sku);
  const rows: EbayLegacyMappingRow[] = [];
  const seenLocalSkuKeys = new Set<string>();

  for (const listing of sortListings(listings)) {
    const skuKey = normalizeSku(listing.sku);
    if (!skuKey) {
      rows.push(listingRow("blank_ebay_sku", listing, undefined, {
        message: "eBay listing has no Custom label/SKU; add one in eBay before mapping."
      }));
      continue;
    }

    const localMatches = localBySku.get(skuKey) ?? [];
    const listingMatches = listingsBySku.get(skuKey) ?? [];

    if (listingMatches.length > 1) {
      rows.push(listingRow("duplicate_ebay_sku", listing, localMatches[0], {
        message: "Multiple active eBay listings use this Custom label/SKU; resolve duplicates before mapping."
      }));
      continue;
    }

    if (localMatches.length === 0) {
      rows.push(listingRow("missing_local", listing, undefined, {
        message: "No active local SKU matches this eBay Custom label/SKU."
      }));
      continue;
    }

    if (localMatches.length > 1) {
      rows.push(listingRow("duplicate_local_sku", listing, localMatches[0], {
        message: "Multiple local items use this SKU; resolve local duplicates before mapping."
      }));
      continue;
    }

    const item = localMatches[0];
    seenLocalSkuKeys.add(skuKey);

    if (hasMappingConflict(item, listing)) {
      rows.push(listingRow("mapping_conflict", listing, item, {
        message: "Local SKU already has a different eBay mapping; review manually before changing it."
      }));
      continue;
    }

    if (hasTitleMismatch(item.name, listing.title)) {
      rows.push(listingRow("title_mismatch", listing, item, {
        message: "SKU matches, but the local name and eBay title do not appear related; review manually."
      }));
      continue;
    }

    if (isAlreadyMapped(item, listing)) {
      rows.push(listingRow("already_mapped", listing, item, {
        message: "This local SKU is already mapped to the same legacy eBay listing."
      }));
      continue;
    }

    rows.push(listingRow("exact_match", listing, item, {
      applyEligible: true,
      applied,
      message: "Exact SKU match; eligible for local-only eBay mapping apply."
    }));
  }

  for (const item of activeItems.sort((left, right) => left.sku.localeCompare(right.sku))) {
    const skuKey = normalizeSku(item.sku);
    if (!skuKey || seenLocalSkuKeys.has(skuKey) || listingsBySku.has(skuKey)) continue;
    rows.push({
      sku: item.sku,
      status: "missing_ebay",
      localSku: item.sku,
      localName: item.name,
      localQuantity: item.quantity,
      currentRemoteSku: item.mappings.ebay?.remoteSku,
      currentListingId: item.mappings.ebay?.listingId,
      applyEligible: false,
      applied: false,
      message: "No active eBay legacy listing matched this local SKU."
    });
  }

  return rows.sort(compareMappingRows);
}

function mappingResult(data: StoreData, listings: EbayLegacyListing[], applyMode: boolean): EbayLegacyMappingResult {
  const rows = buildEbayLegacyMappingRows(data.items, listings, false);
  return {
    generatedAt: new Date().toISOString(),
    applied: applyMode,
    rows,
    summary: summarizeMappingRows(data.items, listings, rows)
  };
}

async function loadLegacyListings(adapter: EbayLegacyListingReader = new EbayAdapter()) {
  if (!adapter.isConfigured()) {
    throw new Error(`eBay is missing: ${adapter.missingEnv().join(", ")}`);
  }
  return adapter.listLegacyActiveListings();
}

function listingRow(
  status: EbayLegacyMappingStatus,
  listing: EbayLegacyListing,
  item: InventoryItem | undefined,
  options: { applyEligible?: boolean; applied?: boolean; message: string }
): EbayLegacyMappingRow {
  const mapping = item?.mappings.ebay;
  return {
    sku: normalizeSku(listing.sku) || listing.sku || "(blank)",
    status,
    localSku: item?.sku,
    localName: item?.name,
    localQuantity: item?.quantity,
    currentRemoteSku: mapping?.remoteSku,
    currentListingId: mapping?.listingId,
    ebaySku: listing.sku.trim() || undefined,
    ebayItemId: listing.itemId,
    ebayTitle: listing.title,
    ebayQuantity: listing.quantity,
    ebayQuantityAvailable: listing.quantityAvailable,
    ebayQuantitySold: listing.quantitySold,
    ebayWatchCount: listing.watchCount,
    ebayUrl: listing.url,
    applyEligible: options.applyEligible ?? false,
    applied: options.applied ?? false,
    message: options.message
  };
}

function summarizeListings(listings: EbayLegacyListing[]) {
  const skuCounts = skuCountMap(listings, (listing) => listing.sku);
  return {
    listings: listings.length,
    withSku: listings.filter((listing) => normalizeSku(listing.sku)).length,
    withoutSku: listings.filter((listing) => !normalizeSku(listing.sku)).length,
    duplicateSkus: [...skuCounts.values()].filter((count) => count > 1).length
  };
}

function summarizeMappingRows(
  items: InventoryItem[],
  listings: EbayLegacyListing[],
  rows: EbayLegacyMappingRow[]
) {
  const activeItems = items.filter((item) => item.active !== false);
  const count = (status: EbayLegacyMappingStatus) => rows.filter((row) => row.status === status).length;
  return {
    localSkus: activeItems.length,
    ebayListings: listings.length,
    exactMatches: count("exact_match"),
    alreadyMapped: count("already_mapped"),
    applied: rows.filter((row) => row.applied).length,
    missingLocal: count("missing_local"),
    missingEbay: count("missing_ebay"),
    duplicateEbaySkus: count("duplicate_ebay_sku"),
    duplicateLocalSkus: count("duplicate_local_sku"),
    blankEbaySkus: count("blank_ebay_sku"),
    titleMismatches: count("title_mismatch"),
    mappingConflicts: count("mapping_conflict"),
    skipped: rows.filter((row) => !row.applied).length
  };
}

function hasMappingConflict(item: InventoryItem, listing: EbayLegacyListing) {
  const mapping = item.mappings.ebay;
  if (!mapping) return false;

  const hasInventoryApiIdentity = Boolean(mapping.offerId || mapping.inventoryItemId || mapping.locationId);
  const hasLegacyIdentity = Boolean(mapping.listingId || mapping.remoteSku);
  if (!hasInventoryApiIdentity && !hasLegacyIdentity) return false;

  if (mapping.listingId && mapping.listingId.trim() !== listing.itemId.trim()) return true;
  if (mapping.remoteSku && normalizeSku(mapping.remoteSku) !== normalizeSku(listing.sku)) return true;
  if (!mapping.listingId && hasInventoryApiIdentity) return true;

  return false;
}

function isAlreadyMapped(item: InventoryItem, listing: EbayLegacyListing) {
  const mapping = item.mappings.ebay;
  return Boolean(
    mapping?.enabled &&
      mapping.remoteSku?.trim() === listing.sku.trim() &&
      mapping.listingId?.trim() === listing.itemId.trim()
  );
}

function hasTitleMismatch(localName: string, ebayTitle: string) {
  const local = normalizeTitle(localName);
  const remote = normalizeTitle(ebayTitle);
  if (!local || !remote) return false;
  if (local.includes(remote) || remote.includes(local)) return false;

  const localTokens = titleTokens(local);
  const remoteTokens = new Set(titleTokens(remote));
  if (localTokens.length === 0 || remoteTokens.size === 0) return false;
  return !localTokens.some((token) => remoteTokens.has(token));
}

function titleTokens(value: string) {
  const stopWords = new Set(["the", "and", "for", "with", "from", "new", "kit", "set", "a", "an", "of", "to", "in", "on", "by", "or"]);
  return value
    .split(/\s+/)
    .map((token) => token.replace(/s$/, ""))
    .filter((token) => token.length >= 3 && !stopWords.has(token));
}

function normalizeTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function groupBySku<T>(items: T[], selector: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const sku = normalizeSku(selector(item));
    if (!sku) continue;
    const group = groups.get(sku) ?? [];
    group.push(item);
    groups.set(sku, group);
  }
  return groups;
}

function skuCountMap<T>(items: T[], selector: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const sku = normalizeSku(selector(item));
    if (!sku) continue;
    counts.set(sku, (counts.get(sku) ?? 0) + 1);
  }
  return counts;
}

function findItemBySku(items: InventoryItem[], sku: string) {
  const normalized = normalizeSku(sku);
  return items.find((item) => normalizeSku(item.sku) === normalized && item.active !== false);
}

function sortListings(listings: EbayLegacyListing[]) {
  return [...listings].sort((left, right) => {
    const skuCompare = normalizeSku(left.sku).localeCompare(normalizeSku(right.sku));
    if (skuCompare !== 0) return skuCompare;
    return left.itemId.localeCompare(right.itemId);
  });
}

function compareMappingRows(left: EbayLegacyMappingRow, right: EbayLegacyMappingRow) {
  const skuCompare = left.sku.localeCompare(right.sku);
  if (skuCompare !== 0) return skuCompare;
  const statusCompare = left.status.localeCompare(right.status);
  if (statusCompare !== 0) return statusCompare;
  return (left.ebayItemId ?? "").localeCompare(right.ebayItemId ?? "");
}

function normalizeSku(value: string) {
  return value.trim().toUpperCase();
}

async function writeMappingOutput(
  result: EbayLegacyMappingResult,
  outputPath: string,
  format?: EbayLegacyOutputFormat
) {
  return writeOutput(
    outputPath,
    format,
    () => legacyMappingRowsToCsv(result.rows),
    () => JSON.stringify(result, null, 2)
  );
}

async function writeOutput(
  outputPath: string,
  format: EbayLegacyOutputFormat | undefined,
  csv: () => string,
  json: () => string
) {
  const resolved = path.resolve(outputPath);
  const resolvedFormat = format ?? (path.extname(resolved).toLowerCase() === ".json" ? "json" : "csv");
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${resolvedFormat === "json" ? json() : csv()}\n`, "utf8");
  return resolved;
}

function legacyListingsToCsv(listings: EbayLegacyListing[]) {
  const headers = [
    "sku",
    "itemId",
    "title",
    "quantityAvailable",
    "quantity",
    "quantitySold",
    "watchCount",
    "url"
  ];
  return csvRows(headers, listings.map((listing) => ({
    sku: listing.sku,
    itemId: listing.itemId,
    title: listing.title,
    quantityAvailable: listing.quantityAvailable,
    quantity: listing.quantity,
    quantitySold: listing.quantitySold,
    watchCount: listing.watchCount,
    url: listing.url
  })));
}

function legacyMappingRowsToCsv(rows: EbayLegacyMappingRow[]) {
  const headers = [
    "sku",
    "status",
    "localSku",
    "localName",
    "localQuantity",
    "currentRemoteSku",
    "currentListingId",
    "ebaySku",
    "ebayItemId",
    "ebayTitle",
    "ebayQuantityAvailable",
    "ebayQuantity",
    "ebayQuantitySold",
    "ebayWatchCount",
    "applyEligible",
    "applied",
    "message",
    "ebayUrl"
  ];
  return csvRows(headers, rows);
}

function csvRows(headers: string[], rows: unknown[]) {
  return `${headers.join(",")}\n${rows
    .map((row) => {
      const record = row as Record<string, unknown>;
      return headers.map((header) => csvCell(record[header])).join(",");
    })
    .join("\n")}`;
}

function csvCell(value: unknown) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
