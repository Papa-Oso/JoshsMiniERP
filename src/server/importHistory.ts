import { randomUUID } from "node:crypto";
import type { ImportBatchRecord, ImportBatchRow, ImportBatchSource, ImportBatchStatus, ImportBatchSummary } from "../shared/types";
import { store } from "./store";

export interface RecordImportBatchInput {
  source: ImportBatchSource;
  fileName?: string;
  status: ImportBatchStatus;
  summary: ImportBatchSummary;
  rows: Array<Omit<ImportBatchRow, "id"> & { id?: string }>;
}

export async function recordImportBatch(input: RecordImportBatchInput) {
  if (!store.recordImportBatch) return;

  const batch: ImportBatchRecord = {
    id: randomUUID(),
    source: input.source,
    fileName: input.fileName,
    status: input.status,
    summary: input.summary,
    rows: input.rows.map((row) => ({
      ...row,
      id: row.id ?? randomUUID()
    })),
    createdAt: new Date().toISOString()
  };

  await store.recordImportBatch(batch);
}

export async function listImportBatches(limit?: number) {
  return store.listImportBatches?.(limit) ?? [];
}
