import { useEffect, useState } from "react";
import { BarChart3, Globe2, PackageOpen, RefreshCw, ShoppingCart, TrendingUp } from "lucide-react";
import { api } from "./api";
import { Metric, Panel } from "./ui";
import type { Platform, SalesDashboardPayload } from "../shared/types";
import { platformLabels } from "../shared/types";

const empty: SalesDashboardPayload = {
  generatedAt: "", lastPulledAt: null, range: "90d", platform: "all",
  summary: { revenue: 0, orders: 0, units: 0, averageOrderValue: 0, currency: "USD" },
  trend: [], platforms: [], countries: [], products: [], recentOrders: [], coverage: [], warnings: []
};

export function SalesPage() {
  const [data, setData] = useState(empty);
  const [range, setRange] = useState("90d");
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { void load(); }, [range, platform]);
  async function load() {
    try { setError(""); setData(await api.sales(range, platform)); }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
  }
  async function refresh() {
    try {
      setBusy(true); setError("");
      const result = await api.refreshSales();
      const failures = result.results.filter((row) => !row.ok);
      if (failures.length) setError(failures.map((row) => `${platformLabels[row.platform]}: ${row.message}`).join(" | "));
      await load();
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
    finally { setBusy(false); }
  }
  const money = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: data.summary.currency, maximumFractionDigits: 0 }).format(value);

  return (
    <div className="sales-page">
      <section className="sales-toolbar">
        <div className="sales-filters">
          <label>Period<select value={range} onChange={(event) => setRange(event.target.value)}><option value="30d">30 days</option><option value="90d">90 days</option><option value="365d">1 year</option><option value="all">All saved</option></select></label>
          <label>Platform<select value={platform} onChange={(event) => setPlatform(event.target.value as Platform | "all")}><option value="all">All platforms</option><option value="shopify">Shopify</option><option value="ebay">eBay</option><option value="etsy">Etsy</option></select></label>
        </div>
        <button className="icon-button primary" type="button" onClick={refresh} disabled={busy}><RefreshCw size={17} className={busy ? "spin" : ""} />{busy ? "Pulling sales" : "Pull sales"}</button>
      </section>
      {error ? <p className="notice danger">{error}</p> : null}
      {data.warnings.map((warning) => <p className="notice warn" key={warning}>{warning}</p>)}
      <section className="sales-metrics">
        <Metric label="Revenue" value={money(data.summary.revenue)} />
        <Metric label="Orders" value={data.summary.orders} />
        <Metric label="Units sold" value={data.summary.units} />
        <Metric label="Average order" value={money(data.summary.averageOrderValue)} />
      </section>
      <section className="sales-primary-grid">
        <Panel title="Sales trend" icon={<TrendingUp size={17} />}><TrendChart data={data.trend} money={money} /></Panel>
        <Panel title="Sales around the world" icon={<Globe2 size={17} />}><WorldSalesMap countries={data.countries} /><CountryList countries={data.countries.slice(0, 6)} money={money} /></Panel>
      </section>
      <section className="sales-secondary-grid">
        <Panel title="Marketplace mix" icon={<BarChart3 size={17} />}><PlatformMix rows={data.platforms} money={money} /></Panel>
        <Panel title="Top products" icon={<PackageOpen size={17} />}><ProductTable rows={data.products.slice(0, 10)} money={money} /></Panel>
      </section>
      <Panel title="Recent orders" icon={<ShoppingCart size={17} />}>
        <div className="sales-table-wrap"><table><thead><tr><th>Date</th><th>Platform</th><th>Order</th><th>Destination</th><th>Units</th><th>Total</th><th>Status</th></tr></thead><tbody>
          {data.recentOrders.map((order) => <tr key={`${order.platform}:${order.orderId}`}><td>{formatDate(order.createdAt)}</td><td>{platformLabels[order.platform]}</td><td>{order.sourceUrl ? <a href={order.sourceUrl} target="_blank" rel="noreferrer">{order.orderNumber}</a> : order.orderNumber}</td><td>{order.countryCode || "Unknown"}</td><td>{order.itemCount}</td><td>{money(order.grossAmount)}</td><td>{order.status}</td></tr>)}
        </tbody></table>{!data.recentOrders.length ? <p className="empty">Pull sales to build the dashboard.</p> : null}</div>
      </Panel>
      <p className="sales-footnote">Geography is stored only as country and region. Customer names, emails, street addresses, phones, and postal codes are not retained.</p>
    </div>
  );
}

