import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { readJson } from "./adapters/types";

const authorizationUrl = "https://www.etsy.com/oauth/connect";
const tokenUrl = "https://api.etsy.com/v3/public/oauth/token";
const scopes = ["listings_r", "listings_w"];
const refreshSkewMs = 5 * 60_000;

interface EtsyTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
}

interface EtsyTokenFile {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

interface EtsyPendingAuth {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: string;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

export async function createEtsyAuthorization() {
  const clientId = etsyClientId();
  const redirectUri = etsyRedirectUri();
  const codeVerifier = base64Url(randomBytes(48));
  const state = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());

  await writeJson(pendingAuthFile(), {
    state,
    codeVerifier,
    redirectUri,
    createdAt: new Date().toISOString()
  } satisfies EtsyPendingAuth);

  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    client_id: clientId,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });

  return {
    url: `${authorizationUrl}?${params.toString()}`,
    redirectUri,
    scopes
  };
}

export async function completeEtsyAuthorization(callbackValue: string) {
  const callback = parseCallback(callbackValue);
  const pending = await readPendingAuth();

  if (!safeEqual(callback.state, pending.state)) {
    throw new Error("Etsy OAuth state did not match. Start again with etsy-auth-url.");
  }

  const token = await requestToken({
    grant_type: "authorization_code",
    client_id: etsyClientId(),
    redirect_uri: pending.redirectUri,
    code: callback.code,
    code_verifier: pending.codeVerifier
  });

  await saveEtsyToken(token);
  await fs.rm(pendingAuthFile(), { force: true });
  return token;
}

export async function getEtsyAccessToken() {
  if (config.etsy.accessToken) return config.etsy.accessToken;

  if (tokenCache && tokenCache.expiresAt > Date.now() + refreshSkewMs) {
    return tokenCache.token;
  }

  const stored = await readStoredToken();
  if (stored && Date.parse(stored.expiresAt) > Date.now() + refreshSkewMs) {
    tokenCache = { token: stored.accessToken, expiresAt: Date.parse(stored.expiresAt) };
    return tokenCache.token;
  }

  const refreshToken = stored?.refreshToken ?? config.etsy.refreshToken;
  if (!refreshToken) {
    throw new Error("Etsy OAuth token is missing. Run npm run inv -- etsy-auth-url after Etsy approves the app.");
  }

  const refreshed = await refreshEtsyToken(refreshToken);
  return refreshed.access_token;
}

export async function refreshEtsyToken(refreshToken = config.etsy.refreshToken) {
  if (!refreshToken) {
    const stored = await readStoredToken();
    refreshToken = stored?.refreshToken;
  }
  if (!refreshToken) {
    throw new Error("ETSY_REFRESH_TOKEN or local Etsy token file is required.");
  }

  const token = await requestToken({
    grant_type: "refresh_token",
    client_id: etsyClientId(),
    refresh_token: refreshToken
  });
  await saveEtsyToken(token);
  return token;
}

export async function hasStoredEtsyToken() {
  return Boolean(await readStoredToken());
}

function etsyClientId() {
  const clientId = config.etsy.clientId ?? config.etsy.apiKey?.split(":")[0];
  if (!clientId) throw new Error("ETSY_KEYSTRING, ETSY_CLIENT_ID, or ETSY_API_KEY is required.");
  return clientId;
}

function etsyRedirectUri() {
  if (!config.etsy.redirectUri) {
    throw new Error("ETSY_REDIRECT_URI is required and must exactly match the HTTPS redirect URI in Etsy.");
  }
  return config.etsy.redirectUri;
}

async function requestToken(body: Record<string, string>) {
  return readJson<EtsyTokenResponse>(
    await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body)
    })
  );
}

async function saveEtsyToken(token: EtsyTokenResponse) {
  const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
  tokenCache = { token: token.access_token, expiresAt: Date.parse(expiresAt) };
  await writeJson(config.etsy.tokenFile, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt
  } satisfies EtsyTokenFile);
}

async function readStoredToken() {
  try {
    const raw = await fs.readFile(config.etsy.tokenFile, "utf8");
    return JSON.parse(raw) as EtsyTokenFile;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readPendingAuth() {
  try {
    const raw = await fs.readFile(pendingAuthFile(), "utf8");
    return JSON.parse(raw) as EtsyPendingAuth;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("No pending Etsy auth flow. Run npm run inv -- etsy-auth-url first.");
    }
    throw error;
  }
}

async function writeJson(filePath: string, data: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function pendingAuthFile() {
  return `${config.etsy.tokenFile}.pending`;
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
    throw new Error(`Etsy OAuth failed: ${errorDescription ?? error}`);
  }
  if (!code || !state) {
    throw new Error("Paste the full Etsy redirect URL, or the query string containing code and state.");
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
