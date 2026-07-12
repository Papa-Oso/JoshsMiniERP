import type { EbayDeletionNoticeRecord, EbayDeletionNoticeStatus } from "../shared/types";
import { config } from "./config";
import { anonymizeFeedbackUsernames } from "./ebayReviews/feedbackStore";

interface WorkerNoticePayload {
  notices?: EbayDeletionNoticeRecord[];
  total?: number;
  unprocessedCount?: number;
  cursor?: string;
  listComplete?: boolean;
}

interface WorkerNoticeList {
  notices: EbayDeletionNoticeRecord[];
  total: number;
  unprocessedCount: number;
  cursor?: string;
  listComplete: boolean;
}

interface EbayDeletionNoticeProcessResult {
  configured: boolean;
  checkedNotices: number;
  processedNotices: number;
  anonymizedRows: number;
  errors: string[];
}

let processorTimer: NodeJS.Timeout | null = null;
let processorRunning = false;

export async function getEbayDeletionNoticeStatus(): Promise<EbayDeletionNoticeStatus> {
  const endpoint = config.ebayDeletionNotices.endpoint;
  const adminToken = config.ebayDeletionNotices.adminToken;

  if (!endpoint || !adminToken) {
    return {
      configured: false,
      endpoint,
      notices: [],
      total: 0,
      unprocessedCount: 0
    };
  }

  try {
    const { notices, total, unprocessedCount } = await fetchWorkerNotices(25);
    return {
      configured: true,
      endpoint,
      notices,
      total,
      unprocessedCount,
      latestReceivedAt: notices[0]?.receivedAt
    };
  } catch (error) {
    return {
      configured: true,
      endpoint,
      error: error instanceof Error ? error.message : String(error),
      notices: [],
      total: 0,
      unprocessedCount: 0
    };
  }
}

export function startEbayDeletionNoticeProcessor(intervalMs = 5 * 60 * 1000) {
  if (processorTimer) clearInterval(processorTimer);

  const run = async () => {
    if (processorRunning) return;
    processorRunning = true;
    try {
      const result = await processEbayDeletionNotices();
      if (result.anonymizedRows > 0) {
        console.log(`Anonymized ${result.anonymizedRows} eBay feedback row(s) from deletion notices.`);
      }
      if (result.errors.length > 0) {
        console.warn(`eBay deletion notice processor skipped ${result.errors.length} notice check(s).`);
      }
    } catch (error) {
      console.warn(`eBay deletion notice processor failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      processorRunning = false;
    }
  };

  void run();
  processorTimer = setInterval(() => void run(), intervalMs);
  processorTimer.unref?.();
}

export function stopEbayDeletionNoticeProcessor() {
  if (!processorTimer) return;
  clearInterval(processorTimer);
  processorTimer = null;
}

export async function processEbayDeletionNotices(): Promise<EbayDeletionNoticeProcessResult> {
  if (!config.ebayDeletionNotices.endpoint || !config.ebayDeletionNotices.adminToken) {
    return {
      configured: false,
      checkedNotices: 0,
      processedNotices: 0,
      anonymizedRows: 0,
      errors: []
    };
  }

  const result: EbayDeletionNoticeProcessResult = {
    configured: true,
    checkedNotices: 0,
    processedNotices: 0,
    anonymizedRows: 0,
    errors: []
  };

  try {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await fetchWorkerNotices(25, cursor);
      const unprocessed = page.notices.filter((notice) => !notice.processedAt);
      result.checkedNotices += unprocessed.length;

      for (const notice of unprocessed) {
        try {
          const usernames = noticeUsernames(notice);
          if (usernames.length > 0) {
            const anonymized = await anonymizeFeedbackUsernames(usernames);
            result.anonymizedRows += anonymized.changedRows;
          }
          await markWorkerNoticeProcessed(notice.id);
          result.processedNotices += 1;
        } catch (error) {
          result.errors.push(error instanceof Error ? error.message : String(error));
        }
      }

      cursor = page.cursor;
      pages += 1;
    } while (cursor && pages < 100);

    if (cursor) result.errors.push("Deletion notice scan stopped after 100 pages.");
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  return result;
}

async function fetchWorkerNotices(limit: number, cursor?: string): Promise<WorkerNoticeList> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`${workerEndpoint()}/notices?${query}`, {
    headers: workerHeaders()
  });
  const payload = (await response.json().catch(() => ({}))) as WorkerNoticePayload & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? response.statusText);
  }

  const notices = Array.isArray(payload.notices) ? payload.notices.map(normalizeNotice) : [];
  return {
    notices,
    total: Number(payload.total ?? notices.length),
    unprocessedCount: Number(payload.unprocessedCount ?? notices.filter((notice) => !notice.processedAt).length),
    cursor: typeof payload.cursor === "string" && payload.cursor ? payload.cursor : undefined,
    listComplete: payload.listComplete !== false
  };
}

async function markWorkerNoticeProcessed(id: string) {
  if (!id) throw new Error("Cannot mark eBay deletion notice without an id.");
  const response = await fetch(`${workerEndpoint()}/notices/${encodeURIComponent(id)}/processed`, {
    method: "POST",
    headers: workerHeaders()
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? response.statusText);
  }
}

function workerEndpoint() {
  const endpoint = config.ebayDeletionNotices.endpoint;
  if (!endpoint) throw new Error("EBAY_DELETION_NOTICES_URL is not configured.");
  return endpoint.replace(/\/+$/, "");
}

function workerHeaders() {
  const adminToken = config.ebayDeletionNotices.adminToken;
  if (!adminToken) throw new Error("EBAY_DELETION_NOTICES_TOKEN is not configured.");
  return {
    authorization: `Bearer ${adminToken}`
  };
}

function noticeUsernames(notice: EbayDeletionNoticeRecord) {
  return [...new Set([notice.username, notice.userId].filter((value): value is string => Boolean(value?.trim())))];
}

function normalizeNotice(notice: EbayDeletionNoticeRecord): EbayDeletionNoticeRecord {
  return {
    id: stringValue(notice.id),
    receivedAt: stringValue(notice.receivedAt),
    topic: stringValue(notice.topic),
    schemaVersion: stringValue(notice.schemaVersion),
    notificationId: stringValue(notice.notificationId),
    eventDate: stringValue(notice.eventDate),
    publishDate: stringValue(notice.publishDate),
    publishAttemptCount:
      typeof notice.publishAttemptCount === "number" && Number.isFinite(notice.publishAttemptCount)
        ? notice.publishAttemptCount
        : undefined,
    username: stringValue(notice.username),
    userId: stringValue(notice.userId),
    eiasToken: stringValue(notice.eiasToken),
    processedAt: stringValue(notice.processedAt)
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}
