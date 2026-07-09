import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdjustInstructionInput,
  PrintEvent,
  PrintEventType,
  PrintInstruction,
  PrintingPayload,
  SkuInstructionMatch,
  UpdatePrintSettingsInput,
  UpdateInstructionInput
} from "../shared/types";
import { defaultPrintingData, makeInstruction, normalizePrintingData } from "./printingData";
import { store } from "./store";

const printingFile = path.resolve(process.env.PRINTING_DATA_FILE ?? "data/printing.json");
const now = () => new Date().toISOString();
let writeQueue = Promise.resolve();

export type InstructionUseResult =
  | { status: "recorded"; instruction: PrintInstruction }
  | { status: "none" }
  | { status: "missing" };

export async function getPrintingData() {
  return readPrintingData();
}

export async function updateInstruction(id: string, input: UpdateInstructionInput) {
  return mutatePrintingData((data) => {
    const instruction = findInstruction(data, id);

    if (input.title !== undefined) instruction.title = clean(input.title) ?? `${instruction.label} Instructions`;
    if (input.body !== undefined) instruction.body = String(input.body ?? "");
    if (input.lowAlert !== undefined) instruction.lowAlert = nonNegativeInteger(input.lowAlert, "Low alert");
    if (input.maxInventory !== undefined) instruction.maxInventory = positiveInteger(input.maxInventory, "Max inventory");

    instruction.updatedAt = now();
    return instruction;
  });
}

export async function updatePrintSettings(input: UpdatePrintSettingsInput) {
  return mutatePrintingData((data) => {
    if (input.labelPrinterName !== undefined) {
      data.defaults.labelPrinterName = clean(input.labelPrinterName);
    }
    if (input.instructionPrinterName !== undefined) {
      data.defaults.instructionPrinterName = clean(input.instructionPrinterName);
    }
    return data.defaults;
  });
}

export async function ensureInstruction(input: {
  id: string;
  label: string;
  matchTerms?: string[];
}) {
  return mutatePrintingData((data) => {
    const existing = data.instructions.find((candidate) => candidate.id === input.id);
    if (existing) {
      existing.label = clean(input.label) ?? existing.label;
      existing.title = existing.title || `${existing.label} Instructions`;
      existing.updatedAt = now();
      return existing;
    }

    const instruction = makeInstruction(input.id, clean(input.label) ?? "Custom", input.matchTerms ?? []);
    data.instructions.push(instruction);
    return instruction;
  });
}

export async function updateSkuInstructionMatch(
  sku: string,
  input: { mode: "auto" | "instruction" | "none"; instructionId?: string }
) {
  return mutatePrintingData((data) => {
    const normalizedSku = normalizeExactSku(sku);
    if (!normalizedSku) throw new Error("SKU is required.");

    data.instructionMatches = data.instructionMatches.filter(
      (match) => normalizeExactSku(match.sku) !== normalizedSku
    );

    if (input.mode === "auto") return { sku: normalizedSku, mode: "auto" as const };

    if (input.mode === "instruction") {
      if (!input.instructionId) throw new Error("Instruction type is required.");
      findInstruction(data, input.instructionId);
    }

    const match: SkuInstructionMatch = {
      sku: normalizedSku,
      mode: input.mode,
      instructionId: input.mode === "instruction" ? input.instructionId : undefined,
      updatedAt: now()
    };
    data.instructionMatches.push(match);
    return match;
  });
}

export async function adjustInstruction(id: string, input: AdjustInstructionInput) {
  const delta = integer(input.delta, "Adjustment");
  if (delta === 0) throw new Error("Adjustment must not be zero.");
  const type = input.type ?? (delta > 0 ? "print_batch" : "package_use");

  return mutatePrintingData((data) => adjustInstructionInData(data, id, delta, type, input.note));
}

export async function consumeInstructionForSku(
  sku: string,
  quantity: number,
  note?: string
): Promise<InstructionUseResult> {
  const count = nonNegativeInteger(quantity, "Package count");
  if (count === 0) throw new Error("Package count must be greater than zero.");

  return mutatePrintingData((data) => {
    const resolution = resolveInstructionForSku(data, sku);
    if (resolution.status !== "recorded") return resolution;

    return {
      status: "recorded" as const,
      instruction: adjustInstructionInData(
        data,
        resolution.instruction.id,
        -count,
        "package_use",
        note ?? `Sale for ${sku}`
      )
    };
  });
}

