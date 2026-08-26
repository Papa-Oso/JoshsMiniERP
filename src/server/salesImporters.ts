import type { Platform, SalesOrder, SalesRefund } from "../shared/types";
import { ShopifyAdapter } from "./adapters/shopify";
import { config } from "./config";
import { ebayFinancesScope, ebayFulfillmentScope, getEbayAccessToken } from "./ebayAuth";
import { getEtsyAccessToken } from "./etsyAuth";
import { resolveEtsyShopId } from "./etsyReviews";
import type { MarketplaceFinancialPull, MarketplaceFinancialTransaction } from "./salesStore";

export interface SalesImportBatch {
  orders: SalesOrder[];
  refunds: SalesRefund[];
  financialTransactions: MarketplaceFinancialTransaction[];
  financialPull: MarketplaceFinancialPull;
}
export async function importPlatformSales(platform: Platform): Promise<SalesImportBatch> {
  if (platform === "shopify") {
    const orders = await importShopifySales();
    const financial = await optionalFinancialPull(importShopifyFinancials);
    return { orders, refunds: [], financialTransactions: financial.transactions, financialPull: financial.pull };
  }
  if (platform === "ebay") return importEbaySales();
  return importEtsySales();
}

interface ShopifyOrdersPage {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string;
      legacyResourceId: string;
      name: string;
      createdAt: string;
      updatedAt: string;
      displayFinancialStatus: string | null;
      displayFulfillmentStatus: string;
      currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      currentSubtotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      currentShippingPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      currentTotalDiscountsSet: { shopMoney: { amount: string; currencyCode: string } };
      currentTotalTaxSet: { shopMoney: { amount: string; currencyCode: string } };
      shippingAddress: { countryCodeV2: string | null; provinceCode: string | null } | null;
      lineItems: {
        nodes: Array<{
          id: string;
          sku: string | null;
          name: string;
          quantity: number;
          currentQuantity: number;
          discountedTotalSet: { shopMoney: { amount: string } };
        }>;
      };
    }>;
  };
}

interface ShopifyPaymentsPage {
  shopifyPaymentsAccount: {
    balanceTransactions: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        id: string;
        transactionDate: string;
        type: string;
        amount: { amount: string; currencyCode: string };
        fee: { amount: string; currencyCode: string };
        net: { amount: string; currencyCode: string };
        associatedOrder?: { id?: string } | null;
      }>;
    };
  } | null;
}

