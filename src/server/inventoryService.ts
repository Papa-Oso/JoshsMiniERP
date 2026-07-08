import { randomUUID } from "node:crypto";
import type {
  AdjustInventoryInput,
  CreateItemInput,
  InventoryEvent,
  InventoryEventType,
  InventoryItem,
  Platform,
  PlatformMapping,
  StoreData,
  UpdateItemInput,
  UpdateScheduleInput
} from "../shared/types";
import { platformLabels, platforms } from "../shared/types";
import { store } from "./store";

const now = () => new Date().toISOString();

const clean = (value?: string) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeQuantity = (value: number) => {
  if (!Number.isInteger(value)) {
    throw new Error("Quantity must be a whole number.");
  }
  if (value < 0) {
    throw new Error("Quantity cannot be negative.");
  }
  return value;
};

const normalizeDelta = (value: number) => {
  if (!Number.isInteger(value) || value === 0) {
    throw new Error("Adjustment must be a non-zero whole number.");
  }
  return value;
};

export async function listData() {
  return store.read();
}

export async function createItem(input: CreateItemInput) {
  const sku = clean(input.sku)?.toUpperCase();
  const name = clean(input.name);
  const quantity = normalizeQuantity(Number(input.quantity));
  const safetyStock = Math.max(0, Number(input.safetyStock ?? 0));

  if (!sku) throw new Error("SKU is required.");
  if (!name) throw new Error("Name is required.");

  return store.mutate((data) => {
    if (data.items.some((item) => item.sku.toUpperCase() === sku)) {
      throw new Error(`SKU ${sku} already exists.`);
    }

    const timestamp = now();
    const item: InventoryItem = {
      id: randomUUID(),
      sku,
      name,
      quantity,
      safetyStock,
      mappings: {},
      createdAt: timestamp,
      updatedAt: timestamp
    };

    data.items.unshift(item);
    data.events.unshift(
      makeEvent(item, "create", quantity, quantity, "local", input.quantity ? "Initial count" : undefined)
    );
    trimHistory(data);
    return item;
  });
}

export async function updateItem(id: string, input: UpdateItemInput) {
  return store.mutate((data) => {
    const item = findItem(data, id);
    const nextSku = clean(input.sku)?.toUpperCase();

    if (nextSku && nextSku !== item.sku) {
      if (data.items.some((candidate) => candidate.id !== id && candidate.sku.toUpperCase() === nextSku)) {
        throw new Error(`SKU ${nextSku} already exists.`);
      }
      item.sku = nextSku;
    }

    const nextName = clean(input.name);
    if (nextName) item.name = nextName;

    if (input.safetyStock !== undefined) {
      item.safetyStock = Math.max(0, Number(input.safetyStock));
    }

    if (input.mappings) {
      item.mappings = mergeMappings(item.mappings, input.mappings);
    }

    item.updatedAt = now();
    return item;
  });
}

export async function adjustInventory(id: string, input: AdjustInventoryInput) {
  const delta = normalizeDelta(Number(input.delta));
  const eventType = input.type ?? (delta > 0 ? "batch_add" : "manual_subtract");

  if (eventType === "batch_add" && delta < 0) {
    throw new Error("Batch add must increase inventory.");
  }
  if (eventType === "manual_subtract" && delta > 0) {
    throw new Error("Manual subtract must reduce inventory.");
  }

  return store.mutate((data) => {
    const item = findItem(data, id);
    const nextQuantity = item.quantity + delta;
    if (nextQuantity < 0) {
      throw new Error(`Cannot subtract ${Math.abs(delta)} from ${item.quantity} on hand.`);
    }

    item.quantity = nextQuantity;
    item.updatedAt = now();
    data.events.unshift(makeEvent(item, eventType, delta, nextQuantity, "local", clean(input.note)));
    trimHistory(data);
    return item;
  });
}

export async function updateSchedule(input: UpdateScheduleInput) {
  return store.mutate((data) => {
    if (input.enabled !== undefined) {
      data.schedule.enabled = Boolean(input.enabled);
    }

    if (input.intervalMinutes !== undefined) {
      const interval = Number(input.intervalMinutes);
      if (!Number.isInteger(interval) || interval < 5 || interval > 1440) {
        throw new Error("Schedule interval must be between 5 and 1440 minutes.");
      }
      data.schedule.intervalMinutes = interval;
    }

    data.schedule.updatedAt = now();
    return data.schedule;
  });
}

export function makeEvent(
  item: InventoryItem,
  type: InventoryEventType,
  delta: number,
  quantityAfter: number,
  source: InventoryEvent["source"],
  note?: string,
  platform?: Platform
): InventoryEvent {
  return {
    id: randomUUID(),
    itemId: item.id,
    sku: item.sku,
    type,
    delta,
    quantityAfter,
    source,
    platform,
    note,
    createdAt: now()
  };
}

function findItem(data: StoreData, id: string) {
  const item = data.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error("Item not found.");
  return item;
}

function mergeMappings(
  current: InventoryItem["mappings"],
  incoming: Partial<Record<Platform, PlatformMapping>>
) {
  const merged = { ...current };

  for (const platform of platforms) {
    if (!incoming[platform]) continue;
    const next = incoming[platform]!;
    const previous = current[platform] ?? { enabled: false };
    const resolved: PlatformMapping = {
      ...previous,
      enabled: Boolean(next.enabled),
      remoteSku: clean(next.remoteSku) ?? previous.remoteSku,
      listingId: clean(next.listingId) ?? previous.listingId,
      inventoryItemId: clean(next.inventoryItemId) ?? previous.inventoryItemId,
      locationId: clean(next.locationId) ?? previous.locationId,
      offerId: clean(next.offerId) ?? previous.offerId,
      lastSyncedQuantity:
        next.lastSyncedQuantity !== undefined ? next.lastSyncedQuantity : previous.lastSyncedQuantity ?? null,
      lastRemoteQuantity:
        next.lastRemoteQuantity !== undefined ? next.lastRemoteQuantity : previous.lastRemoteQuantity ?? null,
      lastSyncedAt: next.lastSyncedAt !== undefined ? next.lastSyncedAt : previous.lastSyncedAt ?? null,
      warning: next.warning !== undefined ? next.warning : previous.warning ?? null
    };

    if (mappingIdentityChanged(previous, resolved)) {
      resolved.lastSyncedQuantity = null;
      resolved.lastRemoteQuantity = null;
      resolved.lastSyncedAt = null;
      resolved.warning = `${platformLabels[platform]} mapping changed; next sync will capture a fresh baseline.`;
    }

    merged[platform] = {
      ...resolved
    };
  }

  return merged;
}

function mappingIdentityChanged(previous: PlatformMapping, next: PlatformMapping) {
  return (
    previous.remoteSku !== next.remoteSku ||
    previous.listingId !== next.listingId ||
    previous.inventoryItemId !== next.inventoryItemId ||
    previous.locationId !== next.locationId ||
    previous.offerId !== next.offerId
  );
}

function trimHistory(data: StoreData) {
  data.events = data.events.slice(0, 500);
  data.syncRuns = data.syncRuns.slice(0, 100);
}
