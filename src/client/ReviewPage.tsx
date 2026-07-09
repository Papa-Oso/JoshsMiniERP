import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Activity, ClipboardList, FileSpreadsheet, GitCompare, History, PackageCheck, RefreshCw, SearchCheck } from "lucide-react";
import { api } from "./api";
import { Metric, Panel } from "./ui";
import type {
  ImportBatchRecord,
  InstructionTrendRow,
  InventoryEvent,
  MappingHealthRow,
  OperationsReportPayload,
  PrintEvent,
  ReconcileRunRecord,
  SyncRun
} from "../shared/types";
import { platformLabels } from "../shared/types";

export function ReviewPage() {
  const [report, setReport] = useState<OperationsReportPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setReport(await api.operationsReport());
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  const mappingIssues = useMemo(
    () => report?.mappingHealth.filter((row) => row.status !== "ok" && row.status !== "disabled") ?? [],
    [report]
  );

  if (loading && !report) {
    return <div className="empty">Loading review history</div>;
  }

  if (error && !report) {
    return (
      <Panel title="Review" icon={<ClipboardList size={18} />}>
        <p className="notice">{error}</p>
      </Panel>
    );
  }

  if (!report) return null;

  return (
    <section className="review-center-page">
      <div className="review-center-summary">
        <Metric label="Imports" value={report.totals.imports} />
        <Metric label="Reconcile" value={report.totals.reconcileRuns} />
        <Metric label="Sync Runs" value={report.totals.syncRuns} />
        <Metric label="Moves" value={report.totals.inventoryEvents} />
        <Metric label="Instr Low" value={report.totals.instructionLow} tone={report.totals.instructionLow ? "warn" : "ok"} />
        <Metric label="Feedback" value={report.totals.feedbackScanRuns} />
        <Metric label="Map Issues" value={report.totals.mappingIssues} tone={report.totals.mappingIssues ? "warn" : "ok"} />
        <button className="icon-button primary review-refresh" type="button" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? "spin" : ""} size={18} />
          Refresh
        </button>
      </div>

      {error ? <p className="notice">{error}</p> : null}

      <div className="review-center-grid">
        <ImportHistoryPanel batches={report.importBatches} />
        <ReconcileHistoryPanel runs={report.reconcileRuns} />
        <SyncHistoryPanel runs={report.syncRuns} />
        <InventoryMovementPanel events={report.inventoryEvents} />
        <InstructionTrendPanel rows={report.instructionTrends} />
        <InstructionEventPanel events={report.printEvents} />
        <MappingHealthPanel rows={mappingIssues.length ? mappingIssues : report.mappingHealth.slice(0, 12)} />
        <FeedbackScanPanel runs={report.feedbackScanRuns} />
      </div>
    </section>
  );
}

function ImportHistoryPanel({ batches }: { batches: ImportBatchRecord[] }) {
  return (
    <Panel title="Import History" icon={<FileSpreadsheet size={18} />} className="review-center-panel">
      <ReportTable empty="No imports recorded">
        {batches.map((batch) => (
          <tr key={batch.id}>
            <td>
              <strong>{batch.source.toUpperCase()}</strong>
              <span>{formatDate(batch.createdAt)}</span>
            </td>
            <td>{batch.status}</td>
            <td>{batch.summary.created}</td>
            <td>{batch.summary.mapped}</td>
            <td>{batch.summary.adjusted}</td>
            <td>{batch.summary.skipped + batch.summary.failed}</td>
          </tr>
        ))}
      </ReportTable>
    </Panel>
  );
}

function ReconcileHistoryPanel({ runs }: { runs: ReconcileRunRecord[] }) {
  return (
    <Panel title="Reconcile Snapshots" icon={<GitCompare size={18} />} className="review-center-panel">
      <ReportTable empty="No reconcile snapshots">
        {runs.map((run) => (
          <tr key={run.id}>
            <td>
              <strong>{run.platform ? platformLabels[run.platform] : "All stores"}</strong>
              <span>{formatDate(run.createdAt)}</span>
            </td>
            <td>{run.summary.salesDetected}</td>
            <td>{run.summary.pushes}</td>
            <td>{run.summary.warnings}</td>
            <td>{run.summary.errors}</td>
            <td>{run.rows[0]?.message ?? "-"}</td>
          </tr>
        ))}
      </ReportTable>
    </Panel>
  );
}

function SyncHistoryPanel({ runs }: { runs: SyncRun[] }) {
  return (
    <Panel title="Sync History" icon={<History size={18} />} className="review-center-panel">
      <ReportTable empty="No sync runs">
        {runs.map((run) => (
          <tr key={run.id}>
            <td>
              <strong>{run.status.replaceAll("_", " ")}</strong>
              <span>{formatDate(run.finishedAt ?? run.startedAt)}</span>
            </td>
            <td>{run.mode}</td>
            <td>{run.summary.salesDetected}</td>
            <td>{run.summary.pushes}</td>
            <td>{run.summary.warnings + run.summary.errors}</td>
            <td>{run.messages[0] ?? "-"}</td>
          </tr>
        ))}
      </ReportTable>
    </Panel>
  );
}

