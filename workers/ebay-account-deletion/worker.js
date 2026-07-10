const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

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

    if (request.method === "POST") {
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

  const rawBody = await request.text();
  const payload = parseJson(rawBody);
  const receivedAt = new Date().toISOString();
  const notification = objectValue(payload?.notification);
  const metadata = objectValue(payload?.metadata);
  const data = objectValue(notification?.data);
  const id = noticeId(notification);

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
    signatureHeader: request.headers.get("x-ebay-signature") || "",
    userAgent: request.headers.get("user-agent") || "",
    payload: payload ?? null,
    rawBody: payload ? undefined : rawBody
  };

  await env.EBAY_DELETION_NOTICES.put(`notice:${id}`, JSON.stringify(notice));
  return new Response(null, { status: 204 });
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
