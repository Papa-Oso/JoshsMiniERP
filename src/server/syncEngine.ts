import { randomUUID } from "node:crypto";
import type { Platform, StoreData, SyncMode, SyncRun, SyncSummary } from "../shared/types";
import { platformLabels, platforms } from "../shared/types";
import { adapterByPlatform, adapters } from "./adapters";
import type { RemoteQuantity } from "./adapters/types";
import { makeEvent } from "./inventoryService";
import { consumeInstructionForSku } from "./printingService";
import { store } from "./store";

interface PullReading extends RemoteQuantity {
  itemId: string;
}

interface PushTarget {
  itemId: string;
  platform: Platform;
  quantity: number;
}

interface PushSuccess extends PushTarget {
  at: string;
}

interface InstructionSaleUse {
  sku: string;
  units: number;
}

let activeRun: Promise<SyncRun> | null = null;

const now = () => new Date().toISOString();
const pushKey = (itemId: string, platform: Platform) => `${itemId}:${platform}`;

export function syncIsRunning() {
  return Boolean(activeRun);
}

export async function runInventorySync(mode: SyncMode) {
  if (activeRun) return activeRun;
  activeRun = runInventorySyncInternal(mode).finally(() => {
    activeRun = null;
  });
  return activeRun;
}

async function runInventorySyncInternal(mode: SyncMode): Promise<SyncRun> {
  return store.withLock(() => runInventorySyncLocked(mode));
}

async function runInventorySyncLocked(mode: SyncMode): Promise<SyncRun> {
  const startedAt = now();
  const messages: string[] = [];
  const summary: SyncSummary = {
    itemsChecked: 0,
    salesDetected: 0,
    pushes: 0,
    warnings: 0,
    errors: 0
  };

  try {
    const pullReadings = await pullRemoteQuantities(messages, summary);
    const pushTargets = await applySalesAndPlanPushes(pullReadings, messages, summary);
    const pushSuccesses = await pushCanonicalQuantities(pushTargets, messages, summary);
    const run = await finalizeRun(mode, startedAt, messages, summary, pushSuccesses);
    return run;
  } catch (error) {
    const run = failedRun(mode, startedAt, messages, summary, error);
    await mutateStore((data) => {
      data.syncRuns.unshift(run);
      data.syncRuns = data.syncRuns.slice(0, 100);
      data.schedule.lastRunAt = run.finishedAt;
      data.schedule.nextRunAt = computeNextRun(data.schedule.enabled, data.schedule.intervalMinutes);
    });
    return run;
  }
}

async function pullRemoteQuantities(messages: string[], summary: SyncSummary) {
  const data = await store.read();
  const readings: PullReading[] = [];

  if (!adapters.some((adapter) => adapter.isConfigured())) {
    summary.warnings += 1;
    messages.push("No marketplace credentials are configured; local inventory was left unchanged.");
  }

  for (const item of data.items.filter((candidate) => candidate.active !== false)) {
    summary.itemsChecked += 1;

    for (const platform of platforms) {
      const mapping = item.mappings[platform];
      if (!mapping?.enabled) continue;

      const adapter = adapterByPlatform[platform];
      if (!adapter.isConfigured()) {
        summary.warnings += 1;
        messages.push(`${item.sku}: ${adapter.label} is enabled but missing ${adapter.missingEnv().join(", ")}.`);
        continue;
      }

      if (!adapter.hasRequiredMapping(item, mapping)) {
        summary.warnings += 1;
        messages.push(
          `${item.sku}: ${adapter.label} mapping is missing ${adapter.missingMapping(item, mapping).join(", ")}.`
        );
        continue;
      }

      try {
        const reading = await adapter.pullQuantity(item, mapping);
        readings.push({ ...reading, itemId: item.id });
      } catch (error) {
        summary.errors += 1;
        messages.push(`${item.sku}: ${adapter.label} pull failed: ${errorMessage(error)}`);
      }
    }
  }

  return readings;
}

