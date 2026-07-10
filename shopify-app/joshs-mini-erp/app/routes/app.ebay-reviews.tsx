import { useEffect, useMemo, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { erpErrorMessage, erpRequest } from "../lib/erp.server";

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
  warnings?: string[];
  history?: ReviewHistory;
};

type LoaderData = {
  result: ReviewResult;
  error: string | null;
};

type ActionData =
  | {
      ok: true;
      message: string;
      result: ReviewResult;
      exportMode?: "incremental" | "full";
    }
  | {
      ok: false;
      error: string;
      result: ReviewResult;
    };

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
  "picture_urls",
];

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
    skipped_existing_rows: 0,
  },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  try {
    return {
      result: await getReviewHistory(),
      error: null,
    } satisfies LoaderData;
  } catch (error) {
    return {
      result: emptyResult,
      error: erpErrorMessage(error),
    } satisfies LoaderData;
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = field(formData, "intent");

  try {
    if (intent === "reset-export") {
      const stats = await erpRequest<{ reset_rows: number }>(
        "/ebay-reviews/export-history/reset",
        { method: "POST" },
      );
      return {
        ok: true,
        message: `Incremental checkpoint reset for ${stats.reset_rows} saved review${stats.reset_rows === 1 ? "" : "s"}.`,
        result: await getReviewHistory(),
      } satisfies ActionData;
    }

    if (intent === "refresh-reviews") {
      const exportMode = field(formData, "exportMode");
      if (exportMode !== "incremental" && exportMode !== "full") {
        throw new Error("Choose an incremental or full CSV export.");
      }
      const result = await erpRequest<ReviewResult>("/ebay-reviews/refresh", {
        method: "POST",
        body: JSON.stringify({ exportMode, maxPages: 100 }),
      });
      return {
        ok: true,
        message: `Both marketplaces refreshed; ${result.exportRows?.length ?? 0} reviews selected for the ${exportMode} CSV.`,
        result,
        exportMode,
      } satisfies ActionData;
    }

    throw new Error("Unknown action.");
  } catch (error) {
    return {
      ok: false,
      error: erpErrorMessage(error),
      result: await safeReviewHistory(),
    } satisfies ActionData;
  }
};

