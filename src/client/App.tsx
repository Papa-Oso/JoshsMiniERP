import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Box,
  Clock3,
  FileSpreadsheet,
  Menu,
  Minus,
  PackagePlus,
  Play,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  X,
  type LucideIcon
} from "lucide-react";
import { api } from "./api";
import { EbayReviewsPage } from "./EbayReviewsPage";
import { ItemManagementPage } from "./ItemManagementPage";
import { PrintingPage } from "./PrintingPage";
import type { DashboardPayload, InventoryItem, Platform, PlatformMapping } from "../shared/types";
import { defaultMaxInventory, platformLabels, platforms } from "../shared/types";

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
type AppPage = "inventory" | "items" | "ebayReviews" | "printing";
type SortField = "sku" | "name" | "quantity" | "lowAlert" | "status";
type SortDirection = "asc" | "desc";

const tools: Array<{
  id: AppPage;
  label: string;
  group: string;
  icon: LucideIcon;
}> = [
  { id: "inventory", label: "Inventory", group: "Core", icon: Box },
  { id: "items", label: "Item Management", group: "Core", icon: PackagePlus },
  { id: "printing", label: "Printing", group: "Fulfillment", icon: Printer },
  { id: "ebayReviews", label: "eBay Reviews", group: "Marketplaces", icon: FileSpreadsheet }
];