interface ShopifyQlPayload {
  shopifyqlQuery: {
    tableData?: {
      rows?: Array<{
        day?: string;
        shipping_label_currency?: string;
        shipping_label_costs?: string;
      }>;
    } | null;
    parseErrors: string[];
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
            currentShippingPriceSet { shopMoney { amount currencyCode } }
            currentTotalDiscountsSet { shopMoney { amount currencyCode } }
            currentTotalTaxSet { shopMoney { amount currencyCode } }
            shippingAddress { countryCodeV2 provinceCode }
            lineItems(first: 100) {
              nodes { id sku name quantity currentQuantity discountedTotalSet { shopMoney { amount } } }
            }
          }
        }
      }`,
      { after }
    );
    validateShopifyOrdersPage(payload);
    orders.push(...payload.orders.nodes.map(toShopifyOrder));
    after = payload.orders.pageInfo.hasNextPage ? payload.orders.pageInfo.endCursor : null;
  } while (after);
  return orders;
}

async function importShopifyFinancials() {
  const adapter = new ShopifyAdapter();
  const { start, end } = financialWindow();
  const transactions: MarketplaceFinancialTransaction[] = [];
  const limitations: string[] = [];
  let completedSources = 0;
  let accountActivityAvailable = false;
  let shippingLabelsAvailable = false;

  try {
    const paymentTransactions: MarketplaceFinancialTransaction[] = [];
    let paymentsAccountAvailable = true;
    let after: string | null = null;
    do {
      const payload: ShopifyPaymentsPage = await adapter.runGraphql<ShopifyPaymentsPage>(
        `query ShopifyPaymentsActivity($after: String, $query: String!) {
          shopifyPaymentsAccount {
            balanceTransactions(first: 250, after: $after, hideTransfers: true, query: $query, sortKey: PROCESSED_AT, reverse: true) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id transactionDate type
                amount { amount currencyCode }
                fee { amount currencyCode }
                net { amount currencyCode }
                associatedOrder { id }
              }
            }
          }
        }`,
        { after, query: `processed_at:>=${start}` }
      );
      if (!payload.shopifyPaymentsAccount) {
        limitations.push("Shopify Payments is not active for this shop, so payment fees and net activity are unavailable.");
        paymentsAccountAvailable = false;
        break;
      }
      validateShopifyPaymentsPage(payload);
      paymentTransactions.push(
        ...payload.shopifyPaymentsAccount.balanceTransactions.nodes.map(toShopifyFinancialTransaction)
      );
      after = payload.shopifyPaymentsAccount.balanceTransactions.pageInfo.hasNextPage
        ? payload.shopifyPaymentsAccount.balanceTransactions.pageInfo.endCursor
        : null;
    } while (after);
    if (paymentsAccountAvailable) {
      transactions.push(...paymentTransactions);
      accountActivityAvailable = true;
      shippingLabelsAvailable = true;
      completedSources += 1;
    }
  } catch (error) {
    limitations.push(
      `Shopify Payments activity is unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!shippingLabelsAvailable) {
    try {
      const payload = await adapter.runGraphql<ShopifyQlPayload>(
        `query ShopifyShippingLabelCosts($query: String!) {
          shopifyqlQuery(query: $query) {
            tableData { rows }
            parseErrors
          }
        }`,
        {
          query: `FROM shipping_labels
SHOW shipping_label_costs
GROUP BY shipping_label_currency
TIMESERIES day
SINCE ${start.slice(0, 10)} UNTIL ${end.slice(0, 10)}
ORDER BY day ASC`
        }
      );
      if (payload.shopifyqlQuery.parseErrors.length) {
        throw new Error(payload.shopifyqlQuery.parseErrors.join("; "));
      }
      const rows = payload.shopifyqlQuery.tableData?.rows;
      if (!Array.isArray(rows)) throw new Error("Shopify shipping-label reporting returned malformed data.");
      transactions.push(...rows.map(toShopifyShippingLabelTransaction));
      completedSources += 1;
      shippingLabelsAvailable = true;
    } catch (error) {
      limitations.push(
        `Shopify Shipping label costs are unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!completedSources) throw new Error(limitations.join(" "));
  return {
    transactions,
    pull: {
      status: limitations.length ? ("partial" as const) : ("success" as const),
      message: limitations.join(" "),
      coverageStart: start,
      coverageEnd: end,
      accountActivityAvailable,
      shippingLabelsAvailable
    }
  };
}

export function toShopifyFinancialTransaction(
  row: NonNullable<ShopifyPaymentsPage["shopifyPaymentsAccount"]>["balanceTransactions"]["nodes"][number]
): MarketplaceFinancialTransaction {
  const type = row.type.toUpperCase();
  const amount = number(row.amount.amount);
  const net = number(row.net.amount);
  const isSale = type === "CHARGE";
  const isRefund = type.startsWith("REFUND");
  const isShippingLabel = type.startsWith("SHIPPING_");
  const isProviderCharge = /(FEE|BILLING|CUSTOMS_DUTY|IMPORT_TAX)/.test(type);
  return {
    platform: "shopify",
    transactionKey: row.id,
    transactionDate: row.transactionDate,
    type,
    orderId: row.associatedOrder?.id?.split("/").at(-1) ?? "",
    grossAmount: isSale ? Math.max(0, amount) : 0,
    feeAmount: isSale || isRefund ? net - amount : isProviderCharge ? net : 0,
    refundAmount: isRefund ? amount : 0,
    shippingLabelAmount: isShippingLabel ? net : null,
    netAmount: net,
    currency: row.net.currencyCode || row.amount.currencyCode
  };
}

export function toShopifyShippingLabelTransaction(
  row: { day?: string; shipping_label_currency?: string; shipping_label_costs?: string }
): MarketplaceFinancialTransaction {
  if (!row.day || Number.isNaN(Date.parse(`${row.day}T00:00:00.000Z`)) || !Number.isFinite(Number(row.shipping_label_costs))) {
    throw new Error("Shopify shipping-label reporting returned a malformed row.");
  }
  const cost = Math.abs(number(row.shipping_label_costs));
  return {
    platform: "shopify",
    transactionKey: `shipping-label:${row.day}:${row.shipping_label_currency ?? "USD"}`,
    transactionDate: `${row.day}T00:00:00.000Z`,
    type: "SHIPPING_LABEL",
    orderId: "",
    grossAmount: 0,
    feeAmount: 0,
    refundAmount: 0,
    shippingLabelAmount: -cost,
    netAmount: 0,
    currency: row.shipping_label_currency ?? "USD"
  };
}

export function toShopifyOrder(order: ShopifyOrdersPage["orders"]["nodes"][number]): SalesOrder {
  const currency = order.currentTotalPriceSet.shopMoney.currencyCode;
  const productAmount = number(order.currentSubtotalPriceSet.shopMoney.amount);
  const shippingAmount = number(order.currentShippingPriceSet.shopMoney.amount);
  const discountAmount = number(order.currentTotalDiscountsSet.shopMoney.amount);
  const taxAmount = number(order.currentTotalTaxSet.shopMoney.amount);
  const lineItems = order.lineItems.nodes.map((line) => ({
    platform: "shopify" as const,
    orderId: order.legacyResourceId,
    lineId: line.id,
    sku: line.sku ?? "",
    title: line.name,
    quantity: line.currentQuantity,
    amount: number(line.discountedTotalSet.shopMoney.amount)
  }));
  return {
    platform: "shopify",
    orderId: order.legacyResourceId,
    orderNumber: order.name,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    status: [order.displayFinancialStatus, order.displayFulfillmentStatus].filter(Boolean).join(" / "),
    currency,
    grossAmount: number(order.currentTotalPriceSet.shopMoney.amount),
    netAmount: productAmount,
    productAmount,
    shippingAmount,
    discountAmount,
    taxAmount,
    refundedAmount: 0,
    comparableSalesAmount: Math.max(0, productAmount + shippingAmount),
    financialStatus: order.displayFinancialStatus ?? "",
    financialsComplete: true,
    financialsSource: "order_api",
    financialsUpdatedAt: order.updatedAt,
    reconciliationState: "complete",
    countryCode: order.shippingAddress?.countryCodeV2 ?? "",
    regionCode: order.shippingAddress?.provinceCode ?? "",
    itemCount: lineItems.reduce((sum, line) => sum + line.quantity, 0),
    sourceUrl: config.shopify.shopDomain
      ? `https://${cleanDomain(config.shopify.shopDomain)}/admin/orders/${order.legacyResourceId}`
      : "",
    lineItems
  };
}

interface EbayOrderPage {
  total?: number;
  next?: string;
  orders?: EbayOrder[];
}
interface EbayOrder {
  orderId: string;
  creationDate: string;
  lastModifiedDate?: string;
  orderPaymentStatus?: string;
  orderFulfillmentStatus?: string;
  cancelStatus?: { cancelState?: string };
  pricingSummary?: {
    total?: Money;
    priceSubtotal?: Money;
    deliveryCost?: Money;
    deliveryDiscount?: Money;
    priceDiscount?: Money;
    tax?: Money;
  };
  fulfillmentStartInstructions?: Array<{
    shippingStep?: { shipTo?: { contactAddress?: { countryCode?: string; stateOrProvince?: string } } };
  }>;
  paymentSummary?: { refunds?: EbayRefund[] };
  lineItems?: Array<{
    lineItemId: string;
    sku?: string;
    title?: string;
    quantity?: number;
    total?: Money;
    refunds?: EbayRefund[];
  }>;
}
interface Money {
  value?: string;
  currency?: string;
}
interface EbayRefund {
  refundId?: string;
  refundReferenceId?: string;
  refundDate?: string;
  refundStatus?: string;
  amount?: Money;
}

interface EbayFinancePage {
  total?: number;
  transactions?: EbayFinanceTransaction[];
  errors?: Array<{ message?: string; longMessage?: string }>;
}

interface EbayFinanceTransaction {
  transactionId?: string;
  transactionDate?: string;
  transactionType?: string;
  bookingEntry?: string;
  orderId?: string;
  amount?: Money;
  totalFeeAmount?: Money;
  totalFeeBasisAmount?: Money;
}

async function importEbaySales() {
  const token = await getEbayAccessToken(ebayFulfillmentScope);
  const orders: SalesOrder[] = [];
  const refunds: SalesRefund[] = [];
  let next: string | null = ebayOrdersUrl();
  while (next) {
    const response = await fetch(next, {
      headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": config.ebay.marketplaceId }
    });
    const payload = (await response.json().catch(() => ({}))) as EbayOrderPage & {
      errors?: Array<{ message?: string; longMessage?: string }>;
    };
    if (!response.ok)
      throw new Error(
        payload.errors?.[0]?.longMessage ||
          payload.errors?.[0]?.message ||
          `eBay orders failed with ${response.status}.`
      );
    validateEbayOrderPage(payload);
    orders.push(...payload.orders!.map(toEbayOrder));
    refunds.push(...payload.orders!.flatMap(ebayRefunds));
    next = payload.next ? new URL(payload.next, ebayBaseUrl()).toString() : null;
  }
  const financial = await optionalFinancialPull(importEbayFinancials);
  return { orders, refunds, financialTransactions: financial.transactions, financialPull: financial.pull };
}

async function importEbayFinancials() {
  const token = await getEbayAccessToken(ebayFinancesScope);
  const { start, end } = financialWindow();
  const transactions: MarketplaceFinancialTransaction[] = [];
  let offset = 0;
  const limit = 1000;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const url = new URL("/sell/finances/v1/transaction", ebayFinancesBaseUrl());
    url.searchParams.set("filter", `transactionDate:[${start}..${end}]`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": config.ebay.marketplaceId }
    });
    if (response.status === 204) break;
    const payload = (await response.json().catch(() => ({}))) as EbayFinancePage;
    if (!response.ok) {
      throw new Error(
        payload.errors?.[0]?.longMessage ||
          payload.errors?.[0]?.message ||
          `eBay Finances failed with ${response.status}.`
      );
    }
    validateEbayFinancePage(payload);
    transactions.push(...payload.transactions!.map(toEbayFinancialTransaction));
    total = Number(payload.total);
    offset += payload.transactions!.length;
    if (!payload.transactions!.length && offset < total) {
      throw new Error("eBay Finances returned an incomplete page.");
    }
  }
  return {
    transactions,
    pull: {
      status: "partial" as const,
      message:
        "eBay excludes shipping labels paid through PayPal or another non-eBay payment method from Finances API totals.",
      coverageStart: start,
      coverageEnd: end,
      accountActivityAvailable: true,
      shippingLabelsAvailable: true
    }
  };
}

