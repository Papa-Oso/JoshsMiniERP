import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { platformLabels } from "../../shared/types";
import type { InventoryItem, PlatformMapping } from "../../shared/types";
import { config, ebayMissingEnv, ebayReadyForSync } from "../config";
import { getEbayAccessToken } from "../ebayAuth";
import type { PlatformAdapter, PushResult, RemoteQuantity } from "./types";
import { mappingSku, readJson } from "./types";

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

export interface EbayBulkMigrateListingResponse {
  responses?: EbayMigrateListingResponse[];
}

export interface EbayMigrateListingResponse {
  listingId?: string;
  marketplaceId?: string;
  statusCode?: number;
  inventoryItemGroupKey?: string;
  inventoryItems?: Array<{
    sku?: string;
    offerId?: string;
  }>;
  errors?: EbayErrorDetail[];
  warnings?: EbayErrorDetail[];
}

export interface EbayInventoryItemSummary {
  sku: string;
  availability?: { shipToLocationAvailability?: { quantity?: number } };
  product?: { title?: string };
  listingId?: string;
}

export interface EbayLegacyListing {
  itemId: string;
  sku: string;
  title: string;
  quantity: number;
  quantitySold: number;
  quantityAvailable: number;
  watchCount?: number;
  url?: string;
  listingType?: string;
  autoPay?: boolean;
  location?: string;
  postalCode?: string;
  country?: string;
  paymentProfileId?: string;
  paymentProfileName?: string;
  returnProfileId?: string;
  returnProfileName?: string;
  shippingProfileId?: string;
  shippingProfileName?: string;
  listingEnhancements?: string[];
  hasBuyerRequirements?: boolean;
  variationSkus?: string[];
}

interface InventoryItemsResponse {
  inventoryItems?: EbayInventoryItemSummary[];
  total?: number;
  size?: number;
  limit?: number;
  offset?: number;
  next?: string;
}

export class EbayAdapter implements PlatformAdapter {
  platform = "ebay" as const;
  label = platformLabels.ebay;

  isConfigured() {
    return ebayReadyForSync();
  }

  missingEnv() {
    return ebayMissingEnv();
  }

  hasRequiredMapping(item: InventoryItem, mapping: PlatformMapping) {
    return Boolean(mappingSku(item, mapping));
  }

  missingMapping(item: InventoryItem, mapping: PlatformMapping) {
    return mappingSku(item, mapping) ? [] : ["sku"];
  }

  pushBlockReason(_item: InventoryItem, mapping: PlatformMapping) {
    return mapping.listingId ? "protected legacy listing; quantity push skipped" : undefined;
  }

  async pullQuantity(item: InventoryItem, mapping: PlatformMapping): Promise<RemoteQuantity> {
    const sku = mappingSku(item, mapping);
    if (mapping.listingId) {
      const listing = await this.getLegacyListing(mapping.listingId);
      if (listing.sku && listing.sku !== sku) {
        throw new Error(`eBay listing ${mapping.listingId} uses custom label ${listing.sku}, not ${sku}.`);
      }
      return { platform: this.platform, quantity: listing.quantityAvailable, raw: listing };
    }

    const payload = await readJson<{
      availability?: { shipToLocationAvailability?: { quantity?: number } };
    }>(await fetch(`${this.baseUrl()}/inventory_item/${encodeURIComponent(sku)}`, { headers: await this.headers() }));
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
    if (mapping.listingId) {
      throw new Error("Legacy eBay listing quantity pushes are disabled until this listing path is reviewed.");
    }

    const request: Record<string, unknown> = {
      sku,
      shipToLocationAvailability: { quantity }
    };

    if (mapping.offerId) {
      request.offers = [{ offerId: mapping.offerId, availableQuantity: quantity }];
    }

    const payload = await readJson<BulkPriceQuantityResponse>(
      await fetch(`${this.baseUrl()}/bulk_update_price_quantity`, {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify({ requests: [request] })
      })
    );
    this.assertBulkUpdateSucceeded(payload, sku);
    return { platform: this.platform, quantity, raw: payload };
  }

