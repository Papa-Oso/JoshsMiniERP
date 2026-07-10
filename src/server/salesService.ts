import type { Platform, SalesDashboardPayload, SalesOrder } from "../shared/types";
import { platforms } from "../shared/types";
import { importPlatformSales } from "./salesImporters";
import { loadSalesOrders, loadSalesPulls, recordSalesPullFailure, upsertSalesOrders } from "./salesStore";

export async function refreshSales(selected: Platform[] = platforms) {
  const results: Array<{ platform: Platform; ok: boolean; ordersSeen: number; message: string }> = [];
  for (const platform of selected) {
    try {
      const orders = await importPlatformSales(platform);
      await upsertSalesOrders(platform, orders);
      results.push({ platform, ok: true, ordersSeen: orders.length, message: "" });
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
  const [allOrders, pulls] = await Promise.all([loadSalesOrders(), loadSalesPulls()]);
  const start = rangeStart(range);
  const orders = allOrders.filter((order) =>
    (platform === "all" || order.platform === platform) && (!start || Date.parse(order.createdAt) >= start)
  );
  const currencies = [...new Set(orders.map((order) => order.currency).filter(Boolean))];
  const currency = currencies[0] ?? "USD";
  const revenue = sum(orders.map((order) => order.grossAmount));
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
    trend: aggregateTrend(orders),
    platforms: platforms.map((source) => aggregatePlatform(orders, source)),
    countries: aggregateCountries(orders),
    products: aggregateProducts(orders),
    recentOrders: orders.slice(0, 25),
    coverage: platforms.map((source) => coverage(allOrders, source)),
    warnings
  };
}

function aggregateTrend(orders: SalesOrder[]) {
  const groups = new Map<string, { date: string; revenue: number; orders: number; units: number }>();
  for (const order of orders) {
    const date = order.createdAt.slice(0, 10);
    const group = groups.get(date) ?? { date, revenue: 0, orders: 0, units: 0 };
    group.revenue += order.grossAmount; group.orders += 1; group.units += order.itemCount;
    groups.set(date, group);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function aggregatePlatform(orders: SalesOrder[], platform: Platform) {
  const matching = orders.filter((order) => order.platform === platform);
  return { platform, revenue: sum(matching.map((order) => order.grossAmount)), orders: matching.length, units: sum(matching.map((order) => order.itemCount)) };
}

function aggregateCountries(orders: SalesOrder[]) {
  const groups = new Map<string, { countryCode: string; revenue: number; orders: number; units: number }>();
  for (const order of orders) {
    const countryCode = order.countryCode || "Unknown";
    const group = groups.get(countryCode) ?? { countryCode, revenue: 0, orders: 0, units: 0 };
    group.revenue += order.grossAmount; group.orders += 1; group.units += order.itemCount;
    groups.set(countryCode, group);
  }
  return [...groups.values()].sort((a, b) => b.orders - a.orders || b.revenue - a.revenue);
}

function aggregateProducts(orders: SalesOrder[]) {
  const groups = new Map<string, { sku: string; title: string; revenue: number; orders: Set<string>; units: number }>();
  for (const order of orders) for (const line of order.lineItems) {
    const key = line.sku || line.title || "Unknown product";
    const group = groups.get(key) ?? { sku: line.sku, title: line.title, revenue: 0, orders: new Set(), units: 0 };
    group.revenue += line.amount; group.orders.add(`${order.platform}:${order.orderId}`); group.units += line.quantity;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ ...group, orders: group.orders.size })).sort((a, b) => b.revenue - a.revenue || b.units - a.units).slice(0, 25);
}

function coverage(orders: SalesOrder[], platform: Platform) {
  const dates = orders.filter((order) => order.platform === platform).map((order) => order.createdAt).sort();
  return { platform, orders: dates.length, earliestAt: dates[0] ?? null, latestAt: dates.at(-1) ?? null };
}

function rangeStart(range: string) {
  if (range === "all") return null;
  const days = Number(range.replace(/d$/, ""));
  return Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : Date.now() - 90 * 86_400_000;
}
function sum(values: number[]) { return values.reduce((total, value) => total + value, 0); }
function label(platform: Platform) { return platform === "ebay" ? "eBay" : platform[0].toUpperCase() + platform.slice(1); }