export function toEbayFinancialTransaction(row: EbayFinanceTransaction): MarketplaceFinancialTransaction {
  const type = (row.transactionType ?? "").toUpperCase();
  const signedAmount = signedMoney(row.amount, row.bookingEntry);
  const fee = Math.abs(number(row.totalFeeAmount?.value));
  const currency =
    row.amount?.currency ?? row.totalFeeAmount?.currency ?? row.totalFeeBasisAmount?.currency ?? "USD";
  return {
    platform: "ebay",
    transactionKey: `${type}:${row.transactionId}`,
    transactionDate: row.transactionDate!,
    type,
    orderId: row.orderId ?? "",
    grossAmount:
      type === "SALE" ? Math.abs(number(row.totalFeeBasisAmount?.value || row.amount?.value)) : 0,
    feeAmount:
      type === "NON_SALE_CHARGE"
        ? signedAmount
        : type === "REFUND"
          ? fee
          : type === "SALE"
            ? -fee
            : 0,
    refundAmount: type === "REFUND" || type === "DISPUTE" ? signedAmount : 0,
    shippingLabelAmount: type === "SHIPPING_LABEL" ? signedAmount : null,
    netAmount: signedAmount,
    currency
  };
}

export function ebayRefunds(order: EbayOrder): SalesRefund[] {
  const rows = [
    ...(order.paymentSummary?.refunds ?? []),
    ...(order.lineItems ?? []).flatMap((line) => line.refunds ?? [])
  ];
  return rows
    .filter((row) => row.refundId || row.refundReferenceId)
    .map((row) => ({
      platform: "ebay",
      orderId: order.orderId,
      refundId: String(row.refundId || row.refundReferenceId),
      refundedAt: row.refundDate ?? order.lastModifiedDate ?? order.creationDate,
      productAmount: 0,
      shippingAmount: 0,
      taxAmount: 0,
      totalAmount: Math.abs(number(row.amount?.value)),
      status: row.refundStatus ?? "",
      currency: row.amount?.currency ?? order.pricingSummary?.total?.currency ?? "USD",
      componentsComplete: false,
      source: "order_api",
      sourceUpdatedAt: order.lastModifiedDate ?? order.creationDate
    }));
}

