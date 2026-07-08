import type { PlatformAdapter } from "./types";
import { EbayAdapter } from "./ebay";
import { EtsyAdapter } from "./etsy";
import { ShopifyAdapter } from "./shopify";

export const adapters: PlatformAdapter[] = [
  new EtsyAdapter(),
  new EbayAdapter(),
  new ShopifyAdapter()
];

export const adapterByPlatform = Object.fromEntries(
  adapters.map((adapter) => [adapter.platform, adapter])
) as Record<PlatformAdapter["platform"], PlatformAdapter>;
