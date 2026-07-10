import type { Platform, PlatformMapping } from "../shared/types";
import { platformLabels, platforms } from "../shared/types";
import { EbayAdapter } from "./adapters/ebay";
import { ShopifyAdapter } from "./adapters/shopify";
import { importCsv } from "./csvImport";
import {
  backupInventoryData,
  exportInventoryCsv,
  exportInventoryData,
  exportInventoryEventsCsv,
  exportOperationsReportCsv,
  inspectOperationalBackup
} from "./dataTools";
import { runDoctor } from "./diagnostics";
import { completeEbayAuthorization, createEbayAuthorization, refreshEbayToken } from "./ebayAuth";
import {
  applyEbayLegacyMappings,
  previewEbayLegacyMappings,
  scanEbayLegacyListings,
  type EbayLegacyOutputFormat
} from "./ebayLegacyListings";
import { completeEtsyAuthorization, createEtsyAuthorization, refreshEtsyToken } from "./etsyAuth";
import { createItem, adjustInventory, listData, updateItem, updateSchedule } from "./inventoryService";
import { migrateJsonToPostgres } from "./postgresMigration";
import { reconcileInventory } from "./reconcile";
import { auditSkuPairings } from "./skuAudit";
import { refreshShopifyDetails } from "./shopifyDetails";
import { importShopifySkus } from "./shopifyImport";
import { migrateJsonToSQLite } from "./sqliteMigration";
import { closeStore } from "./store";
import { runInventorySync } from "./syncEngine";
import { createWindowsStartupScript, createWindowsSyncTask } from "./windowsScheduler";

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
      await syncFromCli(args.slice(1));
      break;
    case "reconcile":
      await reconcileFromCli(args.slice(1));
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
    case "shopify-import":
      await shopifyImportFromCli(args.slice(1));
      break;
    case "shopify-refresh-details":
      await shopifyRefreshDetailsFromCli(args.slice(1));
      break;
    case "csv-import":
      await csvImportFromCli(args.slice(1));
      break;
    case "doctor":
      await doctorFromCli();
      break;
    case "export":
      await exportFromCli(args.slice(1));
      break;
    case "export-csv":
      await exportCsvFromCli(args.slice(1));
      break;
    case "export-events-csv":
      await exportEventsCsvFromCli(args.slice(1));
      break;
    case "export-review-csv":
      await exportReviewCsvFromCli(args.slice(1));
      break;
    case "backup":
      await backupFromCli(args.slice(1));
      break;
    case "restore-dry-run":
      await restoreDryRunFromCli(args.slice(1));
      break;
    case "migrate-postgres":
      await migratePostgresFromCli(args.slice(1));
      break;
    case "migrate-sqlite":
      await migrateSQLiteFromCli(args.slice(1));
      break;
    case "sku-audit":
      await skuAuditFromCli(args.slice(1));
      break;
    case "ebay-auth-url":
      await ebayAuthUrlFromCli();
      break;
    case "ebay-auth-callback":
      await ebayAuthCallbackFromCli(args.slice(1));
      break;
    case "ebay-refresh":
      await ebayRefreshFromCli();
      break;
    case "ebay-test":
      await ebayTestFromCli();
      break;
    case "ebay-lookup":
      await ebayLookupFromCli(args.slice(1));
      break;
    case "ebay-legacy-scan":
      await ebayLegacyScanFromCli(args.slice(1));
      break;
    case "ebay-legacy-map":
      await ebayLegacyMapFromCli(args.slice(1));
      break;
    case "ebay-map":
      await ebayMapFromCli(args.slice(1));
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
    case "schedule-windows":
      await scheduleWindowsFromCli(args.slice(1));
      break;
    default:
      printHelp();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await closeStore();
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
      max: item.maxInventory,
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

async function syncFromCli(input: string[]) {
  const flags = parseFlags(input);
  if (flags["dry-run"] || flags.reconcile) {
    await reconcileFromCli(input);
    return;
  }

  const run = await runInventorySync("cli");
  console.log(`${run.status}: ${run.summary.salesDetected} sales, ${run.summary.pushes} pushes.`);
  for (const message of run.messages) {
    console.log(`- ${message}`);
  }
}

