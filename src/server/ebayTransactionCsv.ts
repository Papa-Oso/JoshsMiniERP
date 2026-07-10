import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SalesOrder } from "../shared/types";
import { parseCsv } from "./ebayReviews/productCatalog";
import { upsertEbayTransactions, upsertSalesOrders, type EbayFinancialTransaction } from "./salesStore";

export async function importEbayTransactionReports(inputPath: string, { dryRun = false } = {}) {
  const files = await transactionFiles(inputPath);
  const parsed = (await Promise.all(files.map(async (file) => parseEbayTransactionCsv(await fs.readFile(file, "utf8"))))).flat();
  const transactions = [...new Map(parsed.map((row) => [row.transactionKey, row])).values()]
    .sort((left, right) => right.transactionDate.localeCompare(left.transactionDate));
  const orders = ordersFromTransactions(transactions);
  if (!dryRun) {
    await upsertEbayTransactions(transactions);
    await upsertSalesOrders("ebay", orders);
  }
  return { dryRun, files: files.length, sourceRows: parsed.length, transactions: transactions.length, duplicates: parsed.length - transactions.length, orders: orders.length, earliestAt: transactions.at(-1)?.transactionDate ?? null, latestAt: transactions[0]?.transactionDate ?? null };
}

export function parseEbayTransactionCsv(csv: string): EbayFinancialTransaction[] {
  const rows = parseCsv(csv); const headerIndex = rows.findIndex((row) => row.includes("Transaction creation date") && row.includes("Type"));
  if (headerIndex < 0) throw new Error("This file is not an eBay transaction report.");
  const header = rows[headerIndex]; const index = Object.fromEntries(header.map((name, position) => [name, position]));
  const get = (row: string[], name: string) => String(row[index[name]] ?? "").trim();
  const feeColumns = header.filter((name) => /fee|charity donation|deposit processing/i.test(name));
  return rows.slice(headerIndex + 1).filter((row) => validDate(get(row, "Transaction creation date")) && get(row, "Type")).map((row) => {
    const fields = ["Transaction creation date", "Type", "Order number", "Legacy order ID", "Net amount", "Payout currency", "Payout date", "Payout ID", "Payout status", "Item ID", "Transaction ID", "Item title", "Custom label", "Quantity", "Item subtotal", "Shipping and handling", "Seller collected tax", "eBay collected tax", "Gross transaction amount", "Transaction currency", "Reference ID", "Description", ...feeColumns];
    return {
      transactionKey: crypto.createHash("sha256").update(fields.map((name) => get(row, name)).join("|")).digest("hex"),
      transactionDate: iso(get(row, "Transaction creation date")), type: get(row, "Type"), orderId: get(row, "Order number") || get(row, "Legacy order ID"), legacyOrderId: get(row, "Legacy order ID"),
      transactionId: get(row, "Transaction ID"), referenceId: get(row, "Reference ID"), payoutId: get(row, "Payout ID"), payoutDate: optionalIso(get(row, "Payout date")), payoutStatus: get(row, "Payout status"),
      itemId: get(row, "Item ID"), title: get(row, "Item title"), sku: get(row, "Custom label"), quantity: number(get(row, "Quantity")), itemSubtotal: money(get(row, "Item subtotal")), shippingAmount: money(get(row, "Shipping and handling")), taxAmount: money(get(row, "Seller collected tax")) + money(get(row, "eBay collected tax")), feeAmount: feeColumns.reduce((sum, name) => sum + money(get(row, name)), 0), grossAmount: money(get(row, "Gross transaction amount")), netAmount: money(get(row, "Net amount")), currency: get(row, "Transaction currency") || get(row, "Payout currency") || "USD"
    };
  }).sort((left, right) => right.transactionDate.localeCompare(left.transactionDate));
}

function ordersFromTransactions(rows: EbayFinancialTransaction[]): SalesOrder[] {
  const sales = rows.filter((row) => row.type.toLowerCase() === "order" && row.orderId); const groups = new Map<string, EbayFinancialTransaction[]>();
  for (const row of sales) { const group = groups.get(row.orderId) ?? []; if (!group.some((existing) => existing.transactionId === row.transactionId && existing.itemId === row.itemId)) group.push(row); groups.set(row.orderId, group); }
  return [...groups.entries()].map(([orderId, group]) => ({ platform: "ebay" as const, orderId, orderNumber: orderId, createdAt: group[0].transactionDate, updatedAt: group[0].transactionDate, status: "PAID", currency: group[0].currency, grossAmount: group.reduce((sum, row) => sum + row.grossAmount, 0), netAmount: group.reduce((sum, row) => sum + row.netAmount, 0), countryCode: "", regionCode: "", itemCount: group.reduce((sum, row) => sum + row.quantity, 0), sourceUrl: `https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(orderId)}`, lineItems: group.map((row, index) => ({ platform: "ebay" as const, orderId, lineId: row.transactionId || row.itemId || `${orderId}-${index + 1}`, sku: row.sku, title: row.title, quantity: row.quantity, amount: row.itemSubtotal })) })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function transactionFiles(inputPath: string) { const stat = await fs.stat(inputPath); if (stat.isFile()) return [inputPath]; return (await fs.readdir(inputPath)).filter((name) => /^Transaction-.*\.csv$/i.test(name)).sort().map((name) => path.join(inputPath, name)); }
function money(value: string) { const parsed = Number(value.replace(/[^0-9.-]+/g, "")); return Number.isFinite(parsed) ? parsed : 0; }
function number(value: string) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function iso(value: string) { const date = new Date(value); if (Number.isNaN(date.getTime())) throw new Error(`Invalid eBay transaction date: ${value}`); return date.toISOString(); }
function optionalIso(value: string) { return validDate(value) ? iso(value) : ""; }
function validDate(value: string) { return Boolean(value && value !== "--" && !Number.isNaN(new Date(value).getTime())); }
