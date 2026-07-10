import { config } from "./config";
import { sqliteDatabase } from "./sqliteDatabase";

const operationalTables = [
  "inventory_items", "platform_mappings", "inventory_events", "sync_runs", "schedule_settings",
  "import_batches", "reconcile_runs", "print_settings", "print_assets", "print_instructions",
  "scanned_feedback", "feedback_scan_runs", "sales_orders", "sales_line_items", "sales_pulls"
];

export async function getDatabaseStatus() {
  return sqliteDatabase(config.databaseFile).read((db) => {
    const integrity = String(db.exec("PRAGMA integrity_check")[0]?.values[0]?.[0] ?? "unknown");
    const existing = new Set((db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? []).map((row) => String(row[0])));
    const tables = operationalTables.filter((table) => existing.has(table)).map((table) => ({
      table,
      rows: Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0] ?? 0)
    }));
    return { databaseFile: config.databaseFile, integrity, tables };
  });
}