export function resolveInstructionForSku(data: PrintingPayload, sku: string) {
  const normalizedSku = normalizeExactSku(sku);
  const savedMatch = data.instructionMatches.find((match) => normalizeExactSku(match.sku) === normalizedSku);
  if (savedMatch?.mode === "none") return { status: "none" as const };
  if (savedMatch?.mode === "instruction" && savedMatch.instructionId) {
    const instruction = data.instructions.find((candidate) => candidate.id === savedMatch.instructionId);
    return instruction ? { status: "recorded" as const, instruction } : { status: "missing" as const };
  }
  const instruction = matchInstruction(data.instructions, sku);
  return instruction ? { status: "recorded" as const, instruction } : { status: "missing" as const };
}

export function matchInstruction(instructions: PrintInstruction[], sku: string) {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) return undefined;

  const z3Seat = instructions.find((instruction) => instruction.id === "z3-seat-clips");
  if (z3Seat && hasAllTerms(normalizedSku, z3Seat.matchTerms)) return z3Seat;

  const z3Visor = instructions.find((instruction) => instruction.id === "z3-visor");
  if (z3Visor && hasAllTerms(normalizedSku, z3Visor.matchTerms)) return z3Visor;

  return instructions.find((instruction) => {
    if (isStrictInstructionMatch(instruction.id)) return false;
    return instruction.matchTerms.some((term) => normalizedSku.includes(normalizeSku(term)));
  });
}

function adjustInstructionInData(
  data: PrintingPayload,
  id: string,
  delta: number,
  type: PrintEventType,
  note?: string
) {
  const instruction = findInstruction(data, id);
  const nextOnHand = instruction.onHand + delta;
  if (nextOnHand < 0) {
    throw new Error(`Cannot subtract ${Math.abs(delta)} from ${instruction.onHand} ${instruction.label} instructions.`);
  }

  instruction.onHand = nextOnHand;
  instruction.updatedAt = now();
  const event: PrintEvent = {
    id: randomUUID(),
    instructionId: instruction.id,
    type,
    delta,
    quantityAfter: nextOnHand,
    note: clean(note),
    createdAt: now()
  };
  data.events.unshift(event);
  data.events = data.events.slice(0, 250);
  return instruction;
}

async function readPrintingData(): Promise<PrintingPayload> {
  if (store.readPrintingData) {
    return store.readPrintingData();
  }

  await fs.mkdir(path.dirname(printingFile), { recursive: true });

  try {
    const raw = await fs.readFile(printingFile, "utf8");
    return normalizePrintingData(JSON.parse(raw));
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    const data = defaultPrintingData();
    await writePrintingData(data);
    return data;
  }
}

async function mutatePrintingData<T>(mutator: (data: PrintingPayload) => T) {
  if (store.mutatePrintingData) {
    return store.mutatePrintingData(mutator);
  }

  const run = async () => {
    const data = await readPrintingData();
    const result = mutator(data);
    await writePrintingData(data);
    return result;
  };

  const next = writeQueue.then(run, run);
  writeQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function writePrintingData(data: PrintingPayload) {
  await fs.mkdir(path.dirname(printingFile), { recursive: true });
  const tempPath = `${printingFile}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, printingFile);
}

function findInstruction(data: PrintingPayload, id: string) {
  const instruction = data.instructions.find((candidate) => candidate.id === id);
  if (!instruction) throw new Error("Instruction type not found.");
  return instruction;
}

function hasAllTerms(value: string, terms: string[]) {
  return terms.every((term) => value.includes(normalizeSku(term)));
}

function isStrictInstructionMatch(id: string) {
  return id === "z3-seat-clips" || id === "z3-visor";
}

function normalizeSku(value: string) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ");
}

function normalizeExactSku(value: string) {
  return String(value ?? "").trim().toUpperCase();
}

function integer(value: unknown, label: string) {
  const next = Number(value);
  if (!Number.isInteger(next)) throw new Error(`${label} must be a whole number.`);
  return next;
}

function nonNegativeInteger(value: unknown, label: string) {
  const next = integer(value, label);
  if (next < 0) throw new Error(`${label} cannot be negative.`);
  return next;
}

function positiveInteger(value: unknown, label: string) {
  const next = integer(value, label);
  if (next < 1) throw new Error(`${label} must be at least 1.`);
  return next;
}

function clean(value?: unknown) {
  const trimmed = String(value ?? "").trim();
  return trimmed || undefined;
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
