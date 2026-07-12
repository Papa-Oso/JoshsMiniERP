import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importEbaySalesCsv, parseEbaySalesCsv } from "../src/server/ebaySalesCsv";

const report = [
  ",,,,,,,,,,,,,",
  '"Order Number","Transaction ID","Item Number","Item Title","Custom Label","Quantity","Sold For","Total Price","Sale Date","Paid On Date","Shipped On Date","Ship To Country","Ship To State"',
  '"order-1","transaction-1","item-1","First item","SKU-1","2","$5.00","$13.00","Jul 1, 2024 10:00:00 AM","Jul 1, 2024","Jul 2, 2024","United States","CA"',
  '"","transaction-2","item-2","Second item","SKU-2","1","$3.00","$13.00","Jul 1, 2024 10:00:00 AM","Jul 1, 2024","Jul 2, 2024","United States","CA"'
].join("\n");

test("parses and groups eBay Seller Hub order report rows", () => {
  const orders = parseEbaySalesCsv(report);
  assert.equal(orders.length, 1); assert.equal(orders[0].lineItems.length, 2); assert.equal(orders[0].itemCount, 3);
  assert.equal(orders[0].grossAmount, 13); assert.equal(orders[0].netAmount, 13); assert.equal(orders[0].countryCode, "US");
  assert.equal(orders[0].financialsComplete, false);
  assert.equal(orders[0].financialsSource, "order_report");
  assert.equal(orders[0].reconciliationState, "incomplete");
});

test("eBay order-report apply creates a verified backup after preview and before mutation", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-ebay-sales-import-"));
  const file = path.join(tempDir, "orders.csv");
  const calls: string[] = [];
  try {
    await writeFile(file, report, "utf8");
    const preview = await importEbaySalesCsv(file, {
      dryRun: true,
      createBackup: async () => { calls.push("backup"); return { path: "backup", itemCount: 0, inspection: { path: "backup", files: [], missingSources: [], restorable: true } }; },
      apply: async () => { calls.push("apply"); }
    });
    assert.equal(preview.backupPath, null);
    assert.deepEqual(calls, []);

    const applied = await importEbaySalesCsv(file, {
      createBackup: async () => { calls.push("backup"); return { path: "verified-backup", itemCount: 0, inspection: { path: "verified-backup", files: [], missingSources: [], restorable: true } }; },
      apply: async (orders) => { calls.push("apply"); assert.equal(orders[0].financialsComplete, false); }
    });
    assert.equal(applied.backupPath, "verified-backup");
    assert.deepEqual(calls, ["backup", "apply"]);

    calls.length = 0;
    await assert.rejects(
      () => importEbaySalesCsv(file, {
        createBackup: async () => { calls.push("backup"); throw new Error("backup verification failed"); },
        apply: async () => { calls.push("apply"); }
      }),
      /backup verification failed/
    );
    assert.deepEqual(calls, ["backup"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
