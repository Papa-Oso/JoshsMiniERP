import type { Platform, PlatformMapping } from "../shared/types";
import { platformLabels, platforms } from "../shared/types";
import { ShopifyAdapter } from "./adapters/shopify";
import { completeEtsyAuthorization, createEtsyAuthorization, refreshEtsyToken } from "./etsyAuth";
import { createItem, adjustInventory, listData, updateItem, updateSchedule } from "./inventoryService";
import { runInventorySync } from "./syncEngine";

type ShopifyLookupResult = Awaited<ReturnType<ShopifyAdapter["lookupSku"]>>;
type ShopifyInventoryLevel =
  ShopifyLookupResult["productVariants"]["nodes"][number]["inventoryItem"]["inventoryLevels"]["nodes"][number];

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
    case "shopify-lookup":
      await shopifyLookupFromCli(args.slice(1));
      break;
    case "shopify-map":
      await shopifyMapFromCli(args.slice(1));
      break;
    case "etsy-auth-url":
      await etsyAuthUrlFromCli();
      break;
    case "etsy-auth-callback":
      await etsyAuthCallbackFromCli(args.slice(1));
      break;
    case "etsy-refresh":
      await etsyRefreshFromCli();
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

async function shopifyLookupFromCli(input: string[]) {
  const [sku] = input;
  if (!sku) throw new Error("Usage: npm run inv -- shopify-lookup <sku>");

  const adapter = new ShopifyAdapter();
  if (!adapter.isConfigured()) {
    throw new Error(`Shopify is missing: ${adapter.missingEnv().join(", ")}`);
  }

  const result = await adapter.lookupSku(sku);
  if (result.productVariants.nodes.length === 0) {
    console.log(`No Shopify variants found for SKU ${sku}.`);
    return;
  }

  for (const variant of result.productVariants.nodes) {
    console.log(`${variant.displayName}`);
    console.log(`  SKU: ${variant.sku ?? "-"}`);
    console.log(`  Inventory item: ${variant.inventoryItem.id}`);
    for (const level of variant.inventoryItem.inventoryLevels.nodes) {
      const available = level.quantities.find((quantity) => quantity.name === "available")?.quantity ?? "-";
      console.log(`  Location: ${level.location.name} (${level.location.id}) available=${available}`);
    }
  }
}

async function shopifyMapFromCli(input: string[]) {
  const [localSku, maybeShopifySku, ...rest] = input;
  if (!localSku) {
    throw new Error("Usage: npm run inv -- shopify-map <local-sku> [shopify-sku] [--location <name-or-id>]");
  }

  const shopifySku = maybeShopifySku && !maybeShopifySku.startsWith("--") ? maybeShopifySku : localSku;
  const flags = parseFlags(maybeShopifySku && !maybeShopifySku.startsWith("--") ? rest : input.slice(1));
  const locationFilter = stringFlag(flags.location);
  const item = await findItemBySku(localSku);

  const adapter = new ShopifyAdapter();
  if (!adapter.isConfigured()) {
    throw new Error(`Shopify is missing: ${adapter.missingEnv().join(", ")}`);
  }

  const result = await adapter.lookupSku(shopifySku);
  const variants = result.productVariants.nodes;
  if (variants.length === 0) {
    throw new Error(`No Shopify variants found for SKU ${shopifySku}.`);
  }
  if (variants.length > 1) {
    throw new Error(
      [`Shopify SKU ${shopifySku} matched multiple variants. Use a more specific Shopify SKU:`]
        .concat(variants.map((variant) => `- ${variant.displayName} (${variant.sku ?? "-"})`))
        .join("\n")
    );
  }

  const variant = variants[0];
  const level = chooseShopifyLocation(variant.inventoryItem.inventoryLevels.nodes, locationFilter);
  const available = level.quantities.find((quantity) => quantity.name === "available")?.quantity;
  const current = item.mappings.shopify ?? { enabled: false };

  await updateItem(item.id, {
    mappings: {
      shopify: {
        ...current,
        enabled: !flags.disable,
        inventoryItemId: variant.inventoryItem.id,
        locationId: level.location.id,
        lastRemoteQuantity: typeof available === "number" ? available : current.lastRemoteQuantity
      }
    }
  });

  console.log(`${item.sku}: Shopify mapping saved.`);
  console.log(`  Inventory item: ${variant.inventoryItem.id}`);
  console.log(`  Location: ${level.location.name} (${level.location.id})`);
  console.log(`  Available: ${typeof available === "number" ? available : "-"}`);
}

async function etsyAuthUrlFromCli() {
  const auth = await createEtsyAuthorization();
  console.log("Register this exact redirect URI in Etsy if you have not already:");
  console.log(auth.redirectUri);
  console.log("");
  console.log(`Scopes: ${auth.scopes.join(" ")}`);
  console.log("");
  console.log("Open this URL after Etsy approves the app:");
  console.log(auth.url);
  console.log("");
  console.log("After approval, paste the full final redirect URL into:");
  console.log('npm run inv -- etsy-auth-callback "https://..."');
}

async function etsyAuthCallbackFromCli(input: string[]) {
  const [callbackValue] = input;
  if (!callbackValue) {
    throw new Error('Usage: npm run inv -- etsy-auth-callback "https://your-redirect-url?code=...&state=..."');
  }

  const token = await completeEtsyAuthorization(callbackValue);
  console.log(`Etsy OAuth saved. Access token expires in ${Math.round(token.expires_in / 60)} minutes.`);
}

async function etsyRefreshFromCli() {
  const token = await refreshEtsyToken();
  console.log(`Etsy token refreshed. Access token expires in ${Math.round(token.expires_in / 60)} minutes.`);
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

function chooseShopifyLocation(levels: ShopifyInventoryLevel[], filter?: string) {
  if (levels.length === 0) {
    throw new Error("Shopify returned no inventory locations for this SKU.");
  }

  if (filter) {
    const normalized = filter.toLowerCase();
    const match = levels.find((level) => {
      const locationId = level.location.id.toLowerCase();
      return (
        level.location.name.toLowerCase() === normalized ||
        locationId === normalized ||
        locationId.endsWith(`/${normalized}`)
      );
    });
    if (!match) {
      throw new Error(
        [`No Shopify location matched ${filter}. Available locations:`]
          .concat(levels.map((level) => `- ${level.location.name} (${level.location.id})`))
          .join("\n")
      );
    }
    return match;
  }

  if (levels.length > 1) {
    throw new Error(
      ["Shopify returned multiple locations. Rerun with --location <name-or-id>:"]
        .concat(levels.map((level) => `- ${level.location.name} (${level.location.id})`))
        .join("\n")
    );
  }

  return levels[0];
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
  npm run inv -- shopify-lookup <sku>
  npm run inv -- shopify-map <local-sku> [shopify-sku] [--location <name-or-id>]
  npm run inv -- etsy-auth-url
  npm run inv -- etsy-auth-callback "https://..."
  npm run inv -- etsy-refresh
  npm run inv -- schedule <on|off> [intervalMinutes]
  npm run inv -- map <sku> etsy --listing-id <id> --remote-sku <sku> --enable
  npm run inv -- map <sku> ebay --remote-sku <sku> --offer-id <id> --enable
  npm run inv -- map <sku> shopify --inventory-item-id <id-or-gid> --location-id <id-or-gid> --enable
`);
}
