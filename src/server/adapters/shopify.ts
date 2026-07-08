import { randomUUID } from "node:crypto";
import { platformLabels } from "../../shared/types";
import type { InventoryItem, PlatformMapping } from "../../shared/types";
import { config } from "../config";
import type { PlatformAdapter, PushResult, RemoteQuantity } from "./types";
import { readJson } from "./types";

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

type InventoryLevelQuery = {
  inventoryItem?: {
    inventoryLevel?: {
      quantities: Array<{ name: string; quantity: number }>;
    } | null;
  } | null;
};

type InventorySetMutation = {
  inventorySetQuantities: {
    inventoryAdjustmentGroup?: unknown;
    userErrors: Array<{ code?: string; field?: string[]; message: string }>;
  };
};

type ShopQuery = {
  shop: {
    name: string;
    myshopifyDomain: string;
  };
};

type SkuLookupQuery = {
  productVariants: {
    nodes: Array<{
      id: string;
      sku: string | null;
      displayName: string;
      inventoryItem: ShopifyInventoryItem;
    }>;
  };
};

type SkuListQuery = {
  productVariants: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    nodes: ShopifySkuVariant[];
  };
};

type InventoryItemsQuery = {
  inventoryItems: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    nodes: Array<{
      id: string;
      sku: string | null;
      inventoryLevels: {
        nodes: Array<{
          id: string;
          location: {
            id: string;
            name?: string;
          };
          quantities: Array<{ name: string; quantity: number }>;
        }>;
      };
    }>;
  };
};

type ClientCredentialsToken = {
  access_token: string;
  scope?: string;
  expires_in?: number;
};

export interface ShopifyInventoryLevel {
  id: string;
  location: {
    id: string;
    name: string;
  };
  quantities: Array<{ name: string; quantity: number }>;
}

export interface ShopifyInventoryItem {
  id: string;
  inventoryLevels: {
    nodes: ShopifyInventoryLevel[];
  };
}

export interface ShopifySkuVariant {
  id: string;
  sku: string | null;
  displayName: string;
  inventoryItem: ShopifyInventoryItem;
}

const toShopifyGid = (type: "InventoryItem" | "Location", value: string) => {
  const trimmed = value.trim();
  if (trimmed.startsWith("gid://shopify/")) return trimmed;
  return `gid://shopify/${type}/${trimmed}`;
};

export class ShopifyAdapter implements PlatformAdapter {
  platform = "shopify" as const;
  label = platformLabels.shopify;
  private tokenCache: { token: string; expiresAt: number } | null = null;

  isConfigured() {
    return Boolean(
      config.shopify.shopDomain &&
        (config.shopify.accessToken || (config.shopify.clientId && config.shopify.clientSecret))
    );
  }

  missingEnv() {
    const missing: string[] = [];
    if (!config.shopify.shopDomain) missing.push("SHOPIFY_SHOP_DOMAIN");
    if (!config.shopify.accessToken && !(config.shopify.clientId && config.shopify.clientSecret)) {
      missing.push("SHOPIFY_ADMIN_ACCESS_TOKEN or SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET");
    }
    return missing;
  }

  hasRequiredMapping(_item: InventoryItem, mapping: PlatformMapping) {
    return Boolean(mapping.inventoryItemId && mapping.locationId);
  }

  missingMapping(_item: InventoryItem, mapping: PlatformMapping) {
    return [
      ["inventory item id", mapping.inventoryItemId],
      ["location id", mapping.locationId]
    ]
      .filter(([, value]) => !value)
      .map(([key]) => key as string);
  }

  async pullQuantity(_item: InventoryItem, mapping: PlatformMapping): Promise<RemoteQuantity> {
    const payload = await this.graphql<InventoryLevelQuery>(
      `query InventoryLevel($inventoryItemId: ID!, $locationId: ID!) {
        inventoryItem(id: $inventoryItemId) {
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available"]) {
              name
              quantity
            }
          }
        }
      }`,
      {
        inventoryItemId: toShopifyGid("InventoryItem", mapping.inventoryItemId!),
        locationId: toShopifyGid("Location", mapping.locationId!)
      }
    );

    const quantity = payload.inventoryItem?.inventoryLevel?.quantities.find(
      (entry) => entry.name === "available"
    )?.quantity;
    if (typeof quantity !== "number") {
      throw new Error("Shopify returned no inventory level for this item/location.");
    }
    return { platform: this.platform, quantity, raw: payload };
  }

