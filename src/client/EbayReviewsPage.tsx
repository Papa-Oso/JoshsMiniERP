import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Loader2
} from "lucide-react";
import { PanelFrame } from "./ui";

const columns = [
  "source_platform",
  "title",
  "body",
  "rating",
  "review_date",
  "reviewer_name",
  "reviewer_email",
  "product_id",
  "product_handle",
  "product_sku",
  "reply",
  "picture_urls"
];

type ExportScope = "incremental" | "full";

type ReviewRow = {
  platform?: "ebay" | "etsy";
  feedback_key?: string;
  source_item_id?: string;
  source_item_title?: string;
  matched_item_id?: string;
  matched_item_title?: string;
  matched_item_url?: string;
  seller_username?: string;
  feedback_profile_url?: string;
  match_type?: string;
  rating?: string;
  star_rating?: number | string;
  buyer_username?: string;
  feedback_date?: string;
  feedback_text?: string;
  feedback_image_urls?: string;
  product_handle?: string;
  product_sku?: string;
  is_latest?: boolean;
};

type ListingSummary = {
  itemId?: string;
  title?: string;
  sellerUsername?: string;
};

type ReviewHistory = {
  scan_mode?: string;
  rows_seen?: number;
  rows_exported?: number;
  new_rows?: number;
  skipped_existing_rows?: number;
};

type ReviewResult = {
  mode?: string;
  listings?: ListingSummary[];
  rows?: ReviewRow[];
  latestRows?: ReviewRow[];
  exportRows?: ReviewRow[];
  exportKeys?: string[];
  warnings?: string[];
  history?: ReviewHistory;
};

const emptyResult: ReviewResult = {
  mode: "history",
  listings: [],
  rows: [],
  latestRows: [],
  warnings: [],
  history: {
    scan_mode: "history",
    rows_seen: 0,
    rows_exported: 0,
    new_rows: 0,
    skipped_existing_rows: 0
  }
};

