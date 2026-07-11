import fs from "node:fs/promises";
import path from "node:path";
import initSqlJs from "sql.js";
import type { Database, SqlValue } from "sql.js";
import type { Platform, SalesOrder, SalesRefund } from "../shared/types";
import { config } from "./config";
import { sqliteDatabase } from "./sqliteDatabase";

const database = sqliteDatabase(config.databaseFile);
const legacySalesFile = path.resolve(process.env.SALES_DATABASE_FILE || "data/sales.sqlite");
let migrationChecked: Promise<void> | undefined;

export type EbayFinancialTransaction = {
  transactionKey: string;
  transactionDate: string;
  type: string;
  orderId: string;
  legacyOrderId: string;
  transactionId: string;
  referenceId: string;
  payoutId: string;
  payoutDate: string;
  payoutStatus: string;
  itemId: string;
  title: string;
  sku: string;
  quantity: number;
  itemSubtotal: number;
  shippingAmount: number;
  taxAmount: number;
  feeAmount: number;
  grossAmount: number;
  netAmount: number;
  currency: string;
};

export async function upsertEbayTransactions(rows: EbayFinancialTransaction[]) {
  await ensureLegacySalesMigrated();
  await database.write((db) => {
    ensureSchema(db);
    db.run("BEGIN");
    try {
      for (const row of rows)
        db.run(
          `INSERT INTO ebay_financial_transactions (transaction_key, transaction_date, type, order_id, legacy_order_id, transaction_id, reference_id, payout_id, payout_date, payout_status, item_id, title, sku, quantity, item_subtotal, shipping_amount, tax_amount, fee_amount, gross_amount, net_amount, currency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(transaction_key) DO UPDATE SET payout_status=excluded.payout_status, net_amount=excluded.net_amount`,
          [
            row.transactionKey,
            row.transactionDate,
            row.type,
            row.orderId,
            row.legacyOrderId,
            row.transactionId,
            row.referenceId,
            row.payoutId,
            row.payoutDate,
            row.payoutStatus,
            row.itemId,
            row.title,
            row.sku,
            row.quantity,
            row.itemSubtotal,
            row.shippingAmount,
            row.taxAmount,
            row.feeAmount,
            row.grossAmount,
            row.netAmount,
            row.currency
          ]
        );
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
  });
}

export async function upsertSalesOrders(platform: Platform, orders: SalesOrder[]) {
  await ensureLegacySalesMigrated();
  const seenAt = new Date().toISOString();
  await database.write((db) => {
    ensureSchema(db);
    db.run("BEGIN");
    try {
      for (const order of orders) upsertOrder(db, platform, order, seenAt);
      db.run(
        `INSERT INTO sales_pulls (platform, pulled_at, orders_seen, status, message) VALUES (?, ?, ?, 'success', '')`,
        [platform, seenAt, orders.length]
      );
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
  });
  return { platform, ordersSeen: orders.length, pulledAt: seenAt };
}

export async function applySalesImport(platform: Platform, orders: SalesOrder[], refunds: SalesRefund[]) {
  await ensureLegacySalesMigrated();
  const seenAt = new Date().toISOString();
  await database.write((db) => {
    ensureSchema(db);
    db.run("BEGIN");
    try {
      for (const order of orders) upsertOrder(db, platform, order, seenAt);
      for (const refund of refunds) upsertRefund(db, refund);
      updateRefundTotals(
        db,
        platform,
        orders.map((order) => order.orderId)
      );
      db.run(
        `INSERT INTO sales_pulls (platform, pulled_at, orders_seen, status, message) VALUES (?, ?, ?, 'success', '')`,
        [platform, seenAt, orders.length]
      );
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
  });
  return { platform, ordersSeen: orders.length, refundsSeen: refunds.length, pulledAt: seenAt };
}

export async function upsertSalesRefunds(refunds: SalesRefund[]) {
  await ensureLegacySalesMigrated();
  await database.write((db) => {
    ensureSchema(db);
    db.run("BEGIN");
    try {
      for (const refund of refunds) upsertRefund(db, refund);
      for (const platform of new Set(refunds.map((refund) => refund.platform)))
        updateRefundTotals(db, platform, [
          ...new Set(refunds.filter((refund) => refund.platform === platform).map((refund) => refund.orderId))
        ]);
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
  });
}

export async function loadSalesRefunds(): Promise<SalesRefund[]> {
  await ensureLegacySalesMigrated();
  return database.read((db) => {
    ensureSchema(db);
    return queryRows(db, "SELECT * FROM sales_refunds ORDER BY refunded_at DESC").map((row) => ({
      platform: String(row.platform) as Platform,
      orderId: String(row.order_id),
      refundId: String(row.refund_id),
      refundedAt: String(row.refunded_at),
      productAmount: Number(row.product_amount ?? 0),
      shippingAmount: Number(row.shipping_amount ?? 0),
      taxAmount: Number(row.tax_amount ?? 0),
      totalAmount: Number(row.total_amount ?? 0),
      status: String(row.status ?? ""),
      currency: String(row.currency ?? "USD"),
      componentsComplete: Number(row.components_complete ?? 0) === 1,
      source: String(row.source ?? "legacy"),
      sourceUpdatedAt: String(row.source_updated_at ?? row.refunded_at)
    }));
  });
}

export async function recordSalesPullFailure(platform: Platform, message: string) {
  await ensureLegacySalesMigrated();
  await database.write((db) => {
    ensureSchema(db);
    db.run(`INSERT INTO sales_pulls (platform, pulled_at, orders_seen, status, message) VALUES (?, ?, 0, 'error', ?)`, [
      platform,
      new Date().toISOString(),
      message.slice(0, 500)
    ]);
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
      collection.push({
        platform: String(row.platform) as Platform,
        orderId: String(row.order_id),
        lineId: String(row.line_id),
        sku: String(row.sku ?? ""),
        title: String(row.title ?? ""),
        quantity: Number(row.quantity ?? 0),
        amount: Number(row.amount ?? 0)
      });
      byOrder.set(key, collection);
    }
    return orders.map((order) => ({ ...order, lineItems: byOrder.get(`${order.platform}:${order.orderId}`) ?? [] }));
  });
}

export async function loadSalesPulls() {
  await ensureLegacySalesMigrated();
  return database.read((db) => {
    ensureSchema(db);
    return queryRows(
      db,
      "SELECT platform, pulled_at, orders_seen, status, message FROM sales_pulls ORDER BY pulled_at DESC"
    );
  });
}

export async function loadCanonicalProductNames() {
  await ensureLegacySalesMigrated();
  return database.read((db) => {
    ensureSchema(db);
    const exists =
      queryRows(db, "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='inventory_items'").length > 0;
    return exists
      ? new Map(
          queryRows(db, "SELECT sku, name, image_path FROM inventory_items WHERE active = 1").map((row) => [
            String(row.sku).toLowerCase(),
            { name: String(row.name), imagePath: String(row.image_path ?? "") }
          ])
        )
      : new Map<string, { name: string; imagePath: string }>();
  });
}

export async function loadEbayFinancialTransactions() {
  await ensureLegacySalesMigrated();
  return database.read((db) => {
    ensureSchema(db);
    return queryRows(
      db,
      "SELECT transaction_date, type, order_id, fee_amount, gross_amount, net_amount, currency FROM ebay_financial_transactions ORDER BY transaction_date DESC"
    ).map((row) => ({
      transactionDate: String(row.transaction_date),
      type: String(row.type),
      orderId: String(row.order_id ?? ""),
      feeAmount: Number(row.fee_amount ?? 0),
      grossAmount: Number(row.gross_amount ?? 0),
      netAmount: Number(row.net_amount ?? 0),
      currency: String(row.currency ?? "USD")
    }));
  });
}

async function ensureLegacySalesMigrated() {
  migrationChecked ??= migrateLegacySales();
  return migrationChecked;
}

async function migrateLegacySales() {
  if (path.resolve(config.databaseFile) === legacySalesFile) return;
  let raw: Buffer;
  try {
    raw = await fs.readFile(legacySalesFile);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const SQL = await initSqlJs({ locateFile: (file) => path.resolve("node_modules", "sql.js", "dist", file) });
  const legacy = new SQL.Database(raw);
  try {
    const legacyOrders = queryRows(legacy, "SELECT * FROM sales_orders");
    const legacyLines = queryRows(legacy, "SELECT * FROM sales_line_items");
    const legacyPulls = queryRows(legacy, "SELECT * FROM sales_pulls");
    if (!legacyOrders.length && !legacyLines.length && !legacyPulls.length) return;
    await database.write((db) => {
      ensureSchema(db);
      for (const row of legacyOrders)
        db.run(
          `INSERT OR IGNORE INTO sales_orders (platform, order_id, order_number, created_at, updated_at, status, currency, gross_amount, net_amount, country_code, region_code, item_count, source_url, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.platform,
            row.order_id,
            row.order_number,
            row.created_at,
            row.updated_at,
            row.status,
            row.currency,
            row.gross_amount,
            row.net_amount,
            row.country_code,
            row.region_code,
            row.item_count,
            row.source_url,
            row.last_seen_at
          ]
        );
      for (const row of legacyLines)
        db.run(
          `INSERT OR IGNORE INTO sales_line_items (platform, order_id, line_id, sku, title, quantity, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [row.platform, row.order_id, row.line_id, row.sku, row.title, row.quantity, row.amount]
        );
      for (const row of legacyPulls)
        db.run(`INSERT INTO sales_pulls (platform, pulled_at, orders_seen, status, message) VALUES (?, ?, ?, ?, ?)`, [
          row.platform,
          row.pulled_at,
          row.orders_seen,
          row.status,
          row.message
        ]);
    });
    const migrated = await loadCanonicalOrderCount();
    if (migrated < legacyOrders.length)
      throw new Error(
        `Sales migration verification failed: expected at least ${legacyOrders.length} orders, found ${migrated}.`
      );
    await fs.rename(legacySalesFile, `${legacySalesFile}.migrated-${new Date().toISOString().replace(/[-:.]/g, "")}`);
  } finally {
    legacy.close();
  }
}

async function loadCanonicalOrderCount() {
  return database.read((db) => {
    ensureSchema(db);
    return Number(queryRows(db, "SELECT COUNT(*) AS count FROM sales_orders")[0]?.count ?? 0);
  });
}

function upsertOrder(db: Database, platform: Platform, order: SalesOrder, seenAt: string) {
  db.run(
    `INSERT INTO sales_orders (platform, order_id, order_number, created_at, updated_at, status, currency, gross_amount, net_amount, product_amount, shipping_amount, discount_amount, tax_amount, refunded_amount, comparable_sales_amount, financial_status, canceled_at, financials_complete, financials_source, financials_updated_at, reconciliation_state, country_code, region_code, item_count, source_url, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, order_id) DO UPDATE SET order_number=excluded.order_number, created_at=excluded.created_at, updated_at=excluded.updated_at, status=excluded.status, currency=excluded.currency, gross_amount=excluded.gross_amount, net_amount=excluded.net_amount, product_amount=excluded.product_amount, shipping_amount=excluded.shipping_amount, discount_amount=excluded.discount_amount, tax_amount=excluded.tax_amount, comparable_sales_amount=excluded.comparable_sales_amount, financial_status=excluded.financial_status, canceled_at=excluded.canceled_at, financials_complete=excluded.financials_complete, financials_source=excluded.financials_source, financials_updated_at=excluded.financials_updated_at, reconciliation_state=excluded.reconciliation_state, country_code=excluded.country_code, region_code=excluded.region_code, item_count=excluded.item_count, source_url=excluded.source_url, last_seen_at=excluded.last_seen_at`,
    [
      platform,
      order.orderId,
      order.orderNumber,
      order.createdAt,
      order.updatedAt,
      order.status,
      order.currency,
      order.grossAmount,
      order.netAmount,
      order.productAmount ?? order.netAmount,
      order.shippingAmount ?? 0,
      order.discountAmount ?? 0,
      order.taxAmount ?? 0,
      order.refundedAmount ?? 0,
      order.comparableSalesAmount ?? order.netAmount,
      order.financialStatus ?? order.status,
      order.canceledAt ?? "",
      order.financialsComplete ? 1 : 0,
      order.financialsSource ?? "legacy",
      order.financialsUpdatedAt ?? order.updatedAt,
      order.reconciliationState ?? "incomplete",
      order.countryCode,
      order.regionCode,
      order.itemCount,
      order.sourceUrl,
      seenAt
    ]
  );
  db.run("DELETE FROM sales_line_items WHERE platform = ? AND order_id = ?", [platform, order.orderId]);
  for (const line of order.lineItems)
    db.run(
      `INSERT INTO sales_line_items (platform, order_id, line_id, sku, title, quantity, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [platform, order.orderId, line.lineId, line.sku, line.title, line.quantity, line.amount]
    );
}

function upsertRefund(db: Database, refund: SalesRefund) {
  db.run(
    `INSERT INTO sales_refunds (platform, order_id, refund_id, refunded_at, product_amount, shipping_amount, tax_amount, total_amount, status, currency, components_complete, source, source_updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(platform, order_id, refund_id) DO UPDATE SET refunded_at=excluded.refunded_at, product_amount=excluded.product_amount, shipping_amount=excluded.shipping_amount, tax_amount=excluded.tax_amount, total_amount=excluded.total_amount, status=excluded.status, currency=excluded.currency, components_complete=excluded.components_complete, source=excluded.source, source_updated_at=excluded.source_updated_at`,
    [
      refund.platform,
      refund.orderId,
      refund.refundId,
      refund.refundedAt,
      refund.productAmount,
      refund.shippingAmount,
      refund.taxAmount,
      refund.totalAmount,
      refund.status,
      refund.currency,
      refund.componentsComplete ? 1 : 0,
      refund.source,
      refund.sourceUpdatedAt
    ]
  );
}
function updateRefundTotals(db: Database, platform: Platform, orderIds: string[]) {
  for (const orderId of orderIds)
    db.run(
      `UPDATE sales_orders SET refunded_amount=COALESCE((SELECT SUM(product_amount+shipping_amount) FROM sales_refunds WHERE platform=? AND order_id=? AND components_complete=1 AND lower(status) NOT IN ('failed','canceled')),0), reconciliation_state=CASE WHEN EXISTS(SELECT 1 FROM sales_refunds WHERE platform=? AND order_id=? AND components_complete=0 AND lower(status) NOT IN ('failed','canceled')) THEN 'unresolved' ELSE reconciliation_state END WHERE platform=? AND order_id=?`,
      [platform, orderId, platform, orderId, platform, orderId]
    );
}

function ensureSchema(db: Database) {
  db.run(schema);
  ensureColumn(db, "sales_orders", "product_amount", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "sales_orders", "shipping_amount", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "sales_orders", "discount_amount", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "sales_orders", "tax_amount", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "sales_orders", "refunded_amount", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "sales_orders", "comparable_sales_amount", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "sales_orders", "financial_status", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "sales_orders", "canceled_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "sales_orders", "financials_complete", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "sales_orders", "financials_source", "TEXT NOT NULL DEFAULT 'legacy'");
  ensureColumn(db, "sales_orders", "financials_updated_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "sales_orders", "reconciliation_state", "TEXT NOT NULL DEFAULT 'incomplete'");
  ensureColumn(db, "sales_refunds", "components_complete", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "sales_refunds", "source", "TEXT NOT NULL DEFAULT 'legacy'");
  ensureColumn(db, "sales_refunds", "source_updated_at", "TEXT NOT NULL DEFAULT ''");
}
function ensureColumn(db: Database, table: string, column: string, definition: string) {
  const columns = db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? [];
  if (!columns.some((row) => row[1] === column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function queryRows(db: Database, sql: string): Array<Record<string, SqlValue>> {
  const result = db.exec(sql)[0];
  return result
    ? result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])))
    : [];
}
function rowToOrder(row: Record<string, SqlValue>): SalesOrder {
  return {
    platform: String(row.platform) as Platform,
    orderId: String(row.order_id),
    orderNumber: String(row.order_number ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    status: String(row.status ?? ""),
    currency: String(row.currency ?? "USD"),
    grossAmount: Number(row.gross_amount ?? 0),
    netAmount: Number(row.net_amount ?? 0),
    productAmount: Number(row.product_amount ?? 0),
    shippingAmount: Number(row.shipping_amount ?? 0),
    discountAmount: Number(row.discount_amount ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
    refundedAmount: Number(row.refunded_amount ?? 0),
    comparableSalesAmount: Number(row.comparable_sales_amount ?? 0),
    financialStatus: String(row.financial_status ?? ""),
    canceledAt: String(row.canceled_at ?? ""),
    financialsComplete: Number(row.financials_complete ?? 0) === 1,
    financialsSource: String(row.financials_source ?? "legacy"),
    financialsUpdatedAt: String(row.financials_updated_at ?? ""),
    reconciliationState: String(row.reconciliation_state ?? "incomplete") as SalesOrder["reconciliationState"],
    countryCode: String(row.country_code ?? ""),
    regionCode: String(row.region_code ?? ""),
    itemCount: Number(row.item_count ?? 0),
    sourceUrl: String(row.source_url ?? ""),
    lineItems: []
  };
}

const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS sales_orders (platform TEXT NOT NULL, order_id TEXT NOT NULL, order_number TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT 'USD', gross_amount REAL NOT NULL DEFAULT 0, net_amount REAL NOT NULL DEFAULT 0, country_code TEXT NOT NULL DEFAULT '', region_code TEXT NOT NULL DEFAULT '', item_count INTEGER NOT NULL DEFAULT 0, source_url TEXT NOT NULL DEFAULT '', last_seen_at TEXT NOT NULL, PRIMARY KEY (platform, order_id));
CREATE TABLE IF NOT EXISTS sales_line_items (platform TEXT NOT NULL, order_id TEXT NOT NULL, line_id TEXT NOT NULL, sku TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', quantity INTEGER NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0, PRIMARY KEY (platform, order_id, line_id), FOREIGN KEY (platform, order_id) REFERENCES sales_orders(platform, order_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS sales_pulls (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, pulled_at TEXT NOT NULL, orders_seen INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS sales_refunds (platform TEXT NOT NULL, order_id TEXT NOT NULL, refund_id TEXT NOT NULL, refunded_at TEXT NOT NULL, product_amount REAL NOT NULL DEFAULT 0, shipping_amount REAL NOT NULL DEFAULT 0, tax_amount REAL NOT NULL DEFAULT 0, total_amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT 'USD', PRIMARY KEY (platform, order_id, refund_id));
CREATE TABLE IF NOT EXISTS ebay_financial_transactions (transaction_key TEXT PRIMARY KEY, transaction_date TEXT NOT NULL, type TEXT NOT NULL, order_id TEXT NOT NULL DEFAULT '', legacy_order_id TEXT NOT NULL DEFAULT '', transaction_id TEXT NOT NULL DEFAULT '', reference_id TEXT NOT NULL DEFAULT '', payout_id TEXT NOT NULL DEFAULT '', payout_date TEXT NOT NULL DEFAULT '', payout_status TEXT NOT NULL DEFAULT '', item_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', sku TEXT NOT NULL DEFAULT '', quantity REAL NOT NULL DEFAULT 0, item_subtotal REAL NOT NULL DEFAULT 0, shipping_amount REAL NOT NULL DEFAULT 0, tax_amount REAL NOT NULL DEFAULT 0, fee_amount REAL NOT NULL DEFAULT 0, gross_amount REAL NOT NULL DEFAULT 0, net_amount REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD');
CREATE INDEX IF NOT EXISTS idx_sales_orders_created ON sales_orders(created_at DESC); CREATE INDEX IF NOT EXISTS idx_sales_orders_country ON sales_orders(country_code); CREATE INDEX IF NOT EXISTS idx_sales_lines_sku ON sales_line_items(sku); CREATE INDEX IF NOT EXISTS idx_sales_refunds_date ON sales_refunds(refunded_at DESC);`;
