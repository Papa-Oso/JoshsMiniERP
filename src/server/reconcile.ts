import { randomUUID } from "node:crypto";
import type {
  InventoryItem,
  Platform,
  PlatformMapping,
  ReconcileResult,
  ReconcileRow,
  ReconcileStatus,
  SyncSummary
} from "../shared/types";
import { platformLabels, platforms } from "../shared/types";
import { adapterByPlatform } from "./adapters";
import { store } from "./store";

export type { ReconcileResult, ReconcileRow, ReconcileStatus } from "../shared/types";

export interface ReconcileOptions {
  platform?: Platform;
}

interface PullReading {
  item: InventoryItem;
  mapping: PlatformMapping;
  platform: Platform;
  row: ReconcileRow;
  remoteQuantity: number;
}

export async function reconcileInventory(options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const data = await store.read();
  const selectedPlatforms = options.platform ? [options.platform] : platforms;
  const rows: ReconcileRow[] = [];
  const readings: PullReading[] = [];
  const activeItems = data.items.filter((item) => item.active !== false);
  const summary: SyncSummary = {
    itemsChecked: activeItems.length,
    salesDetected: 0,
    pushes: 0,
    warnings: 0,
    errors: 0
  };

  for (const item of activeItems) {
    for (const platform of selectedPlatforms) {
      const mapping = item.mappings[platform];
      if (!mapping?.enabled) continue;

      const adapter = adapterByPlatform[platform];
      const baseRow = {
        sku: item.sku,
        platform,
        localQuantity: item.quantity,
        lastSyncedQuantity: mapping.lastSyncedQuantity ?? null
      };

      if (!adapter.isConfigured()) {
        summary.warnings += 1;
        rows.push({
          ...baseRow,
          status: "missing_config",
          message: `${adapter.label} is enabled but missing ${adapter.missingEnv().join(", ")}.`
        });
        continue;
      }

      if (!adapter.hasRequiredMapping(item, mapping)) {
        summary.warnings += 1;
        rows.push({
          ...baseRow,
          status: "missing_mapping",
          message: `${adapter.label} mapping is missing ${adapter.missingMapping(item, mapping).join(", ")}.`
        });
        continue;
      }

      const row: ReconcileRow = {
        ...baseRow,
        status: "ok",
        message: "Remote quantity matches the local plan."
      };
      rows.push(row);

      try {
        const reading = await adapter.pullQuantity(item, mapping);
        row.remoteQuantity = reading.quantity;
        readings.push({ item, mapping, platform, row, remoteQuantity: reading.quantity });
      } catch (error) {
        summary.errors += 1;
        row.status = "error";
        row.message = `${adapter.label} pull failed: ${errorMessage(error)}`;
      }
    }
  }

  const salesByItem = new Map<string, number>();
  for (const reading of readings) {
    const lastSynced = reading.mapping.lastSyncedQuantity;
    if (typeof lastSynced === "number" && reading.remoteQuantity < lastSynced) {
      const sold = lastSynced - reading.remoteQuantity;
      salesByItem.set(reading.item.id, (salesByItem.get(reading.item.id) ?? 0) + sold);
      summary.salesDetected += sold;
    }
  }

  for (const reading of readings) {
    const lastSynced = reading.mapping.lastSyncedQuantity;
    const soldForItem = salesByItem.get(reading.item.id) ?? 0;
    const projectedLocal = Math.max(0, reading.item.quantity - soldForItem);
    reading.row.projectedLocalQuantity = projectedLocal;

    if (soldForItem > reading.item.quantity) {
      summary.warnings += 1;
      reading.row.message = `Detected ${soldForItem} platform sales but only ${reading.item.quantity} are on hand.`;
    }

    if (typeof lastSynced !== "number") {
      summary.warnings += 1;
      reading.row.status = "baseline";
      reading.row.message = `Would capture ${platformLabels[reading.platform]} baseline at ${reading.remoteQuantity}; no push yet.`;
      continue;
    }

    reading.row.wouldPushQuantity = projectedLocal;
    summary.pushes += 1;

    if (reading.remoteQuantity < lastSynced) {
      const sold = lastSynced - reading.remoteQuantity;
      reading.row.status = "sale";
      reading.row.message = `Would subtract ${sold} sold on ${platformLabels[reading.platform]}, then push ${projectedLocal}.`;
      continue;
    }

    if (reading.remoteQuantity > lastSynced) {
      summary.warnings += 1;
      reading.row.status = "remote_increase";
      reading.row.message = `${platformLabels[reading.platform]} increased from ${lastSynced} to ${reading.remoteQuantity}; would keep local authority and push ${projectedLocal}.`;
      continue;
    }

    if (reading.remoteQuantity !== projectedLocal) {
      reading.row.status = "different";
      reading.row.message = `Would push local quantity ${projectedLocal} to ${platformLabels[reading.platform]}.`;
      continue;
    }

    reading.row.status = "ok";
    reading.row.message = `Remote already matches local; sync would confirm ${projectedLocal}.`;
  }

  const result = { rows, summary };
  await store.recordReconcileRun?.({
    id: randomUUID(),
    platform: options.platform,
    createdAt: new Date().toISOString(),
    ...result
  });
  return result;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