function TrendChart({ data, money }: { data: SalesDashboardPayload["trend"]; money: (value: number) => string }) {
  const values = data.slice(-45); const max = Math.max(1, ...values.map((row) => row.revenue));
  if (!values.length) return <p className="empty">No sales in this period.</p>;
  return <div className="trend-chart" aria-label="Daily sales revenue chart">{values.map((row) => <div className="trend-bar" key={row.date} title={`${formatDate(row.date)} · ${money(row.revenue)} · ${row.orders} orders`}><span style={{ height: `${Math.max(3, row.revenue / max * 100)}%` }} /></div>)}</div>;
}

const countryPoints: Record<string, [number, number]> = { US:[108,80],CA:[102,53],MX:[92,103],BR:[143,142],AR:[137,174],GB:[184,56],FR:[190,70],DE:[198,62],ES:[183,79],IT:[202,80],NL:[193,58],SE:[204,43],NO:[195,40],PL:[211,62],UA:[226,65],TR:[226,83],ZA:[211,164],EG:[218,101],NG:[194,123],KE:[224,132],IN:[266,106],CN:[294,88],JP:[337,88],KR:[326,89],AU:[318,159],NZ:[353,176],SG:[288,135],PH:[318,125],ID:[303,143],TH:[289,122],AE:[245,104],SA:[235,107],IL:[225,96],RU:[257,48] };
function WorldSalesMap({ countries }: { countries: SalesDashboardPayload["countries"] }) {
  const max = Math.max(1, ...countries.map((row) => row.orders));
  return <svg className="world-map" viewBox="0 0 380 200" role="img" aria-label="World map of sales by country">
    <g className="world-land"><path d="M20 48 48 25 92 22 126 39 122 68 99 77 87 112 61 103 48 76 24 69Z"/><path d="M103 111 139 105 156 126 146 181 128 190 118 153Z"/><path d="M169 45 205 35 232 52 229 76 245 92 229 112 215 104 205 86 183 87 170 69Z"/><path d="M188 92 222 91 245 117 231 177 205 181 190 140Z"/><path d="M228 51 286 33 350 54 358 91 329 110 317 139 281 139 255 111 242 83Z"/><path d="M298 148 340 143 359 166 343 190 307 184Z"/></g>
    {countries.map((row) => { const point = countryPoints[row.countryCode]; if (!point) return null; const radius = 3 + Math.sqrt(row.orders / max) * 9; return <circle key={row.countryCode} cx={point[0]} cy={point[1]} r={radius}><title>{row.countryCode}: {row.orders} orders</title></circle>; })}
  </svg>;
}
function CountryList({ countries, money }: { countries: SalesDashboardPayload["countries"]; money:(value:number)=>string }) { return <div className="country-list">{countries.map((row) => <div key={row.countryCode}><strong>{row.countryCode}</strong><span>{row.orders} orders</span><span>{money(row.revenue)}</span></div>)}</div>; }
function PlatformMix({ rows, money }: { rows: SalesDashboardPayload["platforms"]; money:(value:number)=>string }) { const max=Math.max(1,...rows.map(r=>r.revenue)); return <div className="platform-mix">{rows.map(row=><div key={row.platform}><div><strong>{platformLabels[row.platform]}</strong><span>{row.orders} orders · {money(row.revenue)}</span></div><progress max={max} value={row.revenue}/></div>)}</div>; }
function ProductTable({ rows, money }: { rows: SalesDashboardPayload["products"]; money:(value:number)=>string }) { return <div className="sales-table-wrap compact"><table><thead><tr><th>Product</th><th>Units</th><th>Revenue</th></tr></thead><tbody>{rows.map(row=><tr key={`${row.sku}:${row.title}`}><td><strong>{row.sku || "No SKU"}</strong><small>{row.title}</small></td><td>{row.units}</td><td>{money(row.revenue)}</td></tr>)}</tbody></table>{!rows.length?<p className="empty">No product sales yet.</p>:null}</div>; }
function formatDate(value:string){ const date=new Date(value); return Number.isNaN(date.valueOf())?value:new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",year:"numeric"}).format(date); }
