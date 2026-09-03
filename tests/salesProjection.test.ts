import assert from "node:assert/strict";
import test from "node:test";
import { projectCurrentMonth } from "../src/client/salesProjection";

const input = {
  generatedAt: "2026-09-03T13:00:00.000Z",
  lastPulledAt: "2026-09-03T12:00:00.000Z",
  range: "ytd",
  period: { startDate: "2026-01-01", endDate: "2026-09-03" },
  trend: [
    { date: "2026-08-31", revenue: 9000, orders: 300, units: 310 },
    { date: "2026-09-01", revenue: 800, orders: 25, units: 30 },
    { date: "2026-09-03", revenue: 200, orders: 5, units: 7 }
  ]
};

test("month projection uses elapsed time through the pull, including zero-sale days and partial today", () => {
  const before = structuredClone(input);
  const result = projectCurrentMonth(input);
  assert.ok(result);
  assert.equal(result.elapsedDays, 2.5);
  assert.equal(result.daysInMonth, 30);
  assert.equal(result.revenue, 12000);
  assert.equal(result.orders, 360);
  assert.equal(result.units, 444);
  assert.deepEqual(result.actual, { revenue: 1000, orders: 30, units: 37 });
  assert.deepEqual(input, before);
});

test("month projection supports daily and all-saved views, even when the last sale predates the pull", () => {
  assert.ok(
    projectCurrentMonth({ ...input, range: "month", period: { startDate: "2026-09-01", endDate: "2026-09-03" } })
  );
  const result = projectCurrentMonth({
    ...input,
    range: "all",
    period: { startDate: "2026-08-01", endDate: "2026-09-01" },
    trend: input.trend.slice(0, 2)
  });
  assert.equal(result?.revenue, 9600);
});

test("month projection rejects clipped months, historical periods, and future-only selections", () => {
  for (const period of [
    { startDate: "2026-09-02", endDate: "2026-09-03" },
    { startDate: "2025-01-01", endDate: "2025-12-31" },
    { startDate: "2026-09-01", endDate: "2026-09-02" },
    { startDate: "2026-10-01", endDate: "2026-10-31" }
  ])
    assert.equal(projectCurrentMonth({ ...input, range: "custom", period }), null);
});

test("month projection requires a valid current-month pull and at least one elapsed day", () => {
  for (const lastPulledAt of [
    null,
    "invalid",
    "2026-08-31T23:00:00Z",
    "2026-09-01T23:59:59Z",
    "2026-09-03T14:00:00Z"
  ]) {
    assert.equal(projectCurrentMonth({ ...input, lastPulledAt }), null);
  }
  assert.equal(projectCurrentMonth({ ...input, generatedAt: "invalid" }), null);
  assert.equal(projectCurrentMonth({ ...input, trend: [] }), null);
});

test("month projection handles leap February and stops projecting September after the month rolls over", () => {
  const result = projectCurrentMonth({
    ...input,
    generatedAt: "2028-02-03T00:00:00Z",
    lastPulledAt: "2028-02-03T00:00:00Z",
    period: { startDate: "2028-02-01", endDate: "2028-02-03" },
    trend: [{ date: "2028-02-01", revenue: 100, orders: 3, units: 5 }]
  });
  assert.equal(result?.daysInMonth, 29);
  assert.equal(result?.revenue, 1450);
  assert.equal(result?.orders, 44);
  assert.equal(projectCurrentMonth({ ...input, generatedAt: "2026-10-01T00:00:00Z" }), null);
});

test("weighted projection blends recent monthly daily rates and increasingly trusts this month", () => {
  const projectionHistory = [
    { month: "2026-06", days: 30, revenue: 3000, orders: 300, units: 300 },
    { month: "2026-07", days: 31, revenue: 6200, orders: 620, units: 620 },
    { month: "2026-08", days: 31, revenue: 9300, orders: 930, units: 930 }
  ];
  const early = projectCurrentMonth({ ...input, projectionHistory });
  assert.ok(early);
  const baseline = (100 + 2 * 200 + 3 * 300) / 6;
  assert.equal(early.currentWeight, 2.5 / 9.5);
  assert.ok(Math.abs(early.revenue - (1000 + (27.5 * (1000 + 7 * baseline)) / 9.5)) < 1e-9);
  assert.ok(early.revenue < 12000 && early.revenue > baseline * 30);
  const later = projectCurrentMonth({
    ...input,
    projectionHistory,
    generatedAt: "2026-09-15T00:00:00Z",
    lastPulledAt: "2026-09-15T00:00:00Z",
    period: { startDate: "2026-09-01", endDate: "2026-09-15" },
    trend: [{ date: "2026-09-01", revenue: 5600, orders: 168, units: 168 }]
  });
  assert.ok(later);
  assert.equal(later.currentWeight, 14 / 21);
  assert.ok(later.currentWeight > early.currentWeight);
  assert.ok(later.revenue > early.revenue && later.revenue < 12000);
});

test("weighted projection supports limited history and converges to actual near month end", () => {
  const projectionHistory = [{ month: "2026-08", days: 31, revenue: 3100, orders: 310, units: 310 }];
  const result = projectCurrentMonth({
    ...input,
    projectionHistory,
    generatedAt: "2026-09-30T23:59:59Z",
    lastPulledAt: "2026-09-30T23:59:59Z",
    period: { startDate: "2026-09-01", endDate: "2026-09-30" }
  });
  assert.ok(result);
  assert.deepEqual(result.historyMonths, ["2026-08"]);
  assert.ok(result.revenue >= 1000 && result.revenue < 1000.01);
  assert.equal(projectCurrentMonth(input)?.currentWeight, 1);
});
