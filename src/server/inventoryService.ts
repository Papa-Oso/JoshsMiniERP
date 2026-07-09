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
import { defaultMaxInventory, platformLabels, platforms } from "../shared/types";
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

const normalizeMaxInventory = (value: number) => {
  const maxInventory = Number(value);
  if (!Number.isInteger(maxInventory)) {
    throw new Error("Max inventory must be a whole number.");
  }
  if (maxInventory < 1) {
    throw new Error("Max inventory must be at least 1.");
  }
  return maxInventory;
};

const normalizeDelta = (value: number) => {
  if (!Number.isInteger(value) || value === 0) {
    throw new Error("Adjustment must be a non-zero whole number.");
  }
  return value;
};

export async function listData() {
  const data = await store.read();
  return {
    ...data,
    items: data.items.map(normalizeItem)
  };
}

export async function createItem(input: CreateItemInput) {
  const sku = clean(input.sku)?.toUpperCase();
  const name = clean(input.name);
  const description = clean(input.description);
  const quantity = normalizeQuantity(Number(input.quantity));
  const safetyStock = Math.max(0, Number(input.safetyStock ?? 0));
  const maxInventory =
    input.maxInventory === undefined ? defaultMaxInventory : normalizeMaxInventory(Number(input.maxInventory));

  if (!sku) throw new Error("SKU is required.");
  if (!name) throw new Error("Name is required.");

  const createInData = (data: StoreData) => {
    assertSkuAvailable(data, sku);
    const timestamp = now();
    const item: InventoryItem = {
      id: randomUUID(),
      sku,
      name,
      description,
      quantity,
      safetyStock,
      maxInventory,
      active: true,
      mappings: {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const event = makeEvent(item, "create", quantity, quantity, "local", input.quantity ? "Initial count" : undefined);

    data.items.unshift(item);
    data.events.unshift(event);
    trimHistory(data);
    return { item, event };
  };

  const saveItemWithEvent = store.saveItemWithEvent?.bind(store);
  if (saveItemWithEvent) {
    return store.withLock(async () => {
      const { item, event } = createInData(await store.read());
      await saveItemWithEvent(item, event);
      return item;
    });
  }

  return store.mutate((data) => createInData(data).item);
}

export async function updateItem(id: string, input: UpdateItemInput) {
  const updateInData = (data: StoreData) => {
    const item = findItem(data, id);
    const nextSku = clean(input.sku)?.toUpperCase();

    if (nextSku && nextSku !== item.sku) {
      assertSkuAvailable(data, nextSku, id);
      item.sku = nextSku;
    }

    const nextName = clean(input.name);
    if (nextName) item.name = nextName;

    if (input.description !== undefined) {
      const nextDescription = clean(input.description);
      if (nextDescription) {
        item.description = nextDescription;
      } else {
        delete item.description;
      }
    }

    if (input.safetyStock !== undefined) {
      item.safetyStock = Math.max(0, Number(input.safetyStock));
    }

    if (input.maxInventory !== undefined) {
      item.maxInventory = normalizeMaxInventory(Number(input.maxInventory));
    }

    if (input.active !== undefined) {
      item.active = Boolean(input.active);
    }

    if (input.mappings) {
      item.mappings = mergeMappings(item.mappings, input.mappings);
    }

    item.updatedAt = now();
    return item;
  };

  const saveItem = store.saveItem?.bind(store);
  if (saveItem) {
    return store.withLock(async () => {
      const item = updateInData(await store.read());
      await saveItem(item);
      return item;
    });
  }

  return store.mutate(updateInData);
}

export async function deleteItem(id: string) {
  const deleteInData = (data: StoreData) => {
    const item = findItem(data, id);
    item.active = false;
    item.updatedAt = now();
    return item;
  };

  const saveItem = store.saveItem?.bind(store);
  if (saveItem) {
    return store.withLock(async () => {
      const item = deleteInData(await store.read());
      await saveItem(item);
      return item;
    });
  }

  return store.mutate(deleteInData);
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

  const adjustInData = (data: StoreData) => {
    const item = findItem(data, id);
    const nextQuantity = item.quantity + delta;
    if (nextQuantity < 0) {
      throw new Error(`Cannot subtract ${Math.abs(delta)} from ${item.quantity} on hand.`);
    }

    item.quantity = nextQuantity;
    item.updatedAt = now();
    const event = makeEvent(item, eventType, delta, nextQuantity, "local", clean(input.note));
    data.events.unshift(event);
    trimHistory(data);
    return { item, event };
  };

  const saveItemWithEvent = store.saveItemWithEvent?.bind(store);
  if (saveItemWithEvent) {
    return store.withLock(async () => {
      const { item, event } = adjustInData(await store.read());
      await saveItemWithEvent(item, event);
      return item;
    });
  }

  return store.mutate((data) => adjustInData(data).item);
}

export async function updateSchedule(input: UpdateScheduleInput) {
  const updateScheduleInData = (data: StoreData) => {
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
  };

  const saveSchedule = store.saveSchedule?.bind(store);
  if (saveSchedule) {
    return store.withLock(async () => {
      const schedule = updateScheduleInData(await store.read());
      await saveSchedule(schedule);
      return schedule;
    });
  }

  return store.mutate(updateScheduleInData);
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
  if (item.active === undefined) item.active = true;
  item.maxInventory = storedMaxInventory(item.maxInventory);
  return item;
}

function assertSkuAvailable(data: StoreData, sku: string, currentItemId?: string) {
  if (data.items.some((item) => item.id !== currentItemId && item.sku.toUpperCase() === sku)) {
    throw new Error(`SKU ${sku} already exists.`);
  }
}

function normalizeItem(item: InventoryItem): InventoryItem {
  return {
    ...item,
    maxInventory: storedMaxInventory(item.maxInventory),
    active: item.active !== false
  };
}

function storedMaxInventory(value: unknown) {
  const maxInventory = Number(value);
  return Number.isInteger(maxInventory) && maxInventory >= 1 ? maxInventory : defaultMaxInventory;
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
