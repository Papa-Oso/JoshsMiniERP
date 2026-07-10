import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker, { challengeResponseFor } from "./worker.js";

const endpoint = "https://example.workers.dev";
const challengeCode = "test-challenge-code";
const verificationToken = "Token_abcdefghijklmnopqrstuvwxyz123456";
const adminToken = "Admin_abcdefghijklmnopqrstuvwxyz123456";
const kv = fakeKv();
const env = {
  EBAY_VERIFICATION_TOKEN: verificationToken,
  EBAY_NOTIFICATION_ENDPOINT: endpoint,
  EBAY_NOTIFICATION_ADMIN_TOKEN: adminToken,
  EBAY_DELETION_NOTICES: kv
};

const expected = createHash("sha256")
  .update(challengeCode)
  .update(verificationToken)
  .update(endpoint)
  .digest("hex");

assert.equal(await challengeResponseFor(challengeCode, verificationToken, endpoint), expected);

const response = await worker.fetch(new Request(`${endpoint}?challenge_code=${challengeCode}`), env);
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
  new Request(endpoint, {
    method: "POST",
    headers: {
      "x-ebay-signature": "signature"
    },
    body: JSON.stringify(notificationPayload)
  }),
  env
);
assert.equal(postResponse.status, 204);

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

function fakeKv() {
  const store = new Map();
  return {
    async put(key, value) {
      store.set(key, value);
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...store.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name }))
      };
    }
  };
}
