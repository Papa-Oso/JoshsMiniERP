import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StoreData } from "../src/shared/types";

const timestamp = "2026-01-01T00:00:00.000Z";

test("failed pushes do not make the same platform sale subtract twice", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-"));
  const dataFile = path.join(tempDir, "inventory.json");
  const originalFetch = globalThis.fetch;

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  });

  process.env.DATA_FILE = dataFile;
  process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "test-token";
  process.env.SHOPIFY_API_VERSION = "2026-07";

  const seed: StoreData = {
    items: [
      {
        id: "item-1",
        sku: "NEON-MUG",
        name: "Neon Mug",
        quantity: 10,
        safetyStock: 0,
        mappings: {
          shopify: {
            enabled: true,
            inventoryItemId: "gid://shopify/InventoryItem/1",
            locationId: "gid://shopify/Location/1",
            lastSyncedQuantity: 10,
            lastRemoteQuantity: 10,
            lastSyncedAt: timestamp,
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

  await writeFile(dataFile, `${JSON.stringify(seed, null, 2)}\n`, "utf8");

  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };

    if (body.query?.includes("query InventoryLevel")) {
      return jsonResponse({
        data: {
          inventoryItem: {
            inventoryLevel: {
              quantities: [{ name: "available", quantity: 9 }]
            }
          }
        }
      });
    }

    if (body.query?.includes("mutation InventorySet")) {
      return jsonResponse({
        data: {
          inventorySetQuantities: {
            inventoryAdjustmentGroup: null,
            userErrors: [{ message: "Simulated push failure" }]
          }
        }
      });
    }

    throw new Error(`Unexpected Shopify GraphQL operation: ${body.query ?? "missing query"}`);
  }) as typeof fetch;

  const { runInventorySync } = await import("../src/server/syncEngine.ts");

  const firstRun = await runInventorySync("cli");
  const secondRun = await runInventorySync("cli");
  const stored = JSON.parse(await readFile(dataFile, "utf8")) as StoreData;
  const item = stored.items[0];

  assert.equal(firstRun.summary.salesDetected, 1);
  assert.equal(secondRun.summary.salesDetected, 0);
  assert.equal(item.quantity, 9);
  assert.equal(item.mappings.shopify?.lastSyncedQuantity, 9);
});

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
