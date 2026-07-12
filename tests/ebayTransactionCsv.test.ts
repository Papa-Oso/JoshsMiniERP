import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importEbayTransactionReports, parseEbayTransactionCsv } from "../src/server/ebayTransactionCsv";

const report = [
  '"Transaction creation date","Type","Order number","Legacy order ID","Buyer username","Buyer name","Ship to city","Ship to province/region/state","Ship to zip","Ship to country","Net amount","Payout currency","Payout date","Payout ID","Payout status","Reason for hold","Item ID","Transaction ID","Item title","Custom label","Quantity","Item subtotal","Shipping and handling","Seller collected tax","eBay collected tax","Final Value Fee - fixed","Final Value Fee - variable","Gross transaction amount","Transaction currency","Reference ID","Description"',
  '"Jul 9, 2023","Order","order-1","legacy-1","private","Private Buyer","City","CA","00000","US","8.50","USD","Jul 10, 2023","payout-1","Paid","","item-1","transaction-1","Item","SKU-1","1","10.00","0","0","0","-0.30","-1.20","10.00","USD","reference-1","Sale"'
].join("\n");

test("parses eBay financial transaction rows without customer PII", () => {
  const rows = parseEbayTransactionCsv(report);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].orderId, "order-1");
  assert.equal(rows[0].feeAmount, -1.5);
  assert.equal(rows[0].netAmount, 8.5);
  assert.equal("buyerName" in rows[0], false);
});

test("eBay transaction-report apply creates a verified backup and marks derived orders incomplete", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-ebay-transactions-import-"));
  const file = path.join(tempDir, "Transaction-report.csv");
  const calls: string[] = [];
  try {
    await writeFile(file, report, "utf8");
    const result = await importEbayTransactionReports(file, {
      createBackup: async () => { calls.push("backup"); return { path: "verified-backup", itemCount: 0, inspection: { path: "verified-backup", files: [], missingSources: [], restorable: true } }; },
      apply: async (_transactions, orders) => {
        calls.push("apply");
        assert.equal(orders[0].financialsComplete, false);
        assert.equal(orders[0].financialsSource, "transaction_report");
        assert.equal(orders[0].reconciliationState, "incomplete");
      }
    });
    assert.equal(result.backupPath, "verified-backup");
    assert.deepEqual(calls, ["backup", "apply"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
