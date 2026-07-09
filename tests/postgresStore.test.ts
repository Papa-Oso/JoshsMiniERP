import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresInventoryStore } from "../src/server/store";
import { assertInventoryStoreContract } from "./storeContract";

const { Pool } = pg;
const databaseUrl = process.env.TEST_POSTGRES_DATABASE_URL?.trim();

test("Postgres inventory store persists the inventory store contract", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresInventoryStore(databaseUrl);

  try {
    await resetPostgresStore(pool);
    await assertInventoryStoreContract(store);
  } finally {
    await store.close();
    await pool.end();
  }
});

test("Postgres inventory store updates existing item rows without deleting them", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresInventoryStore(databaseUrl);

  try {
    await resetPostgresStore(pool);
    const item = {
      id: "item-1",
      sku: "NEON-MUG",
      name: "Neon Mug",
      description: "Bright mug",
      quantity: 12,
      safetyStock: 2,
      maxInventory: 100,
      active: true,
      mappings: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    await store.saveItem(item);

    await installDeleteAudit(pool);
    await store.mutateChanges((data) => {
      data.items[0].quantity = 9;
      data.items[0].updatedAt = "2026-01-01T00:05:00.000Z";
      data.events.unshift({
        id: "event-1",
        itemId: "item-1",
        sku: "NEON-MUG",
        type: "correction",
        delta: -3,
        quantityAfter: 9,
        source: "local",
        note: "Audit adjustment",
        createdAt: "2026-01-01T00:05:00.000Z"
      });
    });

    const result = await pool.query<{ deleted: string }>(
      "SELECT count(*)::text AS deleted FROM postgres_store_delete_audit"
    );
    assert.equal(result.rows[0].deleted, "0");

    const stored = await store.read();
    assert.equal(stored.items[0].quantity, 9);
    assert.equal(stored.events[0].id, "event-1");
  } finally {
    await store.close();
    await resetPostgresStore(pool);
    await pool.end();
  }
});

async function resetPostgresStore(pool: pg.Pool) {
  await pool.query("DROP TRIGGER IF EXISTS postgres_store_delete_audit_trigger ON inventory_items").catch(() => undefined);
  await pool.query("DROP FUNCTION IF EXISTS postgres_store_delete_audit_fn");
  await pool.query("DROP TABLE IF EXISTS postgres_store_delete_audit");
  await pool.query("DROP TABLE IF EXISTS sync_run_messages");
  await pool.query("DROP TABLE IF EXISTS sync_runs");
  await pool.query("DROP TABLE IF EXISTS inventory_events");
  await pool.query("DROP TABLE IF EXISTS platform_mappings");
  await pool.query("DROP TABLE IF EXISTS inventory_items");
  await pool.query("DROP TABLE IF EXISTS schedule_settings");
}

async function installDeleteAudit(pool: pg.Pool) {
  await pool.query("DROP TABLE IF EXISTS postgres_store_delete_audit");
  await pool.query("CREATE TABLE postgres_store_delete_audit (deleted_id TEXT NOT NULL)");
  await pool.query(`
    CREATE OR REPLACE FUNCTION postgres_store_delete_audit_fn()
    RETURNS trigger AS $$
    BEGIN
      INSERT INTO postgres_store_delete_audit(deleted_id) VALUES (OLD.id);
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE TRIGGER postgres_store_delete_audit_trigger
    AFTER DELETE ON inventory_items
    FOR EACH ROW EXECUTE FUNCTION postgres_store_delete_audit_fn()
  `);
}
