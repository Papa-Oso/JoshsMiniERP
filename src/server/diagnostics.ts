import fs from "node:fs/promises";
import path from "node:path";
import { config, getPlatformStatuses, requireProductionApiToken } from "./config";
import { store } from "./store";

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  status: DoctorStatus;
  area: string;
  check: string;
  message: string;
}

export interface DoctorResult {
  generatedAt: string;
  status: DoctorStatus;
  checks: DoctorCheck[];
  summary: Record<DoctorStatus, number>;
}

const backupFreshnessMs = 30 * 24 * 60 * 60 * 1000;

export async function runDoctor(): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  addStoreConfigChecks(checks);
  addProductionConfigCheck(checks);
  await addInventoryChecks(checks);
  await addBackupChecks(checks);
  addMarketplaceChecks(checks);

  const summary = summarize(checks);
  return {
    generatedAt: new Date().toISOString(),
    status: summary.error > 0 ? "error" : summary.warn > 0 ? "warn" : "ok",
    checks,
    summary
  };
}

function addStoreConfigChecks(checks: DoctorCheck[]) {
  if (config.storeDriver === "sqlite") {
    checks.push(ok("Storage", "driver", `Using SQLite at ${config.databaseFile}.`));
    return;
  }

  if (config.storeDriver === "json") {
    checks.push(warn("Storage", "driver", `Using JSON fallback at ${config.dataFile}; SQLite is preferred for normal local use.`));
    return;
  }

  checks.push(config.databaseUrl ? ok("Storage", "driver", "Using PostgreSQL.") : error("Storage", "driver", "STORE_DRIVER=postgres requires DATABASE_URL."));
}

function addProductionConfigCheck(checks: DoctorCheck[]) {
  try {
    requireProductionApiToken();
    checks.push(ok("Security", "production token", "Production API token requirement is satisfied for the current environment."));
  } catch (cause) {
    checks.push(error("Security", "production token", cause instanceof Error ? cause.message : String(cause)));
  }
}

async function addInventoryChecks(checks: DoctorCheck[]) {
  try {
    const data = await store.withLock(() => store.read());
    const activeItems = data.items.filter((item) => item.active !== false);
    const duplicateSkus = duplicateValues(activeItems.map((item) => item.sku.toUpperCase()));
    const lowItems = activeItems.filter((item) => item.quantity <= item.safetyStock);
    const overMaxItems = activeItems.filter((item) => item.quantity > item.maxInventory);

    checks.push(ok("Inventory", "read", `Read ${data.items.length} item(s), ${data.events.length} event(s), and ${data.syncRuns.length} sync run(s).`));
    checks.push(
      duplicateSkus.length
        ? error("Inventory", "sku uniqueness", `Duplicate active SKUs found: ${duplicateSkus.join(", ")}.`)
        : ok("Inventory", "sku uniqueness", "No duplicate active SKUs found.")
    );
    checks.push(
      lowItems.length
        ? warn("Inventory", "low stock", `${lowItems.length} active SKU(s) are at or below safety stock.`)
        : ok("Inventory", "low stock", "No active SKUs are at or below safety stock.")
    );
    checks.push(
      overMaxItems.length
        ? warn("Inventory", "over max", `${overMaxItems.length} active SKU(s) are above max inventory.`)
        : ok("Inventory", "over max", "No active SKUs are above max inventory.")
    );
  } catch (cause) {
    checks.push(error("Inventory", "read", cause instanceof Error ? cause.message : String(cause)));
  }
}

async function addBackupChecks(checks: DoctorCheck[]) {
  const backupDirectory = path.join(path.dirname(config.dataFile), "backups");
  try {
    const files = await fs.readdir(backupDirectory);
    const manifests = await Promise.all(
      files
        .filter((file) => file.startsWith("operational-backup-") && file.endsWith(".json"))
        .map(async (file) => ({
          file,
          stats: await fs.stat(path.join(backupDirectory, file))
        }))
    );
    const newest = manifests.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)[0];
    if (!newest) {
      checks.push(warn("Backup", "manifest", `No operational backup manifest found in ${backupDirectory}.`));
      return;
    }

    const ageMs = Date.now() - newest.stats.mtimeMs;
    checks.push(
      ageMs > backupFreshnessMs
        ? warn("Backup", "manifest", `Newest backup manifest is older than 30 days: ${newest.file}.`)
        : ok("Backup", "manifest", `Newest backup manifest is ${newest.file}.`)
    );
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      checks.push(warn("Backup", "manifest", `No backup directory found at ${backupDirectory}.`));
      return;
    }
    checks.push(error("Backup", "manifest", cause instanceof Error ? cause.message : String(cause)));
  }
}

function addMarketplaceChecks(checks: DoctorCheck[]) {
  const statuses = getPlatformStatuses();
  for (const status of statuses) {
    checks.push(
      status.configured
        ? ok("Marketplace", status.platform, `${status.label} credentials are configured.`)
        : warn("Marketplace", status.platform, `${status.label} missing ${status.missing.join(", ")}.`)
    );
  }
}

function duplicateValues(values: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function summarize(checks: DoctorCheck[]): Record<DoctorStatus, number> {
  return {
    ok: checks.filter((check) => check.status === "ok").length,
    warn: checks.filter((check) => check.status === "warn").length,
    error: checks.filter((check) => check.status === "error").length
  };
}

function ok(area: string, check: string, message: string): DoctorCheck {
  return { status: "ok", area, check, message };
}

function warn(area: string, check: string, message: string): DoctorCheck {
  return { status: "warn", area, check, message };
}

function error(area: string, check: string, message: string): DoctorCheck {
  return { status: "error", area, check, message };
}
