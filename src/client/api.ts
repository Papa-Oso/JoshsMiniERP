import type {
  AdjustInventoryInput,
  PrintAsset,
  CreateItemInput,
  DashboardPayload,
  AdjustInstructionInput,
  InventoryItem,
  OperationsReportPayload,
  PrinterInfo,
  PrintingPayload,
  UpdatePrintSettingsInput,
  UpdateInstructionMatchInput,
  UpdateInstructionInput,
  UploadInstructionInput,
  UploadInstructionResult,
  UploadLabelInput,
  UploadLabelResult,
  UpdateItemInput,
  UpdateScheduleInput,
  SalesDashboardPayload,
  Platform
} from "../shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? response.statusText);
  }
  return payload as T;
}

export const api = {
  dashboard: () => request<DashboardPayload>("/api/dashboard"),
  createItem: (input: CreateItemInput) =>
    request<InventoryItem>("/api/items", { method: "POST", body: JSON.stringify(input) }),
  updateItem: (id: string, input: UpdateItemInput) =>
    request<InventoryItem>(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteItem: (id: string) => request<{ item: InventoryItem; platformTouched: false }>(`/api/items/${id}`, { method: "DELETE" }),
  adjustInventory: (id: string, input: AdjustInventoryInput) =>
    request(`/api/items/${id}/adjust`, { method: "POST", body: JSON.stringify(input) }),
  updateSchedule: (input: UpdateScheduleInput) =>
    request("/api/schedule", { method: "PATCH", body: JSON.stringify(input) }),
  runSync: () => request("/api/sync", { method: "POST" }),
  operationsReport: () => request<OperationsReportPayload>("/api/reports/operations"),
  acknowledgeFeedback: (feedbackKey: string) =>
    request(`/api/ebay-reviews/feedback/${encodeURIComponent(feedbackKey)}/acknowledge`, { method: "POST" }),
  sales: (range = "90d", platform: Platform | "all" = "all") =>
    request<SalesDashboardPayload>(`/api/sales?range=${encodeURIComponent(range)}&platform=${encodeURIComponent(platform)}`),
  refreshSales: () => request<{ results: Array<{ platform: Platform; ok: boolean; ordersSeen: number; message: string }>; dashboard: SalesDashboardPayload }>("/api/sales/refresh", { method: "POST", body: "{}" }),
  printing: () => request<PrintingPayload>("/api/printing"),
  printers: () => request<PrinterInfo[]>("/api/printing/printers"),
  updatePrintSettings: (input: UpdatePrintSettingsInput) =>
    request<PrintingPayload["defaults"]>("/api/printing/settings", {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  printingAssets: () => request<PrintAsset[]>("/api/printing/assets"),
  openPrintingAsset: (id: string) =>
    request<PrintAsset>(`/api/printing/assets/${encodeURIComponent(id)}/open`, { method: "POST" }),
  printPrintingAsset: (id: string, input?: { printerName?: string }) =>
    request<PrintAsset>(`/api/printing/assets/${encodeURIComponent(id)}/print`, {
      method: "POST",
      body: JSON.stringify(input ?? {})
    }),
  uploadInstruction: (input: UploadInstructionInput) =>
    request<UploadInstructionResult>("/api/printing/instructions/upload", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  uploadLabel: (input: UploadLabelInput) =>
    request<UploadLabelResult>("/api/printing/labels/upload", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  updateInstruction: (id: string, input: UpdateInstructionInput) =>
    request(`/api/printing/instructions/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  updateInstructionMatch: (sku: string, input: UpdateInstructionMatchInput) =>
    request(`/api/printing/instruction-matches/${encodeURIComponent(sku)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  adjustInstruction: (id: string, input: AdjustInstructionInput) =>
    request(`/api/printing/instructions/${id}/adjust`, { method: "POST", body: JSON.stringify(input) })
};
