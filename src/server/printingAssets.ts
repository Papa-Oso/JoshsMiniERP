import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { PrintAsset, PrintAssetKind } from "../shared/types";

const printingRoot = path.resolve("data/printing");
const assetDirectories: Record<PrintAssetKind, string> = {
  label: "labels",
  instruction: "instructions"
};
const allowedExtensions = new Set([".docx", ".doc", ".xlsx", ".xls", ".xlsm", ".pdf"]);
const instructionIdsByStem = new Map([
  ["JW-HJC-INSTRUCTIONS", "hjc"],
  ["JW-NEXX-INSTRUCTIONS", "nexx"],
  ["JW-SCORPION-INSTRUCTIONS", "scorpion"],
  ["JW-SHOEI-INSTRUCTIONS", "shoei"],
  ["JW-Z3-SEATBELT-INSTRUCTIONS", "z3-seat-clips"],
  ["JW-Z3-VISOR-INSTRUCTIONS", "z3-visor"]
]);

interface ParsedAssetFile {
  displayName: string;
  sku?: string;
  instructionId?: string;
}

interface UploadInstructionAssetInput {
  filename: string;
  contentBase64: string;
  label?: string;
}

interface UploadLabelAssetInput {
  sku: string;
  filename: string;
  contentBase64: string;
}

export async function listPrintingAssets(): Promise<PrintAsset[]> {
  const assets = await Promise.all(
    (Object.keys(assetDirectories) as PrintAssetKind[]).map(async (kind) => {
      const directory = path.join(printingRoot, assetDirectories[kind]);
      const filenames = await readAssetDirectory(directory);
      return filenames
        .map((filename) => buildPrintingAsset(kind, filename, true))
        .filter((asset): asset is PrintAsset => asset !== undefined);
    })
  );

  return assets.flat().sort((left, right) => {
    const kindCompare = left.kind.localeCompare(right.kind);
    return kindCompare || left.displayName.localeCompare(right.displayName);
  });
}

export async function openPrintingAsset(assetId: string): Promise<PrintAsset> {
  const { kind, filename } = decodePrintingAssetId(assetId);
  const resolvedPath = resolvePrintingAssetPath(kind, filename);
  await fs.access(resolvedPath);

  const asset = buildPrintingAsset(kind, filename, true);
  if (!asset) throw new Error("Printing asset not found.");

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-Command", "Start-Process", "-LiteralPath", resolvedPath],
    { windowsHide: true, detached: true, stdio: "ignore" }
  );
  child.unref();

  return asset;
}

export async function saveUploadedInstructionAsset(input: UploadInstructionAssetInput): Promise<PrintAsset> {
  const extension = path.extname(input.filename).toLowerCase();
  if (!allowedExtensions.has(extension)) throw new Error("Instruction upload must be a document file.");

  const filename = `${instructionStemForLabel(input.label || input.filename)}${extension}`;
  const resolvedPath = resolvePrintingAssetPath("instruction", filename);
  const payload = input.contentBase64.replace(/^data:[^,]+,/, "");
  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length) throw new Error("Instruction upload was empty.");
  if (buffer.length > 25 * 1024 * 1024) throw new Error("Instruction upload is too large.");

  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, buffer);

  const asset = buildPrintingAsset("instruction", filename, true);
  if (!asset) throw new Error("Uploaded instruction could not be indexed.");
  return asset;
}

export async function saveUploadedLabelAsset(input: UploadLabelAssetInput): Promise<PrintAsset> {
  const extension = path.extname(input.filename).toLowerCase();
  if (!allowedExtensions.has(extension)) throw new Error("Label upload must be a document file.");

  const filename = `${labelStemForSku(input.sku)}${extension}`;
  const resolvedPath = resolvePrintingAssetPath("label", filename);
  const payload = input.contentBase64.replace(/^data:[^,]+,/, "");
  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length) throw new Error("Label upload was empty.");
  if (buffer.length > 25 * 1024 * 1024) throw new Error("Label upload is too large.");

  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, buffer);

  const asset = buildPrintingAsset("label", filename, true);
  if (!asset) throw new Error("Uploaded label could not be indexed.");
  return asset;
}

