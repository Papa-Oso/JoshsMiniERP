import type { Platform, PlatformMapping } from "../shared/types";
import { platformLabels, platforms } from "../shared/types";
import { ShopifyAdapter } from "./adapters/shopify";
import { createItem, adjustInventory, listData, updateItem, updateSchedule } from "./inventoryService";
import { runInventorySync } from "./syncEngine";

const args = process.argv.slice(2);
const command = args[0];

try {
  switch (command) {
    case "list":
      await listItems();
      break;
    case "create":
      await createFromCli(args.slice(1));
      break;
    case "add":
      await adjustFromCli(args.slice(1), "add");
      break;
    case "subtract":
    case "sub":
      await adjustFromCli(args.slice(1), "subtract");
      break;
    case "map":
      await mapFromCli(args.slice(1));
      break;
    case "sync":
      await syncFromCli();
      break;
    case "shopify-test":
      await shopifyTestFromCli();
      break;
    case "schedule":
      await scheduleFromCli(args.slice(1));
      break;
    default:
      printHelp();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function listItems() {
  const data = await listData();
  if (data.items.length === 0) {
    console.log("No inventory items yet.");
    return;
  }

  console.table(
    data.items.map((item) => ({
      sku: item.sku,
      name: item.name,
      qty: item.quantity,
      safety: item.safetyStock,
      etsy: item.mappings.etsy?.enabled ? "on" : "",
      ebay: item.mappings.ebay?.enabled ? "on" : "",
      shopify: item.mappings.shopify?.enabled ? "on" : ""
    }))
  );
}

async function createFromCli(input: string[]) {
  const [sku, name, quantity = "0"] = input;
  if (!sku || !name) throw new Error("Usage: npm run inv -- create <sku> <name> [quantity]");
  const item = await createItem({ sku, name, quantity: Number(quantity) });
  console.log(`Created ${item.sku} with ${item.quantity} on hand.`);
}

async function adjustFromCli(input: string[], mode: "add" | "subtract") {
  const [sku, quantity, ...noteParts] = input;
  if (!sku || !quantity) {
    throw new Error(`Usage: npm run inv -- ${mode} <sku> <quantity> [note]`);
  }

  const item = await findItemBySku(sku);
  const units = Number(quantity);
  const delta = mode === "add" ? units : -units;
  const updated = await adjustInventory(item.id, {
    delta,
    type: mode === "add" ? "batch_add" : "manual_subtract",
    note: noteParts.join(" ") || undefined
  });
  console.log(`${updated.sku}: ${updated.quantity} on hand.`);
}

async function mapFromCli(input: string[]) {
  const [sku, rawPlatform, ...rest] = input;
  if (!sku || !rawPlatform || !isPlatform(rawPlatform)) {
    throw new Error("Usage: npm run inv -- map <sku> <etsy|ebay|shopify> [--enable|--disable] [fields]");
  }

  const flags = parseFlags(rest);
  const item = await findItemBySku(sku);
  const current = item.mappings[rawPlatform] ?? { enabled: false };
  const mapping: PlatformMapping = {
    ...current,
    enabled: flags.enable ? true : flags.disable ? false : current.enabled,
    remoteSku: stringFlag(flags["remote-sku"]) ?? current.remoteSku,
    listingId: stringFlag(flags["listing-id"]) ?? current.listingId,
    inventoryItemId: stringFlag(flags["inventory-item-id"]) ?? current.inventoryItemId,
    locationId: stringFlag(flags["location-id"]) ?? current.locationId,
    offerId: stringFlag(flags["offer-id"]) ?? current.offerId
  };

  await updateItem(item.id, { mappings: { [rawPlatform]: mapping } });
  console.log(`${item.sku}: ${platformLabels[rawPlatform]} mapping saved.`);
}

async function syncFromCli() {
  const run = await runInventorySync("cli");
  console.log(`${run.status}: ${run.summary.salesDetected} sales, ${run.summary.pushes} pushes.`);
  for (const message of run.messages) {
    console.log(`- ${message}`);
  }
}

async function shopifyTestFromCli() {
  const adapter = new ShopifyAdapter();
  if (!adapter.isConfigured()) {
    throw new Error(`Shopify is missing: ${adapter.missingEnv().join(", ")}`);
  }

  const result = await adapter.testConnection();
  console.log(`Shopify connected: ${result.shop.name} (${result.shop.myshopifyDomain})`);
}

async function scheduleFromCli(input: string[]) {
  const [state, interval] = input;
  if (state !== "on" && state !== "off") {
    throw new Error("Usage: npm run inv -- schedule <on|off> [intervalMinutes]");
  }

  const schedule = await updateSchedule({
    enabled: state === "on",
    intervalMinutes: interval ? Number(interval) : undefined
  });
  console.log(`Schedule ${schedule.enabled ? "on" : "off"} every ${schedule.intervalMinutes} minutes.`);
}

async function findItemBySku(sku: string) {
  const data = await listData();
  const item = data.items.find((candidate) => candidate.sku.toUpperCase() === sku.toUpperCase());
  if (!item) throw new Error(`SKU ${sku} not found.`);
  return item;
}

function parseFlags(input: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = input[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return flags;
}

function stringFlag(value: string | boolean | undefined) {
  return typeof value === "string" ? value : undefined;
}

function isPlatform(value: string): value is Platform {
  return platforms.includes(value as Platform);
}

function printHelp() {
  console.log(`Josh's Mini ERP inventory CLI

Commands:
  npm run inv -- list
  npm run inv -- create <sku> <name> [quantity]
  npm run inv -- add <sku> <quantity> [note]
  npm run inv -- subtract <sku> <quantity> [note]
  npm run inv -- sync
  npm run inv -- shopify-test
  npm run inv -- schedule <on|off> [intervalMinutes]
  npm run inv -- map <sku> etsy --listing-id <id> --remote-sku <sku> --enable
  npm run inv -- map <sku> ebay --remote-sku <sku> --offer-id <id> --enable
  npm run inv -- map <sku> shopify --inventory-item-id <id-or-gid> --location-id <id-or-gid> --enable
`);
}
