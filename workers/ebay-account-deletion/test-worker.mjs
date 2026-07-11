import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import worker, { challengeResponseFor } from "./worker.js";

const endpoint = "https://example.workers.dev";
const notificationEndpoint = `${endpoint}/ebay/marketplace-account-deletion`;
const challengeCode = "test-challenge-code";
const verificationToken = "Token_abcdefghijklmnopqrstuvwxyz123456";
const adminToken = "Admin_abcdefghijklmnopqrstuvwxyz123456";
const kv = fakeKv();
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const originalFetch = globalThis.fetch;
globalThis.fetch = fakeEbayFetch(publicKey.export({ type: "spki", format: "pem" }));
const env = {
  EBAY_VERIFICATION_TOKEN: verificationToken,
  EBAY_NOTIFICATION_ENDPOINT: notificationEndpoint,
  EBAY_NOTIFICATION_ADMIN_TOKEN: adminToken,
  EBAY_DELETION_NOTICES: kv,
  EBAY_CLIENT_ID: "client-id",
  EBAY_CLIENT_SECRET: "client-secret"
};

const expected = createHash("sha256")
  .update(challengeCode)
  .update(verificationToken)
  .update(notificationEndpoint)
  .digest("hex");

assert.equal(await challengeResponseFor(challengeCode, verificationToken, notificationEndpoint), expected);

const response = await worker.fetch(new Request(`${notificationEndpoint}?challenge_code=${challengeCode}`), env);
assert.equal(response.status, 200);
assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");

const body = await response.json();
assert.deepEqual(body, { challengeResponse: expected });

const notificationPayload = {
  metadata: {
    topic: "MARKETPLACE_ACCOUNT_DELETION",
    schemaVersion: "1.0"
  },
  notification: {
    notificationId: "notification-1",
    eventDate: "2026-07-09T12:00:00.000Z",
    publishDate: "2026-07-09T12:00:01.000Z",
    publishAttemptCount: 1,
    data: {
      username: "buyer-one",
      userId: "immutable-user",
      eiasToken: "eias-token"
    }
  }
};
const postResponse = await worker.fetch(
  new Request(notificationEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ebay-signature": signatureHeader(JSON.stringify(notificationPayload))
    },
    body: JSON.stringify(notificationPayload)
  }),
  env
);
assert.equal(postResponse.status, 204);

const writesAfterFirstDelivery = kv.writeCount();
const duplicateResponse = await worker.fetch(
  new Request(notificationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ebay-signature": signatureHeader(JSON.stringify(notificationPayload)) },
    body: JSON.stringify(notificationPayload)
  }),
  env
);
assert.equal(duplicateResponse.status, 204);
assert.equal(kv.writeCount(), writesAfterFirstDelivery);

const scannerResponse = await worker.fetch(
  new Request(endpoint, { method: "POST", body: "scanner traffic" }),
  env
);
assert.equal(scannerResponse.status, 405);
assert.equal(kv.writeCount(), writesAfterFirstDelivery);

const unsignedResponse = await worker.fetch(
  new Request(notificationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(notificationPayload)
  }),
  env
);
assert.equal(unsignedResponse.status, 412);
assert.equal(kv.writeCount(), writesAfterFirstDelivery);

const invalidSignatureResponse = await worker.fetch(
  new Request(notificationEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ebay-signature": Buffer.from(JSON.stringify({ kid: "test-key", signature: "aW52YWxpZA==" })).toString("base64")
    },
    body: JSON.stringify({ ...notificationPayload, notification: { ...notificationPayload.notification, notificationId: "forged" } })
  }),
  env
);
assert.equal(invalidSignatureResponse.status, 412);
assert.equal(kv.writeCount(), writesAfterFirstDelivery);

const malformedSignatureResponse = await worker.fetch(
  signedRequest(JSON.stringify({ ...notificationPayload }), "not-base64"),
  env
);
assert.equal(malformedSignatureResponse.status, 412);
assert.equal(kv.writeCount(), writesAfterFirstDelivery);

const unknownKeyBody = JSON.stringify({
  ...notificationPayload,
  notification: { ...notificationPayload.notification, notificationId: "unknown-key" }
});
const unknownKeyResponse = await worker.fetch(
  signedRequest(unknownKeyBody, signatureHeader(unknownKeyBody, "unknown-key")),
  env
);
assert.equal(unknownKeyResponse.status, 412);
assert.equal(kv.writeCount(), writesAfterFirstDelivery);

const unauthorizedResponse = await worker.fetch(new Request(`${endpoint}/notices`), env);
assert.equal(unauthorizedResponse.status, 401);

const noticesResponse = await worker.fetch(
  new Request(`${endpoint}/notices`, {
    headers: {
      authorization: `Bearer ${adminToken}`
    }
  }),
  env
);
assert.equal(noticesResponse.status, 200);
const noticesBody = await noticesResponse.json();
assert.equal(noticesBody.total, 1);
assert.equal(noticesBody.unprocessedCount, 1);
assert.equal(noticesBody.notices[0].username, "buyer-one");

const processedResponse = await worker.fetch(
  new Request(`${endpoint}/notices/notification-1/processed`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`
    }
  }),
  env
);
assert.equal(processedResponse.status, 200);
const processedBody = await processedResponse.json();
assert.ok(processedBody.notice.processedAt);

console.log("eBay account deletion Worker smoke test passed.");
globalThis.fetch = originalFetch;

function signatureHeader(body, kid = "test-key") {
  const signature = sign("sha1", Buffer.from(body), privateKey).toString("base64");
  return Buffer.from(JSON.stringify({ kid, signature })).toString("base64");
}

function signedRequest(body, signature) {
  return new Request(notificationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ebay-signature": signature },
    body
  });
}

function fakeEbayFetch(publicKeyPem) {
  return async (url) => {
    if (String(url).includes("/identity/v1/oauth2/token")) {
      return Response.json({ access_token: "test-access-token" });
    }
    if (String(url).includes("/commerce/notification/v1/public_key/test-key")) {
      return Response.json({ key: publicKeyPem });
    }
    return new Response(null, { status: 404 });
  };
}

function fakeKv() {
  const store = new Map();
  let writes = 0;
  return {
    async put(key, value) {
      writes += 1;
      store.set(key, value);
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...store.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name }))
      };
    },
    writeCount() {
      return writes;
    }
  };
}
