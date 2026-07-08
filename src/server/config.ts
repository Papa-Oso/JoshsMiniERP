import path from "node:path";
import dotenv from "dotenv";
import type { PlatformStatus } from "../shared/types";
import { platformLabels } from "../shared/types";

dotenv.config({ quiet: true });

export interface AppConfig {
  port: number;
  dataFile: string;
  shopify: {
    shopDomain?: string;
    accessToken?: string;
    clientId?: string;
    clientSecret?: string;
    apiVersion: string;
  };
  ebay: {
    accessToken?: string;
    marketplaceId: string;
  };
  etsy: {
    apiKey?: string;
    accessToken?: string;
  };
}

const read = (key: string) => process.env[key]?.trim() || undefined;
const placeholderValues = new Set([
  "your-shop.myshopify.com",
  "your-real-store.myshopify.com",
  "shpat_xxx",
  "your_client_id",
  "your_client_secret",
  "v^1.1#xxx",
  "your_etsy_keystring",
  "your_etsy_oauth_token"
]);
const readConfigured = (key: string) => {
  const value = read(key);
  return value && !placeholderValues.has(value) ? value : undefined;
};

export const config: AppConfig = {
  port: Number(readConfigured("PORT") ?? 5174),
  dataFile: path.resolve(readConfigured("DATA_FILE") ?? "data/inventory.json"),
  shopify: {
    shopDomain: readConfigured("SHOPIFY_SHOP_DOMAIN"),
    accessToken: readConfigured("SHOPIFY_ADMIN_ACCESS_TOKEN") ?? readConfigured("SHOPIFY_ACCESS_TOKEN"),
    clientId: readConfigured("SHOPIFY_CLIENT_ID"),
    clientSecret: readConfigured("SHOPIFY_CLIENT_SECRET"),
    apiVersion: readConfigured("SHOPIFY_API_VERSION") ?? "2026-07"
  },
  ebay: {
    accessToken: readConfigured("EBAY_ACCESS_TOKEN"),
    marketplaceId: readConfigured("EBAY_MARKETPLACE_ID") ?? "EBAY_US"
  },
  etsy: {
    apiKey: readConfigured("ETSY_API_KEY"),
    accessToken: readConfigured("ETSY_ACCESS_TOKEN")
  }
};

export function getPlatformStatuses(): PlatformStatus[] {
  return [
    {
      platform: "etsy",
      label: platformLabels.etsy,
      configured: Boolean(config.etsy.apiKey && config.etsy.accessToken),
      missing: [
        ["ETSY_API_KEY", config.etsy.apiKey],
        ["ETSY_ACCESS_TOKEN", config.etsy.accessToken]
      ]
        .filter(([, value]) => !value)
        .map(([key]) => key as string)
    },
    {
      platform: "ebay",
      label: platformLabels.ebay,
      configured: Boolean(config.ebay.accessToken),
      missing: [["EBAY_ACCESS_TOKEN", config.ebay.accessToken]]
        .filter(([, value]) => !value)
        .map(([key]) => key as string)
    },
    {
      platform: "shopify",
      label: platformLabels.shopify,
      configured: Boolean(
        config.shopify.shopDomain &&
          (config.shopify.accessToken || (config.shopify.clientId && config.shopify.clientSecret))
      ),
      missing: shopifyMissingEnv()
    }
  ];
}

function shopifyMissingEnv() {
  const missing: string[] = [];
  if (!config.shopify.shopDomain) missing.push("SHOPIFY_SHOP_DOMAIN");
  if (!config.shopify.accessToken && !(config.shopify.clientId && config.shopify.clientSecret)) {
    missing.push("SHOPIFY_ADMIN_ACCESS_TOKEN or SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET");
  }
  return missing;
}
