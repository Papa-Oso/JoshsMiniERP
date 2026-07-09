import { randomUUID } from "node:crypto";
import type { InventoryItem, PlatformMapping, StoreData } from "../shared/types";
import { defaultMaxInventory } from "../shared/types";
import { ShopifyAdapter } from "./adapters/shopify";
import type { ShopifyInventoryLevel, ShopifySkuVariant } from "./adapters/shopify";
import { makeEvent } from "./inventoryService";
import { store } from "./store";

export type ShopifyImportAction = "create" | "map" | "skip";

export interface ShopifyImportOptions {
  dryRun?: boolean;
  enabled?: boolean;
  location?: string;
}

export interface ShopifyImportRow {
  sku: string;
  action: ShopifyImportAction;
  name?: string;
  localQuantity?: number;
  shopifyQuantity?: number;
  inventoryItemId?: string;
  locationId?: string;
  locationName?: string;
  message: string;
}

export interface ShopifyImportResult {
  rows: ShopifyImportRow[];
  summary: {
    variantsScanned: number;
    created: number;
    mapped: number;
    skipped: number;
  };
}

interface ImportLevelChoice {
  level?: ShopifyInventoryLevel;
  message: string;
}

const now = () => new Date().toISOString();

export async function importShopifySkus(options: ShopifyImportOptions = {}): Promise<ShopifyImportResult> {
  const adapter = new ShopifyAdapter();
  if (!adapter.isConfigured()) {
    throw new Error(`Shopify is missing: ${adapter.missingEnv().join(", ")}`);
  }

  const variants = await adapter.listSkuVariants();
  const grouped = groupVariantsBySku(variants);

  if (options.dryRun) {
    const data = await store.read();
    return planShopifyImport(data, grouped, variants.length, options, false);
  }

  return mutateStore((data) => planShopifyImport(data, grouped, variants.length, options, true));
}

function planShopifyImport(
  data: StoreData,
  grouped: Map<string, ShopifySkuVariant[]>,
  variantsScanned: number,
  options: ShopifyImportOptions,
  apply: boolean
): ShopifyImportResult {
  const rows: ShopifyImportRow[] = [];
  const timestamp = now();
  const enabled = options.enabled ?? true;

  for (const [sku, variants] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (variants.length > 1) {
      rows.push({
        sku,
        action: "skip",
        message: `Shopify has ${variants.length} variants with this SKU; make the SKU unique before importing.`
      });
      continue;
    }

    const variant = variants[0];
    const levelResult = chooseImportLevel(variant.inventoryItem.inventoryLevels.nodes, options.location);
    if (!levelResult.level) {
      rows.push({
        sku,
        action: "skip",
        name: shopifyTitle(variant),
        inventoryItemId: variant.inventoryItem.id,
        message: levelResult.message
      });
      continue;
    }

    const quantity = availableQuantity(levelResult.level);
    if (typeof quantity !== "number") {
      rows.push({
        sku,
        action: "skip",
        name: shopifyTitle(variant),
        inventoryItemId: variant.inventoryItem.id,
        locationId: levelResult.level.location.id,
        locationName: levelResult.level.location.name,
        message: "Shopify returned no available quantity for this location."
      });
      continue;
    }

    const item = data.items.find((candidate) => candidate.sku.toUpperCase() === sku);
    const mapping = shopifyMapping(variant, levelResult.level, quantity, enabled, timestamp);

    if (!item) {
      rows.push({
        sku,
        action: "create",
        name: shopifyTitle(variant),
        shopifyQuantity: quantity,
        inventoryItemId: variant.inventoryItem.id,
        locationId: levelResult.level.location.id,
        locationName: levelResult.level.location.name,
        message: `${apply ? "Created" : "Would create"} local SKU from Shopify with ${quantity} on hand.`
      });

      if (apply) {
        const created = createImportedItem(sku, shopifyTitle(variant), shopifyDescription(variant), quantity, mapping, timestamp);
        data.items.unshift(created);
        data.events.unshift(
          makeEvent(created, "create", quantity, quantity, "local", "Imported from Shopify inventory")
        );
      }
      continue;
    }

    const differentQuantity = item.quantity !== quantity;
    rows.push({
      sku,
      action: "map",
      name: item.name,
      localQuantity: item.quantity,
      shopifyQuantity: quantity,
      inventoryItemId: variant.inventoryItem.id,
      locationId: levelResult.level.location.id,
      locationName: levelResult.level.location.name,
      message: differentQuantity
        ? `${apply ? "Mapped" : "Would map"} Shopify and keep local quantity ${item.quantity}; Shopify currently has ${quantity}.`
        : `${apply ? "Mapped" : "Would map"} Shopify with matching local and Shopify quantity ${quantity}.`
    });

    if (apply) {
      item.mappings.shopify = {
        ...item.mappings.shopify,
        ...mapping,
        warning: differentQuantity
          ? "Local quantity differs from Shopify import baseline; run reconcile before syncing."
          : null
      };
      item.updatedAt = timestamp;
    }
  }

  if (apply) {
    data.events = data.events.slice(0, 500);
    data.syncRuns = data.syncRuns.slice(0, 100);
  }

  return {
    rows,
    summary: {
      variantsScanned,
      created: rows.filter((row) => row.action === "create").length,
      mapped: rows.filter((row) => row.action === "map").length,
      skipped: rows.filter((row) => row.action === "skip").length
    }
  };
}

