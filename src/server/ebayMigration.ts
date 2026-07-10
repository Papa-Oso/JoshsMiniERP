import fs from "node:fs/promises";
import path from "node:path";
import type { InventoryItem, StoreData } from "../shared/types";
import {
  EbayAdapter,
  type EbayBulkMigrateListingResponse,
  type EbayLegacyListing,
  type EbayMigrateListingResponse
} from "./adapters/ebay";
import { listData } from "./inventoryService";
import { store } from "./store";

export type EbayMigrationOutputFormat = "csv" | "json";
export type EbayMigrationCheckStatus = "pass" | "warn" | "fail";
export type EbayMigrationStatus =
  | "ready_to_attempt"
  | "blocked"
  | "already_inventory_api"
  | "migrated"
  | "migration_failed"
  | "mapping_not_updated";

export interface EbayMigrationAdapter {
  isConfigured(): boolean;
  missingEnv(): string[];
  listLegacyActiveListings(): Promise<EbayLegacyListing[]>;
  getLegacyListing?(itemId: string): Promise<EbayLegacyListing>;
  bulkMigrateListings(listingIds: string[]): Promise<EbayBulkMigrateListingResponse>;
}

export interface EbayMigrationOptions {
  target: string;
  apply?: boolean;
  confirmListingId?: string;
  adapter?: EbayMigrationAdapter;
  outputPath?: string;
  format?: EbayMigrationOutputFormat;
}

export interface EbayMigrationCheck {
  check: string;
  status: EbayMigrationCheckStatus;
  message: string;
}

export interface EbayMigrationResult {
  generatedAt: string;
  target: string;
  apply: boolean;
  status: EbayMigrationStatus;
  eligibleToAttempt: boolean;
  listingId?: string;
  localSku?: string;
  ebaySku?: string;
  ebayTitle?: string;
  quantityAvailable?: number;
  offerId?: string;
  inventoryItemGroupKey?: string;
  checks: EbayMigrationCheck[];
  messages: string[];
  response?: EbayMigrateListingResponse;
  outputPath?: string;
}

const inventoryApiBaselineWarning = "eBay listing migrated to Inventory API; next sync will capture a fresh baseline.";

export async function migrateEbayLegacyListing(options: EbayMigrationOptions): Promise<EbayMigrationResult> {
  const adapter = options.adapter ?? new EbayAdapter();
  const preview = await buildMigrationPreview(options.target, adapter);
  const result: EbayMigrationResult = {
    ...preview,
    apply: Boolean(options.apply)
  };

  if (!options.apply) {
    return writeResultIfRequested(result, options);
  }

  if (!result.listingId) {
    result.status = "blocked";
    result.eligibleToAttempt = false;
    result.messages.push("No eBay legacy listing was resolved for migration.");
    return writeResultIfRequested(result, options);
  }

  if (options.confirmListingId?.trim() !== result.listingId) {
    result.status = "blocked";
    result.eligibleToAttempt = false;
    result.checks.push({
      check: "explicit confirmation",
      status: "fail",
      message: `Rerun with --confirm-listing-id ${result.listingId} to acknowledge this exact live listing.`
    });
    result.messages.push("Live eBay migration was not attempted because the listing confirmation was missing or different.");
    return writeResultIfRequested(result, options);
  }

  if (!result.eligibleToAttempt) {
    result.status = "blocked";
    result.messages.push("Live eBay migration was not attempted because one or more checks failed.");
    return writeResultIfRequested(result, options);
  }

  let payload: EbayBulkMigrateListingResponse;
  try {
    payload = await adapter.bulkMigrateListings([result.listingId]);
  } catch (error) {
    result.status = "migration_failed";
    result.eligibleToAttempt = false;
    result.messages.push(`eBay migration API call failed: ${error instanceof Error ? error.message : String(error)}`);
    return writeResultIfRequested(result, options);
  }

  const response = findMigrationResponse(payload, result.listingId);
  result.response = response;

  const responseErrors = response?.errors ?? [];
  if (!response || responseErrors.length || !isSuccessStatus(response.statusCode)) {
    result.status = "migration_failed";
    result.eligibleToAttempt = false;
    result.messages.push(
      responseErrors.length
        ? `eBay migration failed: ${formatEbayMessages(responseErrors)}`
        : `eBay migration failed${response?.statusCode ? ` with status ${response.statusCode}` : "."}`
    );
    return writeResultIfRequested(result, options);
  }

  const inventoryItem = inventoryItemForLocalSku(response, result.localSku);
  if (!inventoryItem?.sku || !inventoryItem.offerId || normalizeSku(inventoryItem.sku) !== normalizeSku(result.localSku ?? "")) {
    result.status = "mapping_not_updated";
    result.eligibleToAttempt = false;
    result.inventoryItemGroupKey = response.inventoryItemGroupKey;
    result.messages.push(
      "eBay reported a successful migration, but the response did not include one matching SKU/offer ID for the local item. Review Seller Hub before updating local mapping."
    );
    return writeResultIfRequested(result, options);
  }

  await saveInventoryApiMapping(result.localSku!, inventoryItem.sku, inventoryItem.offerId);

  result.status = "migrated";
  result.offerId = inventoryItem.offerId;
  result.ebaySku = inventoryItem.sku;
  result.inventoryItemGroupKey = response.inventoryItemGroupKey;
  result.messages.push("eBay migrated the listing and the local ERP mapping now uses the Inventory API offer ID.");
  if (response.warnings?.length) {
    result.messages.push(`eBay migration warning: ${formatEbayMessages(response.warnings)}`);
  }

  return writeResultIfRequested(result, options);
}