export function toEbayOrder(order: EbayOrder): SalesOrder {
  const address = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress;
  const total = order.pricingSummary?.total;
  const priceSubtotal = number(order.pricingSummary?.priceSubtotal?.value ?? total?.value);
  const shippingAmount =
    number(order.pricingSummary?.deliveryCost?.value) + number(order.pricingSummary?.deliveryDiscount?.value);
  const discountAmount = Math.abs(number(order.pricingSummary?.priceDiscount?.value));
  const productAmount = Math.max(0, priceSubtotal - discountAmount);
  const taxAmount = number(order.pricingSummary?.tax?.value);
  const canceled =
    order.cancelStatus?.cancelState && order.cancelStatus.cancelState !== "NONE_REQUESTED"
      ? (order.lastModifiedDate ?? order.creationDate)
      : "";
  const lineItems = (order.lineItems ?? []).map((line) => ({
    platform: "ebay" as const,
    orderId: order.orderId,
    lineId: line.lineItemId,
    sku: line.sku ?? "",
    title: line.title ?? "",
    quantity: line.quantity ?? 0,
    amount: number(line.total?.value)
  }));
  const financialsComplete = Boolean(order.pricingSummary?.priceSubtotal && order.pricingSummary?.deliveryCost);
  return {
    platform: "ebay",
    orderId: order.orderId,
    orderNumber: order.orderId,
    createdAt: order.creationDate,
    updatedAt: order.lastModifiedDate ?? order.creationDate,
    status: [order.orderPaymentStatus, order.orderFulfillmentStatus, order.cancelStatus?.cancelState]
      .filter(Boolean)
      .join(" / "),
    currency: total?.currency ?? "USD",
    grossAmount: number(total?.value),
    netAmount: number(order.pricingSummary?.priceSubtotal?.value ?? total?.value),
    productAmount,
    shippingAmount,
    discountAmount,
    taxAmount,
    refundedAmount: 0,
    comparableSalesAmount: Math.max(0, productAmount + shippingAmount),
    financialStatus: order.orderPaymentStatus ?? "",
    canceledAt: canceled,
    financialsComplete,
    financialsSource: "order_api",
    financialsUpdatedAt: order.lastModifiedDate ?? order.creationDate,
    reconciliationState: financialsComplete ? "complete" : "incomplete",
    countryCode: address?.countryCode ?? "",
    regionCode: address?.stateOrProvince ?? "",
    itemCount: lineItems.reduce((sum, line) => sum + line.quantity, 0),
    sourceUrl: `https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(order.orderId)}`,
    lineItems
  };
}

