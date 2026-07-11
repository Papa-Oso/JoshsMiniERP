export type Platform = "etsy" | "ebay" | "shopify";

export const platforms: Platform[] = ["etsy", "ebay", "shopify"];

export const platformLabels: Record<Platform, string> = {
  etsy: "Etsy",
  ebay: "eBay",
  shopify: "Shopify"
};

export const defaultMaxInventory = 100;

export interface SalesLineItem {
  platform: Platform;
  orderId: string;
  lineId: string;
  sku: string;
  title: string;
  quantity: number;
  amount: number;
}

export type SalesFinancialSource = "payment_api" | "financial_api" | "order_api" | "transaction_report" | "order_report" | "legacy";

export interface SalesOrder {
  platform: Platform;
  orderId: string;
  orderNumber: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  currency: string;
  grossAmount: number;
  netAmount: number;
  productAmount?: number;
  shippingAmount?: number;
  discountAmount?: number;
  taxAmount?: number;
  refundedAmount?: number;
  comparableSalesAmount?: number;
  financialStatus?: string;
  canceledAt?: string;
  financialsComplete?: boolean;
  financialsSource?: SalesFinancialSource;
  financialsUpdatedAt?: string;
  reconciliationState?: "complete" | "incomplete" | "unresolved";
  countryCode: string;
  regionCode: string;
  itemCount: number;
  sourceUrl: string;
  lineItems: SalesLineItem[];
}

export interface SalesRefund {
  platform: Platform;
  orderId: string;
  refundId: string;
  refundedAt: string;
  productAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  status: string;
  currency: string;
  componentsComplete: boolean;
  source: string;
  sourceUpdatedAt: string;
}

export interface SalesDashboardPayload {
  generatedAt: string;
  lastPulledAt: string | null;
  range: string;
  platform: Platform | "all";
  summary: { revenue: number; orders: number; units: number; averageOrderValue: number; currency: string };
  ebayFinancials: {
    grossSales: number;
    fees: number;
    refunds: number;
    shippingLabels: number;
    netProceeds: number;
    transactionCount: number;
  } | null;
  trend: Array<{ date: string; revenue: number; orders: number; units: number }>;
  platforms: Array<{ platform: Platform; revenue: number; orders: number; units: number }>;
  countries: Array<{ countryCode: string; revenue: number; orders: number; units: number }>;
  locations: Array<{ countryCode: string; regionCode: string; revenue: number; orders: number; units: number }>;
  dataQuality: { unknownGeographyOrders: number; missingSkuLines: number };
  products: Array<{ sku: string; title: string; imageUrl?: string; revenue: number; orders: number; units: number }>;
  recentOrders: SalesOrder[];
  coverage: Array<{ platform: Platform; orders: number; earliestAt: string | null; latestAt: string | null }>;
  warnings: string[];
}

export type SalesIntegrityWarningCode =
  | "duplicate_refund"
  | "unmatched_refund"
  | "unresolved_refund"
  | "mixed_currency"
  | "missing_breakdown"
  | "impossible_total"
  | "stale_pull"
  | "duplicate_financial_transaction"
  | "unmatched_financial_transaction"
  | "financial_currency_conflict"
  | "api_report_disagreement";
export interface SalesReconciliationPayload {
  generatedAt: string;
  range: string;
  platform: Platform;
  currency: string | null;
  rows: Array<{
    currency: string;
    importedOrders: number;
    includedOrders: number;
    canceledOrders: number;
    refundedOrders: number;
    unresolvedOrders: number;
    productRevenue: number;
    shippingRevenue: number;
    discounts: number;
    excludedTax: number;
    refunds: number;
    comparableNetSales: number;
    fees: number | null;
    shippingLabels: number | null;
    netProceeds: number | null;
  }>;
  warnings: Array<{ code: SalesIntegrityWarningCode; count: number; message: string }>;
}

export type InventoryEventType =
  "create" | "batch_add" | "manual_subtract" | "platform_sale" | "sync_baseline" | "sync_push" | "correction";

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
  imagePath?: string;
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

export type ReconcileStatus =
  "ok" | "baseline" | "different" | "sale" | "remote_increase" | "missing_config" | "missing_mapping" | "error";