async function applySalesAndPlanPushes(
  readings: PullReading[],
  messages: string[],
  summary: SyncSummary
) {
  const salesByItem = new Map<string, { units: number; notes: string[] }>();
  const pushableMappings = new Set<string>();

  const result = await mutateStore((data) => {
    const instructionUses: InstructionSaleUse[] = [];

    for (const reading of readings) {
      const item = data.items.find((candidate) => candidate.id === reading.itemId);
      const mapping = item?.mappings[reading.platform];
      if (!item || !mapping) continue;

      const lastSynced = mapping.lastSyncedQuantity;
      mapping.lastRemoteQuantity = reading.quantity;
      mapping.warning = null;

      if (typeof lastSynced !== "number") {
        const note = `${platformLabels[reading.platform]} baseline captured at ${reading.quantity}`;
        mapping.lastSyncedQuantity = reading.quantity;
        mapping.lastSyncedAt = now();
        mapping.warning = note;
        data.events.unshift(makeEvent(item, "sync_baseline", 0, item.quantity, "sync", note, reading.platform));
        summary.warnings += 1;
        messages.push(`${item.sku}: ${note}; confirm local count before the next push.`);
        continue;
      }

      pushableMappings.add(pushKey(item.id, reading.platform));

      if (reading.quantity < lastSynced) {
        const sold = lastSynced - reading.quantity;
        const current = salesByItem.get(item.id) ?? { units: 0, notes: [] };
        current.units += sold;
        current.notes.push(`${platformLabels[reading.platform]} sold ${sold}`);
        salesByItem.set(item.id, current);
        mapping.lastSyncedQuantity = reading.quantity;
        mapping.lastSyncedAt = now();
      }

      if (reading.quantity > lastSynced) {
        const note = `${platformLabels[reading.platform]} quantity increased from ${lastSynced} to ${reading.quantity}; local count remains authoritative.`;
        mapping.warning = note;
        summary.warnings += 1;
        messages.push(`${item.sku}: ${note}`);
      }
    }

    for (const [itemId, sale] of salesByItem.entries()) {
      const item = data.items.find((candidate) => candidate.id === itemId);
      if (!item) continue;

      const nextQuantity = Math.max(0, item.quantity - sale.units);
      if (sale.units > item.quantity) {
        summary.warnings += 1;
        messages.push(`${item.sku}: detected ${sale.units} platform sales but only ${item.quantity} were on hand.`);
      }

      item.quantity = nextQuantity;
      item.updatedAt = now();
      summary.salesDetected += sale.units;
      data.events.unshift(
        makeEvent(item, "platform_sale", -sale.units, nextQuantity, "sync", sale.notes.join("; "))
      );
      instructionUses.push({ sku: item.sku, units: sale.units });
      messages.push(`${item.sku}: subtracted ${sale.units} from platform sales.`);
    }

    const targets: PushTarget[] = [];
    for (const reading of readings) {
      const item = data.items.find((candidate) => candidate.id === reading.itemId);
      if (!item) continue;

      const platform = reading.platform;
      const mapping = item.mappings[platform];
      const adapter = adapterByPlatform[platform];
      if (!mapping?.enabled || !adapter.isConfigured() || !adapter.hasRequiredMapping(item, mapping)) continue;
      if (!pushableMappings.has(pushKey(item.id, platform))) continue;
      if (reading.quantity === item.quantity) continue;

      const pushBlockReason = adapter.pushBlockReason?.(item, mapping);
      if (pushBlockReason) {
        messages.push(`${item.sku}: ${adapter.label} ${pushBlockReason}.`);
        continue;
      }

      targets.push({ itemId: item.id, platform, quantity: item.quantity });
    }

    data.events = data.events.slice(0, 500);
    return { targets, instructionUses };
  });

  await consumeInstructionsForSales(result.instructionUses, messages, summary);

  return result.targets;
}

