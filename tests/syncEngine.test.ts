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
const { updateItem } = await import("../src/server/inventoryService.ts");
const { importCsv } = await import("../src/server/csvImport.ts");
const { reconcileInventory } = await import("../src/server/reconcile.ts");

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

test("sync only pushes Shopify SKUs whose remote quantity differs from local", async () => {
  const store = seedStore({
    quantity: 10,
    lastSyncedQuantity: 10,
    lastRemoteQuantity: 10
  });
  store.items[0].sku = "UNCHANGED";
  store.items[0].name = "Unchanged";
  store.items.push({
    id: "item-2",
    sku: "CHANGED",
    name: "Changed",
    quantity: 13,
    safetyStock: 0,
    mappings: {
      shopify: {
        enabled: true,
        inventoryItemId: "gid://shopify/InventoryItem/2",
        locationId: "gid://shopify/Location/1",
        lastSyncedQuantity: 12,
        lastRemoteQuantity: 12,
        lastSyncedAt: timestamp,
        warning: null
      }
    },
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await writeStore(store);

  const mutationInputs: Array<{ inventoryItemId: string; quantity: number }> = [];
  globalThis.fetch = (async (_url, init) => {
    const body = readGraphqlBody(init);

    if (body.query?.includes("query InventoryLevel")) {
      const inventoryItemId = body.variables?.inventoryItemId ?? "";
      const remoteQuantity = inventoryItemId.endsWith("/2") ? 12 : 10;
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
      const quantityInput = body.variables?.input?.quantities?.[0];
      mutationInputs.push({
        inventoryItemId: quantityInput?.inventoryItemId ?? "",
        quantity: quantityInput?.quantity ?? 0
      });
      return successMutation();
    }

    throw new Error(`Unexpected Shopify GraphQL operation: ${body.query ?? "missing query"}`);
  }) as typeof fetch;

  const run = await runInventorySync("cli");
  const stored = await readStore();
  const syncPushEvents = stored.events.filter((event) => event.type === "sync_push");

  assert.equal(run.summary.pushes, 1);
  assert.deepEqual(mutationInputs, [{ inventoryItemId: "gid://shopify/InventoryItem/2", quantity: 13 }]);
  assert.equal(syncPushEvents.length, 1);
  assert.equal(syncPushEvents[0].sku, "CHANGED");
  assert.equal(stored.items.find((item) => item.sku === "UNCHANGED")?.mappings.shopify?.lastSyncedQuantity, 10);
  assert.equal(stored.items.find((item) => item.sku === "CHANGED")?.mappings.shopify?.lastSyncedQuantity, 13);
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

test("changing mapping identity clears the previous sync baseline", async () => {
  await writeStore(
    seedStore({
      quantity: 10,
      lastSyncedQuantity: 10,
      lastRemoteQuantity: 10
    })
  );

  await updateItem("item-1", {
    mappings: {
      shopify: {
        enabled: true,
        inventoryItemId: "gid://shopify/InventoryItem/2",
        locationId: "gid://shopify/Location/1"
      }
    }
  });

  const stored = await readStore();
  const mapping = stored.items[0].mappings.shopify;

  assert.equal(mapping?.lastSyncedQuantity, null);
  assert.equal(mapping?.lastRemoteQuantity, null);
  assert.equal(mapping?.lastSyncedAt, null);
  assert.match(mapping?.warning ?? "", /mapping changed/);
});

test("reconcile previews Shopify sales without mutating local inventory", async () => {
  await writeStore(
    seedStore({
      quantity: 10,
      lastSyncedQuantity: 10,
      lastRemoteQuantity: 10
    })
  );

  mockShopify({
    remoteQuantity: 8,
    onMutation: () => {
      throw new Error("Reconcile should not push inventory.");
    }
  });

  const result = await reconcileInventory({ platform: "shopify" });
  const stored = await readStore();

  assert.equal(result.summary.salesDetected, 2);
  assert.equal(result.summary.pushes, 1);
  assert.equal(result.rows[0].status, "sale");
  assert.equal(result.rows[0].wouldPushQuantity, 8);
  assert.equal(stored.items[0].quantity, 10);
  assert.equal(stored.events.length, 0);
  assert.equal(stored.syncRuns.length, 0);
});

test("csv import creates new SKUs and applies batch quantities", async () => {
  await writeStore(
    seedStore({
      quantity: 10
    })
  );
  const csvPath = path.join(tempDir, "batch.csv");
  await writeFile(
    csvPath,
    "sku,name,quantity,add,safety_stock,note\nNEW-SKU,New SKU,5,,2,initial\nNEON-MUG,,,3,,restock\n",
    "utf8"
  );

  const result = await importCsv(csvPath);
  const stored = await readStore();
  const created = stored.items.find((item) => item.sku === "NEW-SKU");
  const adjusted = stored.items.find((item) => item.sku === "NEON-MUG");

  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.adjusted, 1);
  assert.equal(created?.quantity, 5);
  assert.equal(created?.safetyStock, 2);
  assert.equal(adjusted?.quantity, 13);
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
  return JSON.parse(String(init?.body ?? "{}")) as {
    query?: string;
    variables?: {
      inventoryItemId?: string;
      input?: {
        quantities?: Array<{
          inventoryItemId?: string;
          quantity?: number;
        }>;
      };
    };
  };
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
