import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  erpApiBaseUrl,
  erpErrorMessage,
  erpRequest,
  getDashboard,
} from "../lib/erp.server";
import { createEmptyDashboard, defaultMaxInventory } from "../lib/erp-types";
import type {
  DashboardPayload,
  InventoryItem,
  Platform,
  PlatformMapping,
  SyncRun,
} from "../lib/erp-types";

type LoaderData = {
  dashboard: DashboardPayload;
  apiBaseUrl: string;
  error: string | null;
};

type ActionData =
  | {
      ok: true;
      message: string;
      dashboard: DashboardPayload;
    }
  | {
      ok: false;
      error: string;
      dashboard: DashboardPayload;
    };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  try {
    return {
      dashboard: await getDashboard(),
      apiBaseUrl: erpApiBaseUrl(),
      error: null,
    } satisfies LoaderData;
  } catch (error) {
    return {
      dashboard: createEmptyDashboard(),
      apiBaseUrl: erpApiBaseUrl(),
      error: erpErrorMessage(error),
    } satisfies LoaderData;
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = field(formData, "intent");

  try {
    const message = await runIntent(intent, formData);
    return {
      ok: true,
      message,
      dashboard: await safeDashboard(),
    } satisfies ActionData;
  } catch (error) {
    return {
      ok: false,
      error: erpErrorMessage(error),
      dashboard: await safeDashboard(),
    } satisfies ActionData;
  }
};

