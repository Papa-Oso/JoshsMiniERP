import { ShopifyAdapter } from "./adapters/shopify";
import { store } from "./store";
import type { StoreData } from "../shared/types";

export interface ShopifyDetailsRefreshOptions {
  dryRun?: boolean;
  overwrite?: boolean;
}

export interface ShopifyDetailsRefreshRow {
  sku: string;
  action: "update" | "skip";
  previousName?: string;
  nextName?: string;
  previousDescription?: string;
  nextDescription?: string;
  message: string;
}

export interface ShopifyDetailsRefreshResult {
  rows: ShopifyDetailsRefreshRow[];
  summary: {
    shopifySkus: number;
    updated: number;
    skipped: number;
  };
}

const now = () => new Date().toISOString();

export async function refreshShopifyDetails(
  options: ShopifyDetailsRefreshOptions = {}
): Promise<ShopifyDetailsRefreshResult> {
  const adapter = new ShopifyAdapter();
  if (!adapter.isConfigured()) {
    throw new Error(`Shopify is missing: ${adapter.missingEnv().join(", ")}`);
  }

  const details = await adapter.listSkuProductDetails().catch((error) => {
    if (error instanceof Error && /access denied/i.test(error.message)) {
      throw new Error(
        "Shopify product details require the read_products scope. Update Shopify app scopes, approve the new scopes in Shopify, then export a fresh offline session token."
      );
    }
    throw error;
  });
  const detailsBySku = new Map(details.map((detail) => [detail.sku.toUpperCase(), detail]));

  if (options.dryRun) {
    const data = await store.read();
    return planRefresh(data.items, detailsBySku, Boolean(options.overwrite), false);
  }

  return mutateStore((data) => planRefresh(data.items, detailsBySku, Boolean(options.overwrite), true));
}

function planRefresh(
  items: Array<{ sku: string; name: string; description?: string; updatedAt: string }>,
  detailsBySku: Map<string, { title: string; description?: string }>,
  overwrite: boolean,
  apply: boolean
): ShopifyDetailsRefreshResult {
  const rows: ShopifyDetailsRefreshRow[] = [];

  for (const item of items) {
    const detail = detailsBySku.get(item.sku.toUpperCase());
    if (!detail) {
      rows.push({
        sku: item.sku,
        action: "skip",
        message: "No Shopify product details found for this SKU."
      });
      continue;
    }

    const nextName = overwrite || item.name.toUpperCase() === item.sku.toUpperCase() ? detail.title : item.name;
    const nextDescription = detail.description ?? item.description;
    const nameChanged = nextName !== item.name;
    const descriptionChanged = nextDescription !== item.description;

    if (!nameChanged && !descriptionChanged) {
      rows.push({
        sku: item.sku,
        action: "skip",
        previousName: item.name,
        nextName,
        previousDescription: item.description,
        nextDescription,
        message: "Already matched Shopify details."
      });
      continue;
    }

    rows.push({
      sku: item.sku,
      action: "update",
      previousName: item.name,
      nextName,
      previousDescription: item.description,
      nextDescription,
      message: `${apply ? "Updated" : "Would update"} Shopify title/description.`
    });

    if (apply) {
      item.name = nextName;
      if (nextDescription) item.description = nextDescription;
      item.updatedAt = now();
    }
  }

  return {
    rows,
    summary: {
      shopifySkus: detailsBySku.size,
      updated: rows.filter((row) => row.action === "update").length,
      skipped: rows.filter((row) => row.action === "skip").length
    }
  };
}

function mutateStore<T>(mutator: (data: StoreData) => T | Promise<T>) {
  const mutate = store.mutateChanges?.bind(store) ?? store.mutate.bind(store);
  return mutate(mutator);
}
