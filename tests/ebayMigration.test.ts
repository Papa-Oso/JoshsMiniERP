import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StoreData } from "../src/shared/types";
import type { EbayBulkMigrateListingResponse, EbayLegacyListing } from "../src/server/adapters/ebay";
import type { EbayMigrationAdapter } from "../src/server/ebayMigration";

const timestamp = "2026-01-01T00:00:00.000Z";
const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-ebay-migration-"));
const dataFile = path.join(tempDir, "inventory.json");

process.env.DATA_FILE = dataFile;
process.env.STORE_DRIVER = "json";

const { migrateEbayLegacyListing } = await import("../src/server/ebayMigration.ts");
const { closeStore } = await import("../src/server/store.ts");

after(async () => {
  await closeStore();
  await rm(tempDir, { recursive: true, force: true });
});

test("eBay migration preview checks one legacy listing without changing local mapping", async () => {
  await writeStore(seedStore());
  const adapter = fakeAdapter();

  const result = await migrateEbayLegacyListing({ target: "READY-SKU", adapter });
  const stored = await readStore();

  assert.equal(result.status, "ready_to_attempt");
  assert.equal(result.eligibleToAttempt, true);
  assert.equal(result.listingId, "100");
  assert.equal(adapter.migratedListingIds.length, 0);
  assert.equal(stored.items[0].mappings.ebay?.listingId, "100");
  assert.equal(stored.items[0].mappings.ebay?.offerId, undefined);
});

test("eBay migration apply requires exact listing confirmation", async () => {
  await writeStore(seedStore());
  const adapter = fakeAdapter();

  const result = await migrateEbayLegacyListing({
    target: "READY-SKU",
    apply: true,
    adapter
  });
  const stored = await readStore();

  assert.equal(result.status, "blocked");
  assert.equal(result.eligibleToAttempt, false);
  assert.match(result.messages.join(" "), /confirmation/);
  assert.equal(adapter.migratedListingIds.length, 0);
  assert.equal(stored.items[0].mappings.ebay?.listingId, "100");
  assert.equal(stored.items[0].mappings.ebay?.offerId, undefined);
});

test("eBay migration apply rewrites successful legacy mapping to Inventory API offer", async () => {
  await writeStore(seedStore());
  const adapter = fakeAdapter();

  const result = await migrateEbayLegacyListing({
    target: "READY-SKU",
    apply: true,
    confirmListingId: "100",
    adapter
  });
  const stored = await readStore();
  const mapping = stored.items[0].mappings.ebay;

  assert.equal(result.status, "migrated");
  assert.deepEqual(adapter.migratedListingIds, ["100"]);
  assert.equal(mapping?.enabled, true);
  assert.equal(mapping?.remoteSku, "READY-SKU");
  assert.equal(mapping?.listingId, undefined);
  assert.equal(mapping?.offerId, "offer-100");
  assert.equal(mapping?.lastSyncedQuantity, null);
  assert.equal(mapping?.lastRemoteQuantity, null);
  assert.equal(mapping?.lastSyncedAt, null);
  assert.match(mapping?.warning ?? "", /Inventory API/);
});

async function writeStore(data: StoreData) {
  await writeFile(dataFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readStore() {
  return JSON.parse(await readFile(dataFile, "utf8")) as StoreData;
}

function fakeAdapter(): EbayMigrationAdapter & { migratedListingIds: string[] } {
  const migratedListingIds: string[] = [];
  return {
    migratedListingIds,
    isConfigured: () => true,
    missingEnv: () => [],
    listLegacyActiveListings: async () => [readyListing()],
    bulkMigrateListings: async (listingIds) => {
      migratedListingIds.push(...listingIds);
      return {
        responses: listingIds.map((listingId) => ({
          listingId,
          marketplaceId: "EBAY_US",
          statusCode: 200,
          inventoryItems: [{ sku: "READY-SKU", offerId: "offer-100" }]
        }))
      } satisfies EbayBulkMigrateListingResponse;
    }
  };
}

function readyListing(): EbayLegacyListing {
  return {
    itemId: "100",
    sku: "READY-SKU",
    title: "Ready SKU Item",
    quantity: 12,
    quantitySold: 2,
    quantityAvailable: 10,
    watchCount: 3,
    url: "https://www.ebay.com/itm/100",
    listingType: "FixedPriceItem",
    autoPay: true,
    location: "Chicago",
    postalCode: "60601",
    country: "US",
    paymentProfileId: "pay-1",
    returnProfileId: "return-1",
    shippingProfileId: "ship-1",
    listingEnhancements: [],
    hasBuyerRequirements: false,
    variationSkus: []
  };
}

function seedStore(): StoreData {
  return {
    items: [
      {
        id: "item-1",
        sku: "READY-SKU",
        name: "Ready SKU Item",
        quantity: 10,
        safetyStock: 0,
        maxInventory: 100,
        active: true,
        mappings: {
          ebay: {
            enabled: true,
            remoteSku: "READY-SKU",
            listingId: "100"
          }
        },
        createdAt: timestamp,
        updatedAt: timestamp
      }
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
