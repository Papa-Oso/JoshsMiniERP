import { randomUUID } from "node:crypto";
import type { PrintInstruction, PrintingPayload, SkuInstructionMatch } from "../shared/types";
import { defaultMaxInventory } from "../shared/types";

const now = () => new Date().toISOString();

export function defaultPrintingData(): PrintingPayload {
  return {
    instructions: defaultInstructions(),
    instructionMatches: [],
    events: [],
    defaults: {
      labelBatchSize: 15,
      instructionPages: 10,
      instructionPerPage: 4
    }
  };
}

export function normalizePrintingData(value: Partial<PrintingPayload>): PrintingPayload {
  const defaults = defaultPrintingData();
  const incoming = Array.isArray(value.instructions) ? value.instructions : [];
  const incomingById = new Map(incoming.map((instruction) => [instruction.id, instruction]));
  const defaultIds = new Set(defaults.instructions.map((instruction) => instruction.id));
  const customInstructions = incoming
    .filter((instruction) => instruction.id && !defaultIds.has(instruction.id))
    .map((instruction) => normalizeCustomInstruction(instruction));

  return {
    instructions: [
      ...defaults.instructions.map((fallback) => ({
        ...fallback,
        ...(incomingById.get(fallback.id) ?? {}),
        matchTerms: fallback.matchTerms,
        perPage: fallback.perPage
      })),
      ...customInstructions
    ],
    instructionMatches: normalizeInstructionMatches(value.instructionMatches),
    events: Array.isArray(value.events) ? value.events.slice(0, 250) : [],
    defaults: {
      ...defaults.defaults,
      ...(value.defaults ?? {}),
      labelPrinterName: clean(value.defaults?.labelPrinterName),
      instructionPrinterName: clean(value.defaults?.instructionPrinterName)
    }
  };
}

export function makeInstruction(id: string, label: string, matchTerms: string[]): PrintInstruction {
  return {
    id,
    label,
    matchTerms,
    title: `${label} Instructions`,
    body: "",
    onHand: 0,
    lowAlert: 8,
    maxInventory: defaultMaxInventory,
    perPage: 4,
    updatedAt: now()
  };
}

function defaultInstructions(): PrintInstruction[] {
  return [
    makeInstruction("nexx", "NEXX", ["NEXX"]),
    makeInstruction("scorpion", "SCORPION", ["SCORPION"]),
    makeInstruction("hjc", "HJC", ["HJC"]),
    makeInstruction("shoei", "SHOEI", ["SHOEI", "SHOIE"]),
    makeInstruction("z3-seat-clips", "Z3 Seat Clips", ["Z3", "SEAT"]),
    makeInstruction("z3-visor", "Z3 Visor", ["Z3", "VISOR"])
  ];
}

function normalizeCustomInstruction(instruction: Partial<PrintInstruction>): PrintInstruction {
  const id = clean(instruction.id) ?? `custom-${randomUUID()}`;
  const label = clean(instruction.label) ?? "Custom";
  return {
    id,
    label,
    matchTerms: Array.isArray(instruction.matchTerms) ? instruction.matchTerms.map(String) : [],
    title: clean(instruction.title) ?? `${label} Instructions`,
    body: String(instruction.body ?? ""),
    onHand: nonNegativeInteger(instruction.onHand ?? 0, "Instruction count"),
    lowAlert: nonNegativeInteger(instruction.lowAlert ?? 8, "Low alert"),
    maxInventory: positiveInteger(instruction.maxInventory ?? defaultMaxInventory, "Max inventory"),
    perPage: nonNegativeInteger(instruction.perPage ?? 4, "Instructions per page") || 4,
    updatedAt: clean(instruction.updatedAt) ?? now()
  };
}

function normalizeInstructionMatches(value: unknown): SkuInstructionMatch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((match) => {
    const candidate = match as Partial<SkuInstructionMatch>;
    const sku = normalizeExactSku(candidate.sku ?? "");
    if (!sku || (candidate.mode !== "instruction" && candidate.mode !== "none")) return [];
    const instructionId = clean(candidate.instructionId);
    if (candidate.mode === "instruction" && !instructionId) return [];
    return [
      {
        sku,
        mode: candidate.mode,
        instructionId: candidate.mode === "instruction" ? instructionId : undefined,
        updatedAt: clean(candidate.updatedAt) ?? now()
      }
    ];
  });
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
