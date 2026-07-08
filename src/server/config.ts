import fs from "node:fs";
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
    refreshToken?: string;
    clientId?: string;
    redirectUri?: string;
    tokenFile: string;
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
  "your_etsy_keystring:your_etsy_shared_secret",
  "your_etsy_keystring",
  "your_etsy_oauth_token",
  "your_etsy_refresh_token",
  "https://your-domain.example/etsy/callback"
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
    accessToken: readConfigured("ETSY_ACCESS_TOKEN"),
    refreshToken: readConfigured("ETSY_REFRESH_TOKEN"),
    clientId: readConfigured("ETSY_CLIENT_ID"),
    redirectUri: readConfigured("ETSY_REDIRECT_URI"),
    tokenFile: path.resolve(readConfigured("ETSY_TOKEN_FILE") ?? "data/etsy-auth.json")
  }
};

export function getPlatformStatuses(): PlatformStatus[] {
  return [
    {
      platform: "etsy",
      label: platformLabels.etsy,
      configured: Boolean(config.etsy.apiKey && etsyHasToken()),
      missing: etsyMissingEnv()
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

function etsyHasToken() {
  return Boolean(config.etsy.accessToken || config.etsy.refreshToken || fs.existsSync(config.etsy.tokenFile));
}

function etsyMissingEnv() {
  const missing: string[] = [];
  if (!config.etsy.apiKey) missing.push("ETSY_API_KEY");
  if (!etsyHasToken()) missing.push("ETSY_ACCESS_TOKEN or ETSY_REFRESH_TOKEN or Etsy OAuth token file");
  return missing;
}
