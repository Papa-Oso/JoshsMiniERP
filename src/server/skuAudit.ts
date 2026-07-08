import fs from "node:fs/promises";
import path from "node:path";
import { platformLabels } from "../shared/types";
import type { InventoryItem } from "../shared/types";
import { EbayAdapter } from "./adapters/ebay";
import type { EbayInventoryItemSummary } from "./adapters/ebay";
import { ShopifyAdapter } from "./adapters/shopify";
import type { ShopifyInventoryLevel, ShopifySkuVariant } from "./adapters/shopify";
import { listData } from "./inventoryService";

export interface SkuAuditOptions {
  includeShopify?: boolean;
  includeEbay?: boolean;
  location?: string;
  outputPath?: string;
}

export interface SkuAuditRow {
  sku: string;
  local: "matched" | "missing";
  localName?: string;
  localQuantity?: number;
  shopify: "matched" | "missing" | "duplicate" | "multiple_locations" | "not_configured" | "error";
  shopifyName?: string;
  shopifyQuantity?: number;
  shopifyLocation?: string;
  ebay: "matched" | "missing" | "duplicate" | "not_configured" | "error";
  ebayName?: string;
  ebayQuantity?: number;
  recommendation: string;
}

export interface SkuAuditResult {
  rows: SkuAuditRow[];
  messages: string[];
  summary: {
    localSkus: number;
    shopifySkus: number;
    ebaySkus: number;
    matchedAllAvailable: number;
    missingLocal: number;
    missingShopify: number;
    missingEbay: number;
    warnings: number;
  };
  outputPath?: string;
}

interface ShopifySkuRecord {
  variant: ShopifySkuVariant;
  quantity?: number;
  locationName?: string;
  status: SkuAuditRow["shopify"];
}

interface EbaySkuRecord {
  item: EbayInventoryItemSummary;
  quantity?: number;
  status: SkuAuditRow["ebay"];
}

interface RemoteLoad<T> {
  configured: boolean;
  records: Map<string, T[]>;
  notConfigured?: boolean;
  error?: string;
}

export async function auditSkuPairings(options: SkuAuditOptions = {}): Promise<SkuAuditResult> {
  const data = await listData();
  const localBySku = new Map(data.items.map((item) => [normalizeSku(item.sku), item]));
  const includeShopify = options.includeShopify ?? true;
  const includeEbay = options.includeEbay ?? true;

  const [shopifyLoad, ebayLoad] = await Promise.all([
    includeShopify ? loadShopifySkus(options.location) : emptyRemoteLoad<ShopifySkuRecord>(),
    includeEbay ? loadEbaySkus() : emptyRemoteLoad<EbaySkuRecord>()
  ]);

  const allSkuKeys = new Set<string>([
    ...localBySku.keys(),
    ...shopifyLoad.records.keys(),
    ...ebayLoad.records.keys()
  ]);

  const rows = [...allSkuKeys]
    .sort((left, right) => left.localeCompare(right))
    .map((skuKey) => buildAuditRow(skuKey, localBySku.get(skuKey), shopifyLoad, ebayLoad));

  const result: SkuAuditResult = {
    rows,
    messages: auditMessages(shopifyLoad, ebayLoad),
    summary: summarizeRows(rows, data.items.length, shopifyLoad.records.size, ebayLoad.records.size)
  };

  if (options.outputPath) {
    const resolved = path.resolve(options.outputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, toCsv(rows), "utf8");
    result.outputPath = resolved;
  }

  return result;
}

function buildAuditRow(
  sku: string,
  localItem: InventoryItem | undefined,
  shopifyLoad: RemoteLoad<ShopifySkuRecord>,
  ebayLoad: RemoteLoad<EbaySkuRecord>
): SkuAuditRow {
  const shopifyRecords = shopifyLoad.records.get(sku) ?? [];
  const ebayRecords = ebayLoad.records.get(sku) ?? [];
  const shopifyRecord = shopifyRecords[0];
  const ebayRecord = ebayRecords[0];

  const row: SkuAuditRow = {
    sku,
    local: localItem ? "matched" : "missing",
    localName: localItem?.name,
    localQuantity: localItem?.quantity,
    shopify: shopifyStatus(shopifyLoad, shopifyRecords, shopifyRecord?.status ?? "matched"),
    shopifyName: shopifyRecord?.variant.displayName,
    shopifyQuantity: shopifyRecord?.quantity,
    shopifyLocation: shopifyRecord?.locationName,
    ebay: ebayStatus(ebayLoad, ebayRecords, ebayRecord?.status ?? "matched"),
    ebayName: ebayRecord?.item.product?.title,
    ebayQuantity: ebayRecord?.quantity,
    recommendation: ""
  };

  row.recommendation = recommendation(row);
  return row;
}

function recommendation(row: SkuAuditRow) {
  const remoteStatuses = [row.shopify, row.ebay].filter((status) => status !== "not_configured");
  const missingLocal = row.local === "missing";
  const duplicate = remoteStatuses.includes("duplicate");
  const multipleLocations = row.shopify === "multiple_locations";

  if (duplicate) return "Resolve duplicate remote SKU before mapping.";
  if (multipleLocations) return "Rerun with --location so Shopify quantity can be paired.";
  if (missingLocal) return "Create or import this local SKU before syncing.";

  const missingRemotes = [
    row.shopify === "missing" ? platformLabels.shopify : null,
    row.ebay === "missing" ? platformLabels.ebay : null
  ].filter(Boolean);
  if (missingRemotes.length > 0) return `Missing on ${missingRemotes.join(" and ")}.`;

  const quantities = [row.localQuantity, row.shopifyQuantity, row.ebayQuantity].filter(
    (value): value is number => typeof value === "number"
  );
  if (new Set(quantities).size > 1) return "SKU pairs, but quantities differ; run reconcile before syncing.";
  return "SKU pairs cleanly across available sources.";
}