export default function EbayReviews() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const result = fetcher.data?.result ?? loaderData.result;
  const busy = fetcher.state !== "idle";
  const pendingIntent = field(fetcher.formData, "intent");
  const pendingExportMode = field(fetcher.formData, "exportMode");
  const downloadedResult = useRef<ReviewResult | null>(null);
  const rows = useMemo(() => result.rows ?? [], [result.rows]);
  const latestRows = result.latestRows ?? [];
  const exactCount = useMemo(
    () => rows.filter((row) => row.match_type !== "seller-profile").length,
    [rows],
  );

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      if (downloadedResult.current !== fetcher.data.result) {
        downloadedResult.current = fetcher.data.result;
        const exportRows = fetcher.data.result.exportRows ?? [];
        if (exportRows.length && fetcher.data.exportMode) {
          downloadCsv(
            fetcher.data.result,
            exportRows,
            fetcher.data.exportMode,
          );
        }
      }
    } else {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Marketplace Reviews">
      <style>{styles}</style>

      {loaderData.error ? (
        <s-banner heading="ERP API unavailable" tone="critical">
          <s-paragraph>{loaderData.error}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Export">
        <div className="metric-grid">
          <Metric label="Rows" value={rows.length} />
          <Metric label="Exact matches" value={exactCount} />
          <Metric label="Latest export" value={latestRows.length} />
          <Metric
            label="Skipped"
            value={result.history?.skipped_existing_rows ?? 0}
          />
        </div>

        <div className="button-row">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="refresh-reviews" />
            <input type="hidden" name="exportMode" value="incremental" />
            <s-button
              type="submit"
              icon="export"
              variant="primary"
              {...(pendingIntent === "refresh-reviews" && pendingExportMode === "incremental" ? { loading: true } : {})}
              {...(busy ? { disabled: true } : {})}
            >
              Incremental CSV
            </s-button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="refresh-reviews" />
            <input type="hidden" name="exportMode" value="full" />
            <s-button
              type="submit"
              icon="export"
              variant="secondary"
              {...(pendingIntent === "refresh-reviews" && pendingExportMode === "full" ? { loading: true } : {})}
              {...(busy ? { disabled: true } : {})}
            >
              Full CSV
            </s-button>
          </fetcher.Form>
          <fetcher.Form
            method="post"
            onSubmit={(event) => {
              if (!window.confirm("Reset the incremental CSV checkpoint? Saved reviews will not be deleted.")) {
                event.preventDefault();
              }
            }}
          >
            <input type="hidden" name="intent" value="reset-export" />
            <s-button
              type="submit"
              icon="reset"
              variant="secondary"
              tone="critical"
              {...(pendingIntent === "reset-export" ? { loading: true } : {})}
              {...(busy ? { disabled: true } : {})}
            >
              Reset incremental
            </s-button>
          </fetcher.Form>
        </div>

        {result.warnings?.length ? (
          <s-banner heading="Review export warning" tone="warning">
            <s-paragraph>{result.warnings.join(" ")}</s-paragraph>
          </s-banner>
        ) : null}
      </s-section>

      <s-section heading="Reviews">
        {rows.length ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Item</s-table-header>
              <s-table-header>Platform</s-table-header>
              <s-table-header>Seller</s-table-header>
              <s-table-header>Match</s-table-header>
              <s-table-header>Rating</s-table-header>
              <s-table-header>Stars</s-table-header>
              <s-table-header>Date</s-table-header>
              <s-table-header>Feedback</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row, index) => (
                <s-table-row
                  key={
                    row.feedback_key ||
                    `${row.seller_username}-${row.feedback_date}-${index}`
                  }
                >
                  <s-table-cell>
                    <div className="item-cell">
                      <strong>
                        {row.matched_item_title ||
                          row.source_item_title ||
                          "Untitled item"}
                      </strong>
                      <span>{row.matched_item_id || row.source_item_id}</span>
                    </div>
                  </s-table-cell>
                  <s-table-cell>{row.platform === "etsy" ? "Etsy" : "eBay"}</s-table-cell>
                  <s-table-cell>{row.seller_username}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={row.is_latest ? "info" : "neutral"}>
                      {row.is_latest ? "Latest" : row.match_type || "seller-profile"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{row.rating || "Unknown"}</s-table-cell>
                  <s-table-cell>
                    {row.star_rating === "" || row.star_rating == null
                      ? "Unknown"
                      : Number(row.star_rating).toFixed(0)}
                  </s-table-cell>
                  <s-table-cell>{formatReviewDate(row.feedback_date)}</s-table-cell>
                  <s-table-cell>{row.feedback_text}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text color="subdued">No feedback rows yet</s-text>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <s-badge tone="info">{value}</s-badge>
    </div>
  );
}

async function getReviewHistory() {
  return erpRequest<ReviewResult>("/ebay-reviews/feedback-history");
}

async function safeReviewHistory() {
  try {
    return await getReviewHistory();
  } catch {
    return emptyResult;
  }
}

function downloadCsv(
  result: ReviewResult,
  rows: ReviewRow[],
  scope: "incremental" | "full",
) {
  if (!rows.length) return;
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = csvFilename(result, scope);
  link.click();
  URL.revokeObjectURL(link.href);
}

function toCsv(rows: ReviewRow[]) {
  const importableRows = rows.filter((row) => row.feedback_text?.trim() && !isGenericEbayFeedback(row));
  const escape = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [
    columns.join(","),
    ...importableRows.map((row) =>
      columns.map((column) => escape(directImportValue(row, column))).join(","),
    ),
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
    picture_urls: row.feedback_image_urls || "",
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
  return firstSentence.length > 80
    ? `${firstSentence.slice(0, 77)}...`
    : firstSentence;
}

function reviewDate(value = "") {
  const relative = /past\s+6\s+months|past\s+month|past\s+year|more than a year ago/i.test(value);
  const date = relative ? new Date() : new Date(value);

  if (/past\s+6\s+months/i.test(value)) date.setUTCMonth(date.getUTCMonth() - 6);
  else if (/past\s+month/i.test(value)) date.setUTCMonth(date.getUTCMonth() - 1);
  else if (/past\s+year|more than a year ago/i.test(value)) date.setUTCFullYear(date.getUTCFullYear() - 1);

  const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return [
    String(validDate.getUTCDate()).padStart(2, "0"),
    String(validDate.getUTCMonth() + 1).padStart(2, "0"),
    validDate.getUTCFullYear(),
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
    timeZone: "UTC",
  }).format(date);
}

function csvFilename(result: ReviewResult, scope: "incremental" | "full") {
  const date = new Date().toISOString().slice(0, 10);
  const firstListing = result.listings?.[0] ?? {};
  const firstRow = result.rows?.[0] ?? {};
  const isListing = result.mode === "listing" || Boolean(firstListing.itemId);
  const label = isListing
    ? firstListing.title ||
      firstListing.itemId ||
      firstRow.source_item_title ||
      firstRow.source_item_id
    : firstListing.sellerUsername ||
      firstRow.seller_username ||
      "seller-feedback";

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

function field(formData: FormData | undefined, key: string) {
  const value = formData?.get(key);
  return typeof value === "string" ? value.trim() : "";
}

const styles = `
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 12px;
    margin-bottom: 12px;
  }

  .metric {
    display: grid;
    gap: 4px;
    padding: 12px;
    border: 1px solid #d5d5d5;
    border-radius: 8px;
  }

  .metric span,
  .item-cell span {
    color: #616161;
    font-size: 12px;
  }

  .button-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
  }

  .item-cell {
    display: grid;
    gap: 4px;
  }

`;

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
