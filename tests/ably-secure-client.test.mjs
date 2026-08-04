import test from "node:test";
import assert from "node:assert/strict";

import {
  createSecureAblyAuthCallback,
  createSecureAblyRealtimeOptions,
} from "../src/ably-secure-client.js";

function storageWith(token = "github-token-abcdefghijklmnopqrstuvwxyz") {
  const values = new Map([["github_token_v1", token]]);
  return {
    getItem(key) { return values.get(key) || null; },
  };
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function callAuth(authCallback) {
  return new Promise((resolve, reject) => {
    authCallback({}, (error, token) => {
      if (error) reject(error);
      else resolve(token);
    });
  });
}

test("Realtime options use authCallback and never contain a permanent API key", () => {
  const options = createSecureAblyRealtimeOptions({
    clientId: "client-12345678",
    storage: storageWith(),
    fetchImpl: async () => response({}),
    autoConnect: false,
  });

  assert.equal(options.clientId, "client-12345678");
  assert.equal(options.autoConnect, false);
  assert.equal(typeof options.authCallback, "function");
  assert.equal(Object.hasOwn(options, "key"), false);
  assert.equal(Object.hasOwn(options, "token"), false);
  assert.equal(options.disconnectedRetryTimeout, 2_000);
  assert.equal(options.suspendedRetryTimeout, 5_000);
});

test("authCallback obtains a fresh Yandex JWT whenever Ably asks for authorization", async () => {
  let requestCount = 0;
  const authCallback = createSecureAblyAuthCallback({
    clientId: "client-12345678",
    endpoint: "https://function.example/token",
    storage: storageWith(),
    fetchImpl: async () => {
      requestCount += 1;
      return response({
        ok: true,
        token: `header.payload.signature${requestCount}`,
        clientId: "client-12345678",
        expiresAt: 1_800_000_000_000 + requestCount,
      });
    },
  });

  assert.equal(await callAuth(authCallback), "header.payload.signature1");
  assert.equal(await callAuth(authCallback), "header.payload.signature2");
  assert.equal(requestCount, 2);
});

test("authCallback propagates Yandex authorization errors to Ably", async () => {
  const authCallback = createSecureAblyAuthCallback({
    clientId: "client-12345678",
    storage: storageWith(),
    fetchImpl: async () => response({ ok: false, error: "GITHUB_ACCESS_DENIED" }, 403),
  });

  await assert.rejects(
    callAuth(authCallback),
    error => error.code === "GITHUB_ACCESS_DENIED",
  );
});

test("invalid client id is rejected before any network request", () => {
  assert.throws(
    () => createSecureAblyRealtimeOptions({ clientId: "tiny" }),
    error => error.code === "CLIENT_ID_INVALID",
  );
});