interface EtsyReceiptPage {
  count?: number;
  results?: EtsyReceipt[];
  error?: string;
}
interface EtsyReceipt {
  receipt_id: number;
  create_timestamp: number;
  update_timestamp?: number;
  status?: string;
  country_iso?: string;
  state?: string;
  total_price?: EtsyMoney;
  subtotal?: EtsyMoney;
  total_shipping_cost?: EtsyMoney;
  total_tax_cost?: EtsyMoney;
  total_vat_cost?: EtsyMoney;
  discount_amt?: EtsyMoney;
  transactions?: Array<{
    transaction_id: number;
    listing_id?: number;
    title?: string;
    quantity?: number;
    sku?: string;
    price?: EtsyMoney;
  }>;
}
interface EtsyMoney {
  amount?: number;
  divisor?: number;
  currency_code?: string;
}
interface EtsyPaymentPage {
  count?: number;
  results?: EtsyPayment[];
  error?: string;
}
interface EtsyLedgerPage {
  count?: number;
  results?: EtsyLedgerEntry[];
  error?: string;
}
interface EtsyLedgerEntry {
  entry_id?: number;
  amount?: number;
  currency?: string;
  create_date?: number;
  created_timestamp?: number;
  ledger_type?: string;
  reference_type?: string;
  reference_id?: string;
}
interface EtsyPayment {
  payment_id: number;
  receipt_id: number;
  status?: string;
  currency?: string;
  shop_currency?: string;
  update_timestamp?: number;
  create_timestamp?: number;
  amount_gross?: EtsyMoney;
  amount_fees?: EtsyMoney;
  amount_net?: EtsyMoney;
  posted_gross?: EtsyMoney;
  posted_fees?: EtsyMoney;
  posted_net?: EtsyMoney;
  adjusted_gross?: EtsyMoney;
  adjusted_fees?: EtsyMoney;
  adjusted_net?: EtsyMoney;
  payment_adjustments?: EtsyAdjustment[];
}
interface EtsyAdjustment {
  payment_adjustment_id: number;
  status?: string;
  is_success?: boolean;
  total_adjustment_amount?: number;
  update_timestamp?: number;
  create_timestamp?: number;
  payment_adjustment_items?: Array<{ payment_adjustment_item_id: number; adjustment_type?: string; amount?: number }>;
}

async function importEtsySales() {
  if (!config.etsy.apiKey) throw new Error("Etsy sales require an API key.");
  const apiKey = config.etsy.apiKey;
  const token = await getEtsyAccessToken();
  const shopId = await resolveEtsyShopId();
  const orders: SalesOrder[] = [];
  let offset = 0;
  const limit = 100;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const url = new URL(`https://api.etsy.com/v3/application/shops/${encodeURIComponent(shopId)}/receipts`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const response = await fetch(url, {
      headers: { "x-api-key": config.etsy.apiKey, Authorization: `Bearer ${token}` }
    });
    const payload = (await response.json().catch(() => ({}))) as EtsyReceiptPage;
    if (!response.ok) throw new Error(payload.error || `Etsy receipts failed with ${response.status}.`);
    validateEtsyReceiptPage(payload);
    const receipts = payload.results!;
    orders.push(...receipts.map(toEtsyOrder));
    total = Number(payload.count);
    offset += receipts.length;
    if (!receipts.length && offset < total) throw new Error("Etsy receipts returned an incomplete page.");
    if (!receipts.length) break;
  }
  const earliestCreated = orders.length
    ? Math.min(...orders.map((order) => Math.floor(Date.parse(order.createdAt) / 1000)))
    : null;
  const latestCreated = Math.floor(Date.now() / 1000);
  const financial =
    earliestCreated === null
      ? { payments: [] as EtsyPayment[], ledgerEntries: [] as EtsyLedgerEntry[] }
      : await fetchEtsyFinancialData(shopId, token, apiKey, earliestCreated, latestCreated);
  return {
    orders,
    refunds: financial.payments.flatMap(etsyRefunds),
    financialTransactions: financial.ledgerEntries.flatMap(toEtsyLedgerFinancialTransaction),
    financialPull: {
      status: "partial" as const,
      message:
        "Etsy's USD payment-account ledger is included; transfers and unrecognized ledger categories are excluded.",
      coverageStart: earliestCreated === null ? "" : iso(earliestCreated),
      coverageEnd: iso(latestCreated),
      accountActivityAvailable: true,
      shippingLabelsAvailable: true
    }
  };
}

export async function fetchEtsyPayments(
  shopId: string,
  token: string,
  apiKey: string,
  minCreated: number,
  maxCreated: number,
  fetchImpl: typeof fetch = fetch
) {
  return (await fetchEtsyFinancialData(shopId, token, apiKey, minCreated, maxCreated, fetchImpl)).payments;
}

