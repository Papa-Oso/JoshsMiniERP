import fs from "node:fs";
import { platformLabels } from "../../shared/types";
import type { InventoryItem, PlatformMapping } from "../../shared/types";
import { config } from "../config";
import { getEtsyAccessToken } from "../etsyAuth";
import type { PlatformAdapter, PushResult, RemoteQuantity } from "./types";
import { mappingSku, readJson } from "./types";

const baseUrl = "https://api.etsy.com/v3/application";

interface EtsyOffering {
  price?: unknown;
  quantity?: number;
  is_enabled?: boolean;
  is_deleted?: boolean;
  [key: string]: unknown;
}

interface EtsyProduct {
  sku?: string;
  offerings?: EtsyOffering[];
  [key: string]: unknown;
}

interface EtsyInventory {
  products?: EtsyProduct[];
  price_on_property?: number[];
  quantity_on_property?: number[];
  sku_on_property?: number[];
  readiness_state_on_property?: number[];
  [key: string]: unknown;
}

export class EtsyAdapter implements PlatformAdapter {
  platform = "etsy" as const;
  label = platformLabels.etsy;

  isConfigured() {
    return Boolean(config.etsy.apiKey && etsyHasToken());
  }

  missingEnv() {
    const missing: string[] = [];
    if (!config.etsy.apiKey) missing.push("ETSY_API_KEY");
    if (!etsyHasToken()) missing.push("ETSY_ACCESS_TOKEN or ETSY_REFRESH_TOKEN or Etsy OAuth token file");
    return missing;
  }

  hasRequiredMapping(_item: InventoryItem, mapping: PlatformMapping) {
    return Boolean(mapping.listingId);
  }

  missingMapping(_item: InventoryItem, mapping: PlatformMapping) {
    return mapping.listingId ? [] : ["listing id"];
  }

  async pullQuantity(item: InventoryItem, mapping: PlatformMapping): Promise<RemoteQuantity> {
    const sku = mappingSku(item, mapping);
    const inventory = await this.getInventory(mapping);
    const product = this.findProduct(inventory, sku);
    const offering = this.findSingleOffering(product, sku);
    const quantity = offering.quantity;
    if (typeof quantity !== "number") {
      throw new Error("Etsy returned no offering quantity for this SKU.");
    }
    return { platform: this.platform, quantity, raw: inventory };
  }

  async pushQuantity(
    item: InventoryItem,
    mapping: PlatformMapping,
    quantity: number
  ): Promise<PushResult> {
    const sku = mappingSku(item, mapping);
    const inventory = await this.getInventory(mapping);
    const product = this.findProduct(inventory, sku);
    const offering = this.findSingleOffering(product, sku);
    offering.quantity = quantity;

    const payload: EtsyInventory = {
      products: inventory.products ?? [],
      price_on_property: inventory.price_on_property ?? [],
      quantity_on_property: inventory.quantity_on_property ?? [],
      sku_on_property: inventory.sku_on_property ?? []
    };

    if (inventory.readiness_state_on_property) {
      payload.readiness_state_on_property = inventory.readiness_state_on_property;
    }

    const result = await readJson(
      await fetch(`${baseUrl}/listings/${encodeURIComponent(mapping.listingId!)}/inventory`, {
        method: "PUT",
        headers: await this.headers(),
        body: JSON.stringify(payload)
      })
    );
    return { platform: this.platform, quantity, raw: result };
  }

  private async getInventory(mapping: PlatformMapping) {
    return readJson<EtsyInventory>(
      await fetch(`${baseUrl}/listings/${encodeURIComponent(mapping.listingId!)}/inventory`, {
        headers: await this.headers()
      })
    );
  }

  private findProduct(inventory: EtsyInventory, sku: string) {
    const matches = (inventory.products ?? []).filter((product) => product.sku === sku);
    if (matches.length === 0) {
      throw new Error(`Etsy listing inventory does not contain SKU ${sku}.`);
    }
    if (matches.length > 1) {
      throw new Error(`Etsy listing inventory has multiple products with SKU ${sku}.`);
    }
    return matches[0];
  }

  private findSingleOffering(product: EtsyProduct, sku: string) {
    const offerings = product.offerings ?? [];
    if (offerings.length === 0) {
      throw new Error(`Etsy listing inventory has no offerings for SKU ${sku}.`);
    }
    if (offerings.length > 1) {
      throw new Error(`Etsy listing inventory has multiple offerings for SKU ${sku}; use a unique SKU per offering.`);
    }
    return offerings[0];
  }

  private async headers() {
    return {
      Authorization: `Bearer ${await getEtsyAccessToken()}`,
      "Content-Type": "application/json",
      "x-api-key": config.etsy.apiKey!
    };
  }
}

function etsyHasToken() {
  return Boolean(config.etsy.accessToken || config.etsy.refreshToken || fs.existsSync(config.etsy.tokenFile));
}
