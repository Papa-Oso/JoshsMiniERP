import assert from "node:assert/strict";
import test from "node:test";
import { parseEbayTransactionCsv } from "../src/server/ebayTransactionCsv";

test("parses eBay financial transaction rows without customer PII", () => {
  const csv = [
    '"Transaction creation date","Type","Order number","Legacy order ID","Buyer username","Buyer name","Ship to city","Ship to province/region/state","Ship to zip","Ship to country","Net amount","Payout currency","Payout date","Payout ID","Payout status","Reason for hold","Item ID","Transaction ID","Item title","Custom label","Quantity","Item subtotal","Shipping and handling","Seller collected tax","eBay collected tax","Final Value Fee - fixed","Final Value Fee - variable","Gross transaction amount","Transaction currency","Reference ID","Description"',
    '"Jul 9, 2023","Order","order-1","legacy-1","private","Private Buyer","City","CA","00000","US","8.50","USD","Jul 10, 2023","payout-1","Paid","","item-1","transaction-1","Item","SKU-1","1","10.00","0","0","0","-0.30","-1.20","10.00","USD","reference-1","Sale"'
  ].join("\n");
  const rows = parseEbayTransactionCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].orderId, "order-1");
  assert.equal(rows[0].feeAmount, -1.5);
  assert.equal(rows[0].netAmount, 8.5);
  assert.equal("buyerName" in rows[0], false);
});