  async testConnection() {
    return readJson<{ version?: string }>(await fetch(`${this.baseUrl()}/getVersion`, { headers: await this.headers() }));
  }

  async lookupSku(sku: string) {
    try {
      return await readJson<EbayInventoryItemSummary>(
        await fetch(`${this.baseUrl()}/inventory_item/${encodeURIComponent(sku)}`, { headers: await this.headers() })
      );
    } catch (error) {
      const legacy = await this.lookupLegacyListingBySku(sku);
      if (legacy) {
        return {
          sku: legacy.sku,
          listingId: legacy.itemId,
          availability: { shipToLocationAvailability: { quantity: legacy.quantityAvailable } },
          product: { title: legacy.title }
        };
      }
      throw error;
    }
  }

  async listLegacyActiveListings() {
    const listings: EbayLegacyListing[] = [];
    let pageNumber = 1;
    let totalPages = 1;

    do {
      const $ = await this.tradingCall(
        "GetMyeBaySelling",
        `
          <GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
            <Version>1209</Version>
            <DetailLevel>ReturnAll</DetailLevel>
            <IncludeWatchCount>true</IncludeWatchCount>
            <ActiveList>
              <Include>true</Include>
              <Pagination>
                <EntriesPerPage>200</EntriesPerPage>
                <PageNumber>${pageNumber}</PageNumber>
              </Pagination>
            </ActiveList>
          </GetMyeBaySellingRequest>
        `
      );

      $("ActiveList > ItemArray > Item").each((_, element) => {
        listings.push(legacyListingFromNode($, $(element)));
      });

      totalPages = numberValue($("ActiveList > PaginationResult > TotalNumberOfPages").first().text(), 1);
      pageNumber += 1;
    } while (pageNumber <= totalPages);

    return listings;
  }

  async listInventoryItems() {
    const items: EbayInventoryItemSummary[] = [];
    const limit = 200;
    let offset = 0;

    while (true) {
      const url = new URL(`${this.baseUrl()}/inventory_item`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));

      const payload = await readJson<InventoryItemsResponse>(
        await fetch(url, { headers: await this.headers() })
      );
      const page = payload.inventoryItems ?? [];
      items.push(...page.filter((item) => item.sku?.trim()));

      const total = payload.total;
      if (typeof total === "number" && offset + page.length >= total) break;
      if (page.length === 0 || page.length < limit) break;
      offset += page.length;
    }

    return items;
  }

  async bulkMigrateListings(listingIds: string[]) {
    const uniqueListingIds = [...new Set(listingIds.map((listingId) => listingId.trim()).filter(Boolean))];
    if (uniqueListingIds.length === 0) {
      throw new Error("At least one eBay listing ID is required for migration.");
    }
    if (uniqueListingIds.length > 5) {
      throw new Error("eBay bulk migration accepts at most five listing IDs per request.");
    }

    return readJson<EbayBulkMigrateListingResponse>(
      await fetch(`${this.baseUrl()}/bulk_migrate_listing`, {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify({
          requests: uniqueListingIds.map((listingId) => ({ listingId }))
        })
      })
    );
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

  private baseUrl() {
    const host = config.ebay.environment === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com";
    return `https://${host}/sell/inventory/v1`;
  }

  private tradingUrl() {
    const host = config.ebay.environment === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com";
    return `https://${host}/ws/api.dll`;
  }

  private async headers() {
    return {
      Authorization: `Bearer ${await getEbayAccessToken()}`,
      "Accept-Language": "en-US",
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": config.ebay.marketplaceId
    };
  }

  private async tradingHeaders(callName: string) {
    return {
      "Content-Type": "text/xml;charset=UTF-8",
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1209",
      "X-EBAY-API-IAF-TOKEN": await getEbayAccessToken()
    };
  }

  private async tradingCall(callName: string, requestBody: string) {
    const response = await fetch(this.tradingUrl(), {
      method: "POST",
      headers: await this.tradingHeaders(callName),
      body: xmlDocument(requestBody)
    });
    const text = await response.text();
    const $ = cheerio.load(text, { xmlMode: true });
    const ack = $("Ack").first().text();

    if (!response.ok || (ack !== "Success" && ack !== "Warning")) {
      throw new Error(`${response.status} ${response.statusText}: ${formatTradingErrors($)}`);
    }

    return $;
  }

  async getLegacyListing(itemId: string) {
    const $ = await this.tradingCall(
      "GetItem",
      `
        <GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
          <Version>1209</Version>
          <DetailLevel>ReturnAll</DetailLevel>
          <ItemID>${escapeXml(itemId)}</ItemID>
        </GetItemRequest>
      `
    );
    const item = $("Item").first();
    if (!item.length) throw new Error(`eBay listing ${itemId} was not found.`);
    return legacyListingFromNode($, item);
  }

  private async lookupLegacyListingBySku(sku: string) {
    const normalizedSku = sku.trim().toUpperCase();
    const listings = await this.listLegacyActiveListings();
    return listings.find((listing) => listing.sku.trim().toUpperCase() === normalizedSku);
  }
}

