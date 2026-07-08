export type Platform = "etsy" | "ebay" | "shopify";

export const platforms: Platform[] = ["etsy", "ebay", "shopify"];

export const platformLabels: Record<Platform, string> = {
  etsy: "Etsy",
  ebay: "eBay",
  shopify: "Shopify",
};

export interface PlatformMapping {
  enabled: boolean;
  remoteSku?: string;
  listingId?: string;
  inventoryItemId?: string;
  locationId?: string;
  offerId?: string;
  lastSyncedQuantity?: number | null;
  lastRemoteQuantity?: number | null;
  lastSyncedAt?: string | null;
  warning?: string | null;
}

export interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  description?: string;
  quantity: number;
  safetyStock: number;
  mappings: Partial<Record<Platform, PlatformMapping>>;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryEvent {
  id: string;
  itemId: string;
  sku: string;
  type:
    | "create"
    | "batch_add"
    | "manual_subtract"
    | "platform_sale"
    | "sync_baseline"
    | "sync_push"
    | "correction";
  delta: number;
  quantityAfter: number;
  source: "local" | "sync" | Platform;
  platform?: Platform;
  note?: string;
  createdAt: string;
}

export interface ScheduleSettings {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  updatedAt: string;
}

export interface SyncSummary {
  itemsChecked: number;
  salesDetected: number;
  pushes: number;
  warnings: number;
  errors: number;
}

export interface SyncRun {
  id: string;
  mode: "manual" | "scheduled" | "cli";
  status: "running" | "completed" | "completed_with_warnings" | "failed";
  startedAt: string;
  finishedAt?: string;
  summary: SyncSummary;
  messages: string[];
}

export interface PlatformStatus {
  platform: Platform;
  label: string;
  configured: boolean;
  missing: string[];
}

export interface DashboardPayload {
  items: InventoryItem[];
  events: InventoryEvent[];
  schedule: ScheduleSettings;
  syncRuns: SyncRun[];
  platformStatuses: PlatformStatus[];
}

export function createEmptyDashboard(): DashboardPayload {
  return {
    items: [],
    events: [],
    syncRuns: [],
    schedule: {
      enabled: false,
      intervalMinutes: 60,
      lastRunAt: null,
      nextRunAt: null,
      updatedAt: new Date().toISOString(),
    },
    platformStatuses: [],
  };
}
