import { platformLabels } from "../../shared/types";
import type { InventoryItem, PlatformMapping } from "../../shared/types";
import { config } from "../config";
import type { PlatformAdapter, PushResult, RemoteQuantity } from "./types";
import { mappingSku, readJson } from "./types";

const baseUrl = "https://api.ebay.com/sell/inventory/v1";

interface EbayErrorDetail {
  errorId?: number;
  message?: string;
  longMessage?: string;
}

interface BulkPriceQuantityResponse {
  responses?: Array<{
    sku?: string;
    offerId?: string;
    statusCode?: number;
    errors?: EbayErrorDetail[];
    warnings?: EbayErrorDetail[];
  }>;
  errors?: EbayErrorDetail[];
}

export class EbayAdapter implements PlatformAdapter {
  platform = "ebay" as const;
  label = platformLabels.ebay;

  isConfigured() {
    return Boolean(config.ebay.accessToken);
  }

  missingEnv() {
    return [["EBAY_ACCESS_TOKEN", config.ebay.accessToken]]
      .filter(([, value]) => !value)
      .map(([key]) => key as string);
  }

  hasRequiredMapping(item: InventoryItem, mapping: PlatformMapping) {
    return Boolean(mappingSku(item, mapping));
  }

  missingMapping(item: InventoryItem, mapping: PlatformMapping) {
    return mappingSku(item, mapping) ? [] : ["sku"];
  }

  async pullQuantity(item: InventoryItem, mapping: PlatformMapping): Promise<RemoteQuantity> {
    const sku = mappingSku(item, mapping);
    const payload = await readJson<{
      availability?: { shipToLocationAvailability?: { quantity?: number } };
    }>(await fetch(`${baseUrl}/inventory_item/${encodeURIComponent(sku)}`, { headers: this.headers() }));
    const quantity = payload.availability?.shipToLocationAvailability?.quantity;
    if (typeof quantity !== "number") {
      throw new Error("eBay returned no ship-to-home quantity for this SKU.");
    }
    return { platform: this.platform, quantity, raw: payload };
  }

  async pushQuantity(
    item: InventoryItem,
    mapping: PlatformMapping,
    quantity: number
  ): Promise<PushResult> {
    const sku = mappingSku(item, mapping);
    const request: Record<string, unknown> = {
      sku,
      shipToLocationAvailability: { quantity }
    };

    if (mapping.offerId) {
      request.offers = [{ offerId: mapping.offerId, availableQuantity: quantity }];
    }

    const payload = await readJson<BulkPriceQuantityResponse>(
      await fetch(`${baseUrl}/bulk_update_price_quantity`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ requests: [request] })
      })
    );
    this.assertBulkUpdateSucceeded(payload, sku);
    return { platform: this.platform, quantity, raw: payload };
  }

  private assertBulkUpdateSucceeded(payload: BulkPriceQuantityResponse, sku: string) {
    const topLevelErrors = payload.errors ?? [];
    if (topLevelErrors.length) {
      throw new Error(`eBay bulk update failed: ${formatEbayErrors(topLevelErrors)}`);
    }

    const response = payload.responses?.find((entry) => entry.sku === sku) ?? payload.responses?.[0];
    if (!response) {
      throw new Error(`eBay returned no bulk update response for SKU ${sku}.`);
    }

    if (response.errors?.length) {
      throw new Error(`eBay bulk update failed for SKU ${sku}: ${formatEbayErrors(response.errors)}`);
    }

    if (typeof response.statusCode === "number" && (response.statusCode < 200 || response.statusCode >= 300)) {
      throw new Error(`eBay bulk update failed for SKU ${sku} with status ${response.statusCode}.`);
    }
  }

  private headers() {
    return {
      Authorization: `Bearer ${config.ebay.accessToken}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": config.ebay.marketplaceId
    };
  }
}

function formatEbayErrors(errors: EbayErrorDetail[]) {
  return errors
    .map((error) => error.longMessage ?? error.message ?? `eBay error ${error.errorId ?? "unknown"}`)
    .join("; ");
}
