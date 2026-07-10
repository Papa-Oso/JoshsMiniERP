import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Image as ImageIcon,
  Loader2,
  RotateCcw
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
  "reply",
  "picture_urls"
];

type ExportScope = "latest" | "all";

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
  const [resetLoading, setResetLoading] = useState(false);
  const [etsyLoading, setEtsyLoading] = useState(false);
  const [ebayApiLoading, setEbayApiLoading] = useState(false);
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
  const loading = etsyLoading || ebayApiLoading;

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

  async function importEtsyAndDownload() {
    setEtsyLoading(true);
    setError("");
    setLog(["Requesting Etsy reviews through the official Etsy API"]);

    try {
      const payload = await request<ReviewResult>("/api/ebay-reviews/etsy-import", {
        method: "POST",
        body: JSON.stringify({ scanMode: "incremental", maxPages: 100 })
      });
      setResult(payload);
      setPlatformFilter("etsy");
      setLog([
        `Loaded ${payload.rows?.filter((row) => row.platform === "etsy").length ?? 0} saved Etsy reviews`,
        `${payload.history?.new_rows ?? 0} new, ${payload.history?.skipped_existing_rows ?? 0} already imported`
      ]);
      if (payload.latestRows?.length) downloadCsv(payload.latestRows, "latest", payload);
      else setLog((entries) => [...entries, "No new Etsy reviews found. No CSV was created."]);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setEtsyLoading(false);
    }
  }

  async function importEbayApiAndDownload() {
    setEbayApiLoading(true);
    setError("");
    setLog(["Requesting eBay feedback through the official Feedback API"]);

    try {
      const payload = await request<ReviewResult>("/api/ebay-reviews/ebay-import", {
        method: "POST",
        body: JSON.stringify({ scanMode: "incremental", maxPages: 100 })
      });
      setResult(payload);
      setPlatformFilter("ebay");
      setLog([
        `Loaded ${payload.rows?.filter((row) => (row.platform || "ebay") === "ebay").length ?? 0} saved eBay reviews`,
        `${payload.history?.new_rows ?? 0} new, ${payload.history?.skipped_existing_rows ?? 0} already imported`
      ]);
      if (payload.latestRows?.length) downloadCsv(payload.latestRows, "latest", payload);
      else setLog((entries) => [...entries, "No new eBay reviews found. No CSV was created."]);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setEbayApiLoading(false);
    }
  }

  async function resetIncrementalHistory() {
    const confirmed = window.confirm("Reset all saved eBay and Etsy review history?");
    if (!confirmed) return;

    setResetLoading(true);
    setError("");

    try {
      const payload = await request<{ deleted_rows: number }>("/api/ebay-reviews/feedback-history/reset", {
        method: "POST"
      });
      setResult((current) => ({
        ...current,
        rows: [],
        latestRows: [],
        history: {
          ...current.history,
          rows_seen: 0,
          rows_exported: 0,
          new_rows: 0,
          skipped_existing_rows: 0
        }
      }));
      setLog((entries) => [
        ...entries,
        `Reset incremental history: removed ${payload.deleted_rows} scanned row${payload.deleted_rows === 1 ? "" : "s"}`
      ]);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setResetLoading(false);
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
            <button className="icon-button primary" type="button" disabled={loading || historyLoading} onClick={() => void importEbayApiAndDownload()}>
              {ebayApiLoading ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
              {ebayApiLoading ? "Importing eBay" : "Import eBay + Latest CSV"}
            </button>
            <button className="icon-button" type="button" disabled={loading || historyLoading} onClick={() => void importEtsyAndDownload()}>
              {etsyLoading ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
              {etsyLoading ? "Importing Etsy" : "Import Etsy + Latest CSV"}
            </button>
            <button
              type="button"
              className="icon-button danger-button"
              onClick={resetIncrementalHistory}
              disabled={loading || resetLoading}
            >
              {resetLoading ? <Loader2 className="spin" size={18} /> : <RotateCcw size={18} />}
              Reset
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
                    <td>{row.feedback_date || "Unknown"}</td>
                    <td>{row.feedback_text}</td>
                    <td>
                      {row.matched_item_url || row.feedback_profile_url ? (
                        <a href={row.matched_item_url || row.feedback_profile_url} target="_blank" rel="noreferrer" title="Open source review">
                          <ExternalLink size={17} />
                        </a>
                      ) : null}
                      {row.feedback_image_urls ? (
                        <a href={row.feedback_image_urls.split(",")[0]} target="_blank" rel="noreferrer" title="Open review photo">
                          <ImageIcon size={17} />
                        </a>
                      ) : null}
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
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : response.statusText);
  }
  return payload as T;
}

function toCsv(rows: ReviewRow[]) {
  const importableRows = rows.filter((row) => row.feedback_text?.trim());
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
    reply: "",
    picture_urls: row.feedback_image_urls || ""
  };

  return values[column];
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

function reviewDate(value = "") {
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value;
  const date = new Date();

  if (/past\s+6\s+months/i.test(value)) date.setMonth(date.getMonth() - 6);
  else if (/past\s+month/i.test(value)) date.setMonth(date.getMonth() - 1);
  else if (/past\s+year/i.test(value)) date.setFullYear(date.getFullYear() - 1);

  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function csvFilename(result: ReviewResult, scope: "latest" | "all") {
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
