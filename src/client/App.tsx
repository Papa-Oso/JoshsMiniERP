import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Box,
  Clock3,
  Link2,
  Minus,
  Play,
  Plus,
  RefreshCw,
  Save,
  SlidersHorizontal
} from "lucide-react";
import { api } from "./api";
import type { DashboardPayload, InventoryItem, Platform, PlatformMapping } from "../shared/types";
import { platformLabels, platforms } from "../shared/types";

const emptyDashboard: DashboardPayload = {
  items: [],
  events: [],
  syncRuns: [],
  schedule: {
    enabled: false,
    intervalMinutes: 60,
    lastRunAt: null,
    nextRunAt: null,
    updatedAt: new Date().toISOString()
  },
  platformStatuses: []
};

type AdjustMode = "add" | "subtract";

export function App() {
  const [dashboard, setDashboard] = useState<DashboardPayload>(emptyDashboard);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newItem, setNewItem] = useState({ sku: "", name: "", quantity: 0 });
  const [adjustment, setAdjustment] = useState({ mode: "add" as AdjustMode, quantity: 1, note: "" });
  const [safetyFloor, setSafetyFloor] = useState(0);
  const [schedule, setSchedule] = useState({ enabled: false, intervalMinutes: 60 });
  const [mappingDraft, setMappingDraft] = useState<Partial<Record<Platform, PlatformMapping>>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const selectedItem = useMemo(
    () => dashboard.items.find((item) => item.id === selectedId) ?? dashboard.items[0],
    [dashboard.items, selectedId]
  );

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    setSchedule({
      enabled: dashboard.schedule.enabled,
      intervalMinutes: dashboard.schedule.intervalMinutes
    });
  }, [dashboard.schedule.enabled, dashboard.schedule.intervalMinutes]);

  useEffect(() => {
    if (!selectedItem) {
      setMappingDraft({});
      return;
    }
    setSelectedId(selectedItem.id);
    setMappingDraft(selectedItem.mappings);
  }, [selectedItem?.id]);

  useEffect(() => {
    setSafetyFloor(selectedItem?.safetyStock ?? 0);
  }, [selectedItem?.id, selectedItem?.safetyStock]);

  async function load() {
    const data = await api.dashboard();
    setDashboard(data);
  }

  async function runAction(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      await action();
      await load();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    await runAction(
      () => api.createItem({ ...newItem, quantity: Number(newItem.quantity) }),
      "Item saved."
    );
    setNewItem({ sku: "", name: "", quantity: 0 });
  }

  async function handleAdjust() {
    if (!selectedItem) return;
    const units = Number(adjustment.quantity);
    const delta = adjustment.mode === "add" ? units : -units;
    await runAction(
      () =>
        api.adjustInventory(selectedItem.id, {
          delta,
          type: adjustment.mode === "add" ? "batch_add" : "manual_subtract",
          note: adjustment.note
        }),
      "Inventory adjusted."
    );
    setAdjustment({ mode: adjustment.mode, quantity: 1, note: "" });
  }

  async function handleScheduleSave() {
    await runAction(
      () =>
        api.updateSchedule({
          enabled: schedule.enabled,
          intervalMinutes: Number(schedule.intervalMinutes)
        }),
      "Schedule saved."
    );
  }

  async function handleSync() {
    await runAction(() => api.runSync(), "Sync finished.");
  }

  async function handleSafetyStockSave() {
    if (!selectedItem) return;
    await runAction(
      () => api.updateItem(selectedItem.id, { safetyStock: Number(safetyFloor) }),
      "Safety floor saved."
    );
  }

  async function handleMappingSave() {
    if (!selectedItem) return;
    await runAction(() => api.updateItem(selectedItem.id, { mappings: mappingDraft }), "Mappings saved.");
  }

  function updateMapping(platform: Platform, patch: Partial<PlatformMapping>) {
    setMappingDraft((current) => ({
      ...current,
      [platform]: {
        enabled: false,
        ...(current[platform] ?? {}),
        ...patch
      }
    }));
  }

  const latestRun = dashboard.syncRuns[0];
  const stockTotal = dashboard.items.reduce((sum, item) => sum + item.quantity, 0);
  const lowStockItems = useMemo(
    () => dashboard.items.filter(isLowStock).sort(sortByStockRisk),
    [dashboard.items]
  );
  const stockWatchItems = useMemo(
    () => [...dashboard.items].sort(sortByStockRisk).slice(0, 5),
    [dashboard.items]
  );
  const lowStock = lowStockItems.length;
  const maxQuantity = Math.max(1, ...dashboard.items.map((item) => item.quantity));

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Josh's Mini ERP</p>
          <h1>Inventory Sync</h1>
        </div>
        <div className="status-strip">
          <Metric label="SKUs" value={dashboard.items.length} />
          <Metric label="Global Units" value={stockTotal} />
          <Metric label="Below Floor" value={lowStock} tone={lowStock ? "warn" : "ok"} />
        </div>
      </section>

      <section className="grid">
        <Panel title="Inventory" icon={<Box size={18} />}>
          <div className="inline-form create-form">
            <input
              aria-label="SKU"
              placeholder="SKU"
              value={newItem.sku}
              onChange={(event) => setNewItem({ ...newItem, sku: event.target.value })}
            />
            <input
              aria-label="Name"
              placeholder="Name"
              value={newItem.name}
              onChange={(event) => setNewItem({ ...newItem, name: event.target.value })}
            />
            <input
              aria-label="Initial quantity"
              type="number"
              min="0"
              value={newItem.quantity}
              onChange={(event) => setNewItem({ ...newItem, quantity: Number(event.target.value) })}
            />
            <button className="icon-button primary" type="button" disabled={busy} onClick={handleCreate}>
              <Plus size={18} />
              Add SKU
            </button>
          </div>

          <div className="stock-overview">
            <div className="stock-overview-total">
              <span>Global On Hand</span>
              <strong>{stockTotal}</strong>
              <small>{lowStock ? `${lowStock} below floor` : "All above floor"}</small>
            </div>
            <div className="stock-watch">
              <div className="stock-watch-header">
                <span>Lowest Stock</span>
                <strong>{stockWatchItems.length ? `${stockWatchItems[0].quantity} min` : "-"}</strong>
              </div>
              {stockWatchItems.map((item) => (
                <StockLevelRow
                  key={item.id}
                  item={item}
                  maxQuantity={maxQuantity}
                  selected={item.id === selectedItem?.id}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
              {stockWatchItems.length === 0 ? <div className="empty compact-empty">No SKUs</div> : null}
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Item</th>
                  <th>Global Stock</th>
                  <th>Floor</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.items.map((item) => (
                  <tr
                    key={item.id}
                    className={item.id === selectedItem?.id ? "selected" : ""}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <td>{item.sku}</td>
                    <td>
                      <div className="item-name">{item.name}</div>
                      {item.description ? <div className="item-description">{item.description}</div> : null}
                    </td>
                    <td>
                      <StockCell item={item} maxQuantity={maxQuantity} />
                    </td>
                    <td>{item.safetyStock}</td>
                  </tr>
                ))}
                {dashboard.items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty">
                      No SKUs
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Stock Control" icon={<SlidersHorizontal size={18} />}>
          <div className="selected-sku">
            <span>{selectedItem?.sku ?? "No SKU"}</span>
            <strong className={selectedItem ? stockTone(selectedItem) : ""}>{selectedItem?.quantity ?? 0}</strong>
          </div>

          <div className="selected-stock-meta">
            <div>
              <span>Global</span>
              <strong>{selectedItem?.quantity ?? 0}</strong>
            </div>
            <div>
              <span>Floor</span>
              <strong>{selectedItem?.safetyStock ?? 0}</strong>
            </div>
            <div>
              <span>Status</span>
              <strong className={selectedItem ? stockTone(selectedItem) : ""}>
                {selectedItem ? stockStatusLabel(selectedItem) : "-"}
              </strong>
            </div>
          </div>

          <label>
            Safety Floor
            <input
              type="number"
              min="0"
              value={safetyFloor}
              onChange={(event) => setSafetyFloor(Math.max(0, Number(event.target.value)))}
            />
          </label>
          <button
            className="icon-button full safety-button"
            type="button"
            disabled={!selectedItem || busy}
            onClick={handleSafetyStockSave}
          >
            <Save size={18} />
            Set Floor
          </button>

          <div className="segmented">
            <button
              className={adjustment.mode === "add" ? "active" : ""}
              type="button"
              onClick={() => setAdjustment({ ...adjustment, mode: "add" })}
            >
              <Plus size={17} />
              Add
            </button>
            <button
              className={adjustment.mode === "subtract" ? "active" : ""}
              type="button"
              onClick={() => setAdjustment({ ...adjustment, mode: "subtract" })}
            >
              <Minus size={17} />
              Subtract
            </button>
          </div>

          <label>
            Units
            <input
              type="number"
              min="1"
              value={adjustment.quantity}
              onChange={(event) => setAdjustment({ ...adjustment, quantity: Number(event.target.value) })}
            />
          </label>
          <label>
            Note
            <input
              value={adjustment.note}
              placeholder={adjustment.mode === "add" ? "restock batch" : "discard, personal use"}
              onChange={(event) => setAdjustment({ ...adjustment, note: event.target.value })}
            />
          </label>
          <button className="icon-button primary full" type="button" disabled={!selectedItem || busy} onClick={handleAdjust}>
            <Save size={18} />
            Apply
          </button>
        </Panel>

        <Panel title="Schedule" icon={<Clock3 size={18} />}>
          <label className="switch-row">
            <span>Enabled</span>
            <input
              type="checkbox"
              checked={schedule.enabled}
              onChange={(event) => setSchedule({ ...schedule, enabled: event.target.checked })}
            />
          </label>
          <label>
            Minutes
            <input
              type="number"
              min="5"
              max="1440"
              value={schedule.intervalMinutes}
              onChange={(event) => setSchedule({ ...schedule, intervalMinutes: Number(event.target.value) })}
            />
          </label>
          <div className="schedule-meta">
            <span>Last</span>
            <strong>{formatDate(dashboard.schedule.lastRunAt)}</strong>
            <span>Next</span>
            <strong>{formatDate(dashboard.schedule.nextRunAt)}</strong>
          </div>
          <div className="button-row">
            <button className="icon-button" type="button" disabled={busy} onClick={handleScheduleSave}>
              <Save size={18} />
              Save
            </button>
            <button className="icon-button primary" type="button" disabled={busy} onClick={handleSync}>
              {busy ? <RefreshCw className="spin" size={18} /> : <Play size={18} />}
              Run
            </button>
          </div>
        </Panel>

        <Panel title="Stores" icon={<Activity size={18} />}>
          <div className="platform-list">
            {dashboard.platformStatuses.map((status) => (
              <div className="platform-status" key={status.platform}>
                <div className="platform-status-copy">
                  <span>{status.label}</span>
                  {!status.configured && status.missing.length ? <small>{status.missing.join(", ")}</small> : null}
                </div>
                <strong className={status.configured ? "ok" : "warn"}>
                  {status.configured ? "Ready" : "Needs keys"}
                </strong>
              </div>
            ))}
          </div>
          <div className="latest-run">
            <span>Latest Run</span>
            <strong>{latestRun ? latestRun.status.replaceAll("_", " ") : "None"}</strong>
          </div>
          {latestRun ? (
            <>
              <div className="sync-summary">
                <MiniStat label="Sales" value={latestRun.summary.salesDetected} />
                <MiniStat label="Pushes" value={latestRun.summary.pushes} />
                <MiniStat label="Issues" value={latestRun.summary.errors + latestRun.summary.warnings} />
              </div>
              <div className="run-messages">
                {latestRun.messages.slice(0, 4).map((message) => (
                  <p className="run-message" key={message}>
                    {message}
                  </p>
                ))}
              </div>
            </>
          ) : null}
          {notice ? <p className="notice">{notice}</p> : null}
        </Panel>
      </section>

      <section className="lower-grid">
        <Panel title="Mappings" icon={<Link2 size={18} />}>
          {selectedItem ? (
            <div className="mapping-grid">
              {platforms.map((platform) => (
                <MappingFields
                  key={platform}
                  platform={platform}
                  mapping={mappingDraft[platform] ?? { enabled: false }}
                  onChange={(patch) => updateMapping(platform, patch)}
                />
              ))}
              <button className="icon-button primary mapping-save" type="button" disabled={busy} onClick={handleMappingSave}>
                <Save size={18} />
                Save Mappings
              </button>
            </div>
          ) : (
            <div className="empty">No SKU selected</div>
          )}
        </Panel>

        <Panel title="Activity" icon={<Activity size={18} />}>
          <div className="activity-list">
            {dashboard.events.slice(0, 12).map((event) => (
              <div className="activity-row" key={event.id}>
                <span>{event.sku}</span>
                <strong className={event.delta < 0 ? "danger" : event.delta > 0 ? "ok" : ""}>
                  {event.delta > 0 ? `+${event.delta}` : event.delta}
                </strong>
                <span>{event.note ?? event.type.replaceAll("_", " ")}</span>
                <time>{formatDate(event.createdAt)}</time>
              </div>
            ))}
            {dashboard.events.length === 0 ? <div className="empty">No activity</div> : null}
          </div>
        </Panel>
      </section>
    </main>
  );
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-header">
        <span>{icon}</span>
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="mini-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StockLevelRow({
  item,
  maxQuantity,
  selected,
  onSelect
}: {
  item: InventoryItem;
  maxQuantity: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`stock-level-row ${stockTone(item)} ${selected ? "selected" : ""}`}
      type="button"
      onClick={onSelect}
    >
      <div className="stock-level-name">
        <strong>{item.name}</strong>
        <span>{item.sku}</span>
        <div className="stock-bar">
          <span className="stock-fill" style={{ width: stockPercent(item.quantity, maxQuantity) }} />
        </div>
      </div>
      <strong className="stock-level-count">{item.quantity}</strong>
      <span className={`stock-status ${stockTone(item)}`}>{stockStatusLabel(item)}</span>
    </button>
  );
}