async function fetchEtsyFinancialData(
  shopId: string,
  token: string,
  apiKey: string,
  minCreated: number,
  maxCreated: number,
  fetchImpl: typeof fetch = fetch
) {
  const entryIds = new Set<number>();
  const ledgerEntries = new Map<number, EtsyLedgerEntry>();
  const limit = 100;
  const maxWindowSeconds = 2_678_400;
  for (let windowStart = minCreated; windowStart <= maxCreated; windowStart += maxWindowSeconds + 1) {
    const windowEnd = Math.min(windowStart + maxWindowSeconds, maxCreated);
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const url = new URL(
        `https://api.etsy.com/v3/application/shops/${encodeURIComponent(shopId)}/payment-account/ledger-entries`
      );
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("min_created", String(windowStart));
      url.searchParams.set("max_created", String(windowEnd));
      const response = await fetchImpl(url, { headers: { "x-api-key": apiKey, Authorization: `Bearer ${token}` } });
      const payload = (await response.json().catch(() => ({}))) as EtsyLedgerPage;
      if (!response.ok) throw new Error(payload.error || `Etsy payment ledger failed with ${response.status}.`);
      validateEtsyLedgerPage(payload);
      const rows = payload.results!;
      for (const row of rows) {
        const id = Number(row.entry_id);
        if (Number.isSafeInteger(id) && id > 0) {
          entryIds.add(id);
          ledgerEntries.set(id, row);
        }
      }
      total = Number(payload.count);
      offset += rows.length;
      if (!rows.length && offset < total) throw new Error("Etsy payment ledger returned an incomplete page.");
      if (!rows.length) break;
    }
  }

  const payments = new Map<number, EtsyPayment>();
  const uniqueEntryIds = [...entryIds];
  for (let index = 0; index < uniqueEntryIds.length; index += 100) {
    const url = new URL(
      `https://api.etsy.com/v3/application/shops/${encodeURIComponent(shopId)}/payment-account/ledger-entries/payments`
    );
    url.searchParams.set("ledger_entry_ids", uniqueEntryIds.slice(index, index + 100).join(","));
    const response = await fetchImpl(url, { headers: { "x-api-key": apiKey, Authorization: `Bearer ${token}` } });
    const payload = (await response.json().catch(() => ({}))) as EtsyPaymentPage;
    if (!response.ok) throw new Error(payload.error || `Etsy ledger payments failed with ${response.status}.`);
    validateEtsyPaymentPage(payload);
    for (const payment of payload.results!)
      if (Number.isSafeInteger(payment.payment_id)) payments.set(payment.payment_id, payment);
  }
  return { payments: [...payments.values()], ledgerEntries: [...ledgerEntries.values()] };
}

export function etsyRefunds(payment: EtsyPayment): SalesRefund[] {
  return (payment.payment_adjustments ?? [])
    .filter((row) => row.is_success !== false)
    .map((adjustment) => {
      const items = adjustment.payment_adjustment_items ?? [];
      let productAmount = 0,
        shippingAmount = 0,
        taxAmount = 0;
      let recognized = items.length > 0;
      for (const item of items) {
        const amount = Math.abs(number(item.amount)) / 100;
        const type = (item.adjustment_type ?? "").toLowerCase();
        if (type.includes("shipping") || type.includes("postage")) shippingAmount += amount;
        else if (type.includes("tax") || type.includes("vat")) taxAmount += amount;
        else if (type.includes("transaction") || type.includes("item") || type.includes("sale"))
          productAmount += amount;
        else recognized = false;
      }
      const totalAmount = Math.abs(number(adjustment.total_adjustment_amount)) / 100;
      const componentsComplete =
        recognized && Math.abs(productAmount + shippingAmount + taxAmount - totalAmount) < 0.01;
      const updated =
        adjustment.update_timestamp ??
        adjustment.create_timestamp ??
        payment.update_timestamp ??
        payment.create_timestamp ??
        0;
      return {
        platform: "etsy" as const,
        orderId: String(payment.receipt_id),
        refundId: String(adjustment.payment_adjustment_id),
        refundedAt: iso(updated),
        productAmount: componentsComplete ? productAmount : 0,
        shippingAmount: componentsComplete ? shippingAmount : 0,
        taxAmount: componentsComplete ? taxAmount : 0,
        totalAmount,
        status: adjustment.status ?? payment.status ?? "",
        currency: payment.currency ?? "USD",
        componentsComplete,
        source: "payment_api",
        sourceUpdatedAt: iso(updated)
      };
    });
}

export function toEtsyLedgerFinancialTransaction(
  row: EtsyLedgerEntry
): MarketplaceFinancialTransaction[] {
  const type = (row.ledger_type ?? "").trim().toUpperCase();
  const amount = number(row.amount) / 100;
  const transactionDate = iso(row.created_timestamp ?? row.create_date ?? 0);
  const base = {
    platform: "etsy" as const,
    transactionKey: `ledger:${row.entry_id}`,
    transactionDate,
    type,
    orderId: row.reference_type?.toLowerCase().includes("receipt") ? (row.reference_id ?? "") : "",
    grossAmount: 0,
    refundAmount: 0,
    currency: row.currency ?? "USD"
  };
  if (type === "PAYMENT_GROSS" && amount >= 0) {
    return [{ ...base, grossAmount: amount, feeAmount: 0, shippingLabelAmount: null, netAmount: amount }];
  }
  if (type === "REFUND_GROSS" && amount <= 0) {
    return [{ ...base, feeAmount: 0, refundAmount: amount, shippingLabelAmount: null, netAmount: amount }];
  }
  if (isEtsyShippingLabel(type)) {
    return [{ ...base, feeAmount: 0, shippingLabelAmount: amount, netAmount: amount }];
  }
  if (isEtsyStandaloneCharge(type, row.reference_type, amount)) {
    return [{ ...base, feeAmount: amount, shippingLabelAmount: null, netAmount: amount }];
  }
  return [];
}

