import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { InventoryItem, StoreData } from "../shared/types";
import { defaultMaxInventory } from "../shared/types";
import { makeEvent } from "./inventoryService";
import { store } from "./store";

export type CsvImportAction = "create" | "update" | "adjust" | "skip" | "error";

export interface CsvImportOptions {
  dryRun?: boolean;
}

export interface CsvImportRowResult {
  line: number;
  sku?: string;
  action: CsvImportAction;
  previousQuantity?: number;
  nextQuantity?: number;
  message: string;
}

export interface CsvImportResult {
  rows: CsvImportRowResult[];
  summary: {
    created: number;
    updated: number;
    adjusted: number;
    skipped: number;
    errors: number;
  };
}

interface CsvRecord {
  line: number;
  values: Record<string, string>;
}

const now = () => new Date().toISOString();

export async function importCsv(filePath: string, options: CsvImportOptions = {}): Promise<CsvImportResult> {
  const records = parseCsvRecords(await fs.readFile(filePath, "utf8"));

  if (options.dryRun) {
    const data = structuredClone(await store.read()) as StoreData;
    return applyCsvRecords(data, records, true);
  }

  return store.mutate((data) => applyCsvRecords(data, records, false));
}

function applyCsvRecords(data: StoreData, records: CsvRecord[], dryRun: boolean): CsvImportResult {
  const rows: CsvImportRowResult[] = [];

  for (const record of records) {
    rows.push(applyCsvRecord(data, record, dryRun));
  }

  data.events = data.events.slice(0, 500);
  data.syncRuns = data.syncRuns.slice(0, 100);

  return {
    rows,
    summary: {
      created: rows.filter((row) => row.action === "create").length,
      updated: rows.filter((row) => row.action === "update").length,
      adjusted: rows.filter((row) => row.action === "adjust").length,
      skipped: rows.filter((row) => row.action === "skip").length,
      errors: rows.filter((row) => row.action === "error").length
    }
  };
}