function InventoryMovementPanel({ events }: { events: InventoryEvent[] }) {
  return (
    <Panel title="Inventory Movement" icon={<Activity size={18} />} className="review-center-panel">
      <ReportTable empty="No inventory movement">
        {events.map((event) => (
          <tr key={event.id}>
            <td>
              <strong>{event.sku}</strong>
              <span>{formatDate(event.createdAt)}</span>
            </td>
            <td className={event.delta < 0 ? "danger" : event.delta > 0 ? "ok" : ""}>
              {event.delta > 0 ? `+${event.delta}` : event.delta}
            </td>
            <td>{event.quantityAfter}</td>
            <td>{event.type.replaceAll("_", " ")}</td>
            <td>{event.platform ? platformLabels[event.platform] : event.source}</td>
            <td>{event.note ?? "-"}</td>
          </tr>
        ))}
      </ReportTable>
    </Panel>
  );
}

function InstructionTrendPanel({ rows }: { rows: InstructionTrendRow[] }) {
  return (
    <Panel title="Instruction Trend" icon={<PackageCheck size={18} />} className="review-center-panel">
      <ReportTable empty="No instruction stock">
        {rows.map((row) => (
          <tr key={row.instructionId}>
            <td>
              <strong>{row.label}</strong>
              <span>{row.instructionId}</span>
            </td>
            <td>{row.onHand}</td>
            <td>{row.lowAlert}</td>
            <td>{row.maxInventory}</td>
            <td className={row.recentDelta < 0 ? "danger" : row.recentDelta > 0 ? "ok" : ""}>
              {row.recentDelta > 0 ? `+${row.recentDelta}` : row.recentDelta}
            </td>
            <td>
              <span className={`report-status-pill ${row.status}`}>{row.status.replaceAll("_", " ")}</span>
            </td>
          </tr>
        ))}
      </ReportTable>
    </Panel>
  );
}

function InstructionEventPanel({ events }: { events: PrintEvent[] }) {
  return (
    <Panel title="Instruction Usage" icon={<PackageCheck size={18} />} className="review-center-panel">
      <ReportTable empty="No instruction movement">
        {events.map((event) => (
          <tr key={event.id}>
            <td>
              <strong>{event.instructionId}</strong>
              <span>{formatDate(event.createdAt)}</span>
            </td>
            <td className={event.delta < 0 ? "danger" : event.delta > 0 ? "ok" : ""}>
              {event.delta > 0 ? `+${event.delta}` : event.delta}
            </td>
            <td>{event.quantityAfter}</td>
            <td>{event.type.replaceAll("_", " ")}</td>
            <td>{event.note ?? "-"}</td>
          </tr>
        ))}
      </ReportTable>
    </Panel>
  );
}

function MappingHealthPanel({ rows }: { rows: MappingHealthRow[] }) {
  return (
    <Panel title="Mapping Health" icon={<SearchCheck size={18} />} className="review-center-panel">
      <ReportTable empty="No enabled mappings">
        {rows.map((row) => (
          <tr key={`${row.sku}:${row.platform}`}>
            <td>
              <strong>{row.sku}</strong>
              <span>{row.name}</span>
            </td>
            <td>{platformLabels[row.platform]}</td>
            <td>
              <span className={`report-status-pill ${row.status}`}>{row.status.replaceAll("_", " ")}</span>
            </td>
            <td>{row.message}</td>
          </tr>
        ))}
      </ReportTable>
    </Panel>
  );
}

function FeedbackScanPanel({ runs }: { runs: OperationsReportPayload["feedbackScanRuns"] }) {
  return (
    <Panel title="Feedback Scans" icon={<ClipboardList size={18} />} className="review-center-panel">
      <ReportTable empty="No feedback scans">
        {runs.map((run) => (
          <tr key={run.id}>
            <td>
              <strong>{run.scanMode}</strong>
              <span>{formatDate(run.createdAt)}</span>
            </td>
            <td>{run.rowsSeen}</td>
            <td>{run.rowsExported}</td>
            <td>{run.newRows}</td>
            <td>{run.skippedExistingRows}</td>
          </tr>
        ))}
      </ReportTable>
    </Panel>
  );
}

function ReportTable({ children, empty }: { children: ReactNode; empty: string }) {
  const rows = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  if (rows.length === 0) return <div className="empty">{empty}</div>;

  return (
    <div className="report-table-wrap">
      <table className="report-table">
        <tbody>{children}</tbody>
      </table>
    </div>
  );
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
