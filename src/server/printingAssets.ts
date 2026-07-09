import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { PrintAsset, PrintAssetKind, PrinterInfo } from "../shared/types";
import { store } from "./store";

const printingRoot = path.resolve(process.env.PRINTING_ASSET_DIR ?? "data/printing");
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

  const sorted = assets.flat().sort((left, right) => {
    const kindCompare = left.kind.localeCompare(right.kind);
    return kindCompare || left.displayName.localeCompare(right.displayName);
  });

  await store.recordPrintAssets?.(sorted, { replace: true });
  return sorted;
}

export async function openPrintingAsset(assetId: string): Promise<PrintAsset> {
  const { kind, filename } = decodePrintingAssetId(assetId);
  const resolvedPath = resolvePrintingAssetPath(kind, filename);
  await fs.access(resolvedPath);

  const asset = buildPrintingAsset(kind, filename, true);
  if (!asset) throw new Error("Printing asset not found.");

  await launchAsset(resolvedPath);

  return asset;
}

export async function printPrintingAsset(assetId: string, printerName?: string): Promise<PrintAsset> {
  const { kind, filename } = decodePrintingAssetId(assetId);
  const resolvedPath = resolvePrintingAssetPath(kind, filename);
  await fs.access(resolvedPath);

  const asset = buildPrintingAsset(kind, filename, true);
  if (!asset) throw new Error("Printing asset not found.");

  await printAssetPath(resolvedPath, printerName);

  return asset;
}

export async function listWindowsPrinters(): Promise<PrinterInfo[]> {
  if (process.platform !== "win32") return [];

  const output = await runPowerShell(
    `
      $printers = Get-CimInstance Win32_Printer |
        Select-Object Name, PortName, PrinterStatus, WorkOffline, Default
      @($printers | ForEach-Object {
        [PSCustomObject]@{
          name = $_.Name
          portName = $_.PortName
          status = $_.PrinterStatus
          workOffline = $_.WorkOffline
          isDefault = $_.Default
        }
      }) | ConvertTo-Json -Compress
    `,
    10000
  );
  if (!output) return [];

  const parsed = JSON.parse(output) as PrinterInfo | PrinterInfo[];
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((printer) => printer.name);
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
  await store.recordPrintAssets?.([asset]);
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
  await store.recordPrintAssets?.([asset]);
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

async function launchAsset(resolvedPath: string) {
  if (process.platform !== "win32") {
    throw new Error("Printing assets can only be opened from the local Windows workstation.");
  }

  await runPowerShell(withPath(resolvedPath, "Start-Process -FilePath $path"), 10000);
}

async function printAssetPath(resolvedPath: string, printerName?: string) {
  if (process.platform !== "win32") {
    throw new Error("Printing assets can only be printed from the local Windows workstation.");
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  const printerSetup = printerScript(printerName);

  const defaultPrinterCheck = `
    ${printerSetup}
    if ($printer -eq $null) {
      throw 'No default Windows printer is configured.'
    }
  `;

  if (extension === ".doc" || extension === ".docx") {
    await runPowerShell(
      withPath(
        resolvedPath,
        `
          ${defaultPrinterCheck}
          $word = $null
          $doc = $null
          try {
            $word = New-Object -ComObject Word.Application
            $word.Visible = $false
            $word.DisplayAlerts = 0
            if ($printerName) {
              $word.ActivePrinter = $printer.Name
            }
            $doc = $word.Documents.Open($path, $false, $true)
            $doc.PrintOut($false)
            while ($word.BackgroundPrintingStatus -gt 0) {
              Start-Sleep -Milliseconds 500
            }
          } finally {
            if ($doc -ne $null) {
              $doc.Close($false) | Out-Null
              [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null
            }
            if ($word -ne $null) {
              $word.Quit() | Out-Null
              [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
            }
          }
        `
      ),
      120000
    );
    return;
  }

  if (extension === ".xls" || extension === ".xlsx" || extension === ".xlsm") {
    await runPowerShell(
      withPath(
        resolvedPath,
        `
          ${defaultPrinterCheck}
          $excel = $null
          $workbook = $null
          try {
            $excel = New-Object -ComObject Excel.Application
            $excel.Visible = $false
            $excel.DisplayAlerts = $false
            if ($printerName) {
              $excel.ActivePrinter = $printer.Name
            }
            $workbook = $excel.Workbooks.Open($path, 3, $true)
            $workbook.PrintOut()
          } finally {
            if ($workbook -ne $null) {
              $workbook.Close($false) | Out-Null
              [System.Runtime.InteropServices.Marshal]::ReleaseComObject($workbook) | Out-Null
            }
            if ($excel -ne $null) {
              $excel.Quit() | Out-Null
              [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
            }
          }
        `
      ),
      120000
    );
    return;
  }

  await runPowerShell(
    withPath(
      resolvedPath,
      `
        ${defaultPrinterCheck}
        $shell = New-Object -ComObject Shell.Application
        $folder = $shell.Namespace((Split-Path -Parent $path))
        $item = $folder.ParseName((Split-Path -Leaf $path))
        if ($item -eq $null) {
          throw 'Printing asset could not be loaded by Windows shell.'
        }
        $printVerb = $item.Verbs() | Where-Object { $_.Name.Replace('&', '').Trim().ToLowerInvariant() -eq 'print' } | Select-Object -First 1
        if ($printVerb -eq $null) {
          throw 'This file type does not expose a Windows Print action.'
        }
        $previousDefault = Get-CimInstance Win32_Printer | Where-Object { $_.Default } | Select-Object -First 1
        try {
          if ($printerName) {
            Invoke-CimMethod -InputObject $printer -MethodName SetDefaultPrinter | Out-Null
          }
          $printVerb.DoIt()
        } finally {
          if ($printerName -and $previousDefault -ne $null) {
            Invoke-CimMethod -InputObject $previousDefault -MethodName SetDefaultPrinter | Out-Null
          }
        }
      `
    ),
    30000
  );
}

function printerScript(printerName?: string) {
  const printerPayload = printerName ? Buffer.from(printerName, "utf16le").toString("base64") : "";
  return printerPayload
    ? `
      $printerName = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${printerPayload}'))
      $printer = Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $printerName } | Select-Object -First 1
      if ($printer -eq $null) {
        throw "Printer '$printerName' is not installed on this computer."
      }
    `
    : `
      $printerName = $null
      $printer = Get-CimInstance Win32_Printer | Where-Object { $_.Default } | Select-Object -First 1
    `;
}

function withPath(resolvedPath: string, body: string) {
  const pathPayload = Buffer.from(resolvedPath, "utf16le").toString("base64");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$path = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${pathPayload}'))`,
    body
  ].join("; ");
}

function runPowerShell(script: string, timeoutMs: number) {
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  return new Promise<string>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", encodedCommand], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Windows print command timed out before submitting the job."));
    }, timeoutMs);
    const finish = (error?: Error, output = stdout.trim()) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve(output);
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }

      finish(new Error(stderr.trim() || stdout.trim() || `PowerShell exited with code ${code ?? "unknown"}.`));
    });
  });
}
