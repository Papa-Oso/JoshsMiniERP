const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};
const notificationPath = "/ebay/marketplace-account-deletion";
const maximumNotificationBytes = 32_768;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = normalizePath(url.pathname);

    if (request.method === "GET" && url.searchParams.has("challenge_code")) {
      return handleChallenge(request, env);
    }

    if (request.method === "GET" && pathname === "/notices") {
      return handleListNotices(request, env);
    }

    if (request.method === "POST" && pathname.startsWith("/notices/")) {
      return handleMarkNotice(request, env, pathname);
    }

    if (request.method === "POST" && pathname === notificationPath) {
      return handleNotification(request, env);
    }

    if (request.method === "GET") {
      return Response.json(
        {
          ok: true,
          service: "ebay-account-deletion",
          storageConfigured: Boolean(env.EBAY_DELETION_NOTICES)
        },
        { headers: jsonHeaders }
      );
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        allow: "GET, POST"
      }
    });
  }
};

async function handleChallenge(request, env) {
  const url = new URL(request.url);
  const challengeCode = url.searchParams.get("challenge_code");
  const verificationToken = env.EBAY_VERIFICATION_TOKEN;

  if (!challengeCode) {
    return Response.json({ error: "Missing challenge_code" }, { status: 400, headers: jsonHeaders });
  }

  if (!isValidVerificationToken(verificationToken)) {
    return Response.json(
      { error: "Worker is missing a valid EBAY_VERIFICATION_TOKEN secret" },
      { status: 500, headers: jsonHeaders }
    );
  }

  const endpoint = configuredEndpoint(request, env);
  const challengeResponse = await challengeResponseFor(challengeCode, verificationToken, endpoint);
  return Response.json({ challengeResponse }, { headers: jsonHeaders });
}

async function handleNotification(request, env) {
  if (!env.EBAY_DELETION_NOTICES) {
    return Response.json({ error: "Deletion notice storage is not configured" }, { status: 500, headers: jsonHeaders });
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415, headers: jsonHeaders });
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maximumNotificationBytes) {
    return Response.json({ error: "Notification payload is too large" }, { status: 413, headers: jsonHeaders });
  }

  const signatureHeader = request.headers.get("x-ebay-signature");
  if (!signatureHeader || signatureHeader.length > 4096) {
    return Response.json({ error: "Missing or invalid X-EBAY-SIGNATURE header" }, { status: 412, headers: jsonHeaders });
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > maximumNotificationBytes) {
    return Response.json({ error: "Notification payload is too large" }, { status: 413, headers: jsonHeaders });
  }
  const payload = parseJson(rawBody);
  const validationError = validateNotification(payload);
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400, headers: jsonHeaders });
  }

  const notification = objectValue(payload?.notification);
  const metadata = objectValue(payload?.metadata);
  const data = objectValue(notification?.data);
  const id = noticeId(notification);
  const key = `notice:${id}`;
  if (await env.EBAY_DELETION_NOTICES.get(key)) {
    return new Response(null, { status: 204 });
  }

  const receivedAt = new Date().toISOString();

  const notice = {
    id,
    receivedAt,
    topic: stringValue(metadata?.topic),
    schemaVersion: stringValue(metadata?.schemaVersion),
    notificationId: stringValue(notification?.notificationId) || id,
    eventDate: stringValue(notification?.eventDate),
    publishDate: stringValue(notification?.publishDate),
    publishAttemptCount: numberValue(notification?.publishAttemptCount),
    username: stringValue(data?.username),
    userId: stringValue(data?.userId),
    eiasToken: stringValue(data?.eiasToken),
    signatureHeader,
    userAgent: request.headers.get("user-agent") || "",
    payload: payload ?? null,
    rawBody: payload ? undefined : rawBody
  };

  await env.EBAY_DELETION_NOTICES.put(key, JSON.stringify(notice));
  return new Response(null, { status: 204 });
}

