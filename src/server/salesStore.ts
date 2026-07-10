import fs from "node:fs/promises";
import path from "node:path";
import initSqlJs from "sql.js";
import type { Database, SqlValue } from "sql.js";
import type { Platform, SalesOrder } from "../shared/types";
import { config } from "./config";
import { sqliteDatabase } from "./sqliteDatabase";

const database = sqliteDatabase(config.databaseFile);
const legacySalesFile = path.resolve(process.env.SALES_DATABASE_FILE || "data/sales.sqlite");
let migrationChecked: Promise<void> | undefined;

export async function upsertSalesOrders(platform: Platform, orders: SalesOrder[]) {
  await ensureLegacySalesMigrated();
  const seenAt = new Date().toISOString();
  await database.write((db) => {
    ensureSchema(db);
    db.run("BEGIN");
    try {
      for (const order of orders) upsertOrder(db, platform, order, seenAt);
      db.run(`INSERT INTO sales_pulls (platform, pulled_at, orders_seen, status, message) VALUES (?, ?, ?, 'success', '')`, [platform, seenAt, orders.length]);
      db.run("COMMIT");
    } catch (error) { db.run("ROLLBACK"); throw error; }
  });
  return { platform, ordersSeen: orders.length, pulledAt: seenAt };
}

export async function recordSalesPullFailure(platform: Platform, message: string) {
  await ensureLegacySalesMigrated();
  await database.write((db) => {
    ensureSchema(db);
    db.run(`INSERT INTO sales_pulls (platform, pulled_at, orders_seen, status, message) VALUES (?, ?, 0, 'error', ?)`, [platform, new Date().toISOString(), message.slice(0, 500)]);
  });
}

export async function loadSalesOrders() {
  await ensureLegacySalesMigrated();
  return database.read((db) => {
    ensureSchema(db);
    const orders = queryRows(db, "SELECT * FROM sales_orders ORDER BY created_at DESC").map(rowToOrder);
    const lines = queryRows(db, "SELECT * FROM sales_line_items ORDER BY platform, order_id, line_id");
    const byOrder = new Map<string, SalesOrder["lineItems"]>();
    for (const row of lines) {
      const key = `${row.platform}:${row.order_id}`;
      const collection = byOrder.get(key) ?? [];
      collection.push({ platform: String(row.platform) as Platform, orderId: String(row.order_id), lineId: String(row.line_id), sku: String(row.sku ?? ""), title: String(row.title ?? ""), quantity: Number(row.quantity ?? 0), amount: Number(row.amount ?? 0) });
      byOrder.set(key, collection);
    }
    return orders.map((order) => ({ ...order, lineItems: byOrder.get(`${order.platform}:${order.orderId}`) ?? [] }));
  });
}

export async function loadSalesPulls() {
  await ensureLegacySalesMigrated();
  return database.read((db) => { ensureSchema(db); return queryRows(db, "SELECT platform, pulled_at, orders_seen, status, message FROM sales_pulls ORDER BY pulled_at DESC"); });
}

async function ensureLegacySalesMigrated() {
  migrationChecked ??= migrateLegacySales();
  return migrationChecked;
}

