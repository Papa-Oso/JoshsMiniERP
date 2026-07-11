import type {
  Platform,
  SalesDashboardPayload,
  SalesIntegrityWarningCode,
  SalesOrder,
  SalesReconciliationPayload,
  SalesRefund
} from "../shared/types";
import { platforms } from "../shared/types";
import { importPlatformSales } from "./salesImporters";
import {
  applySalesImport,
  loadCanonicalProductNames,
  loadEbayFinancialTransactions,
  loadSalesOrders,
  loadSalesPulls,
  loadSalesRefunds,
  recordSalesPullFailure
} from "./salesStore";

export async function refreshSales(selected: Platform[] = platforms) {
  const results: Array<{ platform: Platform; ok: boolean; ordersSeen: number; message: string }> = [];
  for (const platform of selected) {
    try {
      const batch = await importPlatformSales(platform);
      await applySalesImport(platform, batch.orders, batch.refunds);
      results.push({ platform, ok: true, ordersSeen: batch.orders.length, message: "" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordSalesPullFailure(platform, message);
      results.push({ platform, ok: false, ordersSeen: 0, message });
    }
  }
  return { results, dashboard: await getSalesDashboard() };
}

export async function getSalesDashboard({
  range = "90d",
  platform = "all"
}: { range?: string; platform?: Platform | "all" } = {}): Promise<SalesDashboardPayload> {
  const [allOrders, pulls, allEbayFinancials, productNames] = await Promise.all([
    loadSalesOrders(),
    loadSalesPulls(),
    loadEbayFinancialTransactions(),
    loadCanonicalProductNames()
  ]);
  const start = rangeStart(range);
  const orders = allOrders.filter(
    (order) =>
      (platform === "all" || order.platform === platform) &&
      (!start || Date.parse(order.createdAt) >= start) &&
      !isExcludedOrder(order)
  );
  const currencies = [...new Set(orders.map((order) => order.currency).filter(Boolean))];
  const currency = currencies[0] ?? "USD";
  const revenue = sum(orders.map(revenueAmount));
  const units = sum(orders.map((order) => order.itemCount));
  const warnings: string[] = [];
  if (currencies.length > 1) warnings.push("Multiple currencies are shown without exchange-rate conversion.");
  for (const source of platforms) {
    const latest = pulls.find((pull) => pull.platform === source);
    if (latest?.status === "error") warnings.push(`${label(source)} sales pull needs attention: ${latest.message}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    lastPulledAt: pulls[0] ? String(pulls[0].pulled_at) : null,
    range,
    platform,
    summary: {
      revenue,
      orders: orders.length,
      units,
      averageOrderValue: orders.length ? revenue / orders.length : 0,
      currency
    },
    ebayFinancials:
      platform === "etsy" || platform === "shopify"
        ? null
        : summarizeEbayFinancials(
            allEbayFinancials.filter((row) => !start || Date.parse(row.transactionDate) >= start)
          ),
    trend: aggregateTrend(orders),
    platforms: platforms.map((source) => aggregatePlatform(orders, source)),
    countries: aggregateCountries(orders),
    locations: aggregateLocations(orders),
    dataQuality: {
      unknownGeographyOrders: orders.filter((order) => !order.countryCode).length,
      missingSkuLines: sum(orders.map((order) => order.lineItems.filter((line) => !line.sku).length))
    },
    products: aggregateProducts(orders, productNames),
    recentOrders: orders.slice(0, 25),
    coverage: platforms.map((source) => coverage(allOrders, source)),
    warnings
  };
}

export async function getSalesReconciliation({
  range = "90d",
  platform,
  currency
}: {
  range?: string;
  platform: Platform;
  currency?: string;
}): Promise<SalesReconciliationPayload> {
  const [orders, refunds, pulls, financials] = await Promise.all([
    loadSalesOrders(),
    loadSalesRefunds(),
    loadSalesPulls(),
    loadEbayFinancialTransactions()
  ]);
  return reconcileSales({ orders, refunds, pulls, financials, range, platform, currency, now: Date.now() });
}

type FinancialRow = Awaited<ReturnType<typeof loadEbayFinancialTransactions>>[number];
export function reconcileSales({
  orders,
  refunds,
  pulls,
  financials,
  range,
  platform,
  currency,
  now
}: {
  orders: SalesOrder[];
  refunds: SalesRefund[];
  pulls: Array<Record<string, unknown>>;
  financials: FinancialRow[];
  range: string;
  platform: Platform;
  currency?: string;
  now: number;
}): SalesReconciliationPayload {
  const start = rangeStart(range, now);
  const imported = orders.filter(
    (order) =>
      order.platform === platform &&
      (!start || Date.parse(order.createdAt) >= start) &&
      (!currency || order.currency === currency)
  );
  const orderKeys = new Set(imported.map((order) => order.orderId));
  const matchingRefunds = refunds.filter(
    (refund) =>
      refund.platform === platform && orderKeys.has(refund.orderId) && (!currency || refund.currency === currency)
  );
  const currencies = [...new Set(imported.map((order) => order.currency || "USD"))].sort();
  const rows = currencies.map((code) =>
    reconciliationRow(
      code,
      imported.filter((order) => (order.currency || "USD") === code),
      matchingRefunds.filter((refund) => refund.currency === code),
      platform === "ebay"
        ? financials.filter((row) => row.currency === code && (!start || Date.parse(row.transactionDate) >= start))
        : []
    )
  );
  const warnings: SalesReconciliationPayload["warnings"] = [];
  const duplicateRefunds =
    matchingRefunds.length - new Set(matchingRefunds.map((refund) => `${refund.orderId}:${refund.refundId}`)).size;
  addWarning(warnings, "duplicate_refund", duplicateRefunds, "Duplicate refund identities require review.");
  addWarning(
    warnings,
    "unmatched_refund",
    refunds.filter(
      (refund) =>
        refund.platform === platform &&
        (!start || Date.parse(refund.refundedAt) >= start) &&
        !orders.some((order) => order.platform === platform && order.orderId === refund.orderId)
    ).length,
    "Refunds without a matching saved order require review."
  );
  addWarning(
    warnings,
    "unresolved_refund",
    matchingRefunds.filter((refund) => !refund.componentsComplete && !failedRefund(refund)).length,
    "Refund totals with unresolved product, shipping, or tax components are excluded from comparable sales."
  );
  addWarning(
    warnings,
    "mixed_currency",
    !currency && currencies.length > 1 ? currencies.length : 0,
    "Currencies are reported separately and are not combined."
  );
  addWarning(
    warnings,
    "missing_breakdown",
    imported.filter((order) => !order.financialsComplete).length,
    "Orders with incomplete financial breakdowns require backfill."
  );
  addWarning(
    warnings,
    "impossible_total",
    imported.filter((order) => impossibleOrder(order)).length,
    "Orders whose components do not reconcile to comparable sales require review."
  );
  const latestPull = pulls.find((pull) => pull.platform === platform);
  addWarning(
    warnings,
    "stale_pull",
    !latestPull || now - Date.parse(String(latestPull.pulled_at ?? "")) > 48 * 3_600_000 ? 1 : 0,
    "The latest marketplace pull is missing or older than 48 hours."
  );
  if (platform === "ebay") {
    const financialOrderIds = new Set(
      financials
        .filter((row) => row.type.toLowerCase() === "order" && (!start || Date.parse(row.transactionDate) >= start))
        .map((row) => row.orderId)
        .filter(Boolean)
    );
    addWarning(
      warnings,
      "api_report_disagreement",
      imported.filter((order) => financialOrderIds.size && !financialOrderIds.has(order.orderId)).length,
      "Saved API orders and imported financial-report orders do not fully overlap."
    );
  }
  return { generatedAt: new Date(now).toISOString(), range, platform, currency: currency ?? null, rows, warnings };
}

function reconciliationRow(
  currency: string,
  orders: SalesOrder[],
  refunds: SalesRefund[],
  platformFinancials: FinancialRow[]
): SalesReconciliationPayload["rows"][number] {
  const included = orders.filter((order) => !canceledOrder(order));
  const completeRefunds = refunds.filter((refund) => refund.componentsComplete && !failedRefund(refund));
  const productRevenue = sum(included.map((order) => order.productAmount ?? 0));
  const shippingRevenue = sum(included.map((order) => order.shippingAmount ?? 0));
  const discounts = sum(included.map((order) => order.discountAmount ?? 0));
  const refundAmount = sum(completeRefunds.map((refund) => refund.productAmount + refund.shippingAmount));
  const operational = platformFinancials.filter(
    (row) => !["payout", "hold", "transfer", "reserve"].includes(row.type.toLowerCase())
  );
  return {
    currency,
    importedOrders: orders.length,
    includedOrders: included.length,
    canceledOrders: orders.length - included.length,
    refundedOrders: new Set(refunds.filter((refund) => !failedRefund(refund)).map((refund) => refund.orderId)).size,
    unresolvedOrders: included.filter((order) => order.reconciliationState !== "complete" || !order.financialsComplete)
      .length,
    productRevenue,
    shippingRevenue,
    discounts,
    excludedTax: sum(included.map((order) => order.taxAmount ?? 0)),
    refunds: refundAmount,
    comparableNetSales: productRevenue + shippingRevenue - refundAmount,
    fees: platformFinancials.length ? Math.abs(sum(operational.map((row) => row.feeAmount))) : null,
    shippingLabels: platformFinancials.length
      ? Math.abs(
          sum(
            platformFinancials.filter((row) => row.type.toLowerCase() === "shipping label").map((row) => row.netAmount)
          )
        )
      : null,
    netProceeds: platformFinancials.length ? sum(operational.map((row) => row.netAmount)) : null
  };
}

function canceledOrder(order: SalesOrder) {
  return Boolean(order.canceledAt) || order.status.toLowerCase().includes("cancel");
}
function failedRefund(refund: SalesRefund) {
  return ["failed", "canceled", "cancelled"].includes(refund.status.toLowerCase());
}
function impossibleOrder(order: SalesOrder) {
  if (!order.financialsComplete) return false;
  const expected = (order.productAmount ?? 0) + (order.shippingAmount ?? 0);
  return (
    (order.comparableSalesAmount ?? expected) < 0 ||
    Math.abs(expected - (order.comparableSalesAmount ?? expected)) > 0.01
  );
}
function addWarning(
  warnings: SalesReconciliationPayload["warnings"],
  code: SalesIntegrityWarningCode,
  count: number,
  message: string
) {
  if (count > 0) warnings.push({ code, count, message });
}

function summarizeEbayFinancials(rows: Awaited<ReturnType<typeof loadEbayFinancialTransactions>>) {
  const operational = rows.filter((row) => !["payout", "hold", "transfer", "reserve"].includes(row.type.toLowerCase()));
  const byType = (type: string) => rows.filter((row) => row.type.toLowerCase() === type);
  return {
    grossSales: sum(byType("order").map((row) => row.grossAmount)),
    fees: Math.abs(sum(operational.map((row) => row.feeAmount))),
    refunds: Math.abs(sum(byType("refund").map((row) => row.netAmount))),
    shippingLabels: Math.abs(sum(byType("shipping label").map((row) => row.netAmount))),
    netProceeds: sum(operational.map((row) => row.netAmount)),
    transactionCount: rows.length
  };
}

function aggregateTrend(orders: SalesOrder[]) {
  const groups = new Map<string, { date: string; revenue: number; orders: number; units: number }>();
  for (const order of orders) {
    const date = order.createdAt.slice(0, 10);
    const group = groups.get(date) ?? { date, revenue: 0, orders: 0, units: 0 };
    group.revenue += revenueAmount(order);
    group.orders += 1;
    group.units += order.itemCount;
    groups.set(date, group);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function aggregatePlatform(orders: SalesOrder[], platform: Platform) {
  const matching = orders.filter((order) => order.platform === platform);
  return {
    platform,
    revenue: sum(matching.map(revenueAmount)),
    orders: matching.length,
    units: sum(matching.map((order) => order.itemCount))
  };
}

function aggregateCountries(orders: SalesOrder[]) {
  const groups = new Map<string, { countryCode: string; revenue: number; orders: number; units: number }>();
  for (const order of orders) {
    const countryCode = order.countryCode || "Unknown";
    const group = groups.get(countryCode) ?? { countryCode, revenue: 0, orders: 0, units: 0 };
    group.revenue += revenueAmount(order);
    group.orders += 1;
    group.units += order.itemCount;
    groups.set(countryCode, group);
  }
  return [...groups.values()].sort((a, b) => b.orders - a.orders || b.revenue - a.revenue);
}

function aggregateLocations(orders: SalesOrder[]) {
  const groups = new Map<
    string,
    { countryCode: string; regionCode: string; revenue: number; orders: number; units: number }
  >();
  for (const order of orders) {
    const countryCode = order.countryCode || "Unknown";
    const regionCode = order.regionCode || "";
    const key = `${countryCode}:${regionCode}`;
    const group = groups.get(key) ?? { countryCode, regionCode, revenue: 0, orders: 0, units: 0 };
    group.revenue += revenueAmount(order);
    group.orders += 1;
    group.units += order.itemCount;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.orders - a.orders || b.revenue - a.revenue);
}

function aggregateProducts(orders: SalesOrder[], productNames: Map<string, { name: string; imagePath: string }>) {
  const groups = new Map<
    string,
    { sku: string; title: string; imageUrl?: string; revenue: number; orders: Set<string>; units: number }
  >();
  for (const order of orders)
    for (const line of order.lineItems) {
      const sku = line.sku.trim() === "--" ? "" : line.sku.trim();
      const key = sku || line.title || "Unknown product";
      const product = sku ? productNames.get(sku.toLowerCase()) : undefined;
      const group = groups.get(key) ?? {
        sku,
        title: product?.name || line.title,
        imageUrl: product?.imagePath ? `/api/product-images/${encodeURIComponent(product.imagePath)}` : undefined,
        revenue: 0,
        orders: new Set(),
        units: 0
      };
      group.revenue += line.amount;
      group.orders.add(`${order.platform}:${order.orderId}`);
      group.units += line.quantity;
      groups.set(key, group);
    }
  return [...groups.values()]
    .map((group) => ({ ...group, orders: group.orders.size }))
    .sort((a, b) => b.revenue - a.revenue || b.units - a.units)
    .slice(0, 25);
}

function coverage(orders: SalesOrder[], platform: Platform) {
  const dates = orders
    .filter((order) => order.platform === platform)
    .map((order) => order.createdAt)
    .sort();
  return { platform, orders: dates.length, earliestAt: dates[0] ?? null, latestAt: dates.at(-1) ?? null };
}

function rangeStart(range: string, now = Date.now()) {
  if (range === "all") return null;
  const days = Number(range.replace(/d$/, ""));
  return Number.isFinite(days) && days > 0 ? now - days * 86_400_000 : now - 90 * 86_400_000;
}
function isExcludedOrder(order: SalesOrder) {
  return order.platform === "etsy" && order.status.trim().toLowerCase() === "canceled";
}
function revenueAmount(order: SalesOrder) {
  return order.platform === "etsy" ? order.netAmount : order.grossAmount;
}
function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
function label(platform: Platform) {
  return platform === "ebay" ? "eBay" : platform[0].toUpperCase() + platform.slice(1);
}