export default function Index() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const dashboard = fetcher.data?.dashboard ?? loaderData.dashboard;
  const latestRun = dashboard.syncRuns[0];
  const [selectedId, setSelectedId] = useState<string | null>(
    dashboard.items[0]?.id ?? null,
  );

  const selectedItem =
    dashboard.items.find((item) => item.id === selectedId) ??
    dashboard.items[0] ??
    null;

  const pendingIntent = field(fetcher.formData, "intent");
  const busy = fetcher.state !== "idle";
  const refreshBusy = revalidator.state !== "idle";
  const stockTotal = dashboard.items.reduce(
    (sum, item) => sum + item.quantity,
    0,
  );
  const lowStock = dashboard.items.filter(isLowStock).length;
  const readyStores = dashboard.platformStatuses.filter(
    (status) => status.configured,
  ).length;
  const recentEvents = useMemo(
    () =>
      dashboard.events
        .filter((event) => event.type !== "sync_push")
        .slice(0, 8),
    [dashboard.events],
  );

  useEffect(() => {
    if (!dashboard.items.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedItem) setSelectedId(dashboard.items[0].id);
  }, [dashboard.items, selectedItem]);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
    } else {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Josh's Mini ERP">
      <style>{styles}</style>

      <fetcher.Form method="post" slot="primary-action">
        <input type="hidden" name="intent" value="run-sync" />
        <s-button
          type="submit"
          variant="primary"
          icon="play-circle"
          {...(pendingIntent === "run-sync" ? { loading: true } : {})}
          {...(busy ? { disabled: true } : {})}
        >
          Run sync
        </s-button>
      </fetcher.Form>

      <s-button
        slot="secondary-actions"
        icon="refresh"
        variant="secondary"
        onClick={() => revalidator.revalidate()}
        {...(refreshBusy ? { loading: true } : {})}
      >
        Refresh
      </s-button>

      {loaderData.error ? (
        <s-banner heading="ERP API unavailable" tone="critical">
          <s-paragraph>{loaderData.error}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Sync">
        <div className="metric-grid">
          <Metric label="SKUs" value={dashboard.items.length} />
          <Metric label="Global units" value={stockTotal} />
          <Metric
            label="Low alerts"
            value={lowStock}
            tone={lowStock ? "warning" : "success"}
          />
          <Metric
            label="Stores ready"
            value={`${readyStores}/${dashboard.platformStatuses.length}`}
            tone={
              readyStores === dashboard.platformStatuses.length
                ? "success"
                : "warning"
            }
          />
        </div>

        <div className="sync-row">
          <div>
            <s-text color="subdued">Latest run</s-text>
            <div className="inline-status">
              <s-badge tone={runTone(latestRun)} icon={runIcon(latestRun)}>
                {latestRun ? latestRun.status.replaceAll("_", " ") : "None"}
              </s-badge>
              <span>
                {formatDate(latestRun?.finishedAt ?? latestRun?.startedAt)}
              </span>
            </div>
          </div>
          {latestRun ? (
            <div className="summary-grid">
              <MiniStat label="Sales" value={latestRun.summary.salesDetected} />
              <MiniStat label="Pushes" value={latestRun.summary.pushes} />
              <MiniStat
                label="Issues"
                value={latestRun.summary.errors + latestRun.summary.warnings}
              />
            </div>
          ) : null}
        </div>

        {latestRun?.messages.length ? (
          <div className="message-list">
            {latestRun.messages.slice(0, 4).map((message) => (
              <s-paragraph key={message}>{message}</s-paragraph>
            ))}
          </div>
        ) : null}
      </s-section>

      <s-section heading="Inventory">
        <fetcher.Form method="post" className="form-grid">
          <input type="hidden" name="intent" value="create-item" />
          <s-text-field label="SKU" name="sku" icon="barcode" required />
          <s-text-field label="Name" name="name" icon="product" required />
          <s-number-field
            label="Initial stock"
            name="quantity"
            min={0}
            step={1}
            defaultValue="0"
            inputMode="numeric"
            required
          />
          <s-button
            type="submit"
            icon="plus-circle"
            variant="secondary"
            {...(busy ? { disabled: true } : {})}
          >
            Add SKU
          </s-button>
        </fetcher.Form>

        {dashboard.items.length ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">SKU</s-table-header>
              <s-table-header>Item</s-table-header>
              <s-table-header format="numeric">Global stock</s-table-header>
              <s-table-header format="numeric">Low at</s-table-header>
              <s-table-header>Shopify</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {dashboard.items.map((item) => (
                <s-table-row key={item.id}>
                  <s-table-cell>
                    <s-button
                      variant="tertiary"
                      onClick={() => setSelectedId(item.id)}
                    >
                      {item.sku}
                    </s-button>
                  </s-table-cell>
                  <s-table-cell>{item.name}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={stockTone(item)}>{item.quantity}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{item.safetyStock}</s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={
                        item.mappings.shopify?.enabled ? "success" : "neutral"
                      }
                    >
                      {item.mappings.shopify?.enabled ? "Linked" : "Not linked"}
                    </s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text color="subdued">No SKUs</s-text>
          </s-box>
        )}
      </s-section>

      <s-section slot="aside" heading="Stock control">
        {selectedItem ? (
          <div className="aside-stack">
            <div className="selected-card">
              <s-text color="subdued">Selected SKU</s-text>
              <strong>{selectedItem.sku}</strong>
              <span>{selectedItem.name}</span>
            </div>

            <fetcher.Form method="post" className="stack-form">
              <input type="hidden" name="intent" value="adjust-stock" />
              <input type="hidden" name="id" value={selectedItem.id} />
              <s-select label="Mode" name="mode">
                <s-option value="add">Add</s-option>
                <s-option value="subtract">Subtract</s-option>
              </s-select>
              <s-number-field
                label="Units"
                name="quantity"
                min={1}
                step={1}
                defaultValue="1"
                inputMode="numeric"
                required
              />
              <s-text-field label="Note" name="note" icon="note" />
              <s-button
                type="submit"
                icon="save"
                variant="secondary"
                {...(busy ? { disabled: true } : {})}
              >
                Apply
              </s-button>
            </fetcher.Form>

            <fetcher.Form method="post" className="stack-form">
              <input type="hidden" name="intent" value="update-safety-stock" />
              <input type="hidden" name="id" value={selectedItem.id} />
              <s-number-field
                label="Low alert"
                name="safetyStock"
                min={0}
                step={1}
                defaultValue={String(selectedItem.safetyStock)}
                inputMode="numeric"
                required
              />
              <s-button
                type="submit"
                icon="save"
                variant="secondary"
                {...(busy ? { disabled: true } : {})}
              >
                Save
              </s-button>
            </fetcher.Form>
          </div>
        ) : (
          <s-text color="subdued">No SKU selected</s-text>
        )}
      </s-section>

      <s-section slot="aside" heading="Schedule">
        <fetcher.Form method="post" className="stack-form">
          <input type="hidden" name="intent" value="update-schedule" />
          <input type="hidden" name="enabled" value="false" />
          <s-switch
            label="Enabled"
            name="enabled"
            value="true"
            defaultChecked={dashboard.schedule.enabled}
          />
          <s-number-field
            label="Minutes"
            name="intervalMinutes"
            min={5}
            max={1440}
            step={5}
            defaultValue={String(dashboard.schedule.intervalMinutes)}
            inputMode="numeric"
            required
          />
          <div className="schedule-meta">
            <span>Last</span>
            <strong>{formatDate(dashboard.schedule.lastRunAt)}</strong>
            <span>Next</span>
            <strong>{formatDate(dashboard.schedule.nextRunAt)}</strong>
          </div>
          <s-button
            type="submit"
            icon="save"
            variant="secondary"
            {...(busy ? { disabled: true } : {})}
          >
            Save schedule
          </s-button>
        </fetcher.Form>
      </s-section>

      <s-section slot="aside" heading="Stores">
        <div className="store-list">
          {dashboard.platformStatuses.map((status) => (
            <div className="store-row" key={status.platform}>
              <span>{status.label}</span>
              <s-badge tone={status.configured ? "success" : "warning"}>
                {status.configured ? "Ready" : "Needs keys"}
              </s-badge>
            </div>
          ))}
        </div>
        <s-paragraph>
          <s-text color="subdued">{loaderData.apiBaseUrl}</s-text>
        </s-paragraph>
      </s-section>

      {selectedItem ? (
        <s-section slot="aside" heading="Shopify link">
          <MappingForm
            busy={busy}
            item={selectedItem}
            mapping={selectedItem.mappings.shopify ?? { enabled: false }}
          />
        </s-section>
      ) : null}

      <s-section heading="Recent activity">
        {recentEvents.length ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">SKU</s-table-header>
              <s-table-header>Change</s-table-header>
              <s-table-header>Note</s-table-header>
              <s-table-header>At</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recentEvents.map((event) => (
                <s-table-row key={event.id}>
                  <s-table-cell>{event.sku}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={event.delta < 0 ? "critical" : "success"}>
                      {event.delta > 0 ? `+${event.delta}` : event.delta}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {event.note ?? event.type.replaceAll("_", " ")}
                  </s-table-cell>
                  <s-table-cell>{formatDate(event.createdAt)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text color="subdued">No activity</s-text>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

function MappingForm({
  busy,
  item,
  mapping,
}: {
  busy: boolean;
  item: InventoryItem;
  mapping: PlatformMapping;
}) {
  const fetcher = useFetcher<typeof action>();

  return (
    <fetcher.Form method="post" className="stack-form">
      <input type="hidden" name="intent" value="update-shopify-link" />
      <input type="hidden" name="id" value={item.id} />
      <input type="hidden" name="enabled" value="false" />
      <s-switch
        label="Enabled"
        name="enabled"
        value="true"
        defaultChecked={mapping.enabled}
      />
      <s-text-field
        label="Inventory item ID/GID"
        name="inventoryItemId"
        defaultValue={mapping.inventoryItemId ?? ""}
        icon="inventory"
      />
      <s-text-field
        label="Location ID/GID"
        name="locationId"
        defaultValue={mapping.locationId ?? ""}
        icon="location"
      />
      <s-button
        type="submit"
        icon="save"
        variant="secondary"
        {...(busy || fetcher.state !== "idle" ? { disabled: true } : {})}
      >
        Save link
      </s-button>
      {mapping.warning ? (
        <s-banner heading="Mapping warning" tone="warning">
          <s-paragraph>{mapping.warning}</s-paragraph>
        </s-banner>
      ) : null}
    </fetcher.Form>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <s-badge tone={tone}>{value}</s-badge>
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

async function runIntent(intent: string, formData: FormData) {
  switch (intent) {
    case "run-sync": {
      const run = await erpRequest<SyncRun>("/sync", { method: "POST" });
      return syncMessage(run);
    }
    case "create-item":
      await erpRequest("/items", {
        method: "POST",
        body: JSON.stringify({
          sku: field(formData, "sku"),
          name: field(formData, "name"),
          quantity: numberField(formData, "quantity", 0),
        }),
      });
      return "Item saved.";
    case "adjust-stock": {
      const id = field(formData, "id");
      const units = numberField(formData, "quantity", 1);
      const mode = field(formData, "mode");
      await erpRequest(`/items/${encodeURIComponent(id)}/adjust`, {
        method: "POST",
        body: JSON.stringify({
          delta: mode === "subtract" ? -units : units,
          type: mode === "subtract" ? "manual_subtract" : "batch_add",
          note: optionalField(formData, "note"),
        }),
      });
      return "Inventory adjusted.";
    }
    case "update-safety-stock": {
      const id = field(formData, "id");
      await erpRequest(`/items/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          safetyStock: numberField(formData, "safetyStock", 0),
        }),
      });
      return "Low alert saved.";
    }
    case "update-schedule":
      await erpRequest("/schedule", {
        method: "PATCH",
        body: JSON.stringify({
          enabled: booleanField(formData, "enabled"),
          intervalMinutes: numberField(formData, "intervalMinutes", 60),
        }),
      });
      return "Schedule saved.";
    case "update-shopify-link": {
      const id = field(formData, "id");
      await erpRequest(`/items/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          mappings: {
            shopify: {
              enabled: booleanField(formData, "enabled"),
              inventoryItemId: optionalField(formData, "inventoryItemId"),
              locationId: optionalField(formData, "locationId"),
            },
          } satisfies Partial<Record<Platform, PlatformMapping>>,
        }),
      });
      return "Shopify link saved.";
    }
    default:
      throw new Error("Unknown action.");
  }
}

async function safeDashboard() {
  try {
    return await getDashboard();
  } catch {
    return createEmptyDashboard();
  }
}

function field(formData: FormData | undefined, key: string) {
  const value = formData?.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function optionalField(formData: FormData, key: string) {
  const value = field(formData, key);
  return value || undefined;
}

function numberField(formData: FormData, key: string, fallback: number) {
  const value = Number(field(formData, key));
  return Number.isFinite(value) ? value : fallback;
}

function booleanField(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .some((value) => value === "true" || value === "on");
}

function syncMessage(run: SyncRun) {
  if (run.status === "failed") return "Sync failed.";
  if (run.status === "completed_with_warnings")
    return "Sync finished with warnings.";
  return "Sync finished.";
}

function runTone(run?: SyncRun) {
  if (!run) return "neutral";
  if (run.status === "failed") return "critical";
  if (run.status === "completed_with_warnings") return "warning";
  if (run.status === "running") return "info";
  return "success";
}

function runIcon(run?: SyncRun) {
  if (!run) return "clock";
  if (run.status === "failed") return "alert-triangle";
  if (run.status === "running") return "in-progress";
  return "check-circle";
}

function isLowStock(item: InventoryItem) {
  return item.quantity <= item.safetyStock;
}

function isOverMax(item: InventoryItem) {
  const maxInventory =
    Number.isInteger(item.maxInventory) && item.maxInventory >= 1 ? item.maxInventory : defaultMaxInventory;
  return item.quantity > maxInventory;
}

function stockTone(item: InventoryItem) {
  if (isOverMax(item)) return "critical";
  return isLowStock(item) ? "warning" : "success";
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

const styles = `
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 12px;
  }

  .metric,
  .mini-stat,
  .selected-card,
  .store-row {
    display: grid;
    gap: 4px;
  }

  .metric,
  .mini-stat,
  .selected-card {
    padding: 12px;
    border: 1px solid #d5d5d5;
    border-radius: 8px;
  }

  .metric span,
  .mini-stat span,
  .schedule-meta span,
  .selected-card span,
  .store-row span {
    color: #616161;
    font-size: 12px;
  }

  .sync-row {
    display: grid;
    gap: 16px;
    grid-template-columns: minmax(0, 1fr) minmax(220px, auto);
    margin-top: 16px;
  }

  .inline-status {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 4px;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(64px, 1fr));
    gap: 8px;
  }

  .message-list {
    margin-top: 12px;
  }

  .form-grid {
    align-items: end;
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(3, minmax(120px, 1fr)) auto;
    margin-bottom: 16px;
  }

  .aside-stack,
  .stack-form,
  .store-list {
    display: grid;
    gap: 12px;
  }

  .schedule-meta {
    display: grid;
    gap: 4px 8px;
    grid-template-columns: auto 1fr;
  }

  .store-row {
    align-items: center;
    grid-template-columns: 1fr auto;
  }

  @media (max-width: 720px) {
    .form-grid,
    .sync-row {
      grid-template-columns: 1fr;
    }

    .summary-grid {
      grid-template-columns: 1fr;
    }
  }
`;

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
