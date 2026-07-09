import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StoreData } from "../src/shared/types";

const timestamp = "2026-01-01T00:00:00.000Z";
const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-shopify-details-"));
const dataFile = path.join(tempDir, "inventory.json");
const originalFetch = globalThis.fetch;

process.env.DATA_FILE = dataFile;
process.env.STORE_DRIVER = "json";
process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "test-token";
process.env.SHOPIFY_API_VERSION = "2026-07";

const { refreshShopifyDetails } = await import("../src/server/shopifyDetails.ts");

after(async () => {
  globalThis.fetch = originalFetch;
  await rm(tempDir, { recursive: true, force: true });
});

test("Shopify details refresh previews and applies names and descriptions safely", async () => {
  await writeStore(seedStore());
  mockShopifyDetails();

  const dryRun = await refreshShopifyDetails({ dryRun: true });
  const previewStore = await readStore();

  assert.equal(dryRun.summary.shopifySkus, 2);
  assert.equal(dryRun.summary.updated, 2);
  assert.equal(dryRun.summary.skipped, 1);
  assert.equal(dryRun.rows.find((row) => row.sku === "SKU-NAME")?.nextName, "Product One");
  assert.equal(dryRun.rows.find((row) => row.sku === "CUSTOM-NAME")?.nextName, "Hand Named");
  assert.equal(previewStore.items.find((item) => item.sku === "SKU-NAME")?.name, "SKU-NAME");
  assert.equal(previewStore.items.find((item) => item.sku === "CUSTOM-NAME")?.description, "Old copy");

  const applied = await refreshShopifyDetails();
  const stored = await readStore();
  const skuNamed = stored.items.find((item) => item.sku === "SKU-NAME");
  const customNamed = stored.items.find((item) => item.sku === "CUSTOM-NAME");
  const missing = stored.items.find((item) => item.sku === "MISSING-SHOPIFY");

  assert.equal(applied.summary.updated, 2);
  assert.equal(skuNamed?.name, "Product One");
  assert.equal(skuNamed?.description, "Bright & useful product.");
  assert.equal(customNamed?.name, "Hand Named");
  assert.equal(customNamed?.description, "Fresh custom description.");
  assert.equal(missing?.name, "Missing Shopify");
});

test("Shopify details refresh explains missing read_products scope", async () => {
  await writeStore(seedStore());
  globalThis.fetch = (async (_url, init) => {
    const body = readGraphqlBody(init);
    if (body.query?.includes("query ListSkuProductDetails")) {
      return jsonResponse({ errors: [{ message: "Access denied for productVariants field." }] });
    }
    throw new Error(`Unexpected Shopify GraphQL operation: ${body.query ?? "missing query"}`);
  }) as typeof fetch;

  await assert.rejects(
    () => refreshShopifyDetails({ dryRun: true }),
    /read_products scope.+approve the new scopes.+fresh offline session token/
  );
});

async function writeStore(data: StoreData) {
  await writeFile(dataFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readStore() {
  return JSON.parse(await readFile(dataFile, "utf8")) as StoreData;
}

function seedStore(): StoreData {
  return {
    items: [
      item("item-1", "SKU-NAME", "SKU-NAME"),
      item("item-2", "CUSTOM-NAME", "Hand Named", "Old copy"),
      item("item-3", "MISSING-SHOPIFY", "Missing Shopify")
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

function item(id: string, sku: string, name: string, description?: string): StoreData["items"][number] {
  return {
    id,
    sku,
    name,
    description,
    quantity: 10,
    safetyStock: 0,
    maxInventory: 100,
    active: true,
    mappings: {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function mockShopifyDetails() {
  globalThis.fetch = (async (_url, init) => {
    const body = readGraphqlBody(init);
    if (body.query?.includes("query ListSkuProductDetails")) {
      return jsonResponse({
        data: {
          productVariants: {
            pageInfo: {
              hasNextPage: false,
              endCursor: null
            },
            nodes: [
              {
                id: "gid://shopify/ProductVariant/1",
                sku: "SKU-NAME",
                displayName: "Product One - Default Title",
                title: "Default Title",
                product: {
                  title: "Product One",
                  descriptionHtml: "<p>Bright &amp; useful product.</p>"
                }
              },
              {
                id: "gid://shopify/ProductVariant/2",
                sku: "CUSTOM-NAME",
                displayName: "Custom Product - Default Title",
                title: "Default Title",
                product: {
                  title: "Custom Product",
                  descriptionHtml: "<p>Fresh custom description.</p>"
                }
              }
            ]
          }
        }
      });
    }
    throw new Error(`Unexpected Shopify GraphQL operation: ${body.query ?? "missing query"}`);
  }) as typeof fetch;
}

function readGraphqlBody(init?: RequestInit) {
  return JSON.parse(String(init?.body ?? "{}")) as {
    query?: string;
  };
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