export function toEtsyOrder(receipt: EtsyReceipt): SalesOrder {
  const total = money(receipt.total_price);
  const productAmount = money(receipt.subtotal ?? receipt.total_price).amount;
  const shippingAmount = money(receipt.total_shipping_cost).amount;
  const discountAmount = money(receipt.discount_amt).amount;
  const taxAmount = money(receipt.total_tax_cost).amount + money(receipt.total_vat_cost).amount;
  const canceled =
    receipt.status?.toLowerCase() === "canceled" ? iso(receipt.update_timestamp ?? receipt.create_timestamp) : "";
  const lines = (receipt.transactions ?? []).map((line) => ({
    platform: "etsy" as const,
    orderId: String(receipt.receipt_id),
    lineId: String(line.transaction_id),
    sku: line.sku ?? "",
    title: line.title ?? "",
    quantity: line.quantity ?? 0,
    amount: money(line.price).amount * (line.quantity ?? 0)
  }));
  const financialsComplete = Boolean(receipt.subtotal && receipt.total_shipping_cost && receipt.total_tax_cost);
  return {
    platform: "etsy",
    orderId: String(receipt.receipt_id),
    orderNumber: String(receipt.receipt_id),
    createdAt: iso(receipt.create_timestamp),
    updatedAt: iso(receipt.update_timestamp ?? receipt.create_timestamp),
    status: receipt.status ?? "",
    currency: total.currency,
    grossAmount: total.amount,
    netAmount: money(receipt.subtotal ?? receipt.total_price).amount,
    productAmount,
    shippingAmount,
    discountAmount,
    taxAmount,
    refundedAmount: 0,
    comparableSalesAmount: Math.max(0, productAmount + shippingAmount),
    financialStatus: receipt.status ?? "",
    canceledAt: canceled,
    financialsComplete,
    financialsSource: "order_api",
    financialsUpdatedAt: iso(receipt.update_timestamp ?? receipt.create_timestamp),
    reconciliationState: financialsComplete ? "complete" : "incomplete",
    countryCode: receipt.country_iso ?? "",
    regionCode: receipt.state ?? "",
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    sourceUrl: `https://www.etsy.com/your/shops/me/orders/sold?order_id=${receipt.receipt_id}`,
    lineItems: lines
  };
}