function formatEbayErrors(errors: EbayErrorDetail[]) {
  return errors
    .map((error) => error.longMessage ?? error.message ?? `eBay error ${error.errorId ?? "unknown"}`)
    .join("; ");
}

function formatTradingErrors($: cheerio.CheerioAPI) {
  const messages = $("Errors")
    .map((_, element) => {
      const error = $(element);
      return error.children("LongMessage").first().text() || error.children("ShortMessage").first().text();
    })
    .get()
    .filter(Boolean);
  return messages.join("; ") || "eBay Trading API request failed.";
}

function legacyListingFromNode($: cheerio.CheerioAPI, item: cheerio.Cheerio<AnyNode>): EbayLegacyListing {
  const quantity = numberValue(item.children("Quantity").first().text());
  const quantitySold = numberValue(item.find("SellingStatus > QuantitySold").first().text());
  const explicitAvailable = item.children("QuantityAvailable").first().text();
  const quantityAvailable = explicitAvailable ? numberValue(explicitAvailable) : Math.max(0, quantity - quantitySold);
  const sellerProfiles = item.children("SellerProfiles").first();
  const listingEnhancements = item.children("ListingEnhancement")
    .map((_, element) => $(element).text().trim())
    .get()
    .filter(Boolean);
  const variationSkus = item.find("Variations > Variation > SKU")
    .map((_, element) => $(element).text().trim())
    .get()
    .filter(Boolean);

  return {
    itemId: item.children("ItemID").first().text(),
    sku: item.children("SKU").first().text(),
    title: item.children("Title").first().text(),
    quantity,
    quantitySold,
    quantityAvailable,
    watchCount: optionalNumber(item.children("WatchCount").first().text()),
    url: item.find("ListingDetails > ViewItemURL").first().text() || undefined,
    listingType: optionalString(item.children("ListingType").first().text()),
    autoPay: optionalBoolean(item.children("AutoPay").first().text()),
    location: optionalString(item.children("Location").first().text()),
    postalCode: optionalString(item.children("PostalCode").first().text()),
    country: optionalString(item.children("Country").first().text()),
    paymentProfileId: optionalString(sellerProfiles.find("SellerPaymentProfile > PaymentProfileID").first().text()),
    paymentProfileName: optionalString(sellerProfiles.find("SellerPaymentProfile > PaymentProfileName").first().text()),
    returnProfileId: optionalString(sellerProfiles.find("SellerReturnProfile > ReturnProfileID").first().text()),
    returnProfileName: optionalString(sellerProfiles.find("SellerReturnProfile > ReturnProfileName").first().text()),
    shippingProfileId: optionalString(sellerProfiles.find("SellerShippingProfile > ShippingProfileID").first().text()),
    shippingProfileName: optionalString(sellerProfiles.find("SellerShippingProfile > ShippingProfileName").first().text()),
    listingEnhancements,
    hasBuyerRequirements: item.children("BuyerRequirementDetails").children().length > 0,
    variationSkus
  };
}

function xmlDocument(body: string) {
  return `<?xml version="1.0" encoding="utf-8"?>${body.trim()}`;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function numberValue(value: string, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalNumber(value: string) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalBoolean(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function optionalString(value: string) {
  return value.trim() || undefined;
}
