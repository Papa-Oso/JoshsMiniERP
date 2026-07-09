import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-sqlite-workflow-"));
const databaseFile = path.join(tempDir, "inventory.sqlite");
const dataFile = path.join(tempDir, "inventory.json");
const printingFile = path.join(tempDir, "printing.json");
const feedbackFile = path.join(tempDir, "feedback.sqlite");
const printingAssetDir = path.join(tempDir, "printing-assets");
const originalFetch = globalThis.fetch;

process.env.STORE_DRIVER = "sqlite";
process.env.DATABASE_FILE = databaseFile;
process.env.DATA_FILE = dataFile;
process.env.PRINTING_DATA_FILE = printingFile;
process.env.FEEDBACK_DATA_FILE = feedbackFile;
process.env.PRINTING_ASSET_DIR = printingAssetDir;
process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "test-token";
process.env.SHOPIFY_API_VERSION = "2026-07";

const { adjustInventory, createItem, listData, updateItem } = await import("../src/server/inventoryService.ts");
const { backupInventoryData, exportInventoryData } = await import("../src/server/dataTools.ts");
const { importCsv } = await import("../src/server/csvImport.ts");
const { listImportBatches } = await import("../src/server/importHistory.ts");
const { adjustInstruction, getPrintingData, updatePrintSettings, updateSkuInstructionMatch } = await import("../src/server/printingService.ts");
const { importShopifySkus } = await import("../src/server/shopifyImport.ts");
const { reconcileInventory } = await import("../src/server/reconcile.ts");
const { runInventorySync } = await import("../src/server/syncEngine.ts");
const { closeStore } = await import("../src/server/store.ts");

after(async () => {
  globalThis.fetch = originalFetch;
  await closeStore();
  await rm(tempDir, { recursive: true, force: true });
});

