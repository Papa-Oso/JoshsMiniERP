import type { SalesDashboardPayload } from "../shared/types";

const dayMs = 86_400_000;

export function projectCurrentMonth({
  trend,
  period,
  range,
  generatedAt,
  lastPulledAt,
  projectionHistory = []
}: Pick<SalesDashboardPayload, "trend" | "period" | "range" | "generatedAt" | "lastPulledAt" | "projectionHistory">) {
  const now = Date.parse(generatedAt);
  const pulledAt = Date.parse(lastPulledAt ?? "");
  if (!Number.isFinite(now) || !Number.isFinite(pulledAt) || pulledAt > now) return null;
  const current = new Date(now);
  const monthStart = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1);
  const monthEnd = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1);
  const monthKey = current.toISOString().slice(0, 7);
  const elapsedDays = (pulledAt - monthStart) / dayMs;
  // A partial first day is too little evidence; never project a clipped or historical month.
  if (elapsedDays < 1 || !period.startDate || period.startDate > `${monthKey}-01`) return null;
  const throughDate = new Date(pulledAt).toISOString().slice(0, 10);
  if (range !== "all" && (!period.endDate || period.endDate < throughDate)) return null;
  const actual = { revenue: 0, orders: 0, units: 0 };
  for (const row of trend) {
    if (row.date.slice(0, 7) !== monthKey || row.date > throughDate) continue;
    actual.revenue += row.revenue;
    actual.orders += row.orders;
    actual.units += row.units;
  }
  if (!actual.orders) return null;
  const daysInMonth = (monthEnd - monthStart) / dayMs;
  const history = projectionHistory
    .filter((row) => row.month < monthKey && row.days > 0)
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-3);
  const priorDays = history.length ? 7 : 0;
  const currentWeight = elapsedDays / (elapsedDays + priorDays);
  const weightTotal = history.reduce((total, _row, index) => total + index + 1, 0);
  const estimate = (metric: "revenue" | "orders" | "units") => {
    const historicalRate =
      history.reduce((total, row, index) => total + ((index + 1) * row[metric]) / row.days, 0) / (weightTotal || 1);
    const dailyRate = (actual[metric] + priorDays * historicalRate) / (elapsedDays + priorDays);
    return actual[metric] + (daysInMonth - elapsedDays) * dailyRate;
  };
  return {
    monthKey,
    through: lastPulledAt!,
    elapsedDays,
    daysInMonth,
    actual,
    currentWeight,
    historyMonths: history.map((row) => row.month),
    revenue: estimate("revenue"),
    orders: Math.round(estimate("orders")),
    units: Math.round(estimate("units"))
  };
}
