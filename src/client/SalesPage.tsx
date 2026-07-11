import { useEffect, useState } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { numericToAlpha2 } from "i18n-iso-countries";
import { BarChart3, Globe2, PackageOpen, RefreshCw, ShoppingCart, TrendingUp } from "lucide-react";
import { feature } from "topojson-client";
import type { FeatureCollection, Geometry } from "geojson";
import world from "world-atlas/countries-110m.json";
import { api } from "./api";
import { Metric, Panel } from "./ui";
import type { Platform, SalesDashboardPayload } from "../shared/types";
import { platformLabels } from "../shared/types";

const empty: SalesDashboardPayload = {
  generatedAt: "",
  lastPulledAt: null,
  range: "90d",
  platform: "all",
  summary: { revenue: 0, orders: 0, units: 0, averageOrderValue: 0, currency: "USD" },
  ebayFinancials: null,
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void load();
  }, [range, platform]);
  async function load() {
    try {
      setError("");
      setData(await api.sales(range, platform));
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
  const money = (value: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: data.summary.currency,
      maximumFractionDigits: 0
    }).format(value);

  return (
    <div className="sales-page">
      <section className="sales-toolbar">
        <div className="sales-filters">
          <label>
            Period
            <select value={range} onChange={(event) => setRange(event.target.value)}>
              <option value="30d">30 days</option>
              <option value="90d">90 days</option>
              <option value="365d">1 year</option>
              <option value="all">All saved</option>
            </select>
          </label>
          <label>
            Platform
            <select value={platform} onChange={(event) => setPlatform(event.target.value as Platform | "all")}>
              <option value="all">All platforms</option>
              <option value="shopify">Shopify</option>
              <option value="ebay">eBay</option>
              <option value="etsy">Etsy</option>
            </select>
          </label>
        </div>
        <button className="icon-button primary" type="button" onClick={refresh} disabled={busy}>
          <RefreshCw size={17} className={busy ? "spin" : ""} />
          {busy ? "Pulling sales" : "Pull sales"}
        </button>
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
      {data.ebayFinancials ? (
        <Panel title="eBay financials" icon={<BarChart3 size={17} />}>
          <section className="sales-metrics ebay-financial-metrics">
            <Metric label="Gross eBay sales" value={money(data.ebayFinancials.grossSales)} />
            <Metric label="eBay fees" value={money(data.ebayFinancials.fees)} tone="warn" />
            <Metric label="Refunds" value={money(data.ebayFinancials.refunds)} tone="warn" />
            <Metric label="Shipping labels" value={money(data.ebayFinancials.shippingLabels)} />
            <Metric label="Net proceeds" value={money(data.ebayFinancials.netProceeds)} />
          </section>
        </Panel>
      ) : null}
      <section className="sales-primary-grid">
        <Panel title="Sales trend" icon={<TrendingUp size={17} />}>
          <TrendChart data={data.trend} money={money} />
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
      <section className="sales-secondary-grid">
        <Panel title="Marketplace mix" icon={<BarChart3 size={17} />}>
          <PlatformMix rows={data.platforms} money={money} />
        </Panel>
        <Panel title="Top products" icon={<PackageOpen size={17} />}>
          <ProductTable rows={data.products.slice(0, 10)} money={money} />
        </Panel>
      </section>
      <Panel title="Recent orders" icon={<ShoppingCart size={17} />}>
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
                  <td>{platformLabels[order.platform]}</td>
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
                  <td>{order.status}</td>
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

function TrendChart({ data, money }: { data: SalesDashboardPayload["trend"]; money: (value: number) => string }) {
  const values = data.slice(-45);
  const max = Math.max(1, ...values.map((row) => row.revenue));
  if (!values.length) return <p className="empty">No sales in this period.</p>;
  return (
    <div className="trend-chart" aria-label="Daily sales revenue chart">
      {values.map((row) => (
        <div
          className="trend-bar"
          key={row.date}
          title={`${formatDate(row.date)} · ${money(row.revenue)} · ${row.orders} orders`}
        >
          <span style={{ height: `${Math.max(3, (row.revenue / max) * 100)}%` }} />
        </div>
      ))}
    </div>
  );
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
function PlatformMix({ rows, money }: { rows: SalesDashboardPayload["platforms"]; money: (value: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.revenue));
  return (
    <div className="platform-mix">
      {rows.map((row) => (
        <div key={row.platform}>
          <div>
            <strong>{platformLabels[row.platform]}</strong>
            <span>
              {row.orders} orders · {money(row.revenue)}
            </span>
          </div>
          <progress max={max} value={row.revenue} />
        </div>
      ))}
    </div>
  );
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