function StockCell({ item, maxQuantity }: { item: InventoryItem; maxQuantity: number }) {
  return (
    <div className={`stock-cell ${stockTone(item)}`}>
      <div className="stock-cell-top">
        <strong>{item.quantity}</strong>
        <span>{stockStatusLabel(item)}</span>
      </div>
      <div className="stock-bar">
        <span className="stock-fill" style={{ width: stockPercent(item.quantity, maxQuantity) }} />
      </div>
    </div>
  );
}

function MappingFields({
  platform,
  mapping,
  onChange
}: {
  platform: Platform;
  mapping: PlatformMapping;
  onChange: (patch: Partial<PlatformMapping>) => void;
}) {
  return (
    <fieldset className="mapping-block">
      <legend>{platformLabels[platform]}</legend>
      <label className="switch-row">
        <span>Enabled</span>
        <input
          type="checkbox"
          checked={mapping.enabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
        />
      </label>
      {platform !== "shopify" ? (
        <label>
          SKU
          <input value={mapping.remoteSku ?? ""} onChange={(event) => onChange({ remoteSku: event.target.value })} />
        </label>
      ) : null}
      {platform === "etsy" ? (
        <label>
          Listing ID
          <input value={mapping.listingId ?? ""} onChange={(event) => onChange({ listingId: event.target.value })} />
        </label>
      ) : null}
      {platform === "ebay" ? (
        <label>
          Offer ID
          <input value={mapping.offerId ?? ""} onChange={(event) => onChange({ offerId: event.target.value })} />
        </label>
      ) : null}
      {platform === "shopify" ? (
        <>
          <label>
            Inventory Item ID/GID
            <input
              value={mapping.inventoryItemId ?? ""}
              onChange={(event) => onChange({ inventoryItemId: event.target.value })}
            />
          </label>
          <label>
            Location ID/GID
            <input value={mapping.locationId ?? ""} onChange={(event) => onChange({ locationId: event.target.value })} />
          </label>
        </>
      ) : null}
      {mapping.enabled ? (
        <div className="mapping-meta">
          <div>
            <span>Remote</span>
            <strong>{formatOptionalNumber(mapping.lastRemoteQuantity)}</strong>
          </div>
          <div>
            <span>Synced</span>
            <strong>{formatOptionalNumber(mapping.lastSyncedQuantity)}</strong>
          </div>
          <div>
            <span>At</span>
            <strong>{formatDate(mapping.lastSyncedAt)}</strong>
          </div>
        </div>
      ) : null}
      {mapping.warning ? <p className="mapping-warning">{mapping.warning}</p> : null}
    </fieldset>
  );
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatOptionalNumber(value?: number | null) {
  return typeof value === "number" ? String(value) : "-";
}

function isLowStock(item: InventoryItem) {
  return item.quantity <= item.safetyStock;
}

function stockTone(item: InventoryItem) {
  if (isLowStock(item)) return "low";
  if (item.safetyStock > 0 && item.quantity <= item.safetyStock + Math.max(3, Math.ceil(item.safetyStock * 0.25))) {
    return "watch";
  }
  return "ok";
}

function stockStatusLabel(item: InventoryItem) {
  const tone = stockTone(item);
  if (tone === "low") return "Low";
  if (tone === "watch") return "Watch";
  return "OK";
}

function stockPercent(quantity: number, maxQuantity: number) {
  if (quantity <= 0) return "0%";
  return `${Math.max(6, Math.round((quantity / maxQuantity) * 100))}%`;
}

function sortByStockRisk(left: InventoryItem, right: InventoryItem) {
  return left.quantity - left.safetyStock - (right.quantity - right.safetyStock) || left.sku.localeCompare(right.sku);
}
