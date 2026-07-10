import { config } from "./config";
import { ebayFeedbackScope, getEbayAccessToken } from "./ebayAuth";

export interface EbayFeedbackEntry {
  feedbackId?: string;
  commentType?: "POSITIVE" | "NEUTRAL" | "NEGATIVE" | string;
  feedbackComment?: { commentText?: string; state?: string };
  providerUserDetail?: { userId?: string; role?: "BUYER" | "SELLER" | string };
  orderLineItemSummary?: {
    orderLineItemId?: string;
    listingId?: string;
    listingTitle?: string;
  };
  feedbackEnteredDate?: string;
  images?: Array<{ url?: string }>;
  feedbackState?: string;
}

interface EbayFeedbackPage {
  feedbackEntries?: EbayFeedbackEntry[];
  pagination?: { total?: number; count?: number; limit?: number; offset?: number; next?: string };
}

export async function importEbayFeedback({
  username,
  maxPages = 100,
  fetchImpl = fetch
}: {
  username: string;
  maxPages?: number;
  fetchImpl?: typeof fetch;
}) {
  if (!username.trim()) throw new Error("An eBay seller username is required to import feedback.");
  const token = await getEbayAccessToken(ebayFeedbackScope);
  const rows: ReturnType<typeof toFeedbackRow>[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  for (let page = 0; page < Math.max(1, Math.min(100, Math.floor(maxPages))); page += 1) {
    const url = feedbackUrl(username, offset);
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": config.ebay.marketplaceId
      }
    });
    const payload = (await response.json().catch(() => ({}))) as EbayFeedbackPage & {
      message?: string;
      errors?: Array<{ message?: string; longMessage?: string }>;
    };
    if (!response.ok) {
      const detail = payload.errors?.[0];
      throw new Error(
        detail?.longMessage || detail?.message || payload.message || `eBay Feedback API failed with ${response.status}.`
      );
    }

    const entries = Array.isArray(payload.feedbackEntries) ? payload.feedbackEntries : [];
    rows.push(
      ...entries.filter(isBuyerFeedback).map((entry) => ({ ...toFeedbackRow(entry), seller_username: username.trim() }))
    );
    total = Number(payload.pagination?.total ?? rows.length);
    if (!entries.length || !payload.pagination?.next) break;
    const nextUrl = new URL(payload.pagination.next, baseUrl());
    offset = Number(nextUrl.searchParams.get("offset") ?? offset + 100);
  }

  return { platform: "ebay" as const, totalAvailable: Number.isFinite(total) ? total : rows.length, rows };
}

function feedbackUrl(username: string, offset: number) {
  const url = new URL(`${baseUrl()}/feedback`);
  url.searchParams.set("user_id", username.trim());
  url.searchParams.set("feedback_type", "FEEDBACK_RECEIVED");
  url.searchParams.set("filter", "role:SELLER");
  url.searchParams.set("limit", "100");
  url.searchParams.set("offset", String(offset));
  return url;
}

export function toFeedbackRow(entry: EbayFeedbackEntry) {
  const item = entry.orderLineItemSummary ?? {};
  const commentType = String(entry.commentType || "").toUpperCase();
  const rating = commentType === "NEGATIVE" ? "negative" : commentType === "NEUTRAL" ? "neutral" : "positive";
  const listingId = String(item.listingId || "");
  const buyerId = String(entry.providerUserDetail?.userId || "");
  return {
    platform: "ebay",
    feedback_id: String(entry.feedbackId || item.orderLineItemId || ""),
    seller_username: "",
    source_item_id: listingId,
    source_item_title: String(item.listingTitle || ""),
    matched_item_id: listingId,
    matched_item_title: String(item.listingTitle || ""),
    rating,
    star_rating: rating === "negative" ? 1 : rating === "neutral" ? 2 : 5,
    buyer_username: buyerId ? `eBay buyer ${buyerId}` : "eBay buyer",
    feedback_date: String(entry.feedbackEnteredDate || ""),
    feedback_text: String(entry.feedbackComment?.commentText || ""),
    feedback_image_urls: (entry.images ?? []).map((image) => image.url).filter(Boolean).join(","),
    source_listing_url: listingId ? `https://www.ebay.com/itm/${listingId}` : "",
    matched_item_url: listingId ? `https://www.ebay.com/itm/${listingId}` : "",
    feedback_profile_url: "",
    match_type: listingId ? "listing-id" : "feedback-api"
  };
}

function isBuyerFeedback(entry: EbayFeedbackEntry) {
  return String(entry.providerUserDetail?.role || "BUYER").toUpperCase() === "BUYER";
}

function baseUrl() {
  const host = config.ebay.environment === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com";
  return `https://${host}/commerce/feedback/v1`;
}
