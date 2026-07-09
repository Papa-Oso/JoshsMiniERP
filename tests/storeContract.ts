import assert from "node:assert/strict";
import type { InventoryStoreDriver } from "../src/server/store";

const timestamp = "2026-01-01T00:00:00.000Z";

export async function assertInventoryStoreContract(store: InventoryStoreDriver) {
  const initial = await store.read();
  assert.deepEqual(initial.items, []);
  assert.deepEqual(initial.events, []);
  assert.deepEqual(initial.syncRuns, []);
  assert.equal(initial.schedule.enabled, false);

  await store.mutate((data) => {
    data.items.unshift({
      id: "item-1",
      sku: "NEON-MUG",
      name: "Neon Mug",
      description: "Bright mug",
      quantity: 12,
      safetyStock: 2,
      maxInventory: 100,
      active: true,
      mappings: {
        shopify: {
          enabled: true,
          remoteSku: "NEON-MUG",
          inventoryItemId: "gid://shopify/InventoryItem/1",
          locationId: "gid://shopify/Location/1",
          lastSyncedQuantity: 12,
          lastRemoteQuantity: 12,
          lastSyncedAt: timestamp,
          warning: null
        }
      },
      createdAt: timestamp,
      updatedAt: timestamp
    });

    data.events.unshift({
      id: "event-1",
      itemId: "item-1",
      sku: "NEON-MUG",
      type: "create",
      delta: 12,
      quantityAfter: 12,
      source: "local",
      note: "Initial count",
      createdAt: timestamp
    });

    data.syncRuns.unshift({
      id: "sync-1",
      mode: "manual",
      status: "completed",
      startedAt: timestamp,
      finishedAt: timestamp,
      summary: {
        itemsChecked: 1,
        salesDetected: 0,
        pushes: 1,
        warnings: 0,
        errors: 0
      },
      messages: ["Sync completed."]
    });

    data.schedule.enabled = true;
    data.schedule.intervalMinutes = 30;
    data.schedule.lastRunAt = timestamp;
    data.schedule.nextRunAt = "2026-01-01T00:30:00.000Z";
    data.schedule.updatedAt = timestamp;
  });

  const stored = await store.read();
  assert.equal(stored.items.length, 1);
  assert.equal(stored.items[0].sku, "NEON-MUG");
  assert.equal(stored.items[0].maxInventory, 100);
  assert.equal(stored.items[0].mappings.shopify?.enabled, true);
  assert.equal(stored.items[0].mappings.shopify?.lastSyncedQuantity, 12);
  assert.equal(stored.events.length, 1);
  assert.equal(stored.events[0].note, "Initial count");
  assert.equal(stored.syncRuns.length, 1);
  assert.deepEqual(stored.syncRuns[0].messages, ["Sync completed."]);
  assert.equal(stored.schedule.enabled, true);
  assert.equal(stored.schedule.intervalMinutes, 30);

  await store.withLock(async () => {
    await store.mutate((data) => {
      data.items[0].quantity = 9;
      data.items[0].updatedAt = "2026-01-01T00:05:00.000Z";
      data.items[0].mappings.shopify!.lastSyncedQuantity = 9;
      data.items[0].mappings.shopify!.lastRemoteQuantity = 9;
      data.events.unshift({
        id: "event-2",
        itemId: "item-1",
        sku: "NEON-MUG",
        type: "platform_sale",
        delta: -3,
        quantityAfter: 9,
        source: "sync",
        platform: "shopify",
        note: "Shopify sold 3",
        createdAt: "2026-01-01T00:05:00.000Z"
      });
    });
  });

  const updated = await store.read();
  assert.equal(updated.items[0].quantity, 9);
  assert.equal(updated.items[0].mappings.shopify?.lastRemoteQuantity, 9);
  assert.equal(updated.events.length, 2);
  assert.equal(updated.events[0].type, "platform_sale");
  assert.equal(updated.events[0].platform, "shopify");

  await store.mutate((data) => {
    data.items[0].mappings = {};
    data.events = data.events.slice(0, 1);
    data.syncRuns = [];
    data.schedule.enabled = false;
    data.schedule.updatedAt = "2026-01-01T00:10:00.000Z";
  });

  const pruned = await store.read();
  assert.equal(pruned.items.length, 1);
  assert.deepEqual(pruned.items[0].mappings, {});
  assert.equal(pruned.events.length, 1);
  assert.equal(pruned.events[0].id, "event-2");
  assert.equal(pruned.syncRuns.length, 0);
  assert.equal(pruned.schedule.enabled, false);
}
