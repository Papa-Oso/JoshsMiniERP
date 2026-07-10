import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { PlatformStatus } from "../shared/types";
import { platformLabels } from "../shared/types";

dotenv.config({ quiet: true });

export interface AppConfig {
  port: number;
  host: string;
  apiToken?: string;
  dataFile: string;
  databaseFile: string;
  storeDriver: "json" | "sqlite";
  shopify: {
    shopDomain?: string;
    accessToken?: string;
    clientId?: string;
    clientSecret?: string;
    apiVersion: string;
  };
  ebay: {
    accessToken?: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    environment: "production" | "sandbox";
    marketplaceId: string;
    tokenFile: string;
  };
  ebayDeletionNotices: {
    endpoint?: string;
    adminToken?: string;
  };
  etsy: {
    apiKey?: string;
    shopId?: string;
    accessToken?: string;
    refreshToken?: string;
    clientId?: string;
    redirectUri?: string;
    tokenFile: string;
  };
}

export interface ProductionConfigInput {
  nodeEnv?: string;
  apiToken?: string;
}

const read = (key: string) => process.env[key]?.trim() || undefined;
const placeholderValues = new Set(
  [
    "your-shop.myshopify.com",
    "your-real-store.myshopify.com",
    "shpat_xxx",
    "your_client_id",
    "your_client_secret",
    "v^1.1#xxx",
    "your_etsy_keystring:your_etsy_shared_secret",
    "your_etsy_keystring",
    "your_etsy_shared_secret",
    "your_etsy_oauth_token",
    "your_etsy_refresh_token",
    "https://your-domain.example/etsy/callback",
    "your_ebay_client_id",
    "your_ebay_client_secret",
    "your_ebay_runame",
    "your_ebay_oauth_token",
    "your_ebay_refresh_token"
  ].map((value) => value.toLowerCase())
);

const readConfigured = (key: string) => {
  const value = read(key);
  return value && !isPlaceholderValue(value) ? value : undefined;
};

const etsyKeystring = readConfigured("ETSY_KEYSTRING") ?? readConfigured("ETSY_CLIENT_ID");
const etsySharedSecret = readConfigured("ETSY_SHARED_SECRET");
const etsyApiKey =
  readConfigured("ETSY_API_KEY") ?? (etsyKeystring && etsySharedSecret ? `${etsyKeystring}:${etsySharedSecret}` : undefined);

export const config: AppConfig = {
  port: Number(readConfigured("PORT") ?? 5174),
  host: readConfigured("HOST") ?? "127.0.0.1",
  apiToken: readConfigured("ERP_API_TOKEN"),
  dataFile: path.resolve(readConfigured("DATA_FILE") ?? "data/inventory.json"),
  databaseFile: path.resolve(readConfigured("DATABASE_FILE") ?? "data/inventory.sqlite"),
  storeDriver: readConfigured("STORE_DRIVER") === "json" ? "json" : "sqlite",
  shopify: {
    shopDomain: readConfigured("SHOPIFY_SHOP_DOMAIN"),
    accessToken: readConfigured("SHOPIFY_ADMIN_ACCESS_TOKEN") ?? readConfigured("SHOPIFY_ACCESS_TOKEN"),
    clientId: readConfigured("SHOPIFY_CLIENT_ID"),
    clientSecret: readConfigured("SHOPIFY_CLIENT_SECRET"),
    apiVersion: readConfigured("SHOPIFY_API_VERSION") ?? "2026-07"
  },
  ebay: {
    accessToken: readConfigured("EBAY_ACCESS_TOKEN"),
    refreshToken: readConfigured("EBAY_REFRESH_TOKEN"),
    clientId: readConfigured("EBAY_CLIENT_ID"),
    clientSecret: readConfigured("EBAY_CLIENT_SECRET"),
    redirectUri: readConfigured("EBAY_RUNAME") ?? readConfigured("EBAY_REDIRECT_URI"),
    environment: readConfigured("EBAY_ENVIRONMENT") === "sandbox" ? "sandbox" : "production",
    marketplaceId: readConfigured("EBAY_MARKETPLACE_ID") ?? "EBAY_US",
    tokenFile: path.resolve(readConfigured("EBAY_TOKEN_FILE") ?? "data/ebay-auth.json")
  },
  ebayDeletionNotices: {
    endpoint: readConfigured("EBAY_DELETION_NOTICES_URL"),
    adminToken: readConfigured("EBAY_DELETION_NOTICES_TOKEN")
  },
  etsy: {
    apiKey: etsyApiKey,
    shopId: readConfigured("ETSY_SHOP_ID"),
    accessToken: readConfigured("ETSY_ACCESS_TOKEN"),
    refreshToken: readConfigured("ETSY_REFRESH_TOKEN"),
    clientId: etsyKeystring ?? etsyApiKey?.split(":")[0],
    redirectUri: readConfigured("ETSY_REDIRECT_URI"),
    tokenFile: path.resolve(readConfigured("ETSY_TOKEN_FILE") ?? "data/etsy-auth.json")
  }
};

export function requireProductionApiToken({
  nodeEnv = process.env.NODE_ENV,
  apiToken = config.apiToken
}: ProductionConfigInput = {}) {
  if (nodeEnv?.trim() === "production" && !apiToken?.trim()) {
    throw new Error("ERP_API_TOKEN is required when NODE_ENV=production.");
  }
}

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
      configured: ebayReadyForSync(),
      missing: ebayMissingEnv()
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

export function ebayReadyForSync() {
  return Boolean(ebayHasRefreshableToken() && config.ebay.clientId && config.ebay.clientSecret);
}

function ebayHasRefreshableToken() {
  return Boolean(config.ebay.refreshToken || fs.existsSync(config.ebay.tokenFile));
}

export function ebayMissingEnv() {
  const missing: string[] = [];
  if (!config.ebay.clientId) missing.push("EBAY_CLIENT_ID");
  if (!config.ebay.clientSecret) missing.push("EBAY_CLIENT_SECRET");
  if (!ebayHasRefreshableToken()) {
    missing.push("EBAY_REFRESH_TOKEN or eBay OAuth token file");
    if (!config.ebay.redirectUri) missing.push("EBAY_RUNAME");
  }
  return missing;
}

function etsyMissingEnv() {
  const missing: string[] = [];
  if (!config.etsy.apiKey) missing.push("ETSY_API_KEY or ETSY_KEYSTRING/ETSY_SHARED_SECRET");
  if (!etsyHasToken()) missing.push("ETSY_ACCESS_TOKEN or ETSY_REFRESH_TOKEN or Etsy OAuth token file");
  return missing;
}

function isPlaceholderValue(value: string) {
  const normalized = value.trim().toLowerCase();
  return (
    placeholderValues.has(normalized) ||
    normalized.startsWith("your_") ||
    normalized.startsWith("your-") ||
    /(^|[#:_-])x{2,}($|[#:_-])/i.test(normalized)
  );
}