export function App() {
  const [page, setPage] = useState<AppPage>("inventory");
  const [toolSwitcherOpen, setToolSwitcherOpen] = useState(false);
  const [toolSearch, setToolSearch] = useState("");
  const [dashboard, setDashboard] = useState<DashboardPayload>(emptyDashboard);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adjustment, setAdjustment] = useState({ mode: "add" as AdjustMode, quantity: 1, note: "" });
  const [lowAlert, setLowAlert] = useState(0);
  const [sortField, setSortField] = useState<SortField>("sku");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [storeSettingsOpen, setStoreSettingsOpen] = useState(false);
  const [printSettingsOpen, setPrintSettingsOpen] = useState(false);
  const [schedule, setSchedule] = useState({ enabled: false, intervalMinutes: 60 });
  const [mappingDraft, setMappingDraft] = useState<Partial<Record<Platform, PlatformMapping>>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const activeItems = useMemo(
    () => dashboard.items.filter((item) => item.active !== false),
    [dashboard.items]
  );
  const activeDashboard = useMemo(
    () => ({ ...dashboard, items: activeItems }),
    [activeItems, dashboard]
  );
  const selectedItem = useMemo(
    () => activeItems.find((item) => item.id === selectedId) ?? activeItems[0],
    [activeItems, selectedId]
  );

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!toolSwitcherOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setToolSwitcherOpen(false);
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [toolSwitcherOpen]);

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
    setLowAlert(selectedItem?.safetyStock ?? 0);
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

  async function handleLowAlertCommit() {
    if (!selectedItem || busy) return;
    const nextLowAlert = Math.max(0, Math.trunc(Number(lowAlert) || 0));
    if (nextLowAlert === selectedItem.safetyStock) {
      setLowAlert(selectedItem.safetyStock);
      return;
    }
    setLowAlert(nextLowAlert);
    await runAction(
      () => api.updateItem(selectedItem.id, { safetyStock: nextLowAlert }),
      "Low alert saved."
    );
  }

  async function handleMappingSave() {
    if (!selectedItem) return;
    await runAction(() => api.updateItem(selectedItem.id, { mappings: mappingDraft }), "Store links saved.");
  }

  function handleSort(nextField: SortField) {
    if (sortField === nextField) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
      return;
    }
    setSortField(nextField);
    setSortDirection("asc");
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
  const stockTotal = activeItems.reduce((sum, item) => sum + item.quantity, 0);
  const lowStock = activeItems.filter(isLowStock).length;
  const readyStores = dashboard.platformStatuses.filter((status) => status.configured).length;
  const linkedStores = selectedItem
    ? platforms.filter((platform) => selectedItem.mappings[platform]?.enabled).length
    : 0;
  const sortedItems = useMemo(
    () => [...activeItems].sort((left, right) => compareInventoryItems(left, right, sortField, sortDirection)),
    [activeItems, sortDirection, sortField]
  );
  const activityEvents = useMemo(
    () =>
      dashboard.events
        .filter((event) => event.type !== "sync_push" && event.type !== "sync_baseline")
        .slice(0, 12),
    [dashboard.events]
  );
  const pageTitle =
    page === "inventory"
      ? "Inventory Sync"
      : page === "items"
        ? "Item Management"
        : page === "printing"
          ? "Printing"
          : "eBay Reviews";
  const visibleTools = useMemo(() => {
    const query = toolSearch.trim().toLowerCase();
    if (!query) return tools;
    return tools.filter((tool) => `${tool.label} ${tool.group}`.toLowerCase().includes(query));
  }, [toolSearch]);

  return (
    <main className="shell">
      <section className="topbar">
        <div className="topbar-title">
          <button className="icon-button tool-trigger" type="button" onClick={() => setToolSwitcherOpen(true)}>
            <Menu size={18} />
            Tools
          </button>
          <div>
            <p className="eyebrow">Josh's Mini ERP</p>
            <h1>{pageTitle}</h1>
          </div>
        </div>
        <div className="topbar-actions">
          {page === "inventory" ? (
            <>
              <div className="status-strip">
                <Metric label="SKUs" value={activeItems.length} />
                <Metric label="Global Units" value={stockTotal} />
                <Metric label="Low Alerts" value={lowStock} tone={lowStock ? "warn" : "ok"} />
              </div>
              <button
                className="icon-button settings-button"
                type="button"
                aria-label="Store settings"
                title="Store settings"
                onClick={() => setStoreSettingsOpen(true)}
              >
                <Settings size={18} />
              </button>
            </>
          ) : page === "items" ? (
            <div className="tool-summary">
              <span>Create + connect</span>
              <strong>SKU library</strong>
            </div>
          ) : page === "printing" ? (
            <>
              <div className="tool-summary">
                <span>Labels + Instructions</span>
                <strong>Packaging station</strong>
              </div>
              <button
                className="icon-button settings-button"
                type="button"
                aria-label="Print settings"
                aria-expanded={printSettingsOpen}
                title="Print settings"
                onClick={() => setPrintSettingsOpen(true)}
              >
                <Settings size={18} />
              </button>
            </>
          ) : (
            <div className="tool-summary">
              <span>Judge.me CSV</span>
              <strong>Local scan history</strong>
            </div>
          )}
        </div>
      </section>

      {toolSwitcherOpen ? (
        <div className="tool-drawer-backdrop" role="presentation" onMouseDown={() => setToolSwitcherOpen(false)}>
          <aside
            className="tool-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tool-drawer-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="tool-drawer-header">
              <div>
                <p className="eyebrow">Josh's Mini ERP</p>
                <h2 id="tool-drawer-title">Tools</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setToolSwitcherOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <label className="tool-search-field">
              <span>Search</span>
              <Search size={16} />
              <input
                autoFocus
                value={toolSearch}
                onChange={(event) => setToolSearch(event.target.value)}
                placeholder="Find page"
              />
            </label>
            <nav className="tool-drawer-list" aria-label="Tools">
              {visibleTools.map((tool) => {
                const Icon = tool.icon;
                return (
                  <button
                    key={tool.id}
                    className={`tool-drawer-item ${page === tool.id ? "active" : ""}`}
                    type="button"
                    onClick={() => {
                      setPage(tool.id);
                      setToolSearch("");
                      setToolSwitcherOpen(false);
                    }}
                  >
                    <span className="tool-drawer-icon">
                      <Icon size={20} />
                    </span>
                    <strong>{tool.label}</strong>
                    <span>{tool.group}</span>
                  </button>
                );
              })}
              {visibleTools.length === 0 ? <div className="tool-empty">No tools</div> : null}
            </nav>
          </aside>
        </div>
      ) : null}

      {page === "inventory" ? (
        <>
      <section className="grid">
        <Panel title="Inventory" icon={<Box size={18} />} className="inventory-panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortableTh
                    field="sku"
                    label="SKU"
                    activeField={sortField}
                    direction={sortDirection}
                    onSort={handleSort}
                  />
                  <SortableTh
                    field="name"
                    label="Item"
                    activeField={sortField}
                    direction={sortDirection}
                    onSort={handleSort}
                  />
                  <SortableTh
                    field="quantity"
                    label="Global Stock"
                    activeField={sortField}
                    direction={sortDirection}
                    onSort={handleSort}
                  />
                  <SortableTh
                    field="lowAlert"
                    label="Low At"
                    activeField={sortField}
                    direction={sortDirection}
                    onSort={handleSort}
                  />
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((item) => (
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
                      <StockCell item={item} />
                    </td>
                    <td>{item.safetyStock}</td>
                  </tr>
                ))}
                {activeItems.length === 0 ? (
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

        <Panel title="Stock Control" icon={<SlidersHorizontal size={18} />} className="stock-panel">
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
              <span>Low At</span>
              <strong>{selectedItem?.safetyStock ?? 0}</strong>
            </div>
            <div>
              <span>Max</span>
              <strong>{selectedItem ? itemMaxInventory(selectedItem) : defaultMaxInventory}</strong>
            </div>
            <div>
              <span>Status</span>
              <strong className={selectedItem ? stockTone(selectedItem) : ""}>
                {selectedItem ? stockStatusLabel(selectedItem) : "-"}
              </strong>
            </div>
          </div>

          <label>
            Low Alert
            <input
              type="number"
              min="0"
              value={lowAlert}
              onBlur={handleLowAlertCommit}
              onChange={(event) => setLowAlert(Math.max(0, Number(event.target.value)))}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>

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

        <Panel title="Schedule" icon={<Clock3 size={18} />} className="schedule-panel">
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

      </section>

      <section className="lower-grid">
        <Panel title="Activity" icon={<Activity size={18} />}>
          <div className="activity-list">
            {activityEvents.map((event) => (
              <div className="activity-row" key={event.id}>
                <span>{event.sku}</span>
                <strong className={event.delta < 0 ? "danger" : event.delta > 0 ? "ok" : ""}>
                  {event.delta > 0 ? `+${event.delta}` : event.delta}
                </strong>
                <span>{event.note ?? event.type.replaceAll("_", " ")}</span>
                <time>{formatDate(event.createdAt)}</time>
              </div>
            ))}
            {activityEvents.length === 0 ? <div className="empty">No activity</div> : null}
          </div>
        </Panel>
      </section>

      {storeSettingsOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setStoreSettingsOpen(false)}>
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="store-settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="settings-modal-header">
              <div>
                <h2 id="store-settings-title">Stores</h2>
                <p>
                  {readyStores}/{dashboard.platformStatuses.length} ready - {linkedStores}/{platforms.length} linked
                </p>
              </div>
              <button className="icon-button" type="button" onClick={() => setStoreSettingsOpen(false)}>
                <X size={18} />
              </button>
            </header>

            <div className="stores-body">
              <div className="store-links-section">
                <div className="section-label">
                  <span>{selectedItem?.sku ?? "No SKU"}</span>
                  <strong>Store Links</strong>
                </div>
                {selectedItem ? (
                  <div className="mapping-grid">
                    {platforms.map((platform) => (
                      <MappingFields
                        key={platform}
                        platform={platform}
                        mapping={mappingDraft[platform] ?? { enabled: false }}
                        configured={Boolean(
                          dashboard.platformStatuses.find((status) => status.platform === platform)?.configured
                        )}
                        onChange={(patch) => updateMapping(platform, patch)}
                      />
                    ))}
                    <button className="icon-button primary mapping-save" type="button" disabled={busy} onClick={handleMappingSave}>
                      <Save size={18} />
                      Save Store Links
                    </button>
                  </div>
                ) : (
                  <div className="empty">No SKU selected</div>
                )}
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
            </div>
          </section>
        </div>
      ) : null}
        </>
      ) : page === "items" ? (
        <ItemManagementPage dashboard={dashboard} onDashboardChange={load} />
      ) : page === "printing" ? (
        <PrintingPage
          dashboard={activeDashboard}
          printSettingsOpen={printSettingsOpen}
          onPrintSettingsClose={() => setPrintSettingsOpen(false)}
        />
      ) : (
        <EbayReviewsPage />
      )}
    </main>
  );
}

