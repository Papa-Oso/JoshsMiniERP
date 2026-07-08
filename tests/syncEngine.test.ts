import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StoreData } from "../src/shared/types";

const timestamp = "2026-01-01T00:00:00.000Z";
const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-"));
const dataFile = path.join(tempDir, "inventory.json");
const originalFetch = globalThis.fetch;

process.env.DATA_FILE = dataFile;
process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "test-token";
process.env.SHOPIFY_API_VERSION = "2026-07";

const { runInventorySync } = await import("../src/server/syncEngine.ts");

after(async () => {
  globalThis.fetch = originalFetch;
  await rm(tempDir, { recursive: true, force: true });
});

test("new Shopify mappings baseline without pushing remote inventory", async () => {
  await writeStore(seedStore({ quantity: 15 }));
  let mutationCalls = 0;

  mockShopify({
    remoteQuantity: 4,
    onMutation: () => {
      mutationCalls += 1;
      return successMutation();
    }
  });

  const run = await runInventorySync("cli");
  const stored = await readStore();
  const item = stored.items[0];

  assert.equal(run.summary.pushes, 0);
  assert.equal(run.summary.warnings, 1);
  assert.equal(mutationCalls, 0);
  assert.equal(item.quantity, 15);
  assert.equal(item.mappings.shopify?.lastSyncedQuantity, 4);
  assert.match(run.messages.join("\n"), /baseline captured/);
});

test("failed pulls do not push stale local inventory", async () => {
  await writeStore(
    seedStore({
      quantity: 10,
      lastSyncedQuantity: 10,
      lastRemoteQuantity: 10
    })
  );
  let mutationCalls = 0;

  globalThis.fetch = (async (_url, init) => {
    const body = readGraphqlBody(init);
    if (body.query?.includes("query InventoryLevel")) {
      return jsonResponse({ errors: [{ message: "Rate limited" }] });
    }
    if (body.query?.includes("mutation InventorySet")) {
      mutationCalls += 1;
      return successMutation();
    }
    throw new Error(`Unexpected Shopify GraphQL operation: ${body.query ?? "missing query"}`);
  }) as typeof fetch;

  const run = await runInventorySync("cli");
  const stored = await readStore();

  assert.equal(run.summary.errors, 1);
  assert.equal(run.summary.pushes, 0);
  assert.equal(mutationCalls, 0);
  assert.equal(stored.items[0].quantity, 10);
});

test("failed pushes do not make the same platform sale subtract twice", async () => {
  await writeStore(
    seedStore({
      quantity: 10,
      lastSyncedQuantity: 10,
      lastRemoteQuantity: 10
    })
  );

  mockShopify({
    remoteQuantity: 9,
    onMutation: () =>
      jsonResponse({
        data: {
          inventorySetQuantities: {
            inventoryAdjustmentGroup: null,
            userErrors: [{ message: "Simulated push failure" }]
          }
        }
      })
  });

  const firstRun = await runInventorySync("cli");
  const secondRun = await runInventorySync("cli");
  const stored = await readStore();
  const item = stored.items[0];

  assert.equal(firstRun.summary.salesDetected, 1);
  assert.equal(secondRun.summary.salesDetected, 0);
  assert.equal(item.quantity, 9);
  assert.equal(item.mappings.shopify?.lastSyncedQuantity, 9);
});

async function writeStore(data: StoreData) {
  await writeFile(dataFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readStore() {
  return JSON.parse(await readFile(dataFile, "utf8")) as StoreData;
}

function seedStore({
  quantity,
  lastSyncedQuantity,
  lastRemoteQuantity
}: {
  quantity: number;
  lastSyncedQuantity?: number;
  lastRemoteQuantity?: number;
}): StoreData {
  return {
    items: [
      {
        id: "item-1",
        sku: "NEON-MUG",
        name: "Neon Mug",
        quantity,
        safetyStock: 0,
        mappings: {
          shopify: {
            enabled: true,
            inventoryItemId: "gid://shopify/InventoryItem/1",
            locationId: "gid://shopify/Location/1",
            lastSyncedQuantity,
            lastRemoteQuantity,
            lastSyncedAt: lastSyncedQuantity === undefined ? null : timestamp,
            warning: null
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

function mockShopify({
  remoteQuantity,
  onMutation
}: {
  remoteQuantity: number;
  onMutation: () => Response;
}) {
  globalThis.fetch = (async (_url, init) => {
    const body = readGraphqlBody(init);

    if (body.query?.includes("query InventoryLevel")) {
      return jsonResponse({
        data: {
          inventoryItem: {
            inventoryLevel: {
              quantities: [{ name: "available", quantity: remoteQuantity }]
            }
          }
        }
      });
    }

    if (body.query?.includes("mutation InventorySet")) {
      return onMutation();
    }

    throw new Error(`Unexpected Shopify GraphQL operation: ${body.query ?? "missing query"}`);
  }) as typeof fetch;
}

function readGraphqlBody(init?: RequestInit) {
  return JSON.parse(String(init?.body ?? "{}")) as { query?: string };
}

function successMutation() {
  return jsonResponse({
    data: {
      inventorySetQuantities: {
        inventoryAdjustmentGroup: {
          changes: []
        },
        userErrors: []
      }
    }
  });
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