async function buildMigrationPreview(target: string, adapter: EbayMigrationAdapter): Promise<EbayMigrationResult> {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) throw new Error("Usage: npm run inv -- ebay-migrate <local-sku-or-listing-id> [--apply --confirm-listing-id <id>]");

  if (!adapter.isConfigured()) {
    throw new Error(`eBay is missing: ${adapter.missingEnv().join(", ")}`);
  }

  const [data, activeListings] = await Promise.all([listData(), adapter.listLegacyActiveListings()]);
  let listings = activeListings;
  let resolved = resolveMigrationTarget(data, listings, normalizedTarget);
  let detailWarning: string | undefined;

  if (resolved.listing && adapter.getLegacyListing) {
    try {
      const detailedListing = await adapter.getLegacyListing(resolved.listing.itemId);
      listings = replaceListing(listings, detailedListing);
      resolved = resolveMigrationTarget(data, listings, normalizedTarget);
    } catch (error) {
      detailWarning = `Could not load detailed eBay listing data: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const checks = migrationChecks(data, listings, resolved, detailWarning);
  const failures = checks.filter((check) => check.status === "fail");
  const alreadyInventoryApi = checks.some((check) => check.check === "current local mapping" && check.message.includes("already uses"));
  const eligibleToAttempt = failures.length === 0 && !alreadyInventoryApi;

  return {
    generatedAt: new Date().toISOString(),
    target: normalizedTarget,
    apply: false,
    status: alreadyInventoryApi ? "already_inventory_api" : eligibleToAttempt ? "ready_to_attempt" : "blocked",
    eligibleToAttempt,
    listingId: resolved.listing?.itemId,
    localSku: resolved.item?.sku,
    ebaySku: migrationSku(resolved.listing),
    ebayTitle: resolved.listing?.title,
    quantityAvailable: resolved.listing?.quantityAvailable,
    checks,
    messages: previewMessages(eligibleToAttempt, alreadyInventoryApi, resolved)
  };
}

function resolveMigrationTarget(data: StoreData, listings: EbayLegacyListing[], target: string) {
  const activeItems = data.items.filter((item) => item.active !== false);
  const itemBySku = activeItems.find((item) => normalizeSku(item.sku) === normalizeSku(target));
  const listingById = listings.find((listing) => listing.itemId.trim() === target);
  const mappedListingId = itemBySku?.mappings.ebay?.listingId?.trim();
  const mappedListing = mappedListingId
    ? listings.find((listing) => listing.itemId.trim() === mappedListingId)
    : undefined;
  const listingBySku = itemBySku
    ? listings.filter((listing) => normalizeSku(migrationSku(listing)) === normalizeSku(itemBySku.sku))
    : [];
  const listing = listingById ?? mappedListing ?? (listingBySku.length === 1 ? listingBySku[0] : undefined);
  const item = itemBySku ?? (listing ? activeItems.find((candidate) => normalizeSku(candidate.sku) === normalizeSku(migrationSku(listing))) : undefined);

  return {
    item,
    listing,
    target,
    listingMatchesForSku: listingBySku,
    localMatchesForListingSku: listing ? activeItems.filter((candidate) => normalizeSku(candidate.sku) === normalizeSku(migrationSku(listing))) : []
  };
}

function migrationChecks(
  data: StoreData,
  listings: EbayLegacyListing[],
  resolved: ReturnType<typeof resolveMigrationTarget>,
  detailWarning?: string
): EbayMigrationCheck[] {
  const checks: EbayMigrationCheck[] = [];
  const { item, listing } = resolved;
  const ebaySku = migrationSku(listing);
  const mapping = item?.mappings.ebay;

  if (detailWarning) {
    pushCheck(checks, "listing detail", "warn", detailWarning);
  }

  pushCheck(checks, "local SKU", item ? "pass" : "fail", item ? `Found local SKU ${item.sku}.` : "No active local SKU matched the target or listing Custom label.");
  pushCheck(
    checks,
    "legacy listing",
    listing ? "pass" : "fail",
    listing ? `Found active eBay legacy listing ${listing.itemId}.` : "No active eBay legacy listing matched the target."
  );

  if (item && listing) {
    pushCheck(
      checks,
      "SKU agreement",
      normalizeSku(item.sku) === normalizeSku(ebaySku) ? "pass" : "fail",
      normalizeSku(item.sku) === normalizeSku(ebaySku)
        ? `Local SKU and eBay Custom label agree on ${item.sku}.`
        : `Local SKU ${item.sku} does not match eBay Custom label ${ebaySku || "(blank)"}.`
    );
  }

  if (resolved.listingMatchesForSku.length > 1) {
    pushCheck(checks, "duplicate eBay SKU", "fail", "Multiple active eBay listings use this local SKU; migrate only after duplicates are resolved.");
  }
  if (resolved.localMatchesForListingSku.length > 1) {
    pushCheck(checks, "duplicate local SKU", "fail", "Multiple active local items use this eBay Custom label; resolve local duplicates first.");
  }

  if (mapping?.offerId && !mapping.listingId) {
    pushCheck(checks, "current local mapping", "warn", "This SKU already uses an Inventory API offer ID locally; migration is not needed.");
  } else if (mapping?.listingId && listing && mapping.listingId.trim() !== listing.itemId.trim()) {
    pushCheck(checks, "current local mapping", "fail", `Local eBay mapping points at listing ${mapping.listingId}, not ${listing.itemId}.`);
  } else if (mapping?.listingId) {
    pushCheck(checks, "current local mapping", "pass", `Local mapping points at legacy listing ${mapping.listingId}.`);
  } else if (mapping?.remoteSku || mapping?.enabled) {
    pushCheck(checks, "current local mapping", "warn", "Local eBay mapping has no listing ID; migration can proceed only if the SKU/listing checks are correct.");
  } else {
    pushCheck(checks, "current local mapping", "warn", "No local eBay mapping exists yet; migration success will save an Inventory API offer mapping.");
  }

  if (!listing) return checks;

  const topLevelSku = listing.sku.trim();
  const variationSkus = listing.variationSkus ?? [];
  if (!topLevelSku && variationSkus.length === 0) {
    pushCheck(checks, "seller SKU", "fail", "The eBay listing has no top-level SKU or variation SKU.");
  } else if (variationSkus.length > 1) {
    pushCheck(checks, "variation listing", "fail", "This migration helper only updates single-SKU listings; handle multi-variation listings manually first.");
  } else {
    pushCheck(checks, "seller SKU", "pass", `eBay seller SKU is ${ebaySku}.`);
  }

  const listingType = listing.listingType?.trim();
  if (!listingType) {
    pushCheck(checks, "listing type", "warn", "eBay did not return a listing type; confirm this is fixed-price before applying migration.");
  } else if (listingType.toLowerCase().includes("fixed")) {
    pushCheck(checks, "listing type", "pass", `Listing type is ${listingType}.`);
  } else {
    pushCheck(checks, "listing type", "fail", `Listing type is ${listingType}; migrate only fixed-price listings through this path.`);
  }

  const missingPolicies = [
    listing.paymentProfileId || listing.paymentProfileName ? null : "payment",
    listing.returnProfileId || listing.returnProfileName ? null : "return",
    listing.shippingProfileId || listing.shippingProfileName ? null : "shipping"
  ].filter(Boolean);
  pushCheck(
    checks,
    "business policies",
    missingPolicies.length === 0 ? "pass" : "fail",
    missingPolicies.length === 0
      ? "Payment, return, and shipping business policies were detected."
      : `Missing ${missingPolicies.join(", ")} business policy data; set business policies in eBay before migration.`
  );

  pushCheck(
    checks,
    "immediate payment",
    listing.autoPay === true ? "pass" : listing.autoPay === false ? "fail" : "warn",
    listing.autoPay === true
      ? "Immediate payment is enabled."
      : listing.autoPay === false
        ? "Immediate payment is not enabled; eBay migration requires it for this path."
        : "Immediate payment was not returned by eBay; confirm the payment policy before applying migration."
  );

  pushCheck(
    checks,
    "inventory location",
    listing.country && (listing.postalCode || listing.location) ? "pass" : "fail",
    listing.country && (listing.postalCode || listing.location)
      ? `Listing location is ${[listing.location, listing.postalCode, listing.country].filter(Boolean).join(", ")}.`
      : "Listing country plus location or postal code is required before migration."
  );

  const unsupportedSignals = [
    ...(listing.listingEnhancements ?? []),
    listing.hasBuyerRequirements ? "buyer requirements" : null
  ].filter(Boolean);
  pushCheck(
    checks,
    "legacy-only features",
    unsupportedSignals.length ? "fail" : "pass",
    unsupportedSignals.length
      ? `Review or remove legacy-only listing features before migration: ${unsupportedSignals.join(", ")}.`
      : "No obvious legacy-only listing features were detected in the scan."
  );

  const duplicateListingIds = listings.filter((candidate) => candidate.itemId.trim() === listing.itemId.trim());
  if (duplicateListingIds.length > 1) {
    pushCheck(checks, "listing ID uniqueness", "fail", `Listing ID ${listing.itemId} appeared more than once in the active listing scan.`);
  }

  const duplicateLocalItems = data.items.filter((candidate) => candidate.active !== false && normalizeSku(candidate.sku) === normalizeSku(item?.sku ?? ""));
  if (item && duplicateLocalItems.length > 1) {
    pushCheck(checks, "local SKU uniqueness", "fail", `Local SKU ${item.sku} appeared more than once.`);
  }

  return checks;
}

function previewMessages(
  eligibleToAttempt: boolean,
  alreadyInventoryApi: boolean,
  resolved: ReturnType<typeof resolveMigrationTarget>
) {
  if (alreadyInventoryApi) {
    return ["No migration is needed because the local mapping already has an Inventory API offer ID."];
  }
  if (!eligibleToAttempt) {
    return ["No live eBay data changed. Fix failed checks before attempting migration."];
  }
  return [
    "No live eBay data changed. This listing is ready for a one-listing migration attempt.",
    `Apply only after reviewing Seller Hub: npm run inv -- ebay-migrate ${resolved.item?.sku ?? resolved.target} --apply --confirm-listing-id ${resolved.listing?.itemId}`
  ];
}

function replaceListing(listings: EbayLegacyListing[], detailedListing: EbayLegacyListing) {
  const replaced = listings.map((listing) => (
    listing.itemId.trim() === detailedListing.itemId.trim() ? detailedListing : listing
  ));
  return replaced.some((listing) => listing === detailedListing) ? replaced : [...replaced, detailedListing];
}

function findMigrationResponse(payload: EbayBulkMigrateListingResponse, listingId: string) {
  return payload.responses?.find((response) => response.listingId === listingId) ?? payload.responses?.[0];
}

function inventoryItemForLocalSku(response: EbayMigrateListingResponse, localSku?: string) {
  const inventoryItems = response.inventoryItems ?? [];
  if (!localSku) return inventoryItems.length === 1 ? inventoryItems[0] : undefined;
  return inventoryItems.find((item) => normalizeSku(item.sku ?? "") === normalizeSku(localSku))
    ?? (inventoryItems.length === 1 ? inventoryItems[0] : undefined);
}

async function saveInventoryApiMapping(localSku: string, ebaySku: string, offerId: string) {
  const mutate = store.mutateChanges?.bind(store) ?? store.mutate.bind(store);
  const now = new Date().toISOString();

  await mutate((data) => {
    const item = findActiveItemBySku(data.items, localSku);
    if (!item) throw new Error(`Local SKU ${localSku} was not found while saving migrated eBay mapping.`);

    item.mappings = {
      ...item.mappings,
      ebay: {
        enabled: true,
        remoteSku: ebaySku,
        offerId,
        lastSyncedQuantity: null,
        lastRemoteQuantity: null,
        lastSyncedAt: null,
        warning: inventoryApiBaselineWarning
      }
    };
    item.updatedAt = now;
  });
}

function migrationSku(listing?: EbayLegacyListing) {
  if (!listing) return "";
  const variationSkus = listing.variationSkus ?? [];
  return listing.sku.trim() || (variationSkus.length === 1 ? variationSkus[0].trim() : "");
}

function findActiveItemBySku(items: InventoryItem[], sku: string) {
  const normalized = normalizeSku(sku);
  return items.find((item) => item.active !== false && normalizeSku(item.sku) === normalized);
}

function pushCheck(checks: EbayMigrationCheck[], check: string, status: EbayMigrationCheckStatus, message: string) {
  checks.push({ check, status, message });
}

function isSuccessStatus(statusCode: number | undefined) {
  return typeof statusCode === "number" && statusCode >= 200 && statusCode < 300;
}

function formatEbayMessages(errors: Array<{ errorId?: number; message?: string; longMessage?: string }>) {
  return errors
    .map((error) => error.longMessage ?? error.message ?? `eBay error ${error.errorId ?? "unknown"}`)
    .join("; ");
}

function normalizeSku(value: string) {
  return value.trim().toUpperCase();
}

async function writeResultIfRequested(result: EbayMigrationResult, options: EbayMigrationOptions) {
  if (options.outputPath) {
    result.outputPath = await writeOutput(
      options.outputPath,
      options.format,
      () => resultToCsv(result),
      () => JSON.stringify(result, null, 2)
    );
  }
  return result;
}

async function writeOutput(
  outputPath: string,
  format: EbayMigrationOutputFormat | undefined,
  csv: () => string,
  json: () => string
) {
  const resolved = path.resolve(outputPath);
  const resolvedFormat = format ?? (path.extname(resolved).toLowerCase() === ".json" ? "json" : "csv");
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${resolvedFormat === "json" ? json() : csv()}\n`, "utf8");
  return resolved;
}

function resultToCsv(result: EbayMigrationResult) {
  const headers = [
    "target",
    "status",
    "apply",
    "eligibleToAttempt",
    "localSku",
    "listingId",
    "ebaySku",
    "offerId",
    "check",
    "checkStatus",
    "message"
  ];
  return csvRows(
    headers,
    result.checks.map((check) => ({
      target: result.target,
      status: result.status,
      apply: result.apply,
      eligibleToAttempt: result.eligibleToAttempt,
      localSku: result.localSku,
      listingId: result.listingId,
      ebaySku: result.ebaySku,
      offerId: result.offerId,
      check: check.check,
      checkStatus: check.status,
      message: check.message
    }))
  );
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
