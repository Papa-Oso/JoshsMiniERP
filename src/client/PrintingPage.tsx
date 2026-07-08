import { useEffect, useMemo, useState } from "react";
import { Box, ExternalLink, FileText, FolderOpen, PackageMinus, Printer, Save, Tags, Upload } from "lucide-react";
import { api } from "./api";
import type { DashboardPayload, InventoryItem, PrintAsset, PrintInstruction, PrintingPayload } from "../shared/types";

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

type DraftMap = Record<string, { title: string; body: string; lowAlert: number }>;

export function PrintingPage({ dashboard }: { dashboard: DashboardPayload }) {
  const [printing, setPrinting] = useState<PrintingPayload>(emptyPrinting);
  const [assets, setAssets] = useState<PrintAsset[]>([]);
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [selectedLabelItemId, setSelectedLabelItemId] = useState("");
  const [selectedInstructionItemId, setSelectedInstructionItemId] = useState("");
  const [labelCount, setLabelCount] = useState(15);
  const [instructionId, setInstructionId] = useState("");
  const [instructionPages, setInstructionPages] = useState(10);
  const [packageCount, setPackageCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const labelItems = useMemo(
    () => dashboard.items.filter((item) => Boolean(findLabelAsset(assets, item.sku))),
    [assets, dashboard.items]
  );
  const instructionItems = useMemo(
    () => dashboard.items.filter((item) => Boolean(resolveInstructionForSku(printing, item.sku))),
    [dashboard.items, printing]
  );
  const selectedItem = labelItems.find((item) => item.id === selectedLabelItemId) ?? labelItems[0] ?? null;
  const selectedInstructionItem =
    instructionItems.find((item) => item.id === selectedInstructionItemId) ??
    instructionItems.find((item) => item.id === selectedItem?.id) ??
    instructionItems[0] ??
    null;
  const selectedInstruction =
    printing.instructions.find((instruction) => instruction.id === instructionId) ?? printing.instructions[0] ?? null;
  const matchedInstruction = selectedItem ? resolveInstructionForSku(printing, selectedItem.sku) : undefined;
  const instructionMatchValue = selectedItem ? instructionMatchValueFor(printing, selectedItem.sku) : "auto";
  const instructionMatchMode = selectedItem ? getInstructionMatch(printing, selectedItem.sku)?.mode ?? "auto" : "auto";
  const selectedLabelAsset = selectedItem ? findLabelAsset(assets, selectedItem.sku) : undefined;
  const matchedInstructionAsset = matchedInstruction ? findInstructionAsset(assets, matchedInstruction.id) : undefined;
  const selectedInstructionAsset = selectedInstruction ? findInstructionAsset(assets, selectedInstruction.id) : undefined;
  const printableInserts = selectedInstruction ? instructionPages * selectedInstruction.perPage : 0;
  const recentEvents = printing.events.slice(0, 8);

  const lowCount = useMemo(
    () => printing.instructions.filter((instruction) => instruction.onHand <= instruction.lowAlert).length,
    [printing.instructions]
  );

  useEffect(() => {
    void loadPrinting();
  }, []);

  useEffect(() => {
    if (selectedLabelItemId && labelItems.some((item) => item.id === selectedLabelItemId)) return;
    if (labelItems[0]) setSelectedLabelItemId(labelItems[0].id);
  }, [labelItems, selectedLabelItemId]);

  useEffect(() => {
    if (
      selectedInstructionItemId &&
      instructionItems.some((item) => item.id === selectedInstructionItemId)
    ) {
      return;
    }
    if (instructionItems[0]) setSelectedInstructionItemId(instructionItems[0].id);
  }, [instructionItems, selectedInstructionItemId]);

  useEffect(() => {
    if (printing.defaults.labelBatchSize) setLabelCount(printing.defaults.labelBatchSize);
    if (printing.defaults.instructionPages) setInstructionPages(printing.defaults.instructionPages);
    if (!instructionId && printing.instructions[0]) setInstructionId(printing.instructions[0].id);
  }, [printing.defaults.instructionPages, printing.defaults.labelBatchSize, printing.instructions, instructionId]);

  async function loadPrinting() {
    const [data, assetData] = await Promise.all([api.printing(), api.printingAssets()]);
    setPrinting(data);
    setAssets(assetData);
    setDrafts(Object.fromEntries(data.instructions.map((instruction) => [instruction.id, draftFor(instruction)])));
  }

  async function runAction(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      await action();
      await loadPrinting();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveInstruction(instruction: PrintInstruction) {
    const draft = drafts[instruction.id] ?? draftFor(instruction);
    await runAction(
      () =>
        api.updateInstruction(instruction.id, {
          title: draft.title,
          body: draft.body,
          lowAlert: Number(draft.lowAlert)
        }),
      "Instruction template saved."
    );
  }

  async function printInstructionBatch() {
    if (!selectedInstruction) return;
    const draft = drafts[selectedInstruction.id] ?? draftFor(selectedInstruction);
    openInstructionPrintWindow({
      ...selectedInstruction,
      title: draft.title,
      body: draft.body
    }, instructionPages);
    await runAction(
      () =>
        api.adjustInstruction(selectedInstruction.id, {
          delta: printableInserts,
          type: "print_batch",
          note: `${instructionPages} page batch`
        }),
      `Added ${printableInserts} instruction inserts.`
    );
  }

  async function useForSelectedSku() {
    if (!selectedInstructionItem) return;
    await runAction(
      () => api.useMatchedInstruction({ sku: selectedInstructionItem.sku, quantity: packageCount }),
      "Instruction inventory reduced."
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
    if (!file || !selectedItem) return;

    const contentBase64 = await fileToBase64(file);
    await runAction(
      () =>
        api.uploadInstruction({
          filename: file.name,
          contentBase64,
          label: instructionLabelFromSku(selectedItem),
          sku: selectedItem.sku
        }),
      "Instruction uploaded and matched."
    );
  }

  async function openAsset(asset: PrintAsset | undefined) {
    if (!asset) return;
    await runAction(() => api.openPrintingAsset(asset.id), `Opened ${asset.filename}.`);
  }

  function updateDraft(id: string, patch: Partial<DraftMap[string]>) {
    setDrafts((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? { title: "", body: "", lowAlert: 0 }),
        ...patch
      }
    }));
  }

  return (
    <section className="printing-page">
      <section className="printing-top-grid">
        <PanelFrame className="printing-label-panel">
          <header className="panel-header">
            <span><Tags size={18} /></span>
            <h2>Product Labels</h2>
          </header>
          <div className="printing-form-grid">
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
              disabled={!selectedItem || !selectedLabelAsset}
              onClick={() => selectedItem && openLabelPrintWindow(selectedItem, labelCount, matchedInstruction?.label)}
            >
              <Printer size={18} />
              Print Labels
            </button>
          </div>
          <div className="instruction-match-card">
            <div className="instruction-match-row">
              <label>
                Instructions
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
              <label className={`icon-button upload-button ${!selectedItem || busy ? "disabled" : ""}`}>
                <Upload size={18} />
                Upload
                <input
                  type="file"
                  accept=".doc,.docx,.pdf,.xls,.xlsx,.xlsm"
                  disabled={!selectedItem || busy}
                  onChange={(event) => void uploadInstructionFile(event)}
                />
              </label>
            </div>
            <span>Current Match</span>
            <strong>
              {instructionMatchMode === "none" ? "No instructions" : matchedInstruction?.label ?? "No match"}
            </strong>
          </div>
          <div className="print-asset-grid">
            <AssetCard
              label="Label Doc"
              asset={selectedLabelAsset}
              emptyText={labelItems.length ? "No matching doc" : "No label docs"}
              onOpen={() => void openAsset(selectedLabelAsset)}
            />
            <AssetCard
              label="Instruction Doc"
              asset={matchedInstructionAsset}
              emptyText="No matching doc"
              onOpen={() => void openAsset(matchedInstructionAsset)}
            />
          </div>
          <div className="printing-form-grid">
            <label>
              Instruction SKU
              <select
                value={selectedInstructionItem?.id ?? ""}
                onChange={(event) => setSelectedInstructionItemId(event.target.value)}
              >
                {instructionItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.sku} - {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Packages
              <input
                type="number"
                min="1"
                max="250"
                value={packageCount}
                onChange={(event) => setPackageCount(Math.max(1, Number(event.target.value)))}
              />
            </label>
            <button className="icon-button" type="button" disabled={!selectedInstructionItem || busy} onClick={useForSelectedSku}>
              <PackageMinus size={18} />
              Use Matched
            </button>
          </div>
          {notice ? <p className="notice">{notice}</p> : null}
        </PanelFrame>

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

      <section className="printing-main-grid">
        <PanelFrame className="instruction-template-panel">
          <header className="panel-header">
            <span><Printer size={18} /></span>
            <h2>Instruction Sheets</h2>
          </header>
          {selectedInstruction ? (
            <>
              <div className="printing-form-grid instruction-print-controls">
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
                <div className="instruction-match-card">
                  <span>Will Add</span>
                  <strong>{printableInserts}</strong>
                </div>
                <button className="icon-button primary full" type="button" disabled={busy} onClick={printInstructionBatch}>
                  <Printer size={18} />
                  Print + Add
                </button>
              </div>
              <div className="print-asset-grid">
                <AssetCard
                  label="Source Doc"
                  asset={selectedInstructionAsset}
                  onOpen={() => void openAsset(selectedInstructionAsset)}
                />
              </div>
              <div className="template-editor-grid">
                <label>
                  Title
                  <input
                    value={drafts[selectedInstruction.id]?.title ?? selectedInstruction.title}
                    onChange={(event) => updateDraft(selectedInstruction.id, { title: event.target.value })}
                  />
                </label>
                <label>
                  Low Alert
                  <input
                    type="number"
                    min="0"
                    value={drafts[selectedInstruction.id]?.lowAlert ?? selectedInstruction.lowAlert}
                    onChange={(event) => updateDraft(selectedInstruction.id, { lowAlert: Number(event.target.value) })}
                  />
                </label>
                <label className="template-body-field">
                  Body
                  <textarea
                    value={drafts[selectedInstruction.id]?.body ?? selectedInstruction.body}
                    onChange={(event) => updateDraft(selectedInstruction.id, { body: event.target.value })}
                  />
                </label>
                <button className="icon-button" type="button" disabled={busy} onClick={() => saveInstruction(selectedInstruction)}>
                  <Save size={18} />
                  Save Template
                </button>
              </div>
            </>
          ) : (
            <div className="empty">No instruction types</div>
          )}
        </PanelFrame>

        <PanelFrame>
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
        </PanelFrame>
      </section>
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
  onOpen
}: {
  label: string;
  asset?: PrintAsset;
  emptyText?: string;
  neutralEmpty?: boolean;
  onOpen: () => void;
}) {
  return (
    <div className={`print-asset-card ${asset ? "" : neutralEmpty ? "neutral-empty" : "missing"}`}>
      <div>
        <span>{label}</span>
        <strong>{asset?.displayName ?? emptyText}</strong>
      </div>
      <button className="icon-button" type="button" disabled={!asset} onClick={onOpen}>
        {asset ? <FolderOpen size={18} /> : <ExternalLink size={18} />}
        Open
      </button>
    </div>
  );
}

function draftFor(instruction: PrintInstruction) {
  return {
    title: instruction.title,
    body: instruction.body,
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

function instructionLabelFromSku(item: InventoryItem) {
  const parts = item.sku.toUpperCase().split("-").filter(Boolean);
  const family = parts[1];
  if (family === "Z3" && parts.includes("VISOR")) return "Z3 Visor";
  if (family === "Z3" && (parts.includes("SEATBELT") || parts.includes("SEAT"))) return "Z3 Seat Clips";
  return family || item.name;
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

function openInstructionPrintWindow(instruction: PrintInstruction, pages: number) {
  const pageMarkup = Array.from({ length: pages }, () => instruction)
    .map(
      () => `
        <section class="sheet">
          ${Array.from({ length: instruction.perPage }, () => instruction)
            .map(
              () => `
                <article class="card">
                  <h1>${escapeHtml(instruction.title || instruction.label)}</h1>
                  <p>${escapeHtml(instruction.body || "").replaceAll("\n", "<br>")}</p>
                </article>
              `
            )
            .join("")}
        </section>
      `
    )
    .join("");

  openPrintWindow(
    `${instruction.label} Instructions`,
    `
      <style>
        @page { size: letter; margin: 0.35in; }
        body { margin: 0; font-family: Arial, sans-serif; color: #111; }
        .sheet { height: 10.3in; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 0.18in; page-break-after: always; }
        .card { border: 1px dashed #777; padding: 0.16in; overflow: hidden; }
        h1 { margin: 0 0 0.1in; font-size: 14pt; }
        p { margin: 0; font-size: 10pt; line-height: 1.25; white-space: normal; }
      </style>
      ${pageMarkup}
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
