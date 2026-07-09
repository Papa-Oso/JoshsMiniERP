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
    await pool.query("DROP TABLE IF EXISTS sync_run_messages");
    await pool.query("DROP TABLE IF EXISTS sync_runs");
    await pool.query("DROP TABLE IF EXISTS inventory_events");
    await pool.query("DROP TABLE IF EXISTS platform_mappings");
    await pool.query("DROP TABLE IF EXISTS inventory_items");
    await pool.query("DROP TABLE IF EXISTS schedule_settings");

    await assertInventoryStoreContract(store);
  } finally {
    await store.close();
    await pool.end();
  }
});