function money(value?: EtsyMoney) {
  return {
    amount: number(value?.amount) / Math.max(1, number(value?.divisor) || 100),
    currency: value?.currency_code ?? "USD"
  };
}
function iso(timestamp: number) {
  return new Date(timestamp * 1000).toISOString();
}
function number(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function cleanDomain(value: string) {
  return value.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
function ebayBaseUrl() {
  return config.ebay.environment === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}
function ebayFinancesBaseUrl() {
  return config.ebay.environment === "sandbox" ? "https://apiz.sandbox.ebay.com" : "https://apiz.ebay.com";
}
function financialWindow(now = Date.now()) {
  const current = new Date(now);
  return {
    start: new Date(current.getFullYear(), 0, 1).toISOString(),
    end: current.toISOString()
  };
}
function signedMoney(value: Money | undefined, bookingEntry: string | undefined) {
  const amount = Math.abs(number(value?.value));
  return bookingEntry?.toUpperCase() === "DEBIT" ? -amount : amount;
}
function isEtsyShippingLabel(type: string) {
  return type.includes("SHIPPING") && (type.includes("LABEL") || type.includes("POSTAGE"));
}
function isEtsyStandaloneCharge(type: string, referenceType: string | undefined, amount: number) {
  if (amount === 0) return false;
  const combined = `${type} ${(referenceType ?? "").toUpperCase()}`;
  if (/(DISBURSE|DEPOSIT|PAYOUT|TRANSFER|RESERVE|HOLD)/.test(combined)) return false;
  return /(FEE|LISTING|RENEW|TRANSACTION|TAX|VAT|ADVERT|MARKETING|SUBSCRIPTION|REGULATORY|ETSY_PLUS|PATTERN|CREDIT|RECOUP|MISC_)/.test(
    combined
  );
}
async function optionalFinancialPull(
  importer: () => Promise<{
    transactions: MarketplaceFinancialTransaction[];
    pull: MarketplaceFinancialPull;
  }>
) {
  try {
    return await importer();
  } catch (error) {
    const { start, end } = financialWindow();
    return {
      transactions: [],
      pull: {
        status: "error" as const,
        message: error instanceof Error ? error.message : String(error),
        coverageStart: start,
        coverageEnd: end,
        accountActivityAvailable: false,
        shippingLabelsAvailable: false
      }
    };
  }
}
export function ebayOrdersUrl() {
  const url = new URL("/sell/fulfillment/v1/order", ebayBaseUrl());
  url.searchParams.set("limit", "200");
  url.searchParams.set("offset", "0");
  url.searchParams.set("fieldGroups", "TAX_BREAKDOWN");
  return url.toString();
}

function validateEbayFinancePage(payload: EbayFinancePage) {
  if (!nonnegativeCount(payload.total) || !Array.isArray(payload.transactions)) {
    throw new Error("eBay Finances returned a malformed page.");
  }
  if (
    payload.transactions.some(
      (row) =>
        !row.transactionId ||
        !row.transactionType ||
        !validDate(row.transactionDate) ||
        !row.amount?.currency ||
        !Number.isFinite(Number(row.amount.value))
    )
  ) {
    throw new Error("eBay Finances returned a malformed transaction.");
  }
}

function validateShopifyPaymentsPage(payload: ShopifyPaymentsPage) {
  const transactions = payload.shopifyPaymentsAccount?.balanceTransactions;
  if (
    !transactions ||
    !Array.isArray(transactions.nodes) ||
    typeof transactions.pageInfo?.hasNextPage !== "boolean" ||
    (transactions.pageInfo.hasNextPage && !transactions.pageInfo.endCursor)
  ) {
    throw new Error("Shopify Payments returned a malformed page.");
  }
  if (
    transactions.nodes.some(
      (row) =>
        !row.id ||
        !row.type ||
        !validDate(row.transactionDate) ||
        !row.amount?.currencyCode ||
        !row.fee?.currencyCode ||
        !row.net?.currencyCode ||
        !Number.isFinite(Number(row.amount.amount)) ||
        !Number.isFinite(Number(row.fee.amount)) ||
        !Number.isFinite(Number(row.net.amount))
    )
  ) {
    throw new Error("Shopify Payments returned a malformed transaction.");
  }
}

function validateShopifyOrdersPage(payload: ShopifyOrdersPage) {
  const orders = payload?.orders;
  if (
    !orders ||
    !Array.isArray(orders.nodes) ||
    typeof orders.pageInfo?.hasNextPage !== "boolean" ||
    (orders.pageInfo.hasNextPage && !orders.pageInfo.endCursor)
  ) {
    throw new Error("Shopify orders returned a malformed page.");
  }
  for (const order of orders.nodes) {
    if (
      !order?.legacyResourceId ||
      !validDate(order.createdAt) ||
      !validDate(order.updatedAt) ||
      !order.currentTotalPriceSet?.shopMoney?.currencyCode ||
      !order.currentSubtotalPriceSet?.shopMoney ||
      !order.currentShippingPriceSet?.shopMoney ||
      !order.currentTotalDiscountsSet?.shopMoney ||
      !order.currentTotalTaxSet?.shopMoney ||
      !Array.isArray(order.lineItems?.nodes)
    ) {
      throw new Error("Shopify orders returned a malformed order.");
    }
  }
}

function validateEbayOrderPage(payload: EbayOrderPage) {
  if (!Array.isArray(payload.orders) || (payload.next !== undefined && typeof payload.next !== "string")) {
    throw new Error("eBay orders returned a malformed page.");
  }
  for (const order of payload.orders) {
    if (!order?.orderId || !validDate(order.creationDate) || !Array.isArray(order.lineItems ?? [])) {
      throw new Error("eBay orders returned a malformed order.");
    }
    if (order.paymentSummary?.refunds && !Array.isArray(order.paymentSummary.refunds)) {
      throw new Error("eBay orders returned a malformed refund batch.");
    }
    if (order.lineItems?.some((line) => !line?.lineItemId || (line.refunds && !Array.isArray(line.refunds)))) {
      throw new Error("eBay orders returned a malformed line-item batch.");
    }
  }
}

function validateEtsyReceiptPage(payload: EtsyReceiptPage) {
  if (!nonnegativeCount(payload.count) || !Array.isArray(payload.results)) {
    throw new Error("Etsy receipts returned a malformed page.");
  }
  if (
    payload.results.some(
      (receipt) =>
        !Number.isSafeInteger(receipt?.receipt_id) ||
        !validUnixTimestamp(receipt.create_timestamp) ||
        !Array.isArray(receipt.transactions ?? [])
    )
  ) {
    throw new Error("Etsy receipts returned a malformed receipt.");
  }
}

function validateEtsyLedgerPage(payload: EtsyLedgerPage) {
  if (!nonnegativeCount(payload.count) || !Array.isArray(payload.results)) {
    throw new Error("Etsy payment ledger returned a malformed page.");
  }
}

function validateEtsyPaymentPage(payload: EtsyPaymentPage) {
  if (!Array.isArray(payload.results)) throw new Error("Etsy ledger payments returned a malformed page.");
  if (
    payload.results.some(
      (payment) =>
        !Number.isSafeInteger(payment?.payment_id) ||
        !Number.isSafeInteger(payment.receipt_id) ||
        !Array.isArray(payment.payment_adjustments ?? [])
    )
  ) {
    throw new Error("Etsy ledger payments returned a malformed payment batch.");
  }
}

function nonnegativeCount(value: unknown) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0;
}

function validDate(value: unknown) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function validUnixTimestamp(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
