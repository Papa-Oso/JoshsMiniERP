import { useEffect, useMemo, useState } from "react";
import { FileText, PackagePlus, Plus, Save, Tags, Upload } from "lucide-react";
import { api } from "./api";
import type { DashboardPayload, InventoryItem, PrintAsset, PrintInstruction, PrintingPayload } from "../shared/types";
import { defaultMaxInventory } from "../shared/types";

const emptyPrinting: PrintingPayload = {
  instructions: [],
  instructionMatches: [],
  events: [],
  defaults: {
    labelBatchSize: 15,
    instructionPages: 10,
    instructionPerPage: 4
  }
};

type InstructionChoice = "auto" | "none" | "upload" | `instruction:${string}`;

export function ItemManagementPage({
  dashboard,
  onDashboardChange
}: {
  dashboard: DashboardPayload;
  onDashboardChange: () => Promise<void>;
}) {
  const [printing, setPrinting] = useState<PrintingPayload>(emptyPrinting);
  const [assets, setAssets] = useState<PrintAsset[]>([]);
  const [draft, setDraft] = useState({
    sku: "",
    name: "",
    quantity: 0,
    safetyStock: 10,
    maxInventory: defaultMaxInventory,
    active: true
  });
  const [selectedItemId, setSelectedItemId] = useState("");
  const [labelFile, setLabelFile] = useState<File | null>(null);
  const [instructionChoice, setInstructionChoice] = useState<InstructionChoice>("auto");
  const [instructionFile, setInstructionFile] = useState<File | null>(null);
  const [instructionLabel, setInstructionLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const sortedItems = useMemo(
    () =>
      [...dashboard.items].sort((left, right) => {
        const activeCompare = Number(right.active !== false) - Number(left.active !== false);
        return activeCompare || left.sku.localeCompare(right.sku);
      }),
    [dashboard.items]
  );
  const selectedItem = sortedItems.find((item) => item.id === selectedItemId) ?? null;

  useEffect(() => {
    void loadPrinting();
  }, []);

  useEffect(() => {
    if (!selectedItem) return;
    setDraft({
      sku: selectedItem.sku,
      name: selectedItem.name,
      quantity: selectedItem.quantity,
      safetyStock: selectedItem.safetyStock,
      maxInventory: selectedItem.maxInventory ?? defaultMaxInventory,
      active: selectedItem.active !== false
    });
    setLabelFile(null);
    setInstructionFile(null);
    setInstructionLabel("");
    setInstructionChoice(instructionChoiceForSku(printing, selectedItem.sku));
  }, [printing, selectedItem]);

  async function loadPrinting() {
    const [data, assetData] = await Promise.all([api.printing(), api.printingAssets()]);
    setPrinting(data);
    setAssets(assetData);
  }

  function startNewItem() {
    setSelectedItemId("");
    setDraft({
      sku: "",
      name: "",
      quantity: 0,
      safetyStock: 10,
      maxInventory: defaultMaxInventory,
      active: true
    });
    setLabelFile(null);
    setInstructionFile(null);
    setInstructionLabel("");
    setInstructionChoice("auto");
    setNotice("");
  }

  async function saveItem() {
    setBusy(true);
    setNotice("");

    try {
      const sku = draft.sku.trim().toUpperCase();
      const saved = selectedItem
        ? await api.updateItem(selectedItem.id, {
            sku,
            name: draft.name,
            safetyStock: Number(draft.safetyStock),
            maxInventory: Number(draft.maxInventory),
            active: draft.active
          })
        : await api.createItem({
            sku,
            name: draft.name,
            quantity: Number(draft.quantity),
            safetyStock: Number(draft.safetyStock),
            maxInventory: Number(draft.maxInventory)
          });

      if (labelFile) {
        await api.uploadLabel({
          sku,
          filename: labelFile.name,
          contentBase64: await fileToBase64(labelFile)
        });
      }

      if (instructionChoice === "upload" && !instructionFile) {
        throw new Error("Choose an instruction document to upload.");
      }

      if (instructionChoice === "none") {
        await api.updateInstructionMatch(sku, { mode: "none" });
      } else if (instructionChoice.startsWith("instruction:")) {
        await api.updateInstructionMatch(sku, {
          mode: "instruction",
          instructionId: instructionChoice.slice("instruction:".length)
        });
      } else if (instructionChoice === "upload" && instructionFile) {
        await api.uploadInstruction({
          filename: instructionFile.name,
          contentBase64: await fileToBase64(instructionFile),
          label: instructionLabel.trim() || instructionLabelFromSku(sku, draft.name),
          sku
        });
      } else {
        await api.updateInstructionMatch(sku, { mode: "auto" });
      }

      setLabelFile(null);
      setInstructionFile(null);
      setInstructionLabel("");
      await Promise.all([onDashboardChange(), loadPrinting()]);
      setSelectedItemId(saved.id);
      setNotice(`${saved.sku} saved.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="item-management-page">
      <section className="item-management-grid">
        <section className="panel item-create-panel">
          <header className="panel-header">
            <span><PackagePlus size={18} /></span>
            <h2>{selectedItem ? "Edit SKU" : "Add SKU"}</h2>
            {selectedItem ? (
              <button className="icon-button" type="button" onClick={startNewItem}>
                <Plus size={18} />
                New
              </button>
            ) : null}
          </header>

          <div className="item-create-grid">
            <label>
              SKU
              <input
                value={draft.sku}
                onChange={(event) => setDraft({ ...draft, sku: event.target.value })}
                placeholder="JW-HJC-EDGE-001"
              />
            </label>
            <label>
              Name
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="HJC Edge"
              />
            </label>
            <label>
              {selectedItem ? "Current Stock" : "Starting Stock"}
              <input
                type="number"
                min="0"
                value={draft.quantity}
                disabled={Boolean(selectedItem)}
                onChange={(event) => setDraft({ ...draft, quantity: Number(event.target.value) })}
              />
            </label>
            <label>
              Low Alert
              <input
                type="number"
                min="0"
                value={draft.safetyStock}
                onChange={(event) => setDraft({ ...draft, safetyStock: Number(event.target.value) })}
              />
            </label>
            <label>
              Max Inventory
              <input
                type="number"
                min="1"
                value={draft.maxInventory}
                onChange={(event) => setDraft({ ...draft, maxInventory: Number(event.target.value) })}
              />
            </label>
            <label>
              Status
              <select
                value={draft.active ? "active" : "inactive"}
                onChange={(event) => setDraft({ ...draft, active: event.target.value === "active" })}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
          </div>

          <div className="item-print-setup">
            <div className="item-print-block">
              <div className="item-print-heading">
                <Tags size={18} />
                <strong>Product Label</strong>
              </div>
              <label className="file-pick-button">
                <Upload size={18} />
                {labelFile ? labelFile.name : "Upload Label Doc"}
                <input
                  type="file"
                  accept=".doc,.docx,.pdf,.xls,.xlsx,.xlsm"
                  onChange={(event) => setLabelFile(event.target.files?.[0] ?? null)}
                />
              </label>
              {labelFile ? (
                <button className="text-button" type="button" onClick={() => setLabelFile(null)}>
                  Clear label
                </button>
              ) : null}
            </div>

            <div className="item-print-block">
              <div className="item-print-heading">
                <FileText size={18} />
                <strong>Instructions</strong>
              </div>
              <select
                value={instructionChoice}
                onChange={(event) => setInstructionChoice(event.target.value as InstructionChoice)}
              >
                <option value="auto">Auto match from SKU</option>
                <option value="none">None</option>
                {printing.instructions.map((instruction) => (
                  <option key={instruction.id} value={`instruction:${instruction.id}`}>
                    {instruction.label}
                  </option>
                ))}
                <option value="upload">Upload new instruction</option>
              </select>

              {instructionChoice === "upload" ? (
                <div className="upload-new-instruction">
                  <label>
                    Instruction Name
                    <input
                      value={instructionLabel}
                      onChange={(event) => setInstructionLabel(event.target.value)}
                      placeholder={instructionLabelFromSku(draft.sku, draft.name)}
                    />
                  </label>
                  <label className="file-pick-button">
                    <Upload size={18} />
                    {instructionFile ? instructionFile.name : "Upload Instruction Doc"}
                    <input
                      type="file"
                      accept=".doc,.docx,.pdf,.xls,.xlsx,.xlsm"
                      onChange={(event) => setInstructionFile(event.target.files?.[0] ?? null)}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          </div>

          <button className="icon-button primary item-save-button" type="button" disabled={busy} onClick={saveItem}>
            <Save size={18} />
            {selectedItem ? "Save Changes" : "Save SKU"}
          </button>
          {notice ? <p className="notice">{notice}</p> : null}
        </section>

        <section className="panel item-library-panel">
          <header className="panel-header">
            <span><FileText size={18} /></span>
            <h2>SKU Print Setup</h2>
          </header>
          <div className="item-setup-column-labels" aria-hidden="true">
            <span>Item</span>
            <span>Label Doc</span>
            <span>Instructions</span>
            <span>Low</span>
            <span>Max</span>
            <span>Status</span>
          </div>
          <div className="item-setup-list">
            {sortedItems.map((item) => (
              <ItemSetupRow
                key={item.id}
                item={item}
                printing={printing}
                assets={assets}
                selected={item.id === selectedItemId}
                onSelect={() => setSelectedItemId(item.id)}
              />
            ))}
          </div>
        </section>
      </section>
    </section>
  );
}

function ItemSetupRow({
  item,
  printing,
  assets,
  selected,
  onSelect
}: {
  item: InventoryItem;
  printing: PrintingPayload;
  assets: PrintAsset[];
  selected: boolean;
  onSelect: () => void;
}) {
  const labelAsset = findLabelAsset(assets, item.sku);
  const savedMatch = getInstructionMatch(printing, item.sku);
  const instruction = resolveInstructionForSku(printing, item.sku);
  const instructionTone = savedMatch?.mode === "none" ? "none" : instruction ? "ok" : "missing";
  const title = item.name || item.sku;

  return (
    <button
      className={`item-setup-row ${selected ? "selected" : ""} ${item.active === false ? "inactive" : ""}`}
      type="button"
      onClick={onSelect}
    >
      <div className="item-setup-identity">
        <strong>{title}</strong>
        <small>{item.sku}</small>
      </div>
      <span className={labelAsset ? "ok" : "missing"}>{labelAsset ? labelAsset.displayName : "No label"}</span>
      <span className={instructionTone}>
        {savedMatch?.mode === "none" ? "No instructions" : instruction?.label ?? "No instruction"}
      </span>
      <span>{item.safetyStock}</span>
      <span>{item.maxInventory ?? defaultMaxInventory}</span>
      <span className={item.active === false ? "missing" : "ok"}>{item.active === false ? "Inactive" : "Active"}</span>
    </button>
  );
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

function instructionChoiceForSku(printing: PrintingPayload, sku: string): InstructionChoice {
  const match = getInstructionMatch(printing, sku);
  if (!match || match.mode === "auto") return "auto";
  if (match.mode === "none") return "none";
  return match.instructionId ? `instruction:${match.instructionId}` : "auto";
}

function matchInstruction(instructions: PrintInstruction[], sku: string) {
  const normalizedSku = normalizeSku(sku);
  const z3Seat = instructions.find((instruction) => instruction.id === "z3-seat-clips");
  if (z3Seat && z3Seat.matchTerms.every((term) => normalizedSku.includes(normalizeSku(term)))) return z3Seat;
  const z3Visor = instructions.find((instruction) => instruction.id === "z3-visor");
  if (z3Visor && z3Visor.matchTerms.every((term) => normalizedSku.includes(normalizeSku(term)))) return z3Visor;
  return instructions.find((instruction) => {
    if (instruction.id === "z3-seat-clips" || instruction.id === "z3-visor") return false;
    return instruction.matchTerms.some((term) => normalizedSku.includes(normalizeSku(term)));
  });
}

function findLabelAsset(assets: PrintAsset[], sku: string) {
  const normalizedSku = sku.toUpperCase();
  return assets.find((asset) => asset.kind === "label" && asset.sku?.toUpperCase() === normalizedSku);
}

function instructionLabelFromSku(sku: string, name: string) {
  const parts = sku.toUpperCase().split("-").filter(Boolean);
  const family = parts[1];
  if (family === "Z3" && parts.includes("VISOR")) return "Z3 Visor";
  if (family === "Z3" && (parts.includes("SEATBELT") || parts.includes("SEAT"))) return "Z3 Seat Clips";
  return family || name || "Custom";
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File could not be read."));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.split(",").pop() ?? "" : value);
    };
    reader.readAsDataURL(file);
  });
}

function normalizeSku(value: string) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ");
}

function normalizeExactSku(value: string) {
  return String(value ?? "").trim().toUpperCase();
}