export interface ReconcileRow {
  sku: string;
  platform: Platform;
  status: ReconcileStatus;
  localQuantity: number;
  remoteQuantity?: number;
  lastSyncedQuantity?: number | null;
  projectedLocalQuantity?: number;
  wouldPushQuantity?: number;
  message: string;
}

export interface ReconcileResult {
  rows: ReconcileRow[];
  summary: SyncSummary;
}

export interface ReconcileRunRecord extends ReconcileResult {
  id: string;
  platform?: Platform;
  createdAt: string;
}

export interface FeedbackScanRunRecord {
  id: string;
  platform: "ebay" | "etsy";
  scanMode: "full" | "incremental";
  rowsSeen: number;
  rowsExported: number;
  newRows: number;
  skippedExistingRows: number;
  createdAt: string;
}

export interface LowInventoryRow {
  itemId: string;
  sku: string;
  name: string;
  quantity: number;
  safetyStock: number;
  maxInventory: number;
}

export interface FeedbackConcernRow {
  feedbackKey: string;
  platform: Platform;
  rating: "positive" | "neutral" | "negative";
  buyerUsername: string;
  itemTitle: string;
  feedbackText: string;
  photoUrl: string;
  reviewUrl: string;
  feedbackDate: string;
  lastSeenAt: string;
  acknowledgedAt: string;
}

export type ImportBatchSource = "csv" | "shopify";
export type ImportBatchStatus = "applied" | "dry_run" | "failed";

export interface ImportBatchSummary {
  rowsTotal: number;
  created: number;
  updated: number;
  adjusted: number;
  mapped: number;
  skipped: number;
  failed: number;
  variantsScanned?: number;
}

export interface ImportBatchRow {
  id: string;
  lineNumber?: number;
  sku?: string;
  action: string;
  previousQuantity?: number;
  nextQuantity?: number;
  message: string;
  raw?: unknown;
}

export interface ImportBatchRecord {
  id: string;
  source: ImportBatchSource;
  fileName?: string;
  status: ImportBatchStatus;
  summary: ImportBatchSummary;
  rows: ImportBatchRow[];
  createdAt: string;
}

export interface PlatformStatus {
  platform: Platform;
  label: string;
  configured: boolean;
  missing: string[];
}

export interface EbayDeletionNoticeRecord {
  id: string;
  receivedAt: string;
  topic?: string;
  schemaVersion?: string;
  notificationId?: string;
  eventDate?: string;
  publishDate?: string;
  publishAttemptCount?: number;
  username?: string;
  userId?: string;
  eiasToken?: string;
  processedAt?: string;
}

export interface EbayDeletionNoticeStatus {
  configured: boolean;
  endpoint?: string;
  error?: string;
  notices: EbayDeletionNoticeRecord[];
  total: number;
  unprocessedCount: number;
  latestReceivedAt?: string;
}

export type MappingHealthStatus = "ok" | "disabled" | "missing_config" | "missing_mapping" | "warning";

export interface MappingHealthRow {
  sku: string;
  name: string;
  platform: Platform;
  status: MappingHealthStatus;
  message: string;
}

export type InstructionTrendStatus = "ok" | "low" | "over_max";

export interface InstructionTrendRow {
  instructionId: string;
  label: string;
  onHand: number;
  lowAlert: number;
  maxInventory: number;
  recentDelta: number;
  eventCount: number;
  status: InstructionTrendStatus;
}

export interface OperationsReportPayload {
  generatedAt: string;
  importBatches: ImportBatchRecord[];
  reconcileRuns: ReconcileRunRecord[];
  syncRuns: SyncRun[];
  lowInventory: LowInventoryRow[];
  inventoryEvents: InventoryEvent[];
  printEvents: PrintEvent[];
  instructionTrends: InstructionTrendRow[];
  feedbackConcerns: FeedbackConcernRow[];
  feedbackScanRuns: FeedbackScanRunRecord[];
  mappingHealth: MappingHealthRow[];
  totals: {
    imports: number;
    reconcileRuns: number;
    syncRuns: number;
    inventoryLow: number;
    inventoryEvents: number;
    printEvents: number;
    instructionLow: number;
    negativeFeedback: number;
    feedbackScanRuns: number;
    mappingIssues: number;
  };
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
  maxInventory: number;
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
  maxInventory?: number;
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