async function migrateLegacySales() {
  if (path.resolve(config.databaseFile) === legacySalesFile) return;
  let raw: Buffer;
  try { raw = await fs.readFile(legacySalesFile); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  const SQL = await initSqlJs({ locateFile: (file) => path.resolve("node_modules", "sql.js", "dist", file) });
  const legacy = new SQL.Database(raw);
  try {
    const legacyOrders = queryRows(legacy, "SELECT * FROM sales_orders");
    const legacyLines = queryRows(legacy, "SELECT * FROM sales_line_items");
    const legacyPulls = queryRows(legacy, "SELECT * FROM sales_pulls");
    if (!legacyOrders.length && !legacyLines.length && !legacyPulls.length) return;
    await database.write((db) => {
      ensureSchema(db);
      for (const row of legacyOrders) db.run(
        `INSERT OR IGNORE INTO sales_orders (platform, order_id, order_number, created_at, updated_at, status, currency, gross_amount, net_amount, country_code, region_code, item_count, source_url, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.platform, row.order_id, row.order_number, row.created_at, row.updated_at, row.status, row.currency, row.gross_amount, row.net_amount, row.country_code, row.region_code, row.item_count, row.source_url, row.last_seen_at]
      );
      for (const row of legacyLines) db.run(`INSERT OR IGNORE INTO sales_line_items (platform, order_id, line_id, sku, title, quantity, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`, [row.platform, row.order_id, row.line_id, row.sku, row.title, row.quantity, row.amount]);
      for (const row of legacyPulls) db.run(`INSERT INTO sales_pulls (platform, pulled_at, orders_seen, status, message) VALUES (?, ?, ?, ?, ?)`, [row.platform, row.pulled_at, row.orders_seen, row.status, row.message]);
    });
    const migrated = await loadCanonicalOrderCount();
    if (migrated < legacyOrders.length) throw new Error(`Sales migration verification failed: expected at least ${legacyOrders.length} orders, found ${migrated}.`);
    await fs.rename(legacySalesFile, `${legacySalesFile}.migrated-${new Date().toISOString().replace(/[-:.]/g, "")}`);
  } finally { legacy.close(); }
}

async function loadCanonicalOrderCount() {
  return database.read((db) => { ensureSchema(db); return Number(queryRows(db, "SELECT COUNT(*) AS count FROM sales_orders")[0]?.count ?? 0); });
}

function upsertOrder(db: Database, platform: Platform, order: SalesOrder, seenAt: string) {
  db.run(`INSERT INTO sales_orders (platform, order_id, order_number, created_at, updated_at, status, currency, gross_amount, net_amount, country_code, region_code, item_count, source_url, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, order_id) DO UPDATE SET order_number=excluded.order_number, created_at=excluded.created_at, updated_at=excluded.updated_at, status=excluded.status, currency=excluded.currency, gross_amount=excluded.gross_amount, net_amount=excluded.net_amount, country_code=excluded.country_code, region_code=excluded.region_code, item_count=excluded.item_count, source_url=excluded.source_url, last_seen_at=excluded.last_seen_at`,
    [platform, order.orderId, order.orderNumber, order.createdAt, order.updatedAt, order.status, order.currency, order.grossAmount, order.netAmount, order.countryCode, order.regionCode, order.itemCount, order.sourceUrl, seenAt]);
  db.run("DELETE FROM sales_line_items WHERE platform = ? AND order_id = ?", [platform, order.orderId]);
  for (const line of order.lineItems) db.run(`INSERT INTO sales_line_items (platform, order_id, line_id, sku, title, quantity, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`, [platform, order.orderId, line.lineId, line.sku, line.title, line.quantity, line.amount]);
}

function ensureSchema(db: Database) { db.run(schema); }
function queryRows(db: Database, sql: string): Array<Record<string, SqlValue>> { const result=db.exec(sql)[0]; return result ? result.values.map(values=>Object.fromEntries(result.columns.map((column,index)=>[column,values[index]]))) : []; }
function rowToOrder(row: Record<string, SqlValue>): SalesOrder { return { platform:String(row.platform) as Platform, orderId:String(row.order_id), orderNumber:String(row.order_number??""), createdAt:String(row.created_at), updatedAt:String(row.updated_at), status:String(row.status??""), currency:String(row.currency??"USD"), grossAmount:Number(row.gross_amount??0), netAmount:Number(row.net_amount??0), countryCode:String(row.country_code??""), regionCode:String(row.region_code??""), itemCount:Number(row.item_count??0), sourceUrl:String(row.source_url??""), lineItems:[] }; }

const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS sales_orders (platform TEXT NOT NULL, order_id TEXT NOT NULL, order_number TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT 'USD', gross_amount REAL NOT NULL DEFAULT 0, net_amount REAL NOT NULL DEFAULT 0, country_code TEXT NOT NULL DEFAULT '', region_code TEXT NOT NULL DEFAULT '', item_count INTEGER NOT NULL DEFAULT 0, source_url TEXT NOT NULL DEFAULT '', last_seen_at TEXT NOT NULL, PRIMARY KEY (platform, order_id));
CREATE TABLE IF NOT EXISTS sales_line_items (platform TEXT NOT NULL, order_id TEXT NOT NULL, line_id TEXT NOT NULL, sku TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', quantity INTEGER NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0, PRIMARY KEY (platform, order_id, line_id), FOREIGN KEY (platform, order_id) REFERENCES sales_orders(platform, order_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS sales_pulls (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, pulled_at TEXT NOT NULL, orders_seen INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_sales_orders_created ON sales_orders(created_at DESC); CREATE INDEX IF NOT EXISTS idx_sales_orders_country ON sales_orders(country_code); CREATE INDEX IF NOT EXISTS idx_sales_lines_sku ON sales_line_items(sku);`;
