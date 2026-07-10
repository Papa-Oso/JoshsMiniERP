import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StoreData } from "../src/shared/types";
import type { EbayLegacyListing } from "../src/server/adapters/ebay";
import type { EbayLegacyListingReader } from "../src/server/ebayLegacyListings";

const timestamp = "2026-01-01T00:00:00.000Z";
const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-ebay-legacy-"));
const dataFile = path.join(tempDir, "inventory.json");

process.env.DATA_FILE = dataFile;
process.env.STORE_DRIVER = "json";

const {
  applyEbayLegacyMappings,
  previewEbayLegacyMappings,
  scanEbayLegacyListings
} = await import("../src/server/ebayLegacyListings.ts");
const { closeStore } = await import("../src/server/store.ts");

after(async () => {
  await closeStore();
  await rm(tempDir, { recursive: true, force: true });
});

test("eBay legacy mapping preview identifies safe exact matches and risky rows", async () => {
  await writeStore(seedStore());

  const scanPath = path.join(tempDir, "legacy-scan.csv");
  const scan = await scanEbayLegacyListings({ adapter: fakeAdapter(), outputPath: scanPath });
  const scanCsv = await readFile(scanPath, "utf8");

  assert.equal(scan.summary.listings, 9);
  assert.equal(scan.summary.withSku, 8);
  assert.equal(scan.summary.withoutSku, 1);
  assert.equal(scan.summary.duplicateSkus, 1);
  assert.match(scanCsv, /watchCount/);
  assert.match(scanCsv, /EXACT-ONE/);

  const preview = await previewEbayLegacyMappings({ adapter: fakeAdapter() });
  const statusBySku = new Map(preview.rows.map((row) => [`${row.sku}:${row.ebayItemId ?? ""}`, row.status]));

  assert.equal(preview.summary.exactMatches, 1);
  assert.equal(preview.summary.alreadyMapped, 1);
  assert.equal(preview.summary.missingLocal, 1);
  assert.equal(preview.summary.missingEbay, 1);
  assert.equal(preview.summary.duplicateEbaySkus, 2);
  assert.equal(preview.summary.duplicateLocalSkus, 1);
  assert.equal(preview.summary.blankEbaySkus, 1);
  assert.equal(preview.summary.titleMismatches, 1);
  assert.equal(preview.summary.mappingConflicts, 1);
  assert.equal(statusBySku.get("EXACT-ONE:100"), "exact_match");
  assert.equal(statusBySku.get("CONFLICT:105"), "mapping_conflict");
  assert.equal(statusBySku.get("TITLE-MISMATCH:104"), "title_mismatch");

  const stored = await readStore();
  assert.equal(stored.items.find((item) => item.sku === "EXACT-ONE")?.mappings.ebay, undefined);
});

test("eBay legacy mapping apply changes only exact eligible local mappings", async () => {
  await writeStore(seedStore());

  const result = await applyEbayLegacyMappings({ adapter: fakeAdapter() });
  const stored = await readStore();
  const exact = stored.items.find((item) => item.sku === "EXACT-ONE");
  const titleMismatch = stored.items.find((item) => item.sku === "TITLE-MISMATCH");
  const conflict = stored.items.find((item) => item.sku === "CONFLICT");
  const already = stored.items.find((item) => item.sku === "ALREADY");

  assert.equal(result.summary.applied, 1);
  assert.equal(result.rows.find((row) => row.sku === "EXACT-ONE")?.applied, true);
  assert.equal(exact?.mappings.ebay?.enabled, true);
  assert.equal(exact?.mappings.ebay?.remoteSku, "EXACT-ONE");
  assert.equal(exact?.mappings.ebay?.listingId, "100");
  assert.equal(exact?.mappings.ebay?.lastSyncedQuantity, null);
  assert.equal(exact?.mappings.ebay?.lastRemoteQuantity, null);
  assert.equal(exact?.mappings.ebay?.lastSyncedAt, null);
  assert.match(exact?.mappings.ebay?.warning ?? "", /baseline/);
  assert.equal(titleMismatch?.mappings.ebay, undefined);
  assert.equal(conflict?.mappings.ebay?.listingId, "old-listing");
  assert.equal(already?.mappings.ebay?.listingId, "300");
});

async function writeStore(data: StoreData) {
  await writeFile(dataFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readStore() {
  return JSON.parse(await readFile(dataFile, "utf8")) as StoreData;
}

function fakeAdapter(): EbayLegacyListingReader {
  return {
    isConfigured: () => true,
    missingEnv: () => [],
    listLegacyActiveListings: async () => legacyListings()
  };
}

function legacyListings(): EbayLegacyListing[] {
  return [
    listing("100", "EXACT-ONE", "Neon Mug Gloss", 9, 12, 3, 2),
    listing("101", "REMOTE-ONLY", "Remote Only Item", 5, 5, 0, 1),
    listing("102", "DUP-SKU", "Duplicate Listing A", 1, 1, 0, 0),
    listing("103", "DUP-SKU", "Duplicate Listing B", 2, 2, 0, 0),
    listing("104", "TITLE-MISMATCH", "Mirror Caps Pair", 4, 4, 0, 4),
    listing("105", "CONFLICT", "Conflict Item", 7, 7, 0, 3),
    listing("300", "ALREADY", "Existing Item", 6, 6, 0, 5),
    listing("350", "LOCAL-DUPE", "Local Duplicate", 6, 6, 0, 0),
    listing("400", "", "Blank SKU Item", 8, 8, 0, 0)
  ];
}

function listing(
  itemId: string,
  sku: string,
  title: string,
  quantityAvailable: number,
  quantity: number,
  quantitySold: number,
  watchCount: number
): EbayLegacyListing {
  return {
    itemId,
    sku,
    title,
    quantity,
    quantitySold,
    quantityAvailable,
    watchCount,
    url: `https://www.ebay.com/itm/${itemId}`
  };
}

function seedStore(): StoreData {
  return {
    items: [
      item("item-1", "EXACT-ONE", "Neon Mug"),
      item("item-2", "MISSING-EBAY", "Missing eBay"),
      item("item-3", "TITLE-MISMATCH", "Helmet Lock"),
      item("item-4", "CONFLICT", "Conflict Item", {
        enabled: true,
        remoteSku: "CONFLICT",
        listingId: "old-listing"
      }),
      item("item-5", "ALREADY", "Existing Item", {
        enabled: true,
        remoteSku: "ALREADY",
        listingId: "300"
      }),
      item("item-6", "LOCAL-DUPE", "Local Duplicate A"),
      item("item-7", "LOCAL-DUPE", "Local Duplicate B")
    ],
    events: [],
    schedule: {
      enabled: false,
      intervalMinutes: 60,
      lastRunAt: null,
      nextRunAt: null,
      updatedAt: timestamp
    },
    syncRuns: []
  };
}

function item(
  id: string,
  sku: string,
  name: string,
  ebay?: StoreData["items"][number]["mappings"]["ebay"]
): StoreData["items"][number] {
  return {
    id,
    sku,
    name,
    quantity: 10,
    safetyStock: 0,
    maxInventory: 100,
    active: true,
    mappings: ebay ? { ebay } : {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
