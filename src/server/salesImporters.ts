import type { Platform, SalesOrder } from "../shared/types";
import { ShopifyAdapter } from "./adapters/shopify";
import { config } from "./config";
import { ebayFulfillmentScope, getEbayAccessToken } from "./ebayAuth";
import { getEtsyAccessToken } from "./etsyAuth";
import { resolveEtsyShopId } from "./etsyReviews";

export async function importPlatformSales(platform: Platform): Promise<SalesOrder[]> {
  if (platform === "shopify") return importShopifySales();
  if (platform === "ebay") return importEbaySales();
  return importEtsySales();
}

interface ShopifyOrdersPage {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string; legacyResourceId: string; name: string; createdAt: string; updatedAt: string;
      displayFinancialStatus: string | null; displayFulfillmentStatus: string;
      currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      currentSubtotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      shippingAddress: { countryCodeV2: string | null; provinceCode: string | null } | null;
      lineItems: { nodes: Array<{ id: string; sku: string | null; name: string; quantity: number; currentQuantity: number; discountedTotalSet: { shopMoney: { amount: string } } }> };
    }>;
  };
}

async function importShopifySales() {
  const adapter = new ShopifyAdapter();
  if (!adapter.isConfigured()) throw new Error(`Shopify is missing: ${adapter.missingEnv().join(", ")}.`);
  const orders: SalesOrder[] = [];
  let after: string | null = null;
  do {
    const payload: ShopifyOrdersPage = await adapter.runGraphql<ShopifyOrdersPage>(
      `query SalesOrders($after: String) {
        orders(first: 100, after: $after, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id legacyResourceId name createdAt updatedAt displayFinancialStatus displayFulfillmentStatus
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            currentSubtotalPriceSet { shopMoney { amount currencyCode } }
            shippingAddress { countryCodeV2 provinceCode }
            lineItems(first: 100) {
              nodes { id sku name quantity currentQuantity discountedTotalSet { shopMoney { amount } } }
            }
          }
        }
      }`,
      { after }
    );
    orders.push(...payload.orders.nodes.map(toShopifyOrder));
    after = payload.orders.pageInfo.hasNextPage ? payload.orders.pageInfo.endCursor : null;
  } while (after);
  return orders;
}

function toShopifyOrder(order: ShopifyOrdersPage["orders"]["nodes"][number]): SalesOrder {
  const currency = order.currentTotalPriceSet.shopMoney.currencyCode;
  const lineItems = order.lineItems.nodes.map((line) => ({
    platform: "shopify" as const, orderId: order.legacyResourceId, lineId: line.id,
    sku: line.sku ?? "", title: line.name, quantity: line.currentQuantity,
    amount: number(line.discountedTotalSet.shopMoney.amount)
  }));
  return {
    platform: "shopify", orderId: order.legacyResourceId, orderNumber: order.name,
    createdAt: order.createdAt, updatedAt: order.updatedAt,
    status: [order.displayFinancialStatus, order.displayFulfillmentStatus].filter(Boolean).join(" / "),
    currency, grossAmount: number(order.currentTotalPriceSet.shopMoney.amount),
    netAmount: number(order.currentSubtotalPriceSet.shopMoney.amount),
    countryCode: order.shippingAddress?.countryCodeV2 ?? "",
    regionCode: order.shippingAddress?.provinceCode ?? "",
    itemCount: lineItems.reduce((sum, line) => sum + line.quantity, 0),
    sourceUrl: config.shopify.shopDomain ? `https://${cleanDomain(config.shopify.shopDomain)}/admin/orders/${order.legacyResourceId}` : "",
    lineItems
  };
}

