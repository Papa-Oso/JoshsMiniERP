import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJson } from "./adapters/types";
import { config } from "./config";

export const ebayInventoryScopes = ["https://api.ebay.com/oauth/api_scope/sell.inventory"];

const refreshSkewMs = 5 * 60_000;

interface EbayTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type: string;
}

interface EbayTokenFile {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  refreshTokenExpiresAt?: string;
  environment: "production" | "sandbox";
  scopes: string[];
}

interface EbayPendingAuth {
  state: string;
  redirectUri: string;
  environment: "production" | "sandbox";
  scopes: string[];
  createdAt: string;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

export async function createEbayAuthorization() {
  const clientId = ebayClientId();
  const redirectUri = ebayRedirectUri();
  const state = base64Url(randomBytes(32));
  const scopes = ebayInventoryScopes;

  await writeJson(pendingAuthFile(), {
    state,
    redirectUri,
    environment: config.ebay.environment,
    scopes,
    createdAt: new Date().toISOString()
  } satisfies EbayPendingAuth);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state
  });

  return {
    url: `${authorizationUrl()}?${params.toString()}`,
    redirectUri,
    environment: config.ebay.environment,
    scopes
  };
}

export async function completeEbayAuthorization(callbackValue: string) {
  const callback = parseCallback(callbackValue);
  const pending = await readPendingAuth();

  if (!safeEqual(callback.state, pending.state)) {
    throw new Error("eBay OAuth state did not match. Start again with ebay-auth-url.");
  }

  const token = await requestToken({
    grant_type: "authorization_code",
    code: callback.code,
    redirect_uri: pending.redirectUri
  });

  await saveEbayToken(token);
  await fs.rm(pendingAuthFile(), { force: true });
  return token;
}

export async function getEbayAccessToken() {
  if (config.ebay.accessToken) return config.ebay.accessToken;

  if (tokenCache && tokenCache.expiresAt > Date.now() + refreshSkewMs) {
    return tokenCache.token;
  }

  const stored = await readStoredToken();
  if (
    stored &&
    stored.environment === config.ebay.environment &&
    Date.parse(stored.expiresAt) > Date.now() + refreshSkewMs
  ) {
    tokenCache = { token: stored.accessToken, expiresAt: Date.parse(stored.expiresAt) };
    return tokenCache.token;
  }

  const refreshToken = stored?.refreshToken ?? config.ebay.refreshToken;
  if (!refreshToken) {
    throw new Error("eBay OAuth token is missing. Run npm run inv -- ebay-auth-url first.");
  }

  const refreshed = await refreshEbayToken(refreshToken);
  return refreshed.access_token;
}

export async function refreshEbayToken(refreshToken = config.ebay.refreshToken) {
  if (!refreshToken) {
    const stored = await readStoredToken();
    refreshToken = stored?.refreshToken;
  }
  if (!refreshToken) {
    throw new Error("EBAY_REFRESH_TOKEN or local eBay token file is required.");
  }

  const token = await requestToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: ebayInventoryScopes.join(" ")
  });
  await saveEbayToken(token, refreshToken);
  return token;
}

export async function hasStoredEbayToken() {
  return Boolean(await readStoredToken());
}

function ebayClientId() {
  if (!config.ebay.clientId) throw new Error("EBAY_CLIENT_ID is required.");
  return config.ebay.clientId;
}

function ebayClientSecret() {
  if (!config.ebay.clientSecret) throw new Error("EBAY_CLIENT_SECRET is required.");
  return config.ebay.clientSecret;
}

function ebayRedirectUri() {
  if (!config.ebay.redirectUri) {
    throw new Error("EBAY_RUNAME is required. This is the eBay RuName redirect_uri value, not a normal URL.");
  }
  return config.ebay.redirectUri;
}

async function requestToken(body: Record<string, string>) {
  return readJson<EbayTokenResponse>(
    await fetch(tokenUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${ebayClientId()}:${ebayClientSecret()}`).toString("base64")}`
      },
      body: new URLSearchParams(body)
    })
  );
}

async function saveEbayToken(token: EbayTokenResponse, fallbackRefreshToken?: string) {
  const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
  const refreshToken = token.refresh_token ?? fallbackRefreshToken;
  tokenCache = { token: token.access_token, expiresAt: Date.parse(expiresAt) };

  await writeJson(config.ebay.tokenFile, {
    accessToken: token.access_token,
    refreshToken,
    expiresAt,
    refreshTokenExpiresAt: token.refresh_token_expires_in
      ? new Date(Date.now() + token.refresh_token_expires_in * 1000).toISOString()
      : undefined,
    environment: config.ebay.environment,
    scopes: ebayInventoryScopes
  } satisfies EbayTokenFile);
}

async function readStoredToken() {
  try {
    const raw = await fs.readFile(config.ebay.tokenFile, "utf8");
    return JSON.parse(raw) as EbayTokenFile;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readPendingAuth() {
  try {
    const raw = await fs.readFile(pendingAuthFile(), "utf8");
    return JSON.parse(raw) as EbayPendingAuth;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("No pending eBay auth flow. Run npm run inv -- ebay-auth-url first.");
    }
    throw error;
  }
}

async function writeJson(filePath: string, data: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function pendingAuthFile() {
  return `${config.ebay.tokenFile}.pending`;
}

function authorizationUrl() {
  return config.ebay.environment === "sandbox"
    ? "https://auth.sandbox.ebay.com/oauth2/authorize"
    : "https://auth.ebay.com/oauth2/authorize";
}

function tokenUrl() {
  return config.ebay.environment === "sandbox"
    ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
    : "https://api.ebay.com/identity/v1/oauth2/token";
}

function parseCallback(value: string) {
  const trimmed = value.trim();
  const parsed = trimmed.startsWith("http://") || trimmed.startsWith("https://")
    ? new URL(trimmed)
    : new URL(`https://placeholder.invalid/?${trimmed}`);
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");
  const error = parsed.searchParams.get("error");
  const errorDescription = parsed.searchParams.get("error_description");

  if (error) {
    throw new Error(`eBay OAuth failed: ${errorDescription ?? error}`);
  }
  if (!code || !state) {
    throw new Error("Paste the full eBay redirect URL, or the query string containing code and state.");
  }
  return { code, state };
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function base64Url(input: Buffer) {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