function applyCsvRecord(data: StoreData, record: CsvRecord, dryRun: boolean): CsvImportRowResult {
  try {
    const sku = requiredText(record, ["sku"], "SKU").toUpperCase();
    const name = optionalText(record, ["name", "title", "itemname"]);
    const description = optionalText(record, ["description", "desc"]);
    const note = optionalText(record, ["note", "notes"]);
    const safetyStock = optionalInteger(record, ["safetystock", "safety"], "safetyStock");
    const maxInventory = optionalPositiveInteger(
      record,
      ["maxinventory", "maxstock", "capacity"],
      "maxInventory"
    );
    const absoluteQuantity = optionalInteger(
      record,
      ["quantity", "qty", "onhand", "onhandquantity"],
      "quantity"
    );
    const delta = optionalInteger(
      record,
      ["delta", "adjust", "adjustment", "add", "batchadd", "batchquantity", "received"],
      "delta"
    );

    if (absoluteQuantity !== undefined && delta !== undefined) {
      throw new Error("Use either quantity for an absolute count or delta/add for a batch adjustment, not both.");
    }

    const item = data.items.find((candidate) => candidate.sku.toUpperCase() === sku);
    if (!item) {
      return createFromCsv(
        data,
        record.line,
        sku,
        name,
        description,
        absoluteQuantity,
        delta,
        safetyStock,
        maxInventory,
        note,
        dryRun
      );
    }

    return updateFromCsv(
      data,
      record.line,
      item,
      name,
      description,
      absoluteQuantity,
      delta,
      safetyStock,
      maxInventory,
      note,
      dryRun
    );
  } catch (error) {
    return {
      line: record.line,
      sku: optionalText(record, ["sku"])?.toUpperCase(),
      action: "error",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function createFromCsv(
  data: StoreData,
  line: number,
  sku: string,
  name: string | undefined,
  description: string | undefined,
  absoluteQuantity: number | undefined,
  delta: number | undefined,
  safetyStock: number | undefined,
  maxInventory: number | undefined,
  note: string | undefined,
  dryRun: boolean
): CsvImportRowResult {
  if (!name) throw new Error("Name is required when creating a new SKU.");

  const quantity = absoluteQuantity ?? delta ?? 0;
  if (quantity < 0) {
    throw new Error("New SKU quantity cannot be negative.");
  }

  const timestamp = now();
  const item: InventoryItem = {
    id: randomUUID(),
    sku,
    name,
    description,
    quantity,
    safetyStock: safetyStock ?? 0,
    maxInventory: maxInventory ?? defaultMaxInventory,
    active: true,
    mappings: {},
    createdAt: timestamp,
    updatedAt: timestamp
  };

  data.items.unshift(item);
  data.events.unshift(makeEvent(item, "create", quantity, quantity, "local", note ?? "CSV import"));

  return {
    line,
    sku,
    action: "create",
    nextQuantity: quantity,
    message: `${dryRun ? "Would create" : "Created"} ${sku} with ${quantity} on hand.`
  };
}

function updateFromCsv(
  data: StoreData,
  line: number,
  item: InventoryItem,
  name: string | undefined,
  description: string | undefined,
  absoluteQuantity: number | undefined,
  delta: number | undefined,
  safetyStock: number | undefined,
  maxInventory: number | undefined,
  note: string | undefined,
  dryRun: boolean
): CsvImportRowResult {
  const previousQuantity = item.quantity;
  let nextQuantity = item.quantity;
  let metadataChanged = false;

  if (name && name !== item.name) {
    item.name = name;
    metadataChanged = true;
  }

  if (description !== undefined && description !== item.description) {
    item.description = description;
    metadataChanged = true;
  }

  if (safetyStock !== undefined && safetyStock !== item.safetyStock) {
    item.safetyStock = safetyStock;
    metadataChanged = true;
  }

  if (maxInventory !== undefined && maxInventory !== item.maxInventory) {
    item.maxInventory = maxInventory;
    metadataChanged = true;
  }

  if (absoluteQuantity !== undefined) {
    nextQuantity = absoluteQuantity;
    const correction = nextQuantity - previousQuantity;
    item.quantity = nextQuantity;
    item.updatedAt = now();

    if (correction !== 0) {
      data.events.unshift(makeEvent(item, "correction", correction, nextQuantity, "local", note ?? "CSV import"));
    }

    return {
      line,
      sku: item.sku,
      action: "update",
      previousQuantity,
      nextQuantity,
      message: `${dryRun ? "Would set" : "Set"} ${item.sku} from ${previousQuantity} to ${nextQuantity}.`
    };
  }

  if (delta !== undefined) {
    if (delta === 0) {
      if (metadataChanged) item.updatedAt = now();
      return {
        line,
        sku: item.sku,
        action: metadataChanged ? "update" : "skip",
        previousQuantity,
        nextQuantity,
        message: `${dryRun ? "Would leave" : "Left"} ${item.sku} quantity unchanged.`
      };
    }

    nextQuantity = previousQuantity + delta;
    if (nextQuantity < 0) {
      throw new Error(`Cannot adjust ${item.sku} below zero.`);
    }

    item.quantity = nextQuantity;
    item.updatedAt = now();
    data.events.unshift(
      makeEvent(
        item,
        delta > 0 ? "batch_add" : "manual_subtract",
        delta,
        nextQuantity,
        "local",
        note ?? "CSV import"
      )
    );

    return {
      line,
      sku: item.sku,
      action: "adjust",
      previousQuantity,
      nextQuantity,
      message: `${dryRun ? "Would adjust" : "Adjusted"} ${item.sku} from ${previousQuantity} to ${nextQuantity}.`
    };
  }

  if (metadataChanged) {
    item.updatedAt = now();
    return {
      line,
      sku: item.sku,
      action: "update",
      previousQuantity,
      nextQuantity,
      message: `${dryRun ? "Would update" : "Updated"} ${item.sku} details.`
    };
  }

  return {
    line,
    sku: item.sku,
    action: "skip",
    previousQuantity,
    nextQuantity,
    message: `${item.sku} already matched the CSV row.`
  };
}

function parseCsvRecords(text: string): CsvRecord[] {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  if (rows.length === 0) throw new Error("CSV is empty.");

  const headers = rows[0].map(normalizeHeader);
  if (!headers.includes("sku")) {
    throw new Error("CSV must include a sku column.");
  }

  return rows
    .slice(1)
    .map((row, index) => ({
      line: index + 2,
      values: Object.fromEntries(headers.map((header, headerIndex) => [header, row[headerIndex]?.trim() ?? ""]))
    }))
    .filter((record) => Object.values(record.values).some((value) => value));
}

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  row.push(field.replace(/\r$/, ""));
  if (row.some((value) => value.trim())) rows.push(row);
  if (quoted) throw new Error("CSV has an unterminated quoted field.");
  return rows;
}

function requiredText(record: CsvRecord, keys: string[], label: string) {
  const value = optionalText(record, keys);
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function optionalText(record: CsvRecord, keys: string[]) {
  for (const key of keys) {
    const value = record.values[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function optionalInteger(record: CsvRecord, keys: string[], label: string) {
  const value = optionalText(record, keys);
  if (value === undefined) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be a whole number.`);
  }
  if (parsed < 0 && label !== "delta") {
    throw new Error(`${label} cannot be negative.`);
  }
  return parsed;
}

function optionalPositiveInteger(record: CsvRecord, keys: string[], label: string) {
  const value = optionalInteger(record, keys, label);
  if (value !== undefined && value < 1) {
    throw new Error(`${label} must be at least 1.`);
  }
  return value;
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}
