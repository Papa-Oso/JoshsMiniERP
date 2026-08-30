import { useEffect, useMemo, useState } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { numericToAlpha2 } from "i18n-iso-countries";
import { BarChart3, Clock3, Globe2, PackageOpen, RefreshCw, ShoppingCart, Store, TrendingUp } from "lucide-react";
import { feature } from "topojson-client";
import type { FeatureCollection, Geometry } from "geojson";
import world from "world-atlas/countries-110m.json";
import { api } from "./api";
import { Metric, Panel } from "./ui";
import type { Platform, SalesDashboardPayload, SalesOrder } from "../shared/types";
import { platformLabels, platforms } from "../shared/types";

const empty: SalesDashboardPayload = {
  generatedAt: "",
  lastPulledAt: null,
  range: "90d",
  period: { startDate: null, endDate: null },
  platform: "all",
  summary: { revenue: 0, orders: 0, units: 0, averageOrderValue: 0, currency: "USD" },
  financialSummaries: [],
  trend: [],
  platforms: [],
  countries: [],
  locations: [],
  dataQuality: { unknownGeographyOrders: 0, missingSkuLines: 0 },
  products: [],
  recentOrders: [],
  coverage: [],
  warnings: []
};

export function SalesPage() {
  const [data, setData] = useState(empty);
  const [range, setRange] = useState("90d");
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [customStartDate, setCustomStartDate] = useState(firstDayOfCurrentMonth);
  const [customEndDate, setCustomEndDate] = useState(todayInputValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void load();
  }, [range, platform, customStartDate, customEndDate]);
  async function load() {
    try {
      setError("");
      setData(
        await api.sales(
          range,
          platform,
          range === "custom" ? customStartDate : undefined,
          range === "custom" ? customEndDate : undefined
        )
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }
  async function refresh() {
    try {
      setBusy(true);
      setError("");
      const result = await api.refreshSales();
      const failures = result.results.filter((row) => !row.ok);
      if (failures.length)
        setError(failures.map((row) => `${platformLabels[row.platform]}: ${row.message}`).join(" | "));
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }
  const money = (value: number, currency = data.summary.currency) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0
    }).format(value);

  return (
    <div className="sales-page">
      <section className="sales-toolbar">
        <div className="sales-filters">
          <label>
            Period
            <select value={range} onChange={(event) => setRange(event.target.value)}>
              <option value="month">This month</option>
              <option value="30d">30 days</option>
              <option value="90d">90 days</option>
              <option value="ytd">This year</option>
              <option value="365d">1 year</option>
              <option value="all">All saved</option>
              <option value="custom">Custom dates</option>
            </select>
          </label>
          {range === "custom" ? (
            <>
              <label>
                From
                <input
                  type="date"
                  value={customStartDate}
                  max={customEndDate}
                  onChange={(event) => setCustomStartDate(event.target.value)}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={customEndDate}
                  min={customStartDate}
                  onChange={(event) => setCustomEndDate(event.target.value)}
                />
              </label>
            </>
          ) : null}
          <label>
            Platform
            <select value={platform} onChange={(event) => setPlatform(event.target.value as Platform | "all")}>
              <option value="all">All platforms</option>
              {platforms.map((source) => (
                <option value={source} key={source}>
                  {platformLabels[source]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="sales-refresh">
          <span>
            <Clock3 size={14} />
            {data.lastPulledAt ? `Updated ${formatDateTime(data.lastPulledAt)}` : "Not pulled yet"}
          </span>
          <button className="icon-button primary" type="button" onClick={refresh} disabled={busy}>
            <RefreshCw size={17} className={busy ? "spin" : ""} />
            {busy ? "Pulling all marketplaces…" : "Pull sales"}
          </button>
        </div>
      </section>
      {error ? <p className="notice danger">{error}</p> : null}
      {data.warnings.map((warning) => (
        <p className="notice warn" key={warning}>
          {warning}
        </p>
      ))}
      <section className="sales-metrics">
        <Metric label="Revenue" value={money(data.summary.revenue)} />
        <Metric label="Orders" value={data.summary.orders} />
        <Metric label="Units sold" value={data.summary.units} />
        <Metric label="Average order" value={money(data.summary.averageOrderValue)} />
      </section>
      <details className="sales-calculation">
        <summary>How these totals are calculated</summary>
        <div>
          <p>
            <strong>Revenue</strong> currently adds saved Shopify and eBay gross order totals plus Etsy merchandise
            subtotal after seller discounts. Canceled Etsy receipts are excluded. This legacy headline does not yet
            subtract refunds or consistently include shipping, and taxes may remain in marketplace gross totals.
          </p>
          <p>
            <strong>Orders</strong> counts the included saved orders in the selected period and platform.{" "}
            <strong>Units sold</strong> adds their item quantities. <strong>Average order</strong> is Revenue divided by
            Orders. If the selection contains multiple currencies, this legacy view shows a warning and does not perform
            currency conversion; use the currency-separated reconciliation totals for comparison.
          </p>
          <p>
            Comparable net sales will replace Revenue only after the financial backfill and marketplace reconciliation
            are reviewed and approved.
          </p>
        </div>
      </details>
      <Panel title="Marketplace performance" icon={<Store size={17} />}>
        <MarketplacePerformance
          rows={data.platforms.filter((row) => platform === "all" || row.platform === platform)}
          money={money}
        />
      </Panel>
      {data.financialSummaries.map((summary) => (
        <Panel
          title={`Automated ${platformLabels[summary.platform]} financial activity`}
          icon={<BarChart3 size={17} />}
          key={`${summary.platform}:${summary.currency}`}
        >
          <p className="sales-panel-note">
            Refreshed by Pull sales. Source coverage: {formatDate(summary.coverageStart)}–
            {formatDate(summary.coverageEnd)}.
          </p>
          <section className="sales-metrics marketplace-financial-metrics">
            <Metric
              label="Gross sales"
              value={summary.accountActivityAvailable ? money(summary.grossSales, summary.currency) : "Unavailable"}
            />
            <Metric
              label={`${platformLabels[summary.platform]} fees & charges`}
              value={summary.accountActivityAvailable ? money(summary.fees, summary.currency) : "Unavailable"}
              tone="warn"
            />
            <Metric
              label="Refund activity"
              value={summary.accountActivityAvailable ? money(summary.refunds, summary.currency) : "Unavailable"}
              tone="warn"
            />
            <Metric
              label="Captured label charges"
              value={summary.shippingLabels === null ? "Unavailable" : money(summary.shippingLabels, summary.currency)}
            />
            <Metric
              label="Net account activity"
              value={summary.accountActivityAvailable ? money(summary.netActivity, summary.currency) : "Unavailable"}
            />
          </section>
          {summary.limitations.map((limitation) => (
            <p className="sales-panel-note" key={limitation}>
              Limitation: {limitation}
            </p>
          ))}
        </Panel>
      ))}
      <section className="sales-primary-grid">
        <Panel title="Sales trend" icon={<TrendingUp size={17} />} className="sales-trend-panel">
          <TrendChart data={data.trend} money={money} period={data.period} range={data.range} />
        </Panel>
        <Panel title="Sales around the world" icon={<Globe2 size={17} />}>
          <WorldSalesMap locations={data.locations} countries={data.countries} money={money} />
          <CountryList countries={data.countries.slice(0, 6)} money={money} />
          <p className="map-note">
            Unknown geography: {data.dataQuality.unknownGeographyOrders}{" "}
            {data.dataQuality.unknownGeographyOrders === 1 ? "order" : "orders"}.
          </p>
        </Panel>
      </section>
      <Panel title="Top products" icon={<PackageOpen size={17} />}>
        <ProductTable rows={data.products.slice(0, 10)} money={money} />
      </Panel>
      <Panel title="Recent orders" icon={<ShoppingCart size={17} />} className="recent-orders-panel">
        <div className="sales-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Platform</th>
                <th>Order</th>
                <th>Destination</th>
                <th>Units</th>
                <th>Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.recentOrders.map((order) => (
                <tr key={`${order.platform}:${order.orderId}`}>
                  <td>{formatDate(order.createdAt)}</td>
                  <td>
                    <span className="sales-platform-badge">{platformLabels[order.platform]}</span>
                  </td>
                  <td>
                    {order.sourceUrl ? (
                      <a href={order.sourceUrl} target="_blank" rel="noreferrer">
                        {order.orderNumber}
                      </a>
                    ) : (
                      order.orderNumber
                    )}
                  </td>
                  <td>{order.countryCode || "Unknown"}</td>
                  <td>{order.itemCount}</td>
                  <td>{money(order.grossAmount)}</td>
                  <td>
                    <OrderStatus order={order} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.recentOrders.length ? <p className="empty">Pull sales to build the dashboard.</p> : null}
        </div>
      </Panel>
      <p className="sales-footnote">
        Geography is stored only as country and region. Customer names, emails, street addresses, phones, and postal
        codes are not retained.
      </p>
    </div>
  );
}

type TrendMetric = "revenue" | "orders" | "units";
type TrendPoint = SalesDashboardPayload["trend"][number] & { key: string; label: string };

function TrendChart({
  data,
  money,
  period,
  range
}: {
  data: SalesDashboardPayload["trend"];
  money: (value: number) => string;
  period: SalesDashboardPayload["period"];
  range: string;
}) {
  const [metric, setMetric] = useState<TrendMetric>("revenue");
  const values = useMemo(() => buildTrendSeries(data, period, range), [data, period, range]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const max = Math.max(1, ...values.map((row) => row[metric]));
  const currentIndex = activeIndex === null ? values.length - 1 : Math.min(activeIndex, values.length - 1);
  const active = values[currentIndex];
  const line = values.map((row, index) => chartPoint(row[metric], index, values.length, max));
  const linePath =
    line.length === 1
      ? `M0,${line[0][1]} L1000,${line[0][1]}`
      : line.map(([x, y], index) => `${index ? "L" : "M"}${x},${y}`).join(" ");
  const areaPath = line.length ? `${linePath} L1000,300 L0,300 Z` : "";
  const tickIndexes = chartTickIndexes(values.length);
  const grouping = rangeUsesMonthlyPoints(range, period) ? "Monthly" : "Daily";

  if (!data.length) return <p className="empty">No sales in this period.</p>;
  return (
    <div className="trend-chart">
      <div className="trend-chart-header">
        <p>{grouping} totals · hover, tap, or use arrow keys to inspect</p>
        <div className="trend-metric-toggle" role="group" aria-label="Chart value">
          {(["revenue", "orders", "units"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={metric === value}
              onClick={() => {
                setMetric(value);
                setActiveIndex(null);
              }}
            >
              {value === "revenue" ? "Revenue" : value === "orders" ? "Orders" : "Units"}
            </button>
          ))}
        </div>
      </div>
      <div className="trend-chart-layout">
        <div className="trend-y-axis" aria-hidden="true">
          {[1, 0.75, 0.5, 0.25, 0].map((portion) => (
            <span key={portion}>{formatTrendValue(max * portion, metric, money)}</span>
          ))}
        </div>
        <div
          className="trend-plot"
          tabIndex={0}
          role="img"
          aria-label={`${grouping} ${metric} line chart. ${active ? trendPointLabel(active, money) : ""}`}
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
            setActiveIndex(Math.round(ratio * (values.length - 1)));
          }}
          onPointerLeave={() => setActiveIndex(null)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const direction = event.key === "ArrowLeft" ? -1 : 1;
            setActiveIndex((index) =>
              Math.max(0, Math.min(values.length - 1, (index ?? values.length - 1) + direction))
            );
          }}
        >
          <svg viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="sales-trend-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {[0, 75, 150, 225, 300].map((y) => (
              <line className="trend-grid-line" x1="0" x2="1000" y1={y} y2={y} key={y} />
            ))}
            <path className="trend-area" d={areaPath} />
            <path className="trend-line" d={linePath} />
            {active ? (
              <line className="trend-crosshair" x1={line[currentIndex][0]} x2={line[currentIndex][0]} y1="0" y2="300" />
            ) : null}
          </svg>
          {active ? (
            <span
              className="trend-point-marker"
              aria-hidden="true"
              style={{ left: `${line[currentIndex][0] / 10}%`, top: `${line[currentIndex][1] / 3}%` }}
            />
          ) : null}
          <div className="trend-x-axis" aria-hidden="true">
            {tickIndexes.map((index) => (
              <span key={values[index].key} style={{ left: `${line[index][0] / 10}%` }}>
                {values[index].label}
              </span>
            ))}
          </div>
        </div>
      </div>
      {active ? (
        <div className="trend-chart-detail" aria-live="polite">
          <strong>{active.label}</strong>
          <span>{money(active.revenue)} revenue</span>
          <span>
            {active.orders} {active.orders === 1 ? "order" : "orders"}
          </span>
          <span>
            {active.units} {active.units === 1 ? "unit" : "units"}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function buildTrendSeries(
  data: SalesDashboardPayload["trend"],
  period: SalesDashboardPayload["period"],
  range: string
): TrendPoint[] {
  if (!data.length) return [];
  const monthly = rangeUsesMonthlyPoints(range, period);
  const startDate = period.startDate ?? data[0].date;
  const endDate = period.endDate ?? data.at(-1)?.date ?? startDate;
  const groups = new Map<string, TrendPoint>();
  for (const row of data) {
    const key = monthly ? row.date.slice(0, 7) : row.date;
    const existing = groups.get(key) ?? {
      key,
      date: key,
      label: trendDateLabel(key, monthly),
      revenue: 0,
      orders: 0,
      units: 0
    };
    existing.revenue += row.revenue;
    existing.orders += row.orders;
    existing.units += row.units;
    groups.set(key, existing);
  }
  const cursor = parseDate(startDate);
  const end = parseDate(endDate);
  const values: TrendPoint[] = [];
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const key = monthly ? date.slice(0, 7) : date;
    values.push(
      groups.get(key) ?? { key, date: key, label: trendDateLabel(key, monthly), revenue: 0, orders: 0, units: 0 }
    );
    if (monthly) cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return values;
}

function rangeUsesMonthlyPoints(range: string, period: SalesDashboardPayload["period"]) {
  if (["ytd", "365d", "all"].includes(range)) return true;
  if (!period.startDate || !period.endDate) return false;
  return (parseDate(period.endDate).getTime() - parseDate(period.startDate).getTime()) / 86_400_000 > 120;
}
function parseDate(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}
function trendDateLabel(value: string, monthly: boolean) {
  const date = parseDate(monthly ? `${value}-01` : value);
  return new Intl.DateTimeFormat(
    undefined,
    monthly
      ? { month: "short", year: "numeric", timeZone: "UTC" }
      : { month: "short", day: "numeric", timeZone: "UTC" }
  ).format(date);
}
function chartPoint(value: number, index: number, length: number, max: number): [number, number] {
  return [length === 1 ? 500 : (index / (length - 1)) * 1000, 300 - (value / max) * 286];
}
function chartTickIndexes(length: number) {
  if (length <= 1) return [0];
  const tickCount = Math.min(6, length);
  return [
    ...new Set(Array.from({ length: tickCount }, (_, index) => Math.round((index / (tickCount - 1)) * (length - 1))))
  ];
}
function formatTrendValue(value: number, metric: TrendMetric, money: (value: number) => string) {
  if (metric === "revenue") return money(value);
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
function trendPointLabel(point: TrendPoint, money: (value: number) => string) {
  return `${point.label}: ${money(point.revenue)}, ${point.orders} orders, ${point.units} units`;
}

const countryCentroids: Record<string, [number, number]> = {
  US: [-98, 39],
  CA: [-106, 57],
  MX: [-102, 23],
  BR: [-52, -10],
  AR: [-64, -34],
  GB: [-3, 55],
  FR: [2, 46],
  DE: [10, 51],
  ES: [-4, 40],
  IT: [12, 42],
  NL: [5, 52],
  SE: [16, 62],
  NO: [9, 62],
  PL: [19, 52],
  UA: [32, 49],
  TR: [35, 39],
  ZA: [24, -29],
  EG: [30, 27],
  NG: [8, 9],
  KE: [38, 1],
  IN: [79, 22],
  CN: [104, 35],
  JP: [138, 37],
  KR: [128, 36],
  AU: [134, -25],
  NZ: [172, -41],
  SG: [104, 1],
  PH: [122, 12],
  ID: [118, -2],
  TH: [101, 15],
  AE: [54, 24],
  SA: [45, 24],
  IL: [35, 31],
  RU: [90, 60]
};
const usRegionOffsets: Record<string, [number, number]> = {
  CA: [-21, -2],
  OR: [-22, 5],
  WA: [-22, 9],
  AZ: [-14, -6],
  TX: [-1, -8],
  IL: [9, 1],
  MI: [12, 5],
  FL: [17, -11],
  GA: [15, -6],
  NC: [18, -2],
  VA: [17, 1],
  PA: [15, 4],
  NY: [17, 7],
  NJ: [17, 3],
  MA: [20, 8],
  CO: [-7, 1],
  OH: [12, 2],
  TN: [10, -4]
};
function locationCoordinates(countryCode: string, regionCode: string) {
  const base = countryCentroids[countryCode];
  if (!base) return null;
  const offset = countryCode === "US" ? usRegionOffsets[regionCode.toUpperCase()] : null;
  return offset ? ([base[0] + offset[0], base[1] + offset[1]] as [number, number]) : base;
}
function placeName(countryCode: string, regionCode: string) {
  try {
    const countries = new Intl.DisplayNames(undefined, { type: "region" });
    const country = countries.of(countryCode) || countryCode;
    return regionCode ? `${regionCode}, ${country}` : country;
  } catch {
    return [regionCode, countryCode].filter(Boolean).join(", ");
  }
}
const mapProjection = geoNaturalEarth1().fitExtent(
  [
    [4, 4],
    [756, 386]
  ],
  { type: "Sphere" }
);
const mapPath = geoPath(mapProjection);
const countryFeatures = (
  feature(world as never, (world as typeof world).objects.countries as never) as unknown as FeatureCollection<Geometry>
).features;
function WorldSalesMap({
  locations,
  countries,
  money
}: {
  locations: SalesDashboardPayload["locations"];
  countries: SalesDashboardPayload["countries"];
  money: (value: number) => string;
}) {
  const max = Math.max(1, ...locations.map((row) => row.orders));
  const ordersByCountry = new Map(countries.map((row) => [row.countryCode, row.orders]));
  const countryMax = Math.max(1, ...countries.map((row) => row.orders));
  return (
    <>
      <svg
        className="world-map"
        viewBox="0 0 760 390"
        role="img"
        aria-label="Country and approximate regional sales destinations"
      >
        <path className="world-ocean" d={mapPath({ type: "Sphere" }) || undefined} />
        <g className="world-land">
          {countryFeatures.map((country) => {
            const code = country.id ? numericToAlpha2(String(country.id).padStart(3, "0")) : undefined;
            const orders = code ? ordersByCountry.get(code) || 0 : 0;
            const intensity = orders ? 0.18 + 0.7 * Math.sqrt(orders / countryMax) : 0;
            return (
              <path
                key={String(country.id || country.properties?.name)}
                d={mapPath(country) || undefined}
                style={
                  orders
                    ? {
                        fill: `color-mix(in srgb, var(--color-primary) ${Math.round(intensity * 100)}%, var(--color-surface-raised))`
                      }
                    : undefined
                }
              >
                <title>
                  {code ? `${placeName(code, "")}: ${orders} orders` : String(country.properties?.name || "Country")}
                </title>
              </path>
            );
          })}
        </g>
        <g role="list" aria-label="Mapped sales regions">
          {locations.map((row) => {
            const coordinates = locationCoordinates(row.countryCode, row.regionCode);
            const point = coordinates ? mapProjection(coordinates) : null;
            if (!point) return null;
            const radius = 4 + Math.sqrt(row.orders / max) * 9;
            const label = `${placeName(row.countryCode, row.regionCode)}: ${row.orders} orders, ${row.units} units, ${money(row.revenue)} comparable net sales`;
            return (
              <circle
                key={`${row.countryCode}:${row.regionCode}`}
                cx={point[0]}
                cy={point[1]}
                r={radius}
                tabIndex={0}
                role="listitem"
                aria-label={label}
              >
                <title>{label}</title>
              </circle>
            );
          })}
        </g>
      </svg>
      <div className="map-legend">
        <span className="map-shade" aria-hidden="true" /> Darker countries have more orders{" "}
        <span className="map-pin" aria-hidden="true" /> Larger pins have more regional orders · approximate centroids
      </div>
    </>
  );
}
function CountryList({
  countries,
  money
}: {
  countries: SalesDashboardPayload["countries"];
  money: (value: number) => string;
}) {
  return (
    <div className="country-list">
      {countries.map((row) => (
        <div key={row.countryCode}>
          <strong>{placeName(row.countryCode, "")}</strong>
          <span>{row.orders} orders</span>
          <span>{money(row.revenue)}</span>
        </div>
      ))}
    </div>
  );
}
function MarketplacePerformance({
  rows,
  money
}: {
  rows: SalesDashboardPayload["platforms"];
  money: (value: number) => string;
}) {
  return (
    <div className="marketplace-performance">
      {rows.map((row) => (
        <article key={row.platform}>
          <header>
            <span className="sales-platform-badge">{platformLabels[row.platform]}</span>
            <strong>{money(row.revenue)}</strong>
          </header>
          <div>
            <span>
              <strong>{row.orders}</strong>
              Orders
            </span>
            <span>
              <strong>{row.units}</strong>
              Units
            </span>
          </div>
        </article>
      ))}
    </div>
  );
}
function OrderStatus({ order }: { order: SalesOrder }) {
  const status = order.status.toLowerCase();
  const canceled = Boolean(order.canceledAt) || status.includes("cancel");
  const refunded = status.includes("refund");
  const paid = status.includes("paid") || status.includes("complete");
  const fulfilled = status.includes("fulfilled") && !status.includes("unfulfilled") && !status.includes("not_started");
  const label = canceled
    ? "Canceled"
    : refunded
      ? "Refunded"
      : paid && fulfilled
        ? "Paid · Fulfilled"
        : paid
          ? "Paid"
          : fulfilled
            ? "Fulfilled"
            : "Open";
  const tone = canceled ? "danger" : refunded ? "warn" : paid ? "ok" : "";
  return <span className={`sales-status-badge ${tone}`}>{label}</span>;
}
function ProductTable({ rows, money }: { rows: SalesDashboardPayload["products"]; money: (value: number) => string }) {
  return (
    <div className="sales-table-wrap compact">
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Units</th>
            <th>Revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.sku}:${row.title}`}>
              <td>
                <div className="product-with-thumbnail">
                  {row.imageUrl ? (
                    <img className="product-thumbnail" src={row.imageUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="product-thumbnail placeholder" aria-hidden="true" />
                  )}
                  <span>
                    <strong className="top-product-name">{row.title || "Unnamed product"}</strong>
                    <small>{row.sku || "Unmatched historical item"}</small>
                  </span>
                </div>
              </td>
              <td>{row.units}</td>
              <td>{money(row.revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length ? <p className="empty">No product sales yet.</p> : null}
    </div>
  );
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}
function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      }).format(date);
}
function todayInputValue() {
  return localDateInputValue(new Date());
}
function firstDayOfCurrentMonth() {
  const date = new Date();
  date.setDate(1);
  return localDateInputValue(date);
}
function localDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
