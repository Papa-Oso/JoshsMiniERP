import fs from "node:fs/promises";
import type { SalesOrder } from "../shared/types";
import { createVerifiedOperationalBackup } from "./dataTools";
import { parseCsv } from "./ebayReviews/productCatalog";
import { upsertSalesOrders } from "./salesStore";

interface EbaySalesImportOptions {
  dryRun?: boolean;
  createBackup?: typeof createVerifiedOperationalBackup;
  apply?: (orders: SalesOrder[]) => Promise<void>;
}

export async function importEbaySalesCsv(file: string, options: EbaySalesImportOptions = {}) {
  const { dryRun = false } = options;
  const orders = parseEbaySalesCsv(await fs.readFile(file, "utf8"));
  let backupPath: string | null = null;
  if (!dryRun) {
    backupPath = (await (options.createBackup ?? createVerifiedOperationalBackup)()).path;
    await (options.apply ?? ((rows) => upsertSalesOrders("ebay", rows)))(orders);
  }
  return { dryRun, backupPath, orders: orders.length, lineItems: orders.reduce((sum, order) => sum + order.lineItems.length, 0), earliestAt: orders.at(-1)?.createdAt ?? null, latestAt: orders[0]?.createdAt ?? null };
}

export function parseEbaySalesCsv(csv: string): SalesOrder[] {
  const rows = parseCsv(csv);
  const headerIndex = rows.findIndex((row) => row.includes("Order Number") && row.includes("Transaction ID"));
  if (headerIndex < 0) throw new Error("This file is not an eBay Seller Hub orders report.");
  const header = rows[headerIndex];
  const column = (name: string) => { const index = header.indexOf(name); if (index < 0) throw new Error(`eBay orders report is missing the ${name} column.`); return index; };
  const names = ["Order Number", "Transaction ID", "Item Number", "Item Title", "Custom Label", "Quantity", "Sold For", "Total Price", "Sale Date", "Paid On Date", "Shipped On Date", "Ship To Country", "Ship To State"];
  const indexes = Object.fromEntries(names.map((name) => [name, column(name)]));
  const groups = new Map<string, string[][]>();
  let currentOrderId = "";
  for (const row of rows.slice(headerIndex + 1)) {
    const substantive = value(row, indexes["Sale Date"]) || value(row, indexes["Transaction ID"]) || value(row, indexes["Item Title"]);
    if (!substantive) continue;
    currentOrderId = value(row, indexes["Order Number"]) || currentOrderId;
    const orderId = currentOrderId;
    if (!orderId) continue;
    const group = groups.get(orderId) ?? []; group.push(row); groups.set(orderId, group);
  }
  return [...groups.entries()].map(([orderId, orderRows]) => toOrder(orderId, orderRows, indexes)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function toOrder(orderId: string, rows: string[][], indexes: Record<string, number>): SalesOrder {
  const first = rows[0]; const createdAt = isoDate(value(first, indexes["Sale Date"]));
  const lineItems = rows.map((row, index) => { const quantity = Math.max(0, integer(value(row, indexes.Quantity))); return { platform: "ebay" as const, orderId, lineId: value(row, indexes["Transaction ID"]) || value(row, indexes["Item Number"]) || `${orderId}-${index + 1}`, sku: value(row, indexes["Custom Label"]), title: value(row, indexes["Item Title"]), quantity, amount: money(value(row, indexes["Sold For"])) * Math.max(1, quantity) }; });
  const total = rows.map((row) => money(value(row, indexes["Total Price"]))).find((amount) => amount > 0) ?? lineItems.reduce((sum, line) => sum + line.amount, 0);
  const paid = rows.some((row) => value(row, indexes["Paid On Date"])); const shipped = rows.some((row) => value(row, indexes["Shipped On Date"]));
  return { platform: "ebay", orderId, orderNumber: orderId, createdAt, updatedAt: createdAt, status: [paid ? "PAID" : "", shipped ? "FULFILLED" : ""].filter(Boolean).join(" / "), currency: "USD", grossAmount: total, netAmount: lineItems.reduce((sum, line) => sum + line.amount, 0), financialsComplete: false, financialsSource: "order_report", financialsUpdatedAt: createdAt, reconciliationState: "incomplete", countryCode: countryCode(value(first, indexes["Ship To Country"])), regionCode: value(first, indexes["Ship To State"]), itemCount: lineItems.reduce((sum, line) => sum + line.quantity, 0), sourceUrl: `https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(orderId)}`, lineItems };
}

function value(row: string[], index: number) { return String(row[index] ?? "").trim(); }
function money(input: string) { const number = Number(input.replace(/[^0-9.-]+/g, "")); return Number.isFinite(number) ? number : 0; }
function integer(input: string) { const number = Number.parseInt(input, 10); return Number.isFinite(number) ? number : 0; }
function isoDate(input: string) { const date = new Date(input); if (Number.isNaN(date.getTime())) throw new Error(`Invalid eBay sale date: ${input}`); return date.toISOString(); }
function countryCode(input: string) { const value = input.trim(); if (/^[A-Z]{2}$/i.test(value)) return value.toUpperCase(); if (/united states/i.test(value)) return "US"; return value; }