test("SQLite default store supports inventory, import, reconcile, sync, backup, and export workflows", async () => {
  const item = await createItem({
    sku: "LOCAL-SKU",
    name: "Local SKU",
    quantity: 10,
    safetyStock: 2,
    maxInventory: 50
  });

  await adjustInventory(item.id, { delta: 5, type: "batch_add", note: "restock" });
  await adjustInventory(item.id, { delta: -2, type: "manual_subtract", note: "sample" });

  await updateItem(item.id, {
    mappings: {
      shopify: {
        enabled: true,
        remoteSku: "LOCAL-SKU",
        inventoryItemId: "gid://shopify/InventoryItem/1",
        locationId: "gid://shopify/Location/1",
        lastSyncedQuantity: 13,
        lastRemoteQuantity: 13,
        lastSyncedAt: "2026-01-01T00:00:00.000Z",
        warning: null
      }
    }
  });

  const csvPath = path.join(tempDir, "batch.csv");
  await writeFile(csvPath, "sku,name,quantity,add,safety_stock,note\nCSV-SKU,CSV SKU,4,,1,initial\nLOCAL-SKU,,,2,,csv add\n", "utf8");
  const csvResult = await importCsv(csvPath);
  assert.equal(csvResult.summary.created, 1);
  assert.equal(csvResult.summary.adjusted, 1);

  mockShopify({ remoteQuantity: 12 });
  const reconcile = await reconcileInventory({ platform: "shopify" });
  assert.equal(reconcile.summary.salesDetected, 0);
  assert.equal(reconcile.rows.find((row) => row.sku === "LOCAL-SKU")?.status, "baseline");

  const baselineRun = await runInventorySync("cli");
  assert.equal(baselineRun.summary.salesDetected, 0);
  assert.equal(baselineRun.summary.pushes, 0);

  mockShopify({ remoteQuantity: 11 });
  const run = await runInventorySync("cli");
  assert.equal(run.summary.salesDetected, 1);
  assert.equal(run.summary.pushes, 1);

  mockShopify({
    remoteQuantity: 6,
    variants: [
      {
        sku: "SHOPIFY-NEW",
        title: "Shopify New",
        inventoryItemId: "gid://shopify/InventoryItem/99",
        locationId: "gid://shopify/Location/1",
        quantity: 6
      }
    ]
  });
  const shopifyImport = await importShopifySkus({ location: "Main" });
  assert.equal(shopifyImport.summary.created, 1);

  await updatePrintSettings({ labelPrinterName: "SQLite Label Printer", instructionPrinterName: "SQLite Instruction Printer" });
  await updateSkuInstructionMatch("LOCAL-SKU", { mode: "instruction", instructionId: "hjc" });
  await adjustInstruction("hjc", { delta: 12, type: "print_batch", note: "SQLite print batch" });
  const printing = await getPrintingData();
  const hjc = printing.instructions.find((instruction) => instruction.id === "hjc");
  assert.equal(hjc?.onHand, 12);
  assert.equal(printing.defaults.labelPrinterName, "SQLite Label Printer");
  assert.equal(printing.defaults.instructionPrinterName, "SQLite Instruction Printer");
  assert.equal(printing.instructionMatches.find((match) => match.sku === "LOCAL-SKU")?.instructionId, "hjc");
  assert.equal(printing.events[0]?.delta, 12);
  await assert.rejects(() => readFile(printingFile, "utf8"), /ENOENT/);

  const importBatches = await listImportBatches();
  const csvBatch = importBatches.find((batch) => batch.source === "csv");
  const shopifyBatch = importBatches.find((batch) => batch.source === "shopify");
  assert.equal(importBatches.length, 2);
  assert.equal(csvBatch?.status, "applied");
  assert.equal(csvBatch?.summary.rowsTotal, 2);
  assert.equal(csvBatch?.summary.created, 1);
  assert.equal(csvBatch?.summary.adjusted, 1);
  assert.equal(csvBatch?.rows.some((row) => row.lineNumber === 3 && row.action === "adjust"), true);
  assert.equal(shopifyBatch?.status, "applied");
  assert.equal(shopifyBatch?.summary.variantsScanned, 1);
  assert.equal(shopifyBatch?.summary.created, 1);
  assert.equal(shopifyBatch?.rows[0]?.sku, "SHOPIFY-NEW");

  await writeFile(printingFile, `${JSON.stringify({ settings: { labelPrinter: "Test Label Printer" } }, null, 2)}\n`, "utf8");
  await writeFile(feedbackFile, "test feedback sqlite placeholder", "utf8");
  await mkdir(printingAssetDir, { recursive: true });
  await writeFile(path.join(printingAssetDir, "instruction.txt"), "instruction asset", "utf8");

  const backup = await backupInventoryData(path.join(tempDir, "backups"));
  const exportPath = path.join(tempDir, "export.json");
  const exported = await exportInventoryData(exportPath);
  const exportedData = JSON.parse(await readFile(exportPath, "utf8")) as Awaited<ReturnType<typeof listData>>;
  const backupFiles = backup.files ?? [];
  const manifest = JSON.parse(await readFile(backup.path, "utf8")) as { files: string[]; missingSources: string[] };

  assert.equal(backup.itemCount, 3);
  assert.ok(path.basename(backup.path).startsWith("operational-backup-"));
  assert.equal(backupFiles.length, 6);
  assert.equal(manifest.files.length, 5);
  assert.equal(manifest.missingSources.length, 0);
  assert.ok(backupFiles.some((file) => path.basename(file).startsWith("inventory-") && file.endsWith(".json")));
  assert.ok(backupFiles.some((file) => path.basename(file).startsWith("inventory-") && file.endsWith(".sqlite")));
  assert.ok(backupFiles.some((file) => path.basename(file).startsWith("printing-") && file.endsWith(".json")));
  assert.ok(backupFiles.some((file) => path.basename(file).startsWith("feedback-") && file.endsWith(".sqlite")));
  assert.ok(backupFiles.some((file) => path.basename(file).startsWith("printing-assets-")));
  assert.equal(exported.itemCount, 3);
  assert.equal(exportedData.items.some((candidate) => candidate.sku === "SHOPIFY-NEW"), true);

  const data = await listData();
  const local = data.items.find((candidate) => candidate.sku === "LOCAL-SKU");
  const csv = data.items.find((candidate) => candidate.sku === "CSV-SKU");
  const shopify = data.items.find((candidate) => candidate.sku === "SHOPIFY-NEW");

  assert.equal(local?.quantity, 14);
  assert.equal(local?.mappings.shopify?.lastSyncedQuantity, 14);
  assert.equal(csv?.quantity, 4);
  assert.equal(shopify?.quantity, 6);
  assert.ok(data.events.some((event) => event.type === "sync_push"));
  assert.ok(data.syncRuns.length >= 1);
});

function mockShopify({
  remoteQuantity,
  variants = []
}: {
  remoteQuantity: number;
  variants?: Array<{
    sku: string;
    title: string;
    inventoryItemId: string;
    locationId: string;
    quantity: number;
  }>;
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

    if (body.query?.includes("query ListSkuVariants")) {
      return jsonResponse({
        data: {
          productVariants: {
            pageInfo: {
              hasNextPage: false,
              endCursor: null
            },
            nodes: variants.map((variant) => ({
              id: `gid://shopify/ProductVariant/${variant.sku}`,
              sku: variant.sku,
              displayName: variant.title,
              title: "Default Title",
              product: {
                title: variant.title,
                descriptionHtml: `<p>${variant.title}</p>`
              },
              inventoryItem: {
                id: variant.inventoryItemId,
                inventoryLevels: {
                  nodes: [
                    {
                      id: `${variant.inventoryItemId}:level`,
                      location: {
                        id: variant.locationId,
                        name: "Main"
                      },
                      quantities: [{ name: "available", quantity: variant.quantity }]
                    }
                  ]
                }
              }
            }))
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
