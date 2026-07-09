import { useEffect, useMemo, useState } from "react";
import { Box, ExternalLink, FileText, FolderOpen, Minus, Plus, Printer, Settings, Tags, Upload, X } from "lucide-react";
import { api } from "./api";
import type { DashboardPayload, InventoryItem, PrintAsset, PrintInstruction, PrinterInfo, PrintingPayload } from "../shared/types";

const emptyPrinting: PrintingPayload = {
  instructions: [],
  events: [],
  defaults: {
    labelBatchSize: 15,
    instructionPages: 10,
    instructionPerPage: 4
  },
  instructionMatches: []
};

type InstructionSettingsMap = Record<string, { lowAlert: number }>;
type NoticeTarget = "labels" | "documents" | "inventory";

export function PrintingPage({
  dashboard,
  printSettingsOpen,
  onPrintSettingsClose
}: {
  dashboard: DashboardPayload;
  printSettingsOpen: boolean;
  onPrintSettingsClose: () => void;
}) {
  const [printing, setPrinting] = useState<PrintingPayload>(emptyPrinting);
  const [assets, setAssets] = useState<PrintAsset[]>([]);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [instructionSettings, setInstructionSettings] = useState<InstructionSettingsMap>({});
  const [printerSettings, setPrinterSettings] = useState({
    labelPrinterName: "",
    instructionPrinterName: ""
  });
  const [printersLoading, setPrintersLoading] = useState(false);
  const [selectedLabelItemId, setSelectedLabelItemId] = useState("");
  const [labelCount, setLabelCount] = useState(15);
  const [instructionId, setInstructionId] = useState("");
  const [instructionPages, setInstructionPages] = useState(10);
  const [inventoryAdjustment, setInventoryAdjustment] = useState(1);
  const [busy, setBusy] = useState(false);
  const [labelNotice, setLabelNotice] = useState("");
  const [documentNotice, setDocumentNotice] = useState("");
  const [inventoryNotice, setInventoryNotice] = useState("");
  const [settingsNotice, setSettingsNotice] = useState("");

  const labelItems = useMemo(() => dashboard.items, [dashboard.items]);
  const selectedItem = labelItems.find((item) => item.id === selectedLabelItemId) ?? labelItems[0] ?? null;
  const selectedInstruction =
    printing.instructions.find((instruction) => instruction.id === instructionId) ?? printing.instructions[0] ?? null;
  const matchedInstruction = selectedItem ? resolveInstructionForSku(printing, selectedItem.sku) : undefined;
  const instructionMatchValue = selectedItem ? instructionMatchValueFor(printing, selectedItem.sku) : "auto";
  const instructionMatchMode = selectedItem ? getInstructionMatch(printing, selectedItem.sku)?.mode ?? "auto" : "auto";
  const selectedLabelAsset = selectedItem ? findLabelAsset(assets, selectedItem.sku) : undefined;
  const selectedInstructionAsset = selectedInstruction ? findInstructionAsset(assets, selectedInstruction.id) : undefined;
  const printedInstructionCount = selectedInstruction ? instructionPages * selectedInstruction.perPage : 0;
  const recentEvents = printing.events.slice(0, 8);

  const lowCount = useMemo(
    () => printing.instructions.filter((instruction) => instruction.onHand <= instruction.lowAlert).length,
    [printing.instructions]
  );

  useEffect(() => {
    void loadPrinting();
    void loadPrinters();
  }, []);

  useEffect(() => {
    if (selectedLabelItemId && labelItems.some((item) => item.id === selectedLabelItemId)) return;
    if (labelItems[0]) setSelectedLabelItemId(labelItems[0].id);
  }, [labelItems, selectedLabelItemId]);

  useEffect(() => {
    if (printing.defaults.labelBatchSize) setLabelCount(printing.defaults.labelBatchSize);
    if (printing.defaults.instructionPages) setInstructionPages(printing.defaults.instructionPages);
    if (!instructionId && printing.instructions[0]) setInstructionId(printing.instructions[0].id);
  }, [printing.defaults.instructionPages, printing.defaults.labelBatchSize, printing.instructions, instructionId]);

  async function loadPrinting() {
    const [data, assetData] = await Promise.all([api.printing(), api.printingAssets()]);
    setPrinting(data);
    setAssets(assetData);
    setPrinterSettings({
      labelPrinterName: data.defaults.labelPrinterName ?? "",
      instructionPrinterName: data.defaults.instructionPrinterName ?? ""
    });
    setInstructionSettings(
      Object.fromEntries(data.instructions.map((instruction) => [instruction.id, settingsFor(instruction)]))
    );
  }

  async function loadPrinters() {
    setPrintersLoading(true);
    try {
      setPrinters(await api.printers());
    } catch (error) {
      setSettingsNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setPrintersLoading(false);
    }
  }

  async function runAction(action: () => Promise<unknown>, success: string, noticeTarget: NoticeTarget = "labels") {
    setBusy(true);
    setLabelNotice("");
    setDocumentNotice("");
    setInventoryNotice("");
    setSettingsNotice("");
    try {
      await action();
      await loadPrinting();
      setPaneNotice(noticeTarget, success);
    } catch (error) {
      setPaneNotice(noticeTarget, error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveInstructionSettings(instruction: PrintInstruction) {
    const settings = instructionSettings[instruction.id] ?? settingsFor(instruction);
    await runAction(
      () =>
        api.updateInstruction(instruction.id, {
          lowAlert: Number(settings.lowAlert)
        }),
      "Instruction alert saved.",
      "inventory"
    );
  }

  async function adjustSelectedInstruction(direction: 1 | -1) {
    if (!selectedInstruction) return;
    const count = Math.max(1, Math.trunc(Number(inventoryAdjustment)));
    const delta = direction * count;
    await runAction(
      () =>
        api.adjustInstruction(selectedInstruction.id, {
          delta,
          type: "correction",
          note: direction > 0 ? "Manual add" : "Manual remove"
        }),
      `${direction > 0 ? "Added" : "Removed"} ${count} ${selectedInstruction.label} instruction${count === 1 ? "" : "s"}.`,
      "inventory"
    );
  }

  async function saveInstructionMatch(value: string) {
    if (!selectedItem) return;
    await runAction(
      () => api.updateInstructionMatch(selectedItem.sku, instructionMatchInputFor(value)),
      "Instruction match saved."
    );
  }

  async function uploadInstructionFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selectedInstruction) return;

    const contentBase64 = await fileToBase64(file);
    await runAction(
      () =>
        api.uploadInstruction({
          filename: file.name,
          contentBase64,
          label: selectedInstruction.label
        }),
      "Instruction document uploaded.",
      "documents"
    );
  }

  async function uploadLabelFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selectedItem) return;

    const contentBase64 = await fileToBase64(file);
    await runAction(
      () =>
        api.uploadLabel({
          sku: selectedItem.sku,
          filename: file.name,
          contentBase64
        }),
      "Label uploaded."
    );
  }

  async function printInstructionBatch() {
    if (!selectedInstruction || !selectedInstructionAsset) return;
    const pages = Math.max(1, Math.trunc(Number(instructionPages)));
    const instructions = pages * selectedInstruction.perPage;
    const printerName = printerForAsset(selectedInstructionAsset);

    await runAction(
      async () => {
        await api.printPrintingAsset(selectedInstructionAsset.id, { printerName });
        await api.adjustInstruction(selectedInstruction.id, {
          delta: instructions,
          type: "print_batch",
          note: `${pages} printed page${pages === 1 ? "" : "s"}`
        });
      },
      `Sent ${selectedInstructionAsset.filename} to ${printerLabel(printerName)} and added ${instructions} ${selectedInstruction.label} instruction${instructions === 1 ? "" : "s"}.`,
      "documents"
    );
  }

  async function openAsset(asset: PrintAsset | undefined, noticeTarget: NoticeTarget = "labels") {
    if (!asset) return;
    await runAction(() => api.openPrintingAsset(asset.id), `Opened ${asset.filename}.`, noticeTarget);
  }

  async function printAsset(asset: PrintAsset | undefined, noticeTarget: NoticeTarget = "documents") {
    if (!asset) return;
    const printerName = printerForAsset(asset);
    await runAction(
      () => api.printPrintingAsset(asset.id, { printerName }),
      `Sent ${asset.filename} to ${printerLabel(printerName)}.`,
      noticeTarget
    );
  }

  async function savePrinterSettings() {
    setBusy(true);
    setLabelNotice("");
    setDocumentNotice("");
    setInventoryNotice("");
    setSettingsNotice("");
    try {
      await api.updatePrintSettings(printerSettings);
      await loadPrinting();
      setSettingsNotice("Print settings saved.");
    } catch (error) {
      setSettingsNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function setPaneNotice(noticeTarget: NoticeTarget, message: string) {
    if (noticeTarget === "documents") {
      setDocumentNotice(message);
      return;
    }
    if (noticeTarget === "inventory") {
      setInventoryNotice(message);
      return;
    }
    setLabelNotice(message);
  }

  function updateInstructionSettings(id: string, patch: Partial<InstructionSettingsMap[string]>) {
    setInstructionSettings((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? { lowAlert: 0 }),
        ...patch
      }
    }));
  }

  function printerForAsset(asset: PrintAsset) {
    return asset.kind === "label" ? printing.defaults.labelPrinterName : printing.defaults.instructionPrinterName;
  }

  function printerLabel(printerName?: string) {
    return printerName ? printerName : "the default printer";
  }

  return (
    <section className="printing-page">
      <section className="printing-top-grid">
        <PanelFrame className="printing-label-panel">
          <header className="panel-header">
            <span><Tags size={18} /></span>
            <h2>Product Labels</h2>
          </header>
          <div className="printing-form-grid label-print-controls">
            <label>
              SKU
              <select value={selectedItem?.id ?? ""} onChange={(event) => setSelectedLabelItemId(event.target.value)}>
                {labelItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.sku} - {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Labels
              <input
                type="number"
                min="1"
                max="250"
                value={labelCount}
                onChange={(event) => setLabelCount(Math.max(1, Number(event.target.value)))}
              />
            </label>
            <button
              className="icon-button primary full"
              type="button"
              disabled={!selectedItem || busy}
              onClick={() => selectedItem && openLabelPrintWindow(selectedItem, labelCount, matchedInstruction?.label)}
            >
              <Printer size={18} />
              Print Labels
            </button>
            <label className={`icon-button upload-button ${!selectedItem || busy ? "disabled" : ""}`}>
              <Upload size={18} />
              Upload
              <input
                type="file"
                accept=".doc,.docx,.pdf,.xls,.xlsx,.xlsm"
                disabled={!selectedItem || busy}
                onChange={(event) => void uploadLabelFile(event)}
              />
            </label>
          </div>
          <div className="print-asset-grid">
            <AssetCard
              label="Label Doc"
              asset={selectedLabelAsset}
              emptyText={labelItems.length ? "No matching doc" : "No inventory items"}
              onOpen={() => void openAsset(selectedLabelAsset, "labels")}
              onPrint={() => void printAsset(selectedLabelAsset, "labels")}
            />
          </div>
          <div className="instruction-match-card">
            <div className="instruction-match-row">
              <label>
                Instruction Match
                <select
                  value={instructionMatchValue}
                  disabled={!selectedItem || busy}
                  onChange={(event) => void saveInstructionMatch(event.target.value)}
                >
                  <option value="auto">Auto match</option>
                  <option value="none">None</option>
                  {printing.instructions.map((instruction) => (
                    <option key={instruction.id} value={`instruction:${instruction.id}`}>
                      {instruction.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <span>Current Instruction</span>
            <strong>
              {instructionMatchMode === "none" ? "No instructions" : matchedInstruction?.label ?? "No match"}
            </strong>
          </div>
          {labelNotice ? <p className="notice">{labelNotice}</p> : null}
        </PanelFrame>

        <PanelFrame className="instruction-document-panel">
          <header className="panel-header">
            <span><Printer size={18} /></span>
            <h2>Instruction Documents</h2>
          </header>
          {selectedInstruction ? (
            <>
              <div className="printing-form-grid instruction-document-controls">
                <label>
                  Type
                  <select value={selectedInstruction.id} onChange={(event) => setInstructionId(event.target.value)}>
                    {printing.instructions.map((instruction) => (
                      <option key={instruction.id} value={instruction.id}>
                        {instruction.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={`icon-button upload-button ${busy ? "disabled" : ""}`}>
                  <Upload size={18} />
                  Upload Doc
                  <input
                    type="file"
                    accept=".doc,.docx,.pdf,.xls,.xlsx,.xlsm"
                    disabled={busy}
                    onChange={(event) => void uploadInstructionFile(event)}
                  />
                </label>
              </div>
              <div className="print-asset-grid">
                <AssetCard
                  label="Source Doc"
                  asset={selectedInstructionAsset}
                  onOpen={() => void openAsset(selectedInstructionAsset, "documents")}
                />
              </div>
              <div className="printing-form-grid instruction-print-controls">
                <label>
                  Pages
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={instructionPages}
                    onChange={(event) => setInstructionPages(Math.max(1, Number(event.target.value)))}
                  />
                </label>
                <div className="instruction-match-card instruction-print-total">
                  <span>Adds</span>
                  <strong>{printedInstructionCount}</strong>
                </div>
                <button
                  className="icon-button primary full"
                  type="button"
                  disabled={!selectedInstructionAsset || busy}
                  onClick={printInstructionBatch}
                >
                  <Printer size={18} />
                  Print + Add
                </button>
              </div>
              {documentNotice ? <p className="notice">{documentNotice}</p> : null}
            </>
          ) : (
            <div className="empty">No instruction types</div>
          )}
        </PanelFrame>
      </section>

      <section className="printing-main-grid">
        <PanelFrame className="instruction-inventory-panel">
          <header className="panel-header">
            <span><FileText size={18} /></span>
            <h2>Instruction Inventory</h2>
          </header>
          <div className="instruction-metric-grid">
            <MiniPrintMetric label="Types" value={printing.instructions.length} />
            <MiniPrintMetric label="Low" value={lowCount} tone={lowCount ? "warn" : "ok"} />
            <MiniPrintMetric
              label="On Hand"
              value={printing.instructions.reduce((sum, instruction) => sum + instruction.onHand, 0)}
            />
          </div>
          {selectedInstruction ? (
            <div className="instruction-adjust-card">
              <div className="selected-instruction-summary">
                <span>Selected</span>
                <strong>{selectedInstruction.label}</strong>
                <span>On hand: {selectedInstruction.onHand}</span>
              </div>
              <div className="printing-form-grid instruction-adjust-controls">
                <label>
                  Adjust
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    value={inventoryAdjustment}
                    onChange={(event) => setInventoryAdjustment(Math.max(1, Number(event.target.value)))}
                  />
                </label>
                <button className="icon-button primary" type="button" disabled={busy} onClick={() => void adjustSelectedInstruction(1)}>
                  <Plus size={18} />
                  Add
                </button>
                <button className="icon-button danger-button" type="button" disabled={busy} onClick={() => void adjustSelectedInstruction(-1)}>
                  <Minus size={18} />
                  Remove
                </button>
              </div>
              <div className="instruction-settings-grid">
                <label>
                  Low Alert
                  <input
                    type="number"
                    min="0"
                    value={instructionSettings[selectedInstruction.id]?.lowAlert ?? selectedInstruction.lowAlert}
                    onChange={(event) =>
                      updateInstructionSettings(selectedInstruction.id, { lowAlert: Number(event.target.value) })
                    }
                  />
                </label>
                <button className="icon-button" type="button" disabled={busy} onClick={() => saveInstructionSettings(selectedInstruction)}>
                  <FileText size={18} />
                  Save Alert
                </button>
              </div>
            </div>
          ) : null}
          <div className="instruction-inventory-list">
            {printing.instructions.map((instruction) => (
              <button
                key={instruction.id}
                className={`instruction-inventory-row ${instruction.id === selectedInstruction?.id ? "active" : ""}`}
                type="button"
                onClick={() => setInstructionId(instruction.id)}
              >
                <span>{instruction.label}</span>
                <strong className={instruction.onHand <= instruction.lowAlert ? "warn" : "ok"}>{instruction.onHand}</strong>
              </button>
            ))}
          </div>
          {inventoryNotice ? <p className="notice">{inventoryNotice}</p> : null}
        </PanelFrame>

        <section className="printing-side-stack">
          <PanelFrame>
            <header className="panel-header">
              <span><Box size={18} /></span>
              <h2>Print Activity</h2>
            </header>
            <div className="print-event-list">
              {recentEvents.map((event) => {
                const instruction = printing.instructions.find((item) => item.id === event.instructionId);
                return (
                  <div className="print-event-row" key={event.id}>
                    <span>{instruction?.label ?? event.instructionId}</span>
                    <strong className={event.delta < 0 ? "danger" : "ok"}>
                      {event.delta > 0 ? `+${event.delta}` : event.delta}
                    </strong>
                    <span>{event.note ?? event.type.replaceAll("_", " ")}</span>
                    <time>{formatDate(event.createdAt)}</time>
                  </div>
                );
              })}
              {recentEvents.length === 0 ? <div className="empty">No print activity</div> : null}
            </div>
          </PanelFrame>
        </section>
      </section>

      {printSettingsOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={onPrintSettingsClose}>
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="print-settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="settings-modal-header">
              <div>
                <h2 id="print-settings-title">Print Settings</h2>
                <p>Labels + instruction printers</p>
              </div>
              <button className="icon-button" type="button" aria-label="Close print settings" onClick={onPrintSettingsClose}>
                <X size={18} />
              </button>
            </header>
            <div className="printer-settings-grid">
              <label>
                Label Printer
                <select
                  value={printerSettings.labelPrinterName}
                  onChange={(event) =>
                    setPrinterSettings((current) => ({ ...current, labelPrinterName: event.target.value }))
                  }
                >
                  <option value="">{printersLoading ? "Loading printers..." : "Windows default"}</option>
                  {printers.map((printer) => (
                    <option key={printer.name} value={printer.name}>
                      {printer.name}{printer.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Instruction Printer
                <select
                  value={printerSettings.instructionPrinterName}
                  onChange={(event) =>
                    setPrinterSettings((current) => ({ ...current, instructionPrinterName: event.target.value }))
                  }
                >
                  <option value="">{printersLoading ? "Loading printers..." : "Windows default"}</option>
                  {printers.map((printer) => (
                    <option key={printer.name} value={printer.name}>
                      {printer.name}{printer.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button className="icon-button primary" type="button" disabled={busy} onClick={savePrinterSettings}>
                <Settings size={18} />
                Save Printers
              </button>
            </div>
            {settingsNotice ? <p className="notice">{settingsNotice}</p> : null}
          </section>
        </div>
      ) : null}
    </section>
  );
}

function PanelFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={`panel ${className ?? ""}`}>{children}</section>;
}

function MiniPrintMetric({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <div className={`mini-stat ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AssetCard({
  label,
  asset,
  emptyText = "No matching doc",
  neutralEmpty = false,
  onOpen,
  onPrint
}: {
  label: string;
  asset?: PrintAsset;
  emptyText?: string;
  neutralEmpty?: boolean;
  onOpen: () => void;
  onPrint?: () => void;
}) {
  return (
    <div className={`print-asset-card ${asset ? "" : neutralEmpty ? "neutral-empty" : "missing"}`}>
      <div>
        <span>{label}</span>
        <strong>{asset?.displayName ?? emptyText}</strong>
      </div>
      <div className="print-asset-actions">
        <button className="icon-button" type="button" disabled={!asset} onClick={onOpen}>
          {asset ? <FolderOpen size={18} /> : <ExternalLink size={18} />}
          Open
        </button>
        {onPrint ? (
          <button className="icon-button primary" type="button" disabled={!asset} onClick={onPrint}>
            <Printer size={18} />
            Print
          </button>
        ) : null}
      </div>
    </div>
  );
}

function settingsFor(instruction: PrintInstruction) {
  return {
    lowAlert: instruction.lowAlert
  };
}

function resolveInstructionForSku(printing: PrintingPayload, sku: string) {
  const savedMatch = getInstructionMatch(printing, sku);
  if (savedMatch?.mode === "none") return undefined;
  if (savedMatch?.mode === "instruction" && savedMatch.instructionId) {
    return printing.instructions.find((instruction) => instruction.id === savedMatch.instructionId);
  }
  return matchInstruction(printing.instructions, sku);
}

function getInstructionMatch(printing: PrintingPayload, sku: string) {
  const normalizedSku = normalizeExactSku(sku);
  return printing.instructionMatches.find((match) => normalizeExactSku(match.sku) === normalizedSku);
}

function instructionMatchValueFor(printing: PrintingPayload, sku: string) {
  const match = getInstructionMatch(printing, sku);
  if (!match || match.mode === "auto") return "auto";
  if (match.mode === "none") return "none";
  return match.instructionId ? `instruction:${match.instructionId}` : "auto";
}

function instructionMatchInputFor(value: string) {
  if (value === "none") return { mode: "none" as const };
  if (value.startsWith("instruction:")) {
    return { mode: "instruction" as const, instructionId: value.slice("instruction:".length) };
  }
  return { mode: "auto" as const };
}

function matchInstruction(instructions: PrintInstruction[], sku: string) {
  const normalizedSku = normalizeSku(sku);
  const z3Seat = instructions.find((instruction) => instruction.id === "z3-seat-clips");
  if (z3Seat && z3Seat.matchTerms.every((term) => normalizedSku.includes(normalizeSku(term)))) return z3Seat;
  const z3Visor = instructions.find((instruction) => instruction.id === "z3-visor");
  if (z3Visor && z3Visor.matchTerms.every((term) => normalizedSku.includes(normalizeSku(term)))) return z3Visor;
  return instructions.find((instruction) => {
    if (isStrictInstructionMatch(instruction.id)) return false;
    return instruction.matchTerms.some((term) => normalizedSku.includes(normalizeSku(term)));
  });
}

function normalizeSku(value: string) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ");
}

function normalizeExactSku(value: string) {
  return String(value ?? "").trim().toUpperCase();
}

function isStrictInstructionMatch(id: string) {
  return id === "z3-seat-clips" || id === "z3-visor";
}

function findLabelAsset(assets: PrintAsset[], sku: string) {
  const normalizedSku = sku.toUpperCase();
  return assets.find((asset) => asset.kind === "label" && asset.sku?.toUpperCase() === normalizedSku);
}

function findInstructionAsset(assets: PrintAsset[], instructionId: string) {
  return assets.find((asset) => asset.kind === "instruction" && asset.instructionId === instructionId);
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Instruction file could not be read."));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.split(",").pop() ?? "" : value);
    };
    reader.readAsDataURL(file);
  });
}

function openLabelPrintWindow(item: InventoryItem, count: number, instructionLabel?: string) {
  const labels = Array.from({ length: count }, () => item);
  openPrintWindow(
    "Product Labels",
    `
      <style>
        @page { size: 2.25in 1.25in; margin: 0; }
        body { margin: 0; font-family: Arial, sans-serif; color: #111; }
        .label { box-sizing: border-box; width: 2.25in; height: 1.25in; padding: 0.08in 0.1in; page-break-after: always; display: grid; align-content: center; gap: 0.04in; }
        .sku { font-size: 17pt; font-weight: 800; line-height: 1; }
        .name { font-size: 8pt; line-height: 1.1; }
        .meta { font-size: 7pt; text-transform: uppercase; letter-spacing: 0.04em; }
      </style>
      ${labels
        .map(
          () => `
            <section class="label">
              <div class="sku">${escapeHtml(item.sku)}</div>
              <div class="name">${escapeHtml(item.name)}</div>
              <div class="meta">${escapeHtml(instructionLabel ? `${instructionLabel} instructions` : "No instruction match")}</div>
            </section>
          `
        )
        .join("")}
    `
  );
}

function openPrintWindow(title: string, body: string) {
  const printWindow = window.open("", "_blank", "popup=yes,width=900,height=700");
  if (!printWindow) return;
  printWindow.document.write(`
    <!doctype html>
    <html>
      <head><title>${escapeHtml(title)}</title></head>
      <body>${body}<script>window.onload = () => { window.focus(); window.print(); };</script></body>
    </html>
  `);
  printWindow.document.close();
}

function escapeHtml(value: string) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}
