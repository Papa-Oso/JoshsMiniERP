import type {
  FeedbackConcernRow,
  FeedbackScanRunRecord,
  InstructionTrendRow,
  InventoryItem,
  LowInventoryRow,
  MappingHealthRow,
  OperationsReportPayload,
  Platform,
  PlatformMapping
} from "../shared/types";
import { platformLabels, platforms } from "../shared/types";
import { adapterByPlatform } from "./adapters";
import { loadFeedbackHistory, loadFeedbackScanRuns } from "./ebayReviews/feedbackStore";
import { listData } from "./inventoryService";
import { getPrintingData } from "./printingService";
import { store } from "./store";

export async function getOperationsReport(): Promise<OperationsReportPayload> {
  const [data, printing, importBatches, reconcileRuns, feedbackScanRuns, feedbackHistory] = await Promise.all([
    listData(),
    getPrintingData(),
    store.listImportBatches?.(12) ?? Promise.resolve([]),
    store.listReconcileRuns?.(12) ?? Promise.resolve([]),
    loadFeedbackScanRuns(12).then(normalizeFeedbackScanRuns),
    loadFeedbackHistory()
  ]);

  const lowInventory = buildLowInventory(data.items);
  const inventoryEvents = data.events.slice(0, 40);
  const printEvents = printing.events.slice(0, 40);
  const instructionTrends = buildInstructionTrends(printing);
  const feedbackConcerns = buildFeedbackConcerns(feedbackHistory);
  const syncRuns = data.syncRuns.slice(0, 12);
  const mappingHealth = buildMappingHealth(data.items).slice(0, 80);

  return {
    generatedAt: new Date().toISOString(),
    importBatches,
    reconcileRuns,
    syncRuns,
    lowInventory,
    inventoryEvents,
    printEvents,
    instructionTrends,
    feedbackConcerns: feedbackConcerns.slice(0, 20),
    feedbackScanRuns,
    mappingHealth,
    totals: {
      imports: importBatches.length,
      reconcileRuns: reconcileRuns.length,
      syncRuns: syncRuns.length,
      inventoryLow: lowInventory.length,
      inventoryEvents: inventoryEvents.length,
      printEvents: printEvents.length,
      instructionLow: instructionTrends.filter((row) => row.status === "low").length,
      negativeFeedback: feedbackConcerns.length,
      feedbackScanRuns: feedbackScanRuns.length,
      mappingIssues: mappingHealth.filter((row) => row.status !== "ok" && row.status !== "disabled").length
    }
  };
}

function buildLowInventory(items: InventoryItem[]): LowInventoryRow[] {
  return items
    .filter((item) => item.active !== false && item.quantity <= item.safetyStock)
    .map((item) => ({
      itemId: item.id,
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      safetyStock: item.safetyStock,
      maxInventory: item.maxInventory
    }))
    .sort((left, right) => {
      const leftGap = left.quantity - left.safetyStock;
      const rightGap = right.quantity - right.safetyStock;
      return leftGap - rightGap || left.sku.localeCompare(right.sku);
    });
}

function buildInstructionTrends(printing: Awaited<ReturnType<typeof getPrintingData>>): InstructionTrendRow[] {
  return printing.instructions
    .map((instruction) => {
      const events = printing.events.filter((event) => event.instructionId === instruction.id);
      const recentDelta = events.reduce((sum, event) => sum + event.delta, 0);
      return {
        instructionId: instruction.id,
        label: instruction.label,
        onHand: instruction.onHand,
        lowAlert: instruction.lowAlert,
        maxInventory: instruction.maxInventory,
        recentDelta,
        eventCount: events.length,
        status:
          instruction.onHand > instruction.maxInventory
            ? "over_max"
            : instruction.onHand <= instruction.lowAlert
              ? "low"
              : "ok"
      } satisfies InstructionTrendRow;
    })
    .sort((left, right) => {
      const rank = instructionStatusRank(left.status) - instructionStatusRank(right.status);
      return rank || left.label.localeCompare(right.label);
    });
}

function buildMappingHealth(items: InventoryItem[]): MappingHealthRow[] {
  const rows: MappingHealthRow[] = [];

  for (const item of items.filter((candidate) => candidate.active !== false)) {
    for (const platform of platforms) {
      const mapping = item.mappings[platform];
      if (!mapping?.enabled) continue;
      rows.push(mappingHealthRow(item, platform, mapping));
    }
  }

  return rows.sort((left, right) => {
    const rank = mappingStatusRank(left.status) - mappingStatusRank(right.status);
    return rank || left.sku.localeCompare(right.sku) || left.platform.localeCompare(right.platform);
  });
}

function mappingHealthRow(item: InventoryItem, platform: Platform, mapping: PlatformMapping): MappingHealthRow {
  const adapter = adapterByPlatform[platform];

  if (!adapter.isConfigured()) {
    return {
      sku: item.sku,
      name: item.name,
      platform,
      status: "missing_config",
      message: `${platformLabels[platform]} needs ${adapter.missingEnv().join(", ")}.`
    };
  }

  if (!adapter.hasRequiredMapping(item, mapping)) {
    return {
      sku: item.sku,
      name: item.name,
      platform,
      status: "missing_mapping",
      message: `${platformLabels[platform]} missing ${adapter.missingMapping(item, mapping).join(", ")}.`
    };
  }

  if (mapping.warning) {
    return {
      sku: item.sku,
      name: item.name,
      platform,
      status: "warning",
      message: mapping.warning
    };
  }

  return {
    sku: item.sku,
    name: item.name,
    platform,
    status: "ok",
    message: `${platformLabels[platform]} link is ready.`
  };
}

function buildFeedbackConcerns(rows: Array<Record<string, unknown>>): FeedbackConcernRow[] {
  return rows
    .filter((row) => String(row.rating ?? "").toLowerCase() === "negative")
    .map((row) => ({
      platform: String(row.platform ?? "ebay") === "etsy" ? "etsy" : "ebay",
      rating: "negative",
      buyerUsername: String(row.buyer_username ?? ""),
      itemTitle: String(row.matched_item_title || row.source_item_title || row.source_item_id || "Unknown item"),
      feedbackText: String(row.feedback_text ?? ""),
      photoUrl: String(row.feedback_image_urls ?? ""),
      feedbackDate: String(row.feedback_date ?? ""),
      lastSeenAt: String(row.last_seen_at ?? "")
    }));
}

function normalizeFeedbackScanRuns(rows: Array<Record<string, unknown>>): FeedbackScanRunRecord[] {
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    platform: row.platform === "etsy" ? "etsy" : "ebay",
    scanMode: row.scan_mode === "incremental" ? "incremental" : "full",
    rowsSeen: Number(row.rows_seen ?? 0),
    rowsExported: Number(row.rows_exported ?? 0),
    newRows: Number(row.new_rows ?? 0),
    skippedExistingRows: Number(row.skipped_existing_rows ?? 0),
    createdAt: new Date(String(row.created_at ?? new Date().toISOString())).toISOString()
  }));
}

function mappingStatusRank(status: MappingHealthRow["status"]) {
  if (status === "missing_config") return 0;
  if (status === "missing_mapping") return 1;
  if (status === "warning") return 2;
  if (status === "ok") return 3;
  return 4;
}

function instructionStatusRank(status: InstructionTrendRow["status"]) {
  if (status === "low") return 0;
  if (status === "over_max") return 1;
  return 2;
}