export function buildPrintingAsset(kind: PrintAssetKind, filename: string, exists: boolean): PrintAsset | undefined {
  const parsed = parsePrintingAssetFile(kind, filename);
  if (!parsed) return undefined;

  return {
    id: encodePrintingAssetId(kind, filename),
    kind,
    filename,
    displayName: parsed.displayName,
    path: `${assetDirectories[kind]}/${filename}`,
    sku: parsed.sku,
    instructionId: parsed.instructionId,
    exists
  };
}

export function parsePrintingAssetFile(kind: PrintAssetKind, filename: string): ParsedAssetFile | undefined {
  if (!isSafeFilename(filename)) return undefined;

  const extension = path.extname(filename).toLowerCase();
  if (!allowedExtensions.has(extension)) return undefined;

  const stem = filename.slice(0, -extension.length);
  if (kind === "label") {
    const suffix = "-LABEL";
    if (!stem.toUpperCase().endsWith(suffix)) return undefined;

    const sku = stem.slice(0, -suffix.length);
    if (!sku) return undefined;
    return { sku, displayName: sku };
  }

  const instructionId = instructionIdForStem(stem);
  if (!instructionId) return undefined;
  return { instructionId, displayName: toDisplayName(stem) };
}

export function instructionIdForStem(stem: string) {
  const normalizedStem = stem.toUpperCase();
  const known = instructionIdsByStem.get(normalizedStem);
  if (known) return known;
  if (!normalizedStem.endsWith("-INSTRUCTIONS")) return undefined;

  const base = normalizedStem.slice(0, -"-INSTRUCTIONS".length).replace(/^JW-/, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `custom-${slug}` : undefined;
}

export function instructionLabelForFilename(filename: string) {
  const extension = path.extname(filename);
  const stem = filename.slice(0, -extension.length);
  const base = stem.toUpperCase().endsWith("-INSTRUCTIONS")
    ? stem.slice(0, -"-INSTRUCTIONS".length)
    : stem;
  return toInstructionLabel(base);
}

export function encodePrintingAssetId(kind: PrintAssetKind, filename: string): string {
  if (!isSafeFilename(filename)) throw new Error("Invalid printing asset filename.");
  return `${kind}-${Buffer.from(filename, "utf8").toString("base64url")}`;
}

export function decodePrintingAssetId(assetId: string): { kind: PrintAssetKind; filename: string } {
  const match = /^(label|instruction)-([A-Za-z0-9_-]+)$/.exec(assetId);
  if (!match) throw new Error("Invalid printing asset id.");

  const kind = match[1] as PrintAssetKind;
  const filename = Buffer.from(match[2], "base64url").toString("utf8");
  if (!parsePrintingAssetFile(kind, filename)) throw new Error("Invalid printing asset id.");

  return { kind, filename };
}

export function resolvePrintingAssetPath(kind: PrintAssetKind, filename: string, root = printingRoot): string {
  if (!parsePrintingAssetFile(kind, filename)) throw new Error("Invalid printing asset filename.");

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, assetDirectories[kind], filename);
  if (!isInsideDirectory(resolvedRoot, resolvedPath)) throw new Error("Invalid printing asset path.");
  return resolvedPath;
}

export function isInsideDirectory(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readAssetDirectory(directory: string) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

function isSafeFilename(filename: string) {
  return filename === path.basename(filename) && !filename.includes("/") && !filename.includes("\\");
}

function toDisplayName(stem: string) {
  return stem
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function instructionStemForLabel(value: string) {
  const extension = path.extname(value);
  const withoutExtension = extension ? value.slice(0, -extension.length) : value;
  const base = withoutExtension
    .replace(/instructions?$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/-+$/g, "")
    .replace(/^-+/g, "");
  const prefixed = base.startsWith("JW-") ? base : `JW-${base || "INSTRUCTION"}`;
  return prefixed.endsWith("-INSTRUCTIONS") ? prefixed : `${prefixed}-INSTRUCTIONS`;
}

function labelStemForSku(value: string) {
  const sku = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sku) throw new Error("SKU is required for label upload.");
  return `${sku}-LABEL`;
}

function toInstructionLabel(value: string) {
  return value
    .replace(/^JW-/i, "")
    .split("-")
    .filter(Boolean)
    .map((part) => (part.length <= 4 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join(" ");
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