function shopifyStatus(
  load: RemoteLoad<ShopifySkuRecord>,
  records: ShopifySkuRecord[],
  matchedStatus: SkuAuditRow["shopify"]
): SkuAuditRow["shopify"] {
  if (!load.configured) return load.notConfigured ? "not_configured" : "error";
  if (records.length === 0) return "missing";
  if (records.length > 1) return "duplicate";
  return matchedStatus;
}

function ebayStatus(
  load: RemoteLoad<EbaySkuRecord>,
  records: EbaySkuRecord[],
  matchedStatus: SkuAuditRow["ebay"]
): SkuAuditRow["ebay"] {
  if (!load.configured) return load.notConfigured ? "not_configured" : "error";
  if (records.length === 0) return "missing";
  if (records.length > 1) return "duplicate";
  return matchedStatus;
}

async function loadShopifySkus(location?: string): Promise<RemoteLoad<ShopifySkuRecord>> {
  const adapter = new ShopifyAdapter();
  if (!adapter.isConfigured()) {
    return {
      configured: false,
      records: new Map(),
      notConfigured: true,
      error: `Shopify is missing ${adapter.missingEnv().join(", ")}.`
    };
  }

  try {
    const variants = await adapter.listSkuVariants();
    const records = new Map<string, ShopifySkuRecord[]>();
    for (const variant of variants) {
      const sku = normalizeSku(variant.sku ?? "");
      if (!sku) continue;
      const choice = chooseShopifyLevel(variant.inventoryItem.inventoryLevels.nodes, location);
      const current = records.get(sku) ?? [];
      current.push({
        variant,
        quantity: choice.level?.quantities.find((quantity) => quantity.name === "available")?.quantity,
        locationName: choice.level?.location.name,
        status: choice.status
      });
      records.set(sku, current);
    }
    return { configured: true, records };
  } catch (error) {
    return { configured: false, records: new Map(), error: errorMessage(error) };
  }
}

async function loadEbaySkus(): Promise<RemoteLoad<EbaySkuRecord>> {
  const adapter = new EbayAdapter();
  if (!adapter.isConfigured()) {
    return {
      configured: false,
      records: new Map(),
      notConfigured: true,
      error: `eBay is missing ${adapter.missingEnv().join(", ")}.`
    };
  }

  try {
    const items = await adapter.listInventoryItems();
    const records = new Map<string, EbaySkuRecord[]>();
    for (const item of items) {
      const sku = normalizeSku(item.sku);
      if (!sku) continue;
      const current = records.get(sku) ?? [];
      current.push({
        item,
        quantity: item.availability?.shipToLocationAvailability?.quantity,
        status: "matched"
      });
      records.set(sku, current);
    }
    return { configured: true, records };
  } catch (error) {
    return { configured: false, records: new Map(), error: errorMessage(error) };
  }
}

function chooseShopifyLevel(levels: ShopifyInventoryLevel[], filter?: string) {
  if (levels.length === 0) {
    return { status: "missing" as const };
  }

  if (filter) {
    const normalized = filter.toLowerCase();
    const level = levels.find((candidate) => {
      const locationId = candidate.location.id.toLowerCase();
      return (
        candidate.location.name.toLowerCase() === normalized ||
        locationId === normalized ||
        locationId.endsWith(`/${normalized}`)
      );
    });
    return level ? { status: "matched" as const, level } : { status: "missing" as const };
  }

  return levels.length === 1
    ? { status: "matched" as const, level: levels[0] }
    : { status: "multiple_locations" as const };
}

function summarizeRows(rows: SkuAuditRow[], localSkus: number, shopifySkus: number, ebaySkus: number) {
  return {
    localSkus,
    shopifySkus,
    ebaySkus,
    matchedAllAvailable: rows.filter(
      (row) =>
        row.local === "matched" &&
        (row.shopify === "matched" || row.shopify === "not_configured") &&
        (row.ebay === "matched" || row.ebay === "not_configured")
    ).length,
    missingLocal: rows.filter((row) => row.local === "missing").length,
    missingShopify: rows.filter((row) => row.shopify === "missing").length,
    missingEbay: rows.filter((row) => row.ebay === "missing").length,
    warnings: rows.filter((row) => row.recommendation !== "SKU pairs cleanly across available sources.").length
  };
}

function auditMessages(
  shopifyLoad: RemoteLoad<ShopifySkuRecord>,
  ebayLoad: RemoteLoad<EbaySkuRecord>
) {
  return [
    shopifyLoad.error ? `${platformLabels.shopify}: ${shopifyLoad.error}` : null,
    ebayLoad.error ? `${platformLabels.ebay}: ${ebayLoad.error}` : null
  ].filter((message): message is string => Boolean(message));
}

function toCsv(rows: SkuAuditRow[]) {
  const headers = [
    "sku",
    "local",
    "localName",
    "localQuantity",
    "shopify",
    "shopifyName",
    "shopifyQuantity",
    "shopifyLocation",
    "ebay",
    "ebayName",
    "ebayQuantity",
    "recommendation"
  ];
  return `${headers.join(",")}\n${rows
    .map((row) => headers.map((header) => csvCell(row[header as keyof SkuAuditRow])).join(","))
    .join("\n")}\n`;
}

function csvCell(value: unknown) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function emptyRemoteLoad<T>(): RemoteLoad<T> {
  return { configured: false, records: new Map(), notConfigured: true };
}

function normalizeSku(value: string) {
  return value.trim().toUpperCase();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