interface EbayOrderPage { total?: number; next?: string; orders?: EbayOrder[] }
interface EbayOrder {
  orderId: string; creationDate: string; lastModifiedDate?: string; orderPaymentStatus?: string;
  orderFulfillmentStatus?: string; cancelStatus?: { cancelState?: string };
  pricingSummary?: { total?: Money; priceSubtotal?: Money; deliveryCost?: Money; deliveryDiscount?: Money; priceDiscount?: Money; tax?: Money };
  fulfillmentStartInstructions?: Array<{ shippingStep?: { shipTo?: { contactAddress?: { countryCode?: string; stateOrProvince?: string } } } }>;
  lineItems?: Array<{ lineItemId: string; sku?: string; title?: string; quantity?: number; total?: Money }>;
}
interface Money { value?: string; currency?: string }

async function importEbaySales() {
  const token = await getEbayAccessToken(ebayFulfillmentScope);
  const orders: SalesOrder[] = [];
  let next: string | null = `${ebayBaseUrl()}/sell/fulfillment/v1/order?limit=200&offset=0`;
  while (next) {
    const response = await fetch(next, { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": config.ebay.marketplaceId } });
    const payload = (await response.json().catch(() => ({}))) as EbayOrderPage & { errors?: Array<{ message?: string; longMessage?: string }> };
    if (!response.ok) throw new Error(payload.errors?.[0]?.longMessage || payload.errors?.[0]?.message || `eBay orders failed with ${response.status}.`);
    orders.push(...(payload.orders ?? []).map(toEbayOrder));
    next = payload.next ? new URL(payload.next, ebayBaseUrl()).toString() : null;
  }
  return orders;
}

export function toEbayOrder(order: EbayOrder): SalesOrder {
  const address = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress;
  const total = order.pricingSummary?.total;
  const productAmount = number(order.pricingSummary?.priceSubtotal?.value ?? total?.value);
  const shippingAmount = number(order.pricingSummary?.deliveryCost?.value) + number(order.pricingSummary?.deliveryDiscount?.value);
  const discountAmount = Math.abs(number(order.pricingSummary?.priceDiscount?.value));
  const taxAmount = number(order.pricingSummary?.tax?.value);
  const canceled = order.cancelStatus?.cancelState && order.cancelStatus.cancelState !== "NONE_REQUESTED" ? order.lastModifiedDate ?? order.creationDate : "";
  const lineItems = (order.lineItems ?? []).map((line) => ({
    platform: "ebay" as const, orderId: order.orderId, lineId: line.lineItemId,
    sku: line.sku ?? "", title: line.title ?? "", quantity: line.quantity ?? 0, amount: number(line.total?.value)
  }));
  return {
    platform: "ebay", orderId: order.orderId, orderNumber: order.orderId,
    createdAt: order.creationDate, updatedAt: order.lastModifiedDate ?? order.creationDate,
    status: [order.orderPaymentStatus, order.orderFulfillmentStatus, order.cancelStatus?.cancelState].filter(Boolean).join(" / "),
    currency: total?.currency ?? "USD", grossAmount: number(total?.value),
    netAmount: number(order.pricingSummary?.priceSubtotal?.value ?? total?.value),
    productAmount, shippingAmount, discountAmount, taxAmount, refundedAmount: 0,
    comparableSalesAmount: Math.max(0, productAmount + shippingAmount - discountAmount),
    financialStatus: order.orderPaymentStatus ?? "", canceledAt: canceled,
    financialsComplete: Boolean(order.pricingSummary?.priceSubtotal && order.pricingSummary?.deliveryCost && order.pricingSummary?.tax),
    financialsSource: "order_api",
    countryCode: address?.countryCode ?? "", regionCode: address?.stateOrProvince ?? "",
    itemCount: lineItems.reduce((sum, line) => sum + line.quantity, 0),
    sourceUrl: `https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(order.orderId)}`,
    lineItems
  };
}

interface EtsyReceiptPage { count?: number; results?: EtsyReceipt[]; error?: string }
interface EtsyReceipt {
  receipt_id: number; create_timestamp: number; update_timestamp?: number; status?: string;
  country_iso?: string; state?: string; total_price?: EtsyMoney; subtotal?: EtsyMoney;
  total_shipping_cost?: EtsyMoney; total_tax_cost?: EtsyMoney; total_vat_cost?: EtsyMoney; discount_amt?: EtsyMoney;
  transactions?: Array<{ transaction_id: number; listing_id?: number; title?: string; quantity?: number; sku?: string; price?: EtsyMoney }>;
}
interface EtsyMoney { amount?: number; divisor?: number; currency_code?: string }

async function importEtsySales() {
  if (!config.etsy.apiKey) throw new Error("Etsy sales require an API key.");
  const token = await getEtsyAccessToken();
  const shopId = await resolveEtsyShopId();
  const orders: SalesOrder[] = [];
  let offset = 0;
  const limit = 100;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const url = new URL(`https://api.etsy.com/v3/application/shops/${encodeURIComponent(shopId)}/receipts`);
    url.searchParams.set("limit", String(limit)); url.searchParams.set("offset", String(offset));
    const response = await fetch(url, { headers: { "x-api-key": config.etsy.apiKey, Authorization: `Bearer ${token}` } });
    const payload = (await response.json().catch(() => ({}))) as EtsyReceiptPage;
    if (!response.ok) throw new Error(payload.error || `Etsy receipts failed with ${response.status}.`);
    const receipts = payload.results ?? [];
    orders.push(...receipts.map(toEtsyOrder));
    total = Number(payload.count ?? orders.length);
    offset += receipts.length;
    if (!receipts.length) break;
  }
  return orders;
}

export function toEtsyOrder(receipt: EtsyReceipt): SalesOrder {
  const total = money(receipt.total_price);
  const productAmount = money(receipt.subtotal ?? receipt.total_price).amount;
  const shippingAmount = money(receipt.total_shipping_cost).amount;
  const discountAmount = money(receipt.discount_amt).amount;
  const taxAmount = money(receipt.total_tax_cost).amount + money(receipt.total_vat_cost).amount;
  const canceled = receipt.status?.toLowerCase() === "canceled" ? iso(receipt.update_timestamp ?? receipt.create_timestamp) : "";
  const lines = (receipt.transactions ?? []).map((line) => ({
    platform: "etsy" as const, orderId: String(receipt.receipt_id), lineId: String(line.transaction_id),
    sku: line.sku ?? "", title: line.title ?? "", quantity: line.quantity ?? 0,
    amount: money(line.price).amount * (line.quantity ?? 0)
  }));
  return {
    platform: "etsy", orderId: String(receipt.receipt_id), orderNumber: String(receipt.receipt_id),
    createdAt: iso(receipt.create_timestamp), updatedAt: iso(receipt.update_timestamp ?? receipt.create_timestamp),
    status: receipt.status ?? "", currency: total.currency, grossAmount: total.amount,
    netAmount: money(receipt.subtotal ?? receipt.total_price).amount,
    productAmount, shippingAmount, discountAmount, taxAmount, refundedAmount: 0,
    comparableSalesAmount: Math.max(0, productAmount + shippingAmount),
    financialStatus: receipt.status ?? "", canceledAt: canceled,
    financialsComplete: Boolean(receipt.subtotal && receipt.total_shipping_cost && receipt.total_tax_cost),
    financialsSource: "order_api",
    countryCode: receipt.country_iso ?? "", regionCode: receipt.state ?? "",
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    sourceUrl: `https://www.etsy.com/your/shops/me/orders/sold?order_id=${receipt.receipt_id}`,
    lineItems: lines
  };
}

function money(value?: EtsyMoney) { return { amount: number(value?.amount) / Math.max(1, number(value?.divisor) || 100), currency: value?.currency_code ?? "USD" }; }
function iso(timestamp: number) { return new Date(timestamp * 1000).toISOString(); }
function number(value: unknown) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function cleanDomain(value: string) { return value.replace(/^https?:\/\//, "").replace(/\/$/, ""); }
function ebayBaseUrl() { return config.ebay.environment === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com"; }