function Panel({
  title,
  icon,
  children,
  className
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className ?? ""}`}>
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

function StockCell({ item }: { item: InventoryItem }) {
  const maxInventory = itemMaxInventory(item);
  const overage = Math.max(0, item.quantity - maxInventory);

  return (
    <div className={`stock-cell ${stockTone(item)}`}>
      <div className="stock-cell-top">
        <strong>{item.quantity}</strong>
        <span>{stockStatusLabel(item)}</span>
      </div>
      <div className="stock-bar">
        <span className="stock-fill" style={{ width: stockPercent(item.quantity, maxInventory) }} />
      </div>
      <div className="stock-cell-scale">
        <span>Max {maxInventory}</span>
        {overage ? <span>+{overage}</span> : null}
      </div>
    </div>
  );
}

function SortableTh({
  field,
  label,
  activeField,
  direction,
  onSort
}: {
  field: SortField;
  label: string;
  activeField: SortField;
  direction: SortDirection;
  onSort: (field: SortField) => void;
}) {
  const active = field === activeField;
  return (
    <th>
      <button className={`sort-header ${active ? "active" : ""}`} type="button" onClick={() => onSort(field)}>
        <span>{label}</span>
        <span className="sort-arrow">{active ? (direction === "asc" ? "^" : "v") : ""}</span>
      </button>
    </th>
  );
}

function MappingFields({
  platform,
  mapping,
  configured,
  onChange
}: {
  platform: Platform;
  mapping: PlatformMapping;
  configured: boolean;
  onChange: (patch: Partial<PlatformMapping>) => void;
}) {
  const target = mappingTarget(platform, mapping);

  return (
    <fieldset className="mapping-block">
      <div className="mapping-row">
        <div className="mapping-row-copy">
          <legend>
            {platformLabels[platform]}
            {!configured ? <span className="needs-key-badge">Needs keys</span> : null}
          </legend>
          <span>{mapping.enabled ? `Linked to ${target}` : "Not linked"}</span>
        </div>
        <input
          type="checkbox"
          aria-label={`${platformLabels[platform]} link enabled`}
          checked={mapping.enabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
        />
      </div>
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
      <details className="mapping-details">
        <summary>Link details</summary>
        {platform !== "shopify" ? (
          <label>
            Store SKU
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
      </details>
      {mapping.warning ? <p className="mapping-warning">{mapping.warning}</p> : null}
    </fieldset>
  );
}

function mappingTarget(platform: Platform, mapping: PlatformMapping) {
  if (platform === "shopify") return shortId(mapping.inventoryItemId) ?? "Shopify item";
  if (platform === "etsy") return mapping.listingId || mapping.remoteSku || "Etsy listing";
  if (platform === "ebay") return mapping.offerId || mapping.remoteSku || "eBay offer";
  return mapping.remoteSku || "store item";
}

function shortId(value?: string) {
  if (!value) return undefined;
  const parts = value.split("/");
  return parts.at(-1) || value;
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

function isOverMax(item: InventoryItem) {
  return item.quantity > itemMaxInventory(item);
}

function itemMaxInventory(item: InventoryItem) {
  return Number.isInteger(item.maxInventory) && item.maxInventory >= 1 ? item.maxInventory : defaultMaxInventory;
}

function stockTone(item: InventoryItem) {
  if (isOverMax(item)) return "over";
  if (isLowStock(item)) return "low";
  if (item.safetyStock > 0 && item.quantity <= item.safetyStock + Math.max(3, Math.ceil(item.safetyStock * 0.25))) {
    return "watch";
  }
  return "ok";
}

function stockStatusLabel(item: InventoryItem) {
  const tone = stockTone(item);
  if (tone === "over") return "Over max";
  if (tone === "low") return "Low";
  if (tone === "watch") return "Watch";
  return "OK";
}

function stockPercent(quantity: number, maxQuantity: number) {
  if (quantity <= 0) return "0%";
  return `${Math.min(100, Math.max(6, Math.round((quantity / maxQuantity) * 100)))}%`;
}

function compareInventoryItems(
  left: InventoryItem,
  right: InventoryItem,
  field: SortField,
  direction: SortDirection
) {
  const comparison = compareSortField(left, right, field);
  if (comparison !== 0) return direction === "asc" ? comparison : -comparison;
  return left.sku.localeCompare(right.sku);
}

function compareSortField(left: InventoryItem, right: InventoryItem, field: SortField) {
  if (field === "sku") return left.sku.localeCompare(right.sku);
  if (field === "name") return left.name.localeCompare(right.name);
  if (field === "quantity") return left.quantity - right.quantity;
  if (field === "lowAlert") return left.safetyStock - right.safetyStock;
  return stockToneRank(left) - stockToneRank(right);
}

function stockToneRank(item: InventoryItem) {
  const tone = stockTone(item);
  if (tone === "over") return 0;
  if (tone === "low") return 1;
  if (tone === "watch") return 2;
  return 3;
}
