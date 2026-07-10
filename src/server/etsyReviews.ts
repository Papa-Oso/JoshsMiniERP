import { config } from "./config";
import { getEtsyAccessToken } from "./etsyAuth";
import { listData } from "./inventoryService";

export interface EtsyTransactionReview {
  shop_id: number;
  listing_id: number;
  transaction_id?: number;
  buyer_user_id?: number;
  rating: number;
  review?: string;
  language?: string;
  image_url_fullxfull?: string;
  created_timestamp?: number;
  create_timestamp?: number;
  updated_timestamp?: number;
  update_timestamp?: number;
}

interface EtsyReviewPage {
  count: number;
  results: EtsyTransactionReview[];
}

export async function importEtsyReviews({
  maxPages = 100,
  fetchImpl = fetch
}: {
  maxPages?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  if (!config.etsy.apiKey) throw new Error("Etsy reviews require ETSY_KEYSTRING and ETSY_SHARED_SECRET.");
  const shopId = await resolveEtsyShopId(fetchImpl);

  const limit = 100;
  const reviews: EtsyTransactionReview[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  for (let page = 0; page < Math.max(1, Math.min(100, Math.floor(maxPages))); page += 1) {
    const url = new URL(`https://api.etsy.com/v3/application/shops/${encodeURIComponent(shopId)}/reviews`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const response = await fetchImpl(url, { headers: { "x-api-key": config.etsy.apiKey } });
    const payload = (await response.json().catch(() => ({}))) as Partial<EtsyReviewPage> & { error?: string };
    if (!response.ok) throw new Error(payload.error || `Etsy reviews request failed with ${response.status}.`);

    const pageRows = Array.isArray(payload.results) ? payload.results : [];
    reviews.push(...pageRows);
    total = Number(payload.count ?? reviews.length);
    offset += pageRows.length;
    if (!pageRows.length || offset >= total) break;
  }

  return {
    platform: "etsy" as const,
    shopId,
    totalAvailable: Number.isFinite(total) ? total : reviews.length,
    rows: reviews.map(toFeedbackRow)
  };
}

export async function resolveEtsyShopId(fetchImpl: typeof fetch = fetch) {
  if (config.etsy.shopId) return config.etsy.shopId;

  const data = await listData();
  const mappedListingId = data.items.find((item) => item.mappings.etsy?.listingId)?.mappings.etsy?.listingId;
  if (mappedListingId) {
    const listingResponse = await fetchImpl(
      `https://api.etsy.com/v3/application/listings/${encodeURIComponent(mappedListingId)}`,
      { headers: { "x-api-key": config.etsy.apiKey! } }
    );
    const listing = (await listingResponse.json().catch(() => ({}))) as { shop_id?: number };
    if (listingResponse.ok && listing.shop_id) return String(listing.shop_id);
  }

  const accessToken = await getEtsyAccessToken();
  const ownerUserId = accessToken.split(".", 1)[0];
  if (!/^\d+$/.test(ownerUserId)) {
    throw new Error("Set ETSY_SHOP_ID because the Etsy shop ID could not be derived from the saved OAuth token.");
  }

  const response = await fetchImpl(`https://api.etsy.com/v3/application/users/${ownerUserId}/shops`, {
    headers: { "x-api-key": config.etsy.apiKey! }
  });
  const payload = (await response.json().catch(() => ({}))) as { shop_id?: number; error?: string };
  if (!response.ok || !payload.shop_id) {
    throw new Error(payload.error || "Etsy shop lookup failed. Set ETSY_SHOP_ID explicitly.");
  }
  return String(payload.shop_id);
}

export function toFeedbackRow(review: EtsyTransactionReview) {
  const stars = Math.max(1, Math.min(5, Number(review.rating) || 1));
  const timestamp = review.created_timestamp ?? review.create_timestamp;
  const listingId = String(review.listing_id || "");
  return {
    platform: "etsy",
    feedback_id: String(review.transaction_id || `${listingId}-${timestamp || "unknown"}`),
    seller_username: String(review.shop_id || ""),
    source_item_id: listingId,
    source_item_title: "",
    matched_item_id: listingId,
    matched_item_title: "",
    rating: stars <= 2 ? "negative" : stars === 3 ? "neutral" : "positive",
    star_rating: stars,
    buyer_username: review.buyer_user_id ? `Etsy buyer ${review.buyer_user_id}` : "Etsy buyer",
    feedback_date: timestamp ? new Date(timestamp * 1000).toISOString() : "",
    feedback_text: String(review.review || ""),
    feedback_image_urls: String(review.image_url_fullxfull || ""),
    source_listing_url: listingId ? `https://www.etsy.com/listing/${listingId}` : "",
    matched_item_url: listingId ? `https://www.etsy.com/listing/${listingId}` : "",
    feedback_profile_url: "",
    match_type: listingId ? "listing-id" : "shop-review"
  };
}
