import { useEffect, useMemo } from "react";
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
    if (intent === "reset-history") {
      const stats = await erpRequest<{ deleted_rows: number }>(
        "/ebay-reviews/feedback-history/reset",
        { method: "POST" },
      );
      return {
        ok: true,
        message: `Reset ${stats.deleted_rows} saved row${
          stats.deleted_rows === 1 ? "" : "s"
        }.`,
        result: emptyResult,
      } satisfies ActionData;
    }

    if (intent === "etsy-import") {
      const result = await erpRequest<ReviewResult>("/ebay-reviews/etsy-import", {
        method: "POST",
        body: JSON.stringify({ scanMode: "incremental", maxPages: 100 }),
      });
      return {
        ok: true,
        message: "Etsy reviews imported through the official API.",
        result,
      } satisfies ActionData;
    }

    if (intent === "ebay-import") {
      const result = await erpRequest<ReviewResult>("/ebay-reviews/ebay-import", {
        method: "POST",
        body: JSON.stringify({ scanMode: "incremental", maxPages: 100 }),
      });
      return {
        ok: true,
        message: "eBay reviews imported through the official Feedback API.",
        result,
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
            <input type="hidden" name="intent" value="ebay-import" />
            <s-button
              type="submit"
              icon="import"
              variant="primary"
              {...(pendingIntent === "ebay-import" ? { loading: true } : {})}
              {...(busy ? { disabled: true } : {})}
            >
              Import eBay reviews
            </s-button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="etsy-import" />
            <s-button
              type="submit"
              icon="import"
              variant="secondary"
              {...(pendingIntent === "etsy-import" ? { loading: true } : {})}
              {...(busy ? { disabled: true } : {})}
            >
              Import Etsy reviews
            </s-button>
          </fetcher.Form>
          <s-button
            icon="export"
            variant="secondary"
            onClick={() => downloadCsv(result, latestRows, "latest")}
            {...(!latestRows.length ? { disabled: true } : {})}
          >
            Latest CSV
          </s-button>
          <s-button
            icon="export"
            variant="secondary"
            onClick={() => downloadCsv(result, rows, "all")}
            {...(!rows.length ? { disabled: true } : {})}
          >
            All CSV
          </s-button>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="reset-history" />
            <s-button
              type="submit"
              icon="reset"
              variant="secondary"
              tone="critical"
              {...(pendingIntent === "reset-history" ? { loading: true } : {})}
              {...(busy ? { disabled: true } : {})}
            >
              Reset history
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
                  <s-table-cell>{row.feedback_date || "Unknown"}</s-table-cell>
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
  scope: "latest" | "all",
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
  const importableRows = rows.filter((row) => row.feedback_text?.trim());
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
    reply: "",
    picture_urls: row.feedback_image_urls || "",
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
  return firstSentence.length > 80
    ? `${firstSentence.slice(0, 77)}...`
    : firstSentence;
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