async function reconcileFromCli(input: string[]) {
  const flags = parseFlags(input);
  const [maybePlatform] = positionalArgs(input);
  const platformValue = stringFlag(flags.platform) ?? maybePlatform;

  if (platformValue && !isPlatform(platformValue)) {
    throw new Error("Usage: npm run inv -- reconcile [etsy|ebay|shopify]");
  }

  const result = await reconcileInventory({ platform: platformValue as Platform | undefined });
  console.log(
    `Dry run: ${result.summary.salesDetected} sales, ${result.summary.pushes} reviewable pushes, ${result.summary.warnings} warnings, ${result.summary.errors} errors.`
  );
  printReconcileRows(result.rows);
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

async function shopifyImportFromCli(input: string[]) {
  const flags = parseFlags(input);
  const result = await importShopifySkus({
    dryRun: Boolean(flags["dry-run"]),
    enabled: !flags.disable,
    location: stringFlag(flags.location)
  });

  console.log(
    `${flags["dry-run"] ? "Dry run" : "Imported"} Shopify SKUs: ${result.summary.created} create, ${result.summary.mapped} map, ${result.summary.skipped} skip from ${result.summary.variantsScanned} variants.`
  );
  console.table(
    result.rows.map((row) => ({
      sku: row.sku,
      action: row.action,
      local: row.localQuantity ?? "-",
      shopify: row.shopifyQuantity ?? "-",
      location: row.locationName ?? "-",
      message: row.message
    }))
  );
}

async function shopifyRefreshDetailsFromCli(input: string[]) {
  const flags = parseFlags(input);
  const result = await refreshShopifyDetails({
    dryRun: Boolean(flags["dry-run"]),
    overwrite: Boolean(flags.overwrite)
  });

  console.log(
    `${flags["dry-run"] ? "Dry run" : "Refreshed"} Shopify details: ${result.summary.updated} update, ${result.summary.skipped} skip from ${result.summary.shopifySkus} Shopify SKUs.`
  );
  console.table(
    result.rows.map((row) => ({
      sku: row.sku,
      action: row.action,
      previousName: row.previousName ?? "-",
      nextName: row.nextName ?? "-",
      description: row.nextDescription ? "yes" : "-",
      message: row.message
    }))
  );
}

async function csvImportFromCli(input: string[]) {
  const flags = parseFlags(input);
  const [filePath] = positionalArgs(input);
  if (!filePath) {
    throw new Error("Usage: npm run inv -- csv-import <file.csv> [--dry-run]");
  }

  const result = await importCsv(filePath, { dryRun: Boolean(flags["dry-run"]) });
  console.log(
    `${flags["dry-run"] ? "Dry run" : "Imported"} CSV: ${result.summary.created} created, ${result.summary.updated} updated, ${result.summary.adjusted} adjusted, ${result.summary.skipped} skipped, ${result.summary.errors} errors.`
  );
  console.table(
    result.rows.map((row) => ({
      line: row.line,
      sku: row.sku ?? "-",
      action: row.action,
      previous: row.previousQuantity ?? "-",
      next: row.nextQuantity ?? "-",
      message: row.message
    }))
  );
}

async function doctorFromCli() {
  const result = await runDoctor();
  console.log(
    `Doctor status: ${result.status.toUpperCase()} (${result.summary.ok} ok, ${result.summary.warn} warn, ${result.summary.error} error)`
  );
  console.table(
    result.checks.map((check) => ({
      status: check.status,
      area: check.area,
      check: check.check,
      message: check.message
    }))
  );
  if (result.status === "error") process.exitCode = 1;
}

async function exportFromCli(input: string[]) {
  const [outputPath] = positionalArgs(input);
  const result = await exportInventoryData(outputPath);
  if (result.json) {
    console.log(result.json.trimEnd());
    return;
  }

  console.log(`Exported ${result.itemCount} items to ${result.path}.`);
}

async function exportCsvFromCli(input: string[]) {
  const [outputPath] = positionalArgs(input);
  const result = await exportInventoryCsv(outputPath);
  if (result.csv) {
    console.log(result.csv.trimEnd());
    return;
  }

  console.log(`Exported ${result.itemCount} items to ${result.path}.`);
}

async function exportEventsCsvFromCli(input: string[]) {
  const [outputPath] = positionalArgs(input);
  const result = await exportInventoryEventsCsv(outputPath);
  if (result.csv) {
    console.log(result.csv.trimEnd());
    return;
  }

  console.log(`Exported ${result.itemCount} events to ${result.path}.`);
}

async function exportReviewCsvFromCli(input: string[]) {
  const [outputDirectory] = positionalArgs(input);
  const result = await exportOperationsReportCsv(outputDirectory);
  console.log(`Exported ${result.itemCount} review rows across ${result.files?.length ?? 0} CSV files to ${result.path}.`);
}

async function backupFromCli(input: string[]) {
  const [outputDirectory] = positionalArgs(input);
  const result = await backupInventoryData(outputDirectory);
  console.log(`Backed up ${result.itemCount} items to manifest ${result.path}.`);
  if (result.files?.length) {
    console.log(`Captured ${result.files.length} file${result.files.length === 1 ? "" : "s"}.`);
  }
}

async function restoreDryRunFromCli(input: string[]) {
  const [manifestPath] = positionalArgs(input);
  const result = await inspectOperationalBackup(manifestPath);
  console.log(`Restore dry run: ${result.restorable ? "RESTORABLE" : "NOT RESTORABLE"}`);
  console.log(`Manifest: ${result.path}`);
  console.log(`Created: ${result.createdAt ?? "-"}`);
  console.log(`Items: ${result.itemCount ?? "-"}`);
  if (result.missingSources.length) {
    console.log(`Original sources missing when backup was created: ${result.missingSources.join(", ")}`);
  }
  console.table(
    result.files.map((file) => ({
      exists: file.exists,
      sizeBytes: file.sizeBytes ?? "-",
      path: file.path
    }))
  );
  if (!result.restorable) process.exitCode = 1;
}

async function migratePostgresFromCli(input: string[]) {
  const flags = parseFlags(input);
  const result = await migrateJsonToPostgres({
    dryRun: Boolean(flags["dry-run"]),
    force: Boolean(flags.force)
  });

  console.log(`${result.dryRun ? "Dry run" : "Migrated"} JSON inventory to Postgres.`);
  console.table([
    {
      database: result.databaseUrl,
      items: result.items,
      mappings: result.mappings,
      events: result.events,
      syncRuns: result.syncRuns,
      syncMessages: result.syncMessages,
      scheduleRows: result.scheduleRows,
      force: result.force,
      backup: result.backupPath ?? "-"
    }
  ]);
}

async function migrateSQLiteFromCli(input: string[]) {
  const flags = parseFlags(input);
  const result = await migrateJsonToSQLite({
    dryRun: Boolean(flags["dry-run"]),
    force: Boolean(flags.force)
  });

  console.log(`${result.dryRun ? "Dry run" : "Migrated"} JSON inventory to SQLite.`);
  console.table([
    {
      database: result.databaseFile,
      items: result.items,
      mappings: result.mappings,
      events: result.events,
      syncRuns: result.syncRuns,
      syncMessages: result.syncMessages,
      scheduleRows: result.scheduleRows,
      force: result.force,
      backup: result.backupPath ?? "-"
    }
  ]);
}

async function skuAuditFromCli(input: string[]) {
  const flags = parseFlags(input);
  const only = stringFlag(flags.platform);
  if (only && only !== "shopify" && only !== "ebay" && only !== "all") {
    throw new Error("Usage: npm run inv -- sku-audit [--platform shopify|ebay|all] [--location <name>] [--output file.csv]");
  }

  const result = await auditSkuPairings({
    includeShopify: only ? only === "shopify" || only === "all" : true,
    includeEbay: only ? only === "ebay" || only === "all" : true,
    location: stringFlag(flags.location),
    outputPath: stringFlag(flags.output)
  });

  console.log(
    `SKU audit: ${result.summary.matchedAllAvailable} paired, ${result.summary.missingLocal} missing local, ${result.summary.missingShopify} missing Shopify, ${result.summary.missingEbay} missing eBay, ${result.summary.warnings} warnings.`
  );
  for (const message of result.messages) {
    console.log(`- ${message}`);
  }
  console.table(
    result.rows.map((row) => ({
      sku: row.sku,
      local: row.localQuantity ?? row.local,
      shopify: row.shopifyQuantity ?? row.shopify,
      ebay: row.ebayQuantity ?? row.ebay,
      recommendation: row.recommendation
    }))
  );

  if (result.outputPath) {
    console.log(`Wrote SKU audit CSV to ${result.outputPath}.`);
  }
}

async function ebayAuthUrlFromCli() {
  const auth = await createEbayAuthorization();
  console.log("Register/use this exact eBay RuName redirect_uri value:");
  console.log(auth.redirectUri);
  console.log("");
  console.log(`Environment: ${auth.environment}`);
  console.log(`Scopes: ${auth.scopes.join(" ")}`);
  console.log("");
  console.log("Open this URL and approve the seller account:");
  console.log(auth.url);
  console.log("");
  console.log("After approval, paste the full final redirect URL into:");
  console.log('npm run inv -- ebay-auth-callback "https://..."');
}

async function ebayAuthCallbackFromCli(input: string[]) {
  const [callbackValue] = input;
  if (!callbackValue) {
    throw new Error('Usage: npm run inv -- ebay-auth-callback "https://your-accept-url?code=...&state=..."');
  }

  const token = await completeEbayAuthorization(callbackValue);
  console.log(`eBay OAuth saved. Access token expires in ${Math.round(token.expires_in / 60)} minutes.`);
}

async function ebayRefreshFromCli() {
  const token = await refreshEbayToken();
  console.log(`eBay token refreshed. Access token expires in ${Math.round(token.expires_in / 60)} minutes.`);
}

async function ebayTestFromCli() {
  const adapter = new EbayAdapter();
  if (!adapter.isConfigured()) {
    throw new Error(`eBay is missing: ${adapter.missingEnv().join(", ")}`);
  }

  const result = await adapter.testConnection();
  console.log(`eBay connected${result.version ? `: Inventory API ${result.version}` : "."}`);
}

async function ebayLookupFromCli(input: string[]) {
  const [sku] = input;
  if (!sku) throw new Error("Usage: npm run inv -- ebay-lookup <sku>");

  const adapter = new EbayAdapter();
  if (!adapter.isConfigured()) {
    throw new Error(`eBay is missing: ${adapter.missingEnv().join(", ")}`);
  }

  const result = await adapter.lookupSku(sku);
  const quantity = result.availability?.shipToLocationAvailability?.quantity;
  console.log(`eBay SKU: ${result.sku ?? sku}`);
  if (result.product?.title) console.log(`  Title: ${result.product.title}`);
  console.log(`  Quantity: ${typeof quantity === "number" ? quantity : "-"}`);
}

async function ebayLegacyScanFromCli(input: string[]) {
  const flags = parseFlags(input);
  const result = await scanEbayLegacyListings({
    outputPath: stringFlag(flags.output),
    format: outputFormat(stringFlag(flags.format))
  });

  console.log(
    `Read-only eBay legacy scan: ${result.summary.listings} active listings, ${result.summary.withSku} with Custom label/SKU, ${result.summary.duplicateSkus} duplicate SKU groups.`
  );
  console.table(
    result.listings.map((listing) => ({
      sku: listing.sku || "-",
      itemId: listing.itemId,
      title: listing.title,
      available: listing.quantityAvailable,
      total: listing.quantity,
      sold: listing.quantitySold,
      watchers: listing.watchCount ?? "-",
      url: listing.url ?? "-"
    }))
  );
  if (result.outputPath) {
    console.log(`Wrote eBay legacy scan to ${result.outputPath}.`);
  }
}

async function ebayLegacyMapFromCli(input: string[]) {
  const flags = parseFlags(input);
  const apply = Boolean(flags.apply);
  const options = {
    outputPath: stringFlag(flags.output),
    format: outputFormat(stringFlag(flags.format))
  };
  const result = apply ? await applyEbayLegacyMappings(options) : await previewEbayLegacyMappings(options);

  console.log(
    `${apply ? "Applied" : "Previewed"} eBay legacy mappings: ${result.summary.exactMatches} exact, ${result.summary.alreadyMapped} already mapped, ${result.summary.applied} applied, ${result.summary.missingLocal} missing local, ${result.summary.missingEbay} missing eBay, ${result.summary.duplicateEbaySkus} duplicate eBay SKU rows, ${result.summary.titleMismatches} title mismatches, ${result.summary.mappingConflicts} mapping conflicts.`
  );
  if (!apply) {
    console.log("No local data changed. Rerun with --apply to save exact eligible matches only.");
  }
  console.table(
    result.rows.map((row) => ({
      sku: row.sku,
      status: row.status,
      local: row.localSku ?? "-",
      ebayItem: row.ebayItemId ?? "-",
      available: row.ebayQuantityAvailable ?? "-",
      watchers: row.ebayWatchCount ?? "-",
      eligible: row.applyEligible,
      applied: row.applied,
      message: row.message
    }))
  );
  if (result.outputPath) {
    console.log(`Wrote eBay legacy mapping ${apply ? "result" : "preview"} to ${result.outputPath}.`);
  }
}

async function ebayMapFromCli(input: string[]) {
  const [localSku, maybeEbaySku, ...rest] = input;
  if (!localSku) {
    throw new Error("Usage: npm run inv -- ebay-map <local-sku> [ebay-sku] [--listing-id <id>] [--offer-id <id>] [--disable]");
  }

  const ebaySku = maybeEbaySku && !maybeEbaySku.startsWith("--") ? maybeEbaySku : localSku;
  const flags = parseFlags(maybeEbaySku && !maybeEbaySku.startsWith("--") ? rest : input.slice(1));
  const item = await findItemBySku(localSku);

  const adapter = new EbayAdapter();
  if (!adapter.isConfigured()) {
    throw new Error(`eBay is missing: ${adapter.missingEnv().join(", ")}`);
  }

  const result = await adapter.lookupSku(ebaySku);
  const quantity = result.availability?.shipToLocationAvailability?.quantity;
  const current = item.mappings.ebay ?? { enabled: false };

  await updateItem(item.id, {
    mappings: {
      ebay: {
        ...current,
        enabled: !flags.disable,
        remoteSku: ebaySku,
        listingId: stringFlag(flags["listing-id"]) ?? result.listingId ?? current.listingId,
        offerId: stringFlag(flags["offer-id"]) ?? current.offerId,
        lastRemoteQuantity: typeof quantity === "number" ? quantity : current.lastRemoteQuantity
      }
    }
  });

  console.log(`${item.sku}: eBay mapping saved.`);
  console.log(`  eBay SKU: ${ebaySku}`);
  if (result.listingId || flags["listing-id"]) console.log(`  Listing ID: ${stringFlag(flags["listing-id"]) ?? result.listingId}`);
  console.log(`  Quantity: ${typeof quantity === "number" ? quantity : "-"}`);
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

async function scheduleWindowsFromCli(input: string[]) {
  const flags = parseFlags(input);
  const [mode, maybeInterval] = positionalArgs(input);
  const install = Boolean(flags.install || flags.write);

  if (mode === "startup") {
    const result = await createWindowsStartupScript(install);
    console.log(`${result.installed ? "Installed" : "Prepared"} Windows startup script: ${result.path}`);
    if (!result.installed) {
      console.log("");
      console.log(result.script.trimEnd());
      console.log("");
      console.log("Rerun with --install to write it into your Startup folder.");
    }
    return;
  }

  if (mode === "task") {
    const interval = Number(stringFlag(flags.interval) ?? maybeInterval ?? 30);
    const result = await createWindowsSyncTask({
      install,
      intervalMinutes: interval,
      taskName: stringFlag(flags.name)
    });
    console.log(
      `${result.installed ? "Installed" : "Prepared"} Task Scheduler job "${result.taskName}" every ${result.intervalMinutes} minutes.`
    );
    if (!result.installed) {
      console.log(result.command);
      console.log("Rerun with --install to create it.");
    }
    return;
  }

  throw new Error("Usage: npm run inv -- schedule-windows <startup|task> [intervalMinutes] [--install]");
}

async function findItemBySku(sku: string) {
  const data = await listData();
  const item = data.items.find((candidate) => candidate.sku.toUpperCase() === sku.toUpperCase());
  if (!item) throw new Error(`SKU ${sku} not found.`);
  return item;
}

function positionalArgs(input: string[]) {
  const positional: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    if (isBooleanFlag(token.slice(2))) {
      continue;
    }

    const next = input[index + 1];
    if (next && !next.startsWith("--")) {
      index += 1;
    }
  }
  return positional;
}

function parseFlags(input: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (isBooleanFlag(key)) {
      flags[key] = true;
      continue;
    }
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

function isBooleanFlag(key: string) {
  return ["apply", "disable", "dry-run", "enable", "install", "overwrite", "reconcile", "write"].includes(key);
}

function stringFlag(value: string | boolean | undefined) {
  return typeof value === "string" ? value : undefined;
}

function outputFormat(value: string | undefined): EbayLegacyOutputFormat | undefined {
  if (value === undefined) return undefined;
  if (value === "csv" || value === "json") return value;
  throw new Error("Output format must be csv or json.");
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

function printReconcileRows(rows: Awaited<ReturnType<typeof reconcileInventory>>["rows"]) {
  if (rows.length === 0) {
    console.log("No enabled mappings matched the reconcile request.");
    return;
  }

  console.table(
    rows.map((row) => ({
      sku: row.sku,
      platform: platformLabels[row.platform],
      status: row.status,
      local: row.localQuantity,
      remote: row.remoteQuantity ?? "-",
      last: row.lastSyncedQuantity ?? "-",
      projected: row.projectedLocalQuantity ?? "-",
      push: row.wouldPushQuantity ?? "-",
      message: row.message
    }))
  );
}

function printHelp() {
  console.log(`Josh's Mini ERP inventory CLI

Commands:
  npm run inv -- list
  npm run inv -- create <sku> <name> [quantity]
  npm run inv -- add <sku> <quantity> [note]
  npm run inv -- subtract <sku> <quantity> [note]
  npm run inv -- sync
  npm run inv -- sync --dry-run [--platform shopify]
  npm run inv -- reconcile [etsy|ebay|shopify]
  npm run inv -- csv-import <file.csv> [--dry-run]
  npm run inv -- doctor
  npm run inv -- export [output.json]
  npm run inv -- export-csv [output.csv]
  npm run inv -- export-events-csv [output.csv]
  npm run inv -- export-review-csv [output-directory]
  npm run inv -- backup [backup-directory]
  npm run inv -- restore-dry-run [backup-manifest.json]
  npm run inv -- migrate-sqlite [--dry-run] [--force]
  npm run inv -- migrate-postgres [--dry-run] [--force]
  npm run inv -- sku-audit [--platform shopify|ebay|all] [--location <name>] [--output data/sku-audit.csv]
  npm run inv -- shopify-test
  npm run inv -- shopify-lookup <sku>
  npm run inv -- shopify-map <local-sku> [shopify-sku] [--location <name-or-id>]
  npm run inv -- shopify-import [--location <name-or-id>] [--dry-run] [--disable]
  npm run inv -- shopify-refresh-details [--dry-run] [--overwrite]
  npm run inv -- ebay-auth-url
  npm run inv -- ebay-auth-callback "https://..."
  npm run inv -- ebay-refresh
  npm run inv -- ebay-test
  npm run inv -- ebay-lookup <sku>
  npm run inv -- ebay-legacy-scan [--output data/ebay-legacy-listings.csv]
  npm run inv -- ebay-legacy-map [--apply] [--output data/ebay-legacy-mapping.csv]
  npm run inv -- ebay-map <local-sku> [ebay-sku] [--listing-id <id>] [--offer-id <id>]
  npm run inv -- etsy-auth-url
  npm run inv -- etsy-auth-callback "https://..."
  npm run inv -- etsy-refresh
  npm run inv -- schedule <on|off> [intervalMinutes]
  npm run inv -- schedule-windows startup [--install]
  npm run inv -- schedule-windows task [intervalMinutes] [--install]
  npm run inv -- map <sku> etsy --listing-id <id> --remote-sku <sku> --enable
  npm run inv -- map <sku> ebay --remote-sku <sku> --offer-id <id> --enable
  npm run inv -- map <sku> shopify --inventory-item-id <id-or-gid> --location-id <id-or-gid> --enable
`);
}
