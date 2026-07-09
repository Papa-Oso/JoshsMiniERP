import type {
  FeedbackScanRunRecord,
  InventoryItem,
  MappingHealthRow,
  OperationsReportPayload,
  Platform,
  PlatformMapping
} from "../shared/types";
import { platformLabels, platforms } from "../shared/types";
import { adapterByPlatform } from "./adapters";
import { loadFeedbackScanRuns } from "./ebayReviews/feedbackStore";
import { listData } from "./inventoryService";
import { getPrintingData } from "./printingService";
import { store } from "./store";

export async function getOperationsReport(): Promise<OperationsReportPayload> {
  const [data, printing, importBatches, reconcileRuns, feedbackScanRuns] = await Promise.all([
    listData(),
    getPrintingData(),
    store.listImportBatches?.(12) ?? Promise.resolve([]),
    store.listReconcileRuns?.(12) ?? Promise.resolve([]),
    loadFeedbackScanRuns(12).then(normalizeFeedbackScanRuns)
  ]);

  const inventoryEvents = data.events.slice(0, 40);
  const printEvents = printing.events.slice(0, 40);
  const syncRuns = data.syncRuns.slice(0, 12);
  const mappingHealth = buildMappingHealth(data.items).slice(0, 80);

  return {
    generatedAt: new Date().toISOString(),
    importBatches,
    reconcileRuns,
    syncRuns,
    inventoryEvents,
    printEvents,
    feedbackScanRuns,
    mappingHealth,
    totals: {
      imports: importBatches.length,
      reconcileRuns: reconcileRuns.length,
      syncRuns: syncRuns.length,
      inventoryEvents: inventoryEvents.length,
      printEvents: printEvents.length,
      feedbackScanRuns: feedbackScanRuns.length,
      mappingIssues: mappingHealth.filter((row) => row.status !== "ok" && row.status !== "disabled").length
    }
  };
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

function normalizeFeedbackScanRuns(rows: Array<Record<string, unknown>>): FeedbackScanRunRecord[] {
  return rows.map((row) => ({
    id: String(row.id ?? ""),
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
