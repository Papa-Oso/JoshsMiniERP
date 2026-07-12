import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../src/server/config";
import {
  completeEbayAuthorization,
  createEbayAuthorization,
  getEbayAccessToken,
  refreshEbayToken
} from "../src/server/ebayAuth";
import {
  completeEtsyAuthorization,
  createEtsyAuthorization,
  getEtsyAccessToken,
  refreshEtsyToken
} from "../src/server/etsyAuth";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-oauth-"));
const originalFetch = globalThis.fetch;
const originalEbay = config.ebay;
const originalEtsy = config.etsy;

config.ebay = {
  ...originalEbay,
  accessToken: undefined,
  refreshToken: undefined,
  clientId: "test-ebay-client",
  clientSecret: "test-ebay-secret",
  redirectUri: "test-ebay-runame",
  environment: "sandbox",
  tokenFile: path.join(tempDir, "ebay-token.json")
};
config.etsy = {
  ...originalEtsy,
  accessToken: undefined,
  refreshToken: undefined,
  apiKey: "test-etsy-key:test-etsy-secret",
  clientId: "test-etsy-key",
  redirectUri: "https://localhost.invalid/etsy/callback",
  tokenFile: path.join(tempDir, "etsy-token.json")
};

test.after(async () => {
  globalThis.fetch = originalFetch;
  config.ebay = originalEbay;
  config.etsy = originalEtsy;
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("eBay OAuth failures reject invalid callbacks without saving token state", async () => {
  const callbackCode = "ebay-code-canary";
  const wrongState = "ebay-wrong-state-canary";
  const refreshToken = "ebay-refresh-canary";
  let fetchCalls = 0;
  globalThis.fetch = async (_input, init) => {
    fetchCalls += 1;
    assert.equal(init?.method, "POST");
    assert.match(String(new Headers(init?.headers).get("Authorization")), /^Basic /);
    return jsonResponse({ error: "invalid_grant", error_description: "Authorization was rejected." }, 400);
  };

  assertSensitiveValuesAbsent(
    await errorMessage(() => completeEbayAuthorization("error=access_denied&error_description=Authorization+declined")),
    [callbackCode, wrongState, refreshToken, config.ebay.clientId!, config.ebay.clientSecret!]
  );
  assert.equal(fetchCalls, 0);

  await createEbayAuthorization();
  const pendingPath = `${config.ebay.tokenFile}.pending`;
  const pending = JSON.parse(await fs.readFile(pendingPath, "utf8")) as { state: string };

  const mismatchMessage = await errorMessage(() =>
    completeEbayAuthorization(`code=${encodeURIComponent(callbackCode)}&state=${encodeURIComponent(wrongState)}`)
  );
  assert.match(mismatchMessage, /state did not match/);
  assertSensitiveValuesAbsent(mismatchMessage, [callbackCode, wrongState, pending.state]);
  assert.equal(fetchCalls, 0);
  assert.equal(await exists(pendingPath), true);
  assert.equal(await exists(config.ebay.tokenFile), false);

  const exchangeMessage = await errorMessage(() =>
    completeEbayAuthorization(`code=${encodeURIComponent(callbackCode)}&state=${encodeURIComponent(pending.state)}`)
  );
  assert.match(exchangeMessage, /400/);
  assertSensitiveValuesAbsent(exchangeMessage, [callbackCode, pending.state, config.ebay.clientId!, config.ebay.clientSecret!]);
  assert.equal(fetchCalls, 1);
  assert.equal(await exists(pendingPath), true);
  assert.equal(await exists(config.ebay.tokenFile), false);

  await fs.rm(pendingPath, { force: true });
  const missingMessage = await errorMessage(() => getEbayAccessToken());
  assert.match(missingMessage, /OAuth token is missing/);
  assertSensitiveValuesAbsent(missingMessage, [refreshToken]);

  const refreshMessage = await errorMessage(() => refreshEbayToken(refreshToken));
  assert.match(refreshMessage, /400/);
  assertSensitiveValuesAbsent(refreshMessage, [refreshToken, config.ebay.clientId!, config.ebay.clientSecret!]);
  assert.equal(fetchCalls, 2);
  assert.equal(await exists(config.ebay.tokenFile), false);
});

test("Etsy OAuth failures reject invalid callbacks without saving token state", async () => {
  const callbackCode = "etsy-code-canary";
  const wrongState = "etsy-wrong-state-canary";
  const refreshToken = "etsy-refresh-canary";
  let fetchCalls = 0;
  let lastBody = "";
  globalThis.fetch = async (_input, init) => {
    fetchCalls += 1;
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    lastBody = String(init?.body ?? "");
    return jsonResponse({ error: "invalid_grant", error_description: "Authorization was rejected." }, 400);
  };

  assertSensitiveValuesAbsent(
    await errorMessage(() => completeEtsyAuthorization("error=access_denied&error_description=Authorization+declined")),
    [callbackCode, wrongState, refreshToken, config.etsy.clientId!]
  );
  assert.equal(fetchCalls, 0);

  await createEtsyAuthorization();
  const pendingPath = `${config.etsy.tokenFile}.pending`;
  const pending = JSON.parse(await fs.readFile(pendingPath, "utf8")) as { state: string; codeVerifier: string };

  const mismatchMessage = await errorMessage(() =>
    completeEtsyAuthorization(`code=${encodeURIComponent(callbackCode)}&state=${encodeURIComponent(wrongState)}`)
  );
  assert.match(mismatchMessage, /state did not match/);
  assertSensitiveValuesAbsent(mismatchMessage, [callbackCode, wrongState, pending.state, pending.codeVerifier]);
  assert.equal(fetchCalls, 0);
  assert.equal(await exists(pendingPath), true);
  assert.equal(await exists(config.etsy.tokenFile), false);

  const exchangeMessage = await errorMessage(() =>
    completeEtsyAuthorization(`code=${encodeURIComponent(callbackCode)}&state=${encodeURIComponent(pending.state)}`)
  );
  assert.match(exchangeMessage, /400/);
  assert.equal(lastBody.includes(callbackCode), true);
  assert.equal(lastBody.includes(pending.codeVerifier), true);
  assertSensitiveValuesAbsent(exchangeMessage, [callbackCode, pending.state, pending.codeVerifier, config.etsy.clientId!]);
  assert.equal(fetchCalls, 1);
  assert.equal(await exists(pendingPath), true);
  assert.equal(await exists(config.etsy.tokenFile), false);

  await fs.rm(pendingPath, { force: true });
  const missingMessage = await errorMessage(() => getEtsyAccessToken());
  assert.match(missingMessage, /OAuth token is missing/);
  assertSensitiveValuesAbsent(missingMessage, [refreshToken]);

  const refreshMessage = await errorMessage(() => refreshEtsyToken(refreshToken));
  assert.match(refreshMessage, /400/);
  assert.equal(lastBody.includes(refreshToken), true);
  assertSensitiveValuesAbsent(refreshMessage, [refreshToken, config.etsy.clientId!]);
  assert.equal(fetchCalls, 2);
  assert.equal(await exists(config.etsy.tokenFile), false);
});

async function errorMessage(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail("Expected the OAuth action to fail.");
}

function assertSensitiveValuesAbsent(message: string, values: string[]) {
  for (const value of values) assert.equal(message.includes(value), false);
  assert.equal(/\bBasic\s+[A-Za-z0-9+/=]+/.test(message), false);
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function jsonResponse(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    statusText: "Bad Request",
    headers: { "content-type": "application/json" }
  });
}