function validateNotification(payload) {
  if (!payload || typeof payload !== "object") return "Body must be valid JSON";
  const metadata = objectValue(payload.metadata);
  const notification = objectValue(payload.notification);
  const data = objectValue(notification.data);
  if (metadata.topic !== "MARKETPLACE_ACCOUNT_DELETION") return "Unsupported notification topic";
  if (!isNonEmptyString(metadata.schemaVersion, 32)) return "Missing schema version";
  if (!isNonEmptyString(notification.notificationId, 180)) return "Missing notification ID";
  if (!isNonEmptyString(notification.eventDate, 64)) return "Missing event date";
  if (!isNonEmptyString(notification.publishDate, 64)) return "Missing publish date";
  if (!isNonEmptyString(data.userId, 512) && !isNonEmptyString(data.username, 512) && !isNonEmptyString(data.eiasToken, 2048)) {
    return "Notification is missing an eBay user identifier";
  }
  return null;
}

function isNonEmptyString(value, maximumLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

async function handleListNotices(request, env) {
  const authResponse = authorizeAdmin(request, env);
  if (authResponse) return authResponse;

  if (!env.EBAY_DELETION_NOTICES) {
    return Response.json({ error: "Deletion notice storage is not configured" }, { status: 500, headers: jsonHeaders });
  }

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 25)));
  const listed = await env.EBAY_DELETION_NOTICES.list({ prefix: "notice:" });
  const notices = (
    await Promise.all(
      listed.keys.map(async (key) => {
        const value = await env.EBAY_DELETION_NOTICES.get(key.name);
        return value ? parseJson(value) : null;
      })
    )
  )
    .filter(Boolean)
    .sort((left, right) => String(right.receivedAt || "").localeCompare(String(left.receivedAt || "")));

  return Response.json(
    {
      notices: notices.slice(0, limit),
      total: notices.length,
      unprocessedCount: notices.filter((notice) => !notice.processedAt).length
    },
    { headers: jsonHeaders }
  );
}

async function handleMarkNotice(request, env, pathname) {
  const authResponse = authorizeAdmin(request, env);
  if (authResponse) return authResponse;

  if (!env.EBAY_DELETION_NOTICES) {
    return Response.json({ error: "Deletion notice storage is not configured" }, { status: 500, headers: jsonHeaders });
  }

  const match = pathname.match(/^\/notices\/([^/]+)\/processed$/);
  if (!match) {
    return Response.json({ error: "Unsupported notice action" }, { status: 404, headers: jsonHeaders });
  }

  const id = decodeURIComponent(match[1]);
  const key = `notice:${id}`;
  const value = await env.EBAY_DELETION_NOTICES.get(key);
  if (!value) {
    return Response.json({ error: "Notice not found" }, { status: 404, headers: jsonHeaders });
  }

  const notice = parseJson(value);
  notice.processedAt = new Date().toISOString();
  await env.EBAY_DELETION_NOTICES.put(key, JSON.stringify(notice));
  return Response.json({ notice }, { headers: jsonHeaders });
}

function configuredEndpoint(request, env) {
  if (env.EBAY_NOTIFICATION_ENDPOINT) return env.EBAY_NOTIFICATION_ENDPOINT;
  const url = new URL(request.url);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function authorizeAdmin(request, env) {
  const adminToken = env.EBAY_NOTIFICATION_ADMIN_TOKEN;
  if (!isValidVerificationToken(adminToken)) {
    return Response.json(
      { error: "Worker is missing a valid EBAY_NOTIFICATION_ADMIN_TOKEN secret" },
      { status: 500, headers: jsonHeaders }
    );
  }

  const bearerToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const headerToken = request.headers.get("x-ebay-notification-token");
  if (bearerToken === adminToken || headerToken === adminToken) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401, headers: jsonHeaders });
}

function isValidVerificationToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{32,80}$/.test(token);
}

export async function challengeResponseFor(challengeCode, verificationToken, endpoint) {
  const input = `${challengeCode}${verificationToken}${endpoint}`;
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizePath(pathname) {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function noticeId(notification) {
  const notificationId = stringValue(notification?.notificationId);
  if (notificationId) return safeId(notificationId);
  return crypto.randomUUID();
}

function safeId(value) {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 180);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function objectValue(value) {
  return value && typeof value === "object" ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
