export type Platform = "etsy" | "ebay" | "shopify";

export const platforms: Platform[] = ["etsy", "ebay", "shopify"];

export const platformLabels: Record<Platform, string> = {
  etsy: "Etsy",
  ebay: "eBay",
  shopify: "Shopify"
};

export const defaultMaxInventory = 100;

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
  maxInventory: number;
  active: boolean;
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
  maxInventory?: number;
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
  maxInventory?: number;
  active?: boolean;
  mappings?: Partial<Record<Platform, PlatformMapping>>;
}

export interface UpdateScheduleInput {
  enabled?: boolean;
  intervalMinutes?: number;
}

export type PrintEventType = "print_batch" | "package_use" | "correction";

export interface PrintInstruction {
  id: string;
  label: string;
  matchTerms: string[];
  title: string;
  body: string;
  onHand: number;
  lowAlert: number;
  perPage: number;
  updatedAt: string;
}

export interface PrintEvent {
  id: string;
  instructionId: string;
  type: PrintEventType;
  delta: number;
  quantityAfter: number;
  note?: string;
  createdAt: string;
}

export interface PrintingPayload {
  instructions: PrintInstruction[];
  instructionMatches: SkuInstructionMatch[];
  events: PrintEvent[];
  defaults: {
    labelBatchSize: number;
    instructionPages: number;
    instructionPerPage: number;
    labelPrinterName?: string;
    instructionPrinterName?: string;
  };
}

export type InstructionMatchMode = "auto" | "instruction" | "none";

export interface SkuInstructionMatch {
  sku: string;
  mode: InstructionMatchMode;
  instructionId?: string;
  updatedAt: string;
}

export interface UpdateInstructionInput {
  title?: string;
  body?: string;
  lowAlert?: number;
}

export interface UpdateInstructionMatchInput {
  mode: InstructionMatchMode;
  instructionId?: string;
}

export interface UpdatePrintSettingsInput {
  labelPrinterName?: string;
  instructionPrinterName?: string;
}

export interface PrinterInfo {
  name: string;
  isDefault: boolean;
  portName?: string;
  status?: number;
  workOffline?: boolean;
}

export interface UploadInstructionInput {
  filename: string;
  contentBase64: string;
  label?: string;
  sku?: string;
}

export interface UploadInstructionResult {
  instruction: PrintInstruction;
  asset: PrintAsset;
}

export interface UploadLabelInput {
  sku: string;
  filename: string;
  contentBase64: string;
}

export interface UploadLabelResult {
  asset: PrintAsset;
}

export interface AdjustInstructionInput {
  delta: number;
  type?: PrintEventType;
  note?: string;
}

export type PrintAssetKind = "label" | "instruction";

export interface PrintAsset {
  id: string;
  kind: PrintAssetKind;
  filename: string;
  displayName: string;
  path: string;
  sku?: string;
  instructionId?: string;
  exists: boolean;
}