async function consumeInstructionsForSales(
  instructionUses: InstructionSaleUse[],
  messages: string[],
  summary: SyncSummary
) {
  for (const usage of instructionUses) {
    try {
      const result = await consumeInstructionForSku(
        usage.sku,
        usage.units,
        `Marketplace sale for ${usage.sku}`
      );

      if (result.status === "recorded") {
        messages.push(`${usage.sku}: used ${usage.units} ${result.instruction.label} instruction${usage.units === 1 ? "" : "s"}.`);
        continue;
      }

      if (result.status === "missing") {
        summary.warnings += 1;
        messages.push(`${usage.sku}: no instruction mapping matched; instruction inventory was not changed.`);
      }
    } catch (error) {
      summary.warnings += 1;
      messages.push(`${usage.sku}: instruction inventory was not changed: ${errorMessage(error)}`);
    }
  }
}

async function pushCanonicalQuantities(
  targets: PushTarget[],
  messages: string[],
  summary: SyncSummary
) {
  const data = await store.read();
  const successes: PushSuccess[] = [];

  for (const target of targets) {
    const item = data.items.find((candidate) => candidate.id === target.itemId);
    if (!item) continue;

    const mapping = item.mappings[target.platform];
    if (!mapping) continue;

    const adapter = adapterByPlatform[target.platform];
    try {
      await adapter.pushQuantity(item, mapping, target.quantity);
      summary.pushes += 1;
      successes.push({ ...target, at: now() });
    } catch (error) {
      summary.errors += 1;
      messages.push(`${item.sku}: ${adapter.label} push failed: ${errorMessage(error)}`);
    }
  }

  return successes;
}

async function finalizeRun(
  mode: SyncMode,
  startedAt: string,
  messages: string[],
  summary: SyncSummary,
  pushSuccesses: PushSuccess[]
) {
  const finishedAt = now();
  const status = summary.errors > 0 || summary.warnings > 0 ? "completed_with_warnings" : "completed";

  const run: SyncRun = {
    id: randomUUID(),
    mode,
    status,
    startedAt,
    finishedAt,
    summary,
    messages: messages.length ? messages : ["Sync completed."]
  };

  await mutateStore((data) => {
    for (const success of pushSuccesses) {
      const item = data.items.find((candidate) => candidate.id === success.itemId);
      const mapping = item?.mappings[success.platform];
      if (!item || !mapping) continue;

      mapping.lastSyncedQuantity = success.quantity;
      mapping.lastRemoteQuantity = success.quantity;
      mapping.lastSyncedAt = success.at;
      mapping.warning = null;
      data.events.unshift(
        makeEvent(
          item,
          "sync_push",
          0,
          item.quantity,
          "sync",
          `${platformLabels[success.platform]} set to ${success.quantity}`,
          success.platform
        )
      );
    }

    data.syncRuns.unshift(run);
    data.syncRuns = data.syncRuns.slice(0, 100);
    data.events = data.events.slice(0, 500);
    data.schedule.lastRunAt = finishedAt;
    data.schedule.nextRunAt = computeNextRun(data.schedule.enabled, data.schedule.intervalMinutes);
  });

  return run;
}

function failedRun(
  mode: SyncMode,
  startedAt: string,
  messages: string[],
  summary: SyncSummary,
  error: unknown
): SyncRun {
  const finishedAt = now();
  return {
    id: randomUUID(),
    mode,
    status: "failed",
    startedAt,
    finishedAt,
    summary: { ...summary, errors: summary.errors + 1 },
    messages: [...messages, errorMessage(error)]
  };
}

export function computeNextRun(enabled: boolean, intervalMinutes: number) {
  if (!enabled) return null;
  return new Date(Date.now() + intervalMinutes * 60_000).toISOString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function mutateStore<T>(mutator: (data: StoreData) => T | Promise<T>) {
  const mutate = store.mutateChanges?.bind(store) ?? store.mutate.bind(store);
  return mutate(mutator);
}