export function EbayReviewsPage() {
  const [historyLoading, setHistoryLoading] = useState(true);
  const [exportLoading, setExportLoading] = useState<ExportScope | null>(null);
  const [platformFilter, setPlatformFilter] = useState<"all" | "ebay" | "etsy">("all");
  const [result, setResult] = useState<ReviewResult>(emptyResult);
  const [error, setError] = useState("");
  const [log, setLog] = useState<string[]>([]);

  const visibleRows = useMemo(
    () => (result.rows ?? []).filter((row) => platformFilter === "all" || (row.platform || "ebay") === platformFilter),
    [platformFilter, result.rows]
  );
  const exactCount = visibleRows.filter((row) => row.match_type !== "seller-profile").length;
  const latestCount = (result.latestRows ?? []).filter(
    (row) => platformFilter === "all" || (row.platform || "ebay") === platformFilter
  ).length;
  const allCount = visibleRows.length;
  const loading = exportLoading !== null;

  useEffect(() => {
    void loadSavedReviews();
  }, []);

  async function loadSavedReviews() {
    setHistoryLoading(true);

    try {
      const payload = await request<ReviewResult>("/api/ebay-reviews/feedback-history");
      setResult(payload);
      if (payload.rows?.length) {
        setLog([`Loaded ${payload.rows.length} saved review${payload.rows.length === 1 ? "" : "s"}`]);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function exportSavedReviews(scope: ExportScope) {
    setExportLoading(scope);
    setError("");
    setLog([`Preparing the ${scope} CSV from saved review history`]);

    try {
      const payload = await request<ReviewResult>("/api/ebay-reviews/export", {
        method: "POST",
        body: JSON.stringify({ exportMode: scope })
      });
      setResult(payload);
      setLog([
        `${payload.history?.rows_exported ?? 0} saved review${payload.history?.rows_exported === 1 ? "" : "s"} selected for the ${scope} CSV`
      ]);
      if (payload.exportRows?.length) downloadCsv(payload.exportRows, scope, payload);
      else setLog((entries) => [...entries, scope === "incremental"
        ? "No reviews have been added since the last CSV download."
        : "No eligible saved reviews are available for a CSV."]);
      await request("/api/ebay-reviews/export/mark", {
        method: "POST",
        body: JSON.stringify({ feedbackKeys: payload.exportKeys ?? [] })
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setExportLoading(null);
    }
  }

  async function resetIncrementalExport() {
    const confirmed = window.confirm("Reset the incremental CSV checkpoint? Saved reviews will not be deleted.");
    if (!confirmed) return;
    setError("");
    try {
      const payload = await request<{ reset_rows: number }>("/api/ebay-reviews/export-history/reset", { method: "POST" });
      setLog([`Incremental checkpoint reset for ${payload.reset_rows} saved review${payload.reset_rows === 1 ? "" : "s"}.`]);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  function downloadCsv(rows: ReviewRow[] | undefined, scope: ExportScope, source = result) {
    if (!rows?.length) return;
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = csvFilename(source, scope);
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <section className="review-tool">
      <PanelFrame className="review-controls">
        <header className="review-panel-header">
          <span className="review-mark">
            <FileSpreadsheet size={24} />
          </span>
          <div>
            <h2>Marketplace Review Exporter</h2>
            <p>Judge.me CSV</p>
          </div>
        </header>

        <div className="review-form">
          <div className="review-action-row">
            <button className="icon-button primary" type="button" disabled={loading || historyLoading} onClick={() => void exportSavedReviews("incremental")}>
              {exportLoading === "incremental" ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
              {exportLoading === "incremental" ? "Preparing CSV" : "Incremental CSV"}
            </button>
            <button className="icon-button" type="button" disabled={loading || historyLoading} onClick={() => void exportSavedReviews("full")}>
              {exportLoading === "full" ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
              {exportLoading === "full" ? "Preparing CSV" : "Full CSV"}
            </button>
            <button className="icon-button danger-button" type="button" disabled={loading || historyLoading} onClick={() => void resetIncrementalExport()}>
              Reset incremental
            </button>
          </div>
        </div>

        <div className="review-status-list">
          {log.map((entry) => (
            <div className="review-status-row" key={entry}>
              <CheckCircle2 size={15} />
              <span>{entry}</span>
            </div>
          ))}
          {error ? (
            <div className="review-status-row error">
              <AlertCircle size={15} />
              <span>{error}</span>
            </div>
          ) : null}
        </div>
      </PanelFrame>

      <PanelFrame className="review-results">
        <div className="review-filter-row">
          <label className="review-field">
            <span>Platform</span>
            <select value={platformFilter} onChange={(event) => setPlatformFilter(event.target.value as "all" | "ebay" | "etsy")}>
              <option value="all">eBay + Etsy</option>
              <option value="ebay">eBay</option>
              <option value="etsy">Etsy</option>
            </select>
          </label>
        </div>
        <div className="review-summary-band">
          <ReviewMetric label="Rows" value={allCount} />
          <ReviewMetric label="Exact Matches" value={exactCount} />
          <ReviewMetric label="Latest Export" value={latestCount} />
          <ReviewMetric label="Skipped" value={result.history?.skipped_existing_rows ?? 0} />
        </div>

        {result.warnings?.length ? (
          <div className="review-warning-strip">
            <AlertCircle size={17} />
            <span>{result.warnings.join(" ")}</span>
          </div>
        ) : null}

        <div className="review-table-shell">
          {historyLoading ? (
            <div className="review-empty">
              <Loader2 className="spin" size={38} />
              <p>Loading saved reviews.</p>
            </div>
          ) : visibleRows.length ? (
            <table className="review-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Platform</th>
                  <th>Seller</th>
                  <th>Match</th>
                  <th>Rating</th>
                  <th>Stars</th>
                  <th>Date</th>
                  <th>Feedback</th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, index) => (
                  <tr className={row.is_latest ? "latest-row" : ""} key={row.feedback_key || `${row.seller_username}-${row.feedback_date}-${index}`}>
                    <td>
                      <strong>{row.matched_item_title || row.source_item_title || "Untitled item"}</strong>
                      <span>{row.matched_item_id || row.source_item_id}</span>
                    </td>
                    <td>{row.platform === "etsy" ? "Etsy" : "eBay"}</td>
                    <td>{row.seller_username}</td>
                    <td>
                      <Badge value={row.match_type} />
                      {row.is_latest ? <span className="latest-pill">Latest</span> : null}
                    </td>
                    <td>{row.rating || "Unknown"}</td>
                    <td>{row.star_rating === "" || row.star_rating == null ? "Unknown" : Number(row.star_rating).toFixed(0)}</td>
                    <td>{formatReviewDate(row.feedback_date)}</td>
                    <td>{row.feedback_text}</td>
                    <td>
                      <div className="review-table-links">
                        {row.matched_item_url || row.feedback_profile_url ? (
                          <a href={row.matched_item_url || row.feedback_profile_url} target="_blank" rel="noreferrer" title="Open source review" aria-label="Open source review">
                            <ExternalLink size={17} />
                          </a>
                        ) : null}
                        {row.feedback_image_urls ? (
                          <a className="review-photo-link compact" href={row.feedback_image_urls.split(",")[0]} target="_blank" rel="noreferrer" title="Open review photo">
                            <img className="review-photo-thumbnail" src={row.feedback_image_urls.split(",")[0]} alt="Customer review attachment" loading="lazy" />
                            <span>Photo</span>
                          </a>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="review-empty">
              <FileSpreadsheet size={38} />
              <p>No feedback rows yet.</p>
            </div>
          )}
        </div>
      </PanelFrame>
    </section>
  );
}

function ReviewMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="review-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Badge({ value }: { value?: string }) {
  const label = value || "seller-profile";
  return <span className={`badge ${label}`}>{label}</span>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      }
    });
  } catch {
    throw new Error("The local ERP server is unavailable. Start it with Start ERP.cmd and try again.");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : response.statusText);
  }
  return payload as T;
}

export function toCsv(rows: ReviewRow[]) {
  const importableRows = rows.filter((row) => row.feedback_text?.trim() && !isGenericEbayFeedback(row));
  const escape = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [
    columns.join(","),
    ...importableRows.map((row) => columns.map((column) => escape(directImportValue(row, column))).join(","))
  ].join("\n");
}

function directImportValue(row: ReviewRow, column: string) {
  const values: Record<string, string | number> = {
    source_platform: row.platform === "etsy" ? "Etsy" : "eBay",
    title: reviewTitle(row.feedback_text),
    body: row.feedback_text || "",
    rating: row.star_rating || "",
    review_date: reviewDate(row.feedback_date),
    reviewer_name: marketplaceReviewerName(row),
    reviewer_email: "",
    product_id: "",
    product_handle: row.product_handle || row.product_sku || "",
    product_sku: row.product_sku || "",
    reply: "",
    picture_urls: row.feedback_image_urls || ""
  };

  return values[column];
}

function isGenericEbayFeedback(row: ReviewRow) {
  if ((row.platform || "ebay") !== "ebay") return false;
  return String(row.feedback_text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim() === "order delivered on time with no issues";
}

function marketplaceReviewerName(row: ReviewRow) {
  const platform = row.platform === "etsy" ? "Etsy" : "eBay";
  const identifier = String(row.buyer_username || "").trim();
  if (!identifier) return `${platform} buyer`;
  if (identifier.toLowerCase().startsWith(`${platform.toLowerCase()} buyer`)) return identifier;
  return `${platform} buyer ${identifier}`;
}

function reviewTitle(text = "") {
  const firstSentence = String(text).split(/[.!?]/)[0]?.trim();
  if (!firstSentence) return "Marketplace Review";
  return firstSentence.length > 80 ? `${firstSentence.slice(0, 77)}...` : firstSentence;
}

export function reviewDate(value = "") {
  const relative = /past\s+6\s+months|past\s+month|past\s+year|more than a year ago/i.test(value);
  const date = relative ? new Date() : new Date(value);

  if (/past\s+6\s+months/i.test(value)) date.setUTCMonth(date.getUTCMonth() - 6);
  else if (/past\s+month/i.test(value)) date.setUTCMonth(date.getUTCMonth() - 1);
  else if (/past\s+year|more than a year ago/i.test(value)) date.setUTCFullYear(date.getUTCFullYear() - 1);

  const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return [
    String(validDate.getUTCDate()).padStart(2, "0"),
    String(validDate.getUTCMonth() + 1).padStart(2, "0"),
    validDate.getUTCFullYear()
  ].join("/");
}

function formatReviewDate(value?: string) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function csvFilename(result: ReviewResult, scope: ExportScope) {
  const date = new Date().toISOString().slice(0, 10);
  const firstListing = result.listings?.[0] ?? {};
  const firstRow = result.rows?.[0] ?? {};
  const isListing = result.mode === "listing" || Boolean(firstListing.itemId);
  const label = isListing
    ? firstListing.title || firstListing.itemId || firstRow.source_item_title || firstRow.source_item_id
    : firstListing.sellerUsername || firstRow.seller_username || "seller-feedback";

  return `marketplace-reviews-${slugForFilename(label)}-${scope}-${date}.csv`;
}

function slugForFilename(value = "") {
  const slug = String(value)
    .replace(/\| eBay.*/i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .toLowerCase();

  return slug || "export";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