function createImportedItem(
  sku: string,
  name: string,
  description: string | undefined,
  quantity: number,
  mapping: PlatformMapping,
  timestamp: string
): InventoryItem {
  return {
    id: randomUUID(),
    sku,
    name,
    description,
    quantity,
    safetyStock: 0,
    maxInventory: defaultMaxInventory,
    active: true,
    mappings: { shopify: mapping },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function shopifyMapping(
  variant: ShopifySkuVariant,
  level: ShopifyInventoryLevel,
  quantity: number,
  enabled: boolean,
  timestamp: string
): PlatformMapping {
  return {
    enabled,
    remoteSku: variant.sku?.trim(),
    inventoryItemId: variant.inventoryItem.id,
    locationId: level.location.id,
    lastSyncedQuantity: quantity,
    lastRemoteQuantity: quantity,
    lastSyncedAt: timestamp,
    warning: null
  };
}

function groupVariantsBySku(variants: ShopifySkuVariant[]) {
  const grouped = new Map<string, ShopifySkuVariant[]>();
  for (const variant of variants) {
    const sku = variant.sku?.trim().toUpperCase();
    if (!sku) continue;
    const current = grouped.get(sku) ?? [];
    current.push(variant);
    grouped.set(sku, current);
  }
  return grouped;
}

function chooseImportLevel(levels: ShopifyInventoryLevel[], filter?: string): ImportLevelChoice {
  if (levels.length === 0) {
    return { message: "Shopify returned no inventory locations for this SKU." };
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

    return level
      ? { level, message: "" }
      : {
          message: `No Shopify location matched ${filter}. Available: ${levels
            .map((level) => `${level.location.name} (${level.location.id})`)
            .join(", ")}.`
        };
  }

  if (levels.length > 1) {
    return {
      message: `Shopify has multiple locations for this SKU. Rerun with --location. Available: ${levels
        .map((level) => `${level.location.name} (${level.location.id})`)
        .join(", ")}.`
    };
  }

  return { level: levels[0], message: "" };
}

function availableQuantity(level: ShopifyInventoryLevel) {
  return level.quantities.find((quantity) => quantity.name === "available")?.quantity;
}

function shopifyTitle(variant: ShopifySkuVariant) {
  return variant.productTitle?.trim() || variant.displayName;
}

function shopifyDescription(variant: ShopifySkuVariant) {
  return htmlToText(variant.descriptionHtml);
}

function htmlToText(value?: string | null) {
  if (!value) return undefined;
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function mutateStore<T>(mutator: (data: StoreData) => T | Promise<T>) {
  const mutate = store.mutateChanges?.bind(store) ?? store.mutate.bind(store);
  return mutate(mutator);
}
