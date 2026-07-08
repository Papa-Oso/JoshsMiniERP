export type Platform = "etsy" | "ebay" | "shopify";

export const platforms: Platform[] = ["etsy", "ebay", "shopify"];

export const platformLabels: Record<Platform, string> = {
  etsy: "Etsy",
  ebay: "eBay",
  shopify: "Shopify"
};

export type InventoryEventType =
  | "create"
  | "batch_add"
  | "manual_subtract"
  | "platform_sale"
  | "sync_baseline"
  | "sync_push"
  | "correction";

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
  type: InventoryEventType;
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

export type SyncMode = "manual" | "scheduled" | "cli";
export type SyncStatus = "running" | "completed" | "completed_with_warnings" | "failed";

export interface SyncSummary {
  itemsChecked: number;
  salesDetected: number;
  pushes: number;
  warnings: number;
  errors: number;
}

export interface SyncRun {
  id: string;
  mode: SyncMode;
  status: SyncStatus;
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

export interface StoreData {
  items: InventoryItem[];
  events: InventoryEvent[];
  schedule: ScheduleSettings;
  syncRuns: SyncRun[];
}

export interface DashboardPayload extends StoreData {
  platformStatuses: PlatformStatus[];
}

export interface CreateItemInput {
  sku: string;
  name: string;
  description?: string;
  quantity: number;
  safetyStock?: number;
}

export interface AdjustInventoryInput {
  delta: number;
  type?: "batch_add" | "manual_subtract" | "correction";
  note?: string;
}

export interface UpdateItemInput {
  sku?: string;
  name?: string;
  description?: string;
  safetyStock?: number;
  mappings?: Partial<Record<Platform, PlatformMapping>>;
}

export interface UpdateScheduleInput {
  enabled?: boolean;
  intervalMinutes?: number;
}