  async pushQuantity(
    _item: InventoryItem,
    mapping: PlatformMapping,
    quantity: number
  ): Promise<PushResult> {
    const payload = await this.graphql<InventorySetMutation>(
      `mutation InventorySet($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
          inventoryAdjustmentGroup {
            createdAt
            reason
            referenceDocumentUri
            changes {
              name
              delta
              quantityAfterChange
            }
          }
          userErrors {
            code
            field
            message
          }
        }
      }`,
      {
        idempotencyKey: randomUUID(),
        input: {
          name: "available",
          reason: "correction",
          referenceDocumentUri: `gid://joshs-mini-erp/SyncJob/${randomUUID()}`,
          quantities: [
            {
              inventoryItemId: toShopifyGid("InventoryItem", mapping.inventoryItemId!),
              locationId: toShopifyGid("Location", mapping.locationId!),
              quantity,
              changeFromQuantity:
                typeof mapping.lastRemoteQuantity === "number" ? mapping.lastRemoteQuantity : null
            }
          ]
        }
      }
    );

    const userErrors = payload.inventorySetQuantities.userErrors;
    if (userErrors.length) {
      throw new Error(userErrors.map((error) => error.message).join("; "));
    }

    return { platform: this.platform, quantity, raw: payload };
  }

  async testConnection() {
    return this.graphql<ShopQuery>(
      `query ShopConnectionTest {
        shop {
          name
          myshopifyDomain
        }
      }`,
      {}
    );
  }

  async lookupSku(sku: string) {
    const escapedSku = sku.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return this.graphql<SkuLookupQuery>(
      `query LookupSku {
        productVariants(first: 10, query: "sku:${escapedSku}") {
          nodes {
            id
            sku
            displayName
            inventoryItem {
              id
              inventoryLevels(first: 10) {
                nodes {
                  id
                  location {
                    id
                  }
                  quantities(names: ["available"]) {
                    name
                    quantity
                  }
                }
              }
            }
          }
        }
      }`,
      {}
    );
  }

  async listSkuVariants() {
    try {
      return await this.listProductVariantSkus();
    } catch (error) {
      if (!isAccessDenied(error)) throw error;
      return this.listInventoryItemSkus();
    }
  }

  private async listProductVariantSkus() {
    const variants: ShopifySkuVariant[] = [];
    let after: string | null = null;

    do {
      const payload: SkuListQuery = await this.graphql<SkuListQuery>(
        `query ListSkuVariants($first: Int!, $after: String) {
          productVariants(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              sku
              displayName
              inventoryItem {
                id
                inventoryLevels(first: 10) {
                  nodes {
                    id
                    location {
                      id
                      name
                    }
                    quantities(names: ["available"]) {
                      name
                      quantity
                    }
                  }
                }
              }
            }
          }
        }`,
        { first: 100, after }
      );

      variants.push(...payload.productVariants.nodes.filter((variant) => variant.sku?.trim()));
      after = payload.productVariants.pageInfo.hasNextPage ? payload.productVariants.pageInfo.endCursor : null;
    } while (after);

    return variants;
  }

  private async listInventoryItemSkus() {
    const variants: ShopifySkuVariant[] = [];
    let after: string | null = null;

    do {
      const payload: InventoryItemsQuery = await this.graphql<InventoryItemsQuery>(
        `query ListInventoryItemSkus($first: Int!, $after: String) {
          inventoryItems(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              sku
              inventoryLevels(first: 10) {
                nodes {
                  id
                  location {
                    id
                  }
                  quantities(names: ["available"]) {
                    name
                    quantity
                  }
                }
              }
            }
          }
        }`,
        { first: 100, after }
      );

      variants.push(
        ...payload.inventoryItems.nodes
          .filter((item) => item.sku?.trim())
          .map((item) => ({
            id: item.id,
            sku: item.sku,
            displayName: item.sku ?? item.id,
            inventoryItem: {
              id: item.id,
              inventoryLevels: {
                nodes: item.inventoryLevels.nodes.map((level) => ({
                  ...level,
                  location: {
                    id: level.location.id,
                    name: level.location.name ?? level.location.id
                  }
                }))
              }
            }
          }))
      );
      after = payload.inventoryItems.pageInfo.hasNextPage ? payload.inventoryItems.pageInfo.endCursor : null;
    } while (after);

    return variants;
  }

  private domain() {
    const shop = config.shopify.shopDomain!.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `https://${shop}`;
  }

  private async headers() {
    return {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": await this.accessToken()
    };
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>) {
    const payload = await readJson<GraphqlResponse<T>>(
      await fetch(`${this.domain()}/admin/api/${config.shopify.apiVersion}/graphql.json`, {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify({ query, variables })
      })
    );

    if (payload.errors?.length) {
      throw new Error(payload.errors.map((error) => error.message).join("; "));
    }
    if (!payload.data) {
      throw new Error("Shopify returned no GraphQL data.");
    }
    return payload.data;
  }

  private async accessToken() {
    if (config.shopify.accessToken) return config.shopify.accessToken;

    if (!config.shopify.clientId || !config.shopify.clientSecret) {
      throw new Error("Shopify credentials are missing.");
    }

    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 300_000) {
      return this.tokenCache.token;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.shopify.clientId,
      client_secret: config.shopify.clientSecret
    });

    const payload = await readJson<ClientCredentialsToken>(
      await fetch(`${this.domain()}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      })
    );

    this.tokenCache = {
      token: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000
    };

    return this.tokenCache.token;
  }
}

function isAccessDenied(error: unknown) {
  return error instanceof Error && /access denied/i.test(error.message);
}
