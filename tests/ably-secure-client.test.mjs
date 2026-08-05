import test from "node:test";
import assert from "node:assert/strict";

import {
  createSecureAblyAuthCallback,
  createSecureAblyRealtimeOptions,
} from "../src/ably-secure-client.js";

const CLIENT_ID = "client-12345678";
const SESSION_TOKEN = "session.header.signature";

function storageWithSession() {
  const values = new Map([
    ["masterskaya_storage_session_v1", JSON.stringify({
      token: SESSION_TOKEN,
      expiresAt: Date.now() + 10 * 24 * 60 * 60 * 1000,
      clientId: "web-device-12345678",
    })],
  ]);
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
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
    clientId: CLIENT_ID,
    storage: storageWithSession(),
    fetchImpl: async () => response({}),
    autoConnect: false,
  });

  assert.equal(options.clientId, CLIENT_ID);
  assert.equal(options.autoConnect, false);
  assert.equal(typeof options.authCallback, "function");
  assert.equal(Object.hasOwn(options, "key"), false);
  assert.equal(Object.hasOwn(options, "token"), false);
  assert.equal(options.disconnectedRetryTimeout, 2_000);
  assert.equal(options.suspendedRetryTimeout, 5_000);
});

test("authCallback obtains a fresh Yandex JWT through the shared session whenever Ably asks", async () => {
  let requestCount = 0;
  const authCallback = createSecureAblyAuthCallback({
    clientId: CLIENT_ID,
    endpoint: "https://function.example/token",
    storage: storageWithSession(),
    fetchImpl: async (_url, options) => {
      requestCount += 1;
      assert.equal(options.headers["X-Masterskaya-Session"], SESSION_TOKEN);
      return response({
        ok: true,
        token: `header.payload.signature${requestCount}`,
        clientId: CLIENT_ID,
        expiresAt: 1_800_000_000_000 + requestCount,
      });
    },
  });

  assert.equal(await callAuth(authCallback), "header.payload.signature1");
  assert.equal(await callAuth(authCallback), "header.payload.signature2");
  assert.equal(requestCount, 2);
});

test("authCallback propagates Yandex session authorization errors", async () => {
  const storage = storageWithSession();
  const authCallback = createSecureAblyAuthCallback({
    clientId: CLIENT_ID,
    storage,
    fetchImpl: async () => response({ ok: false, error: "SESSION_INVALID" }, 401),
  });

  await assert.rejects(
    callAuth(authCallback),
    error => error.code === "SESSION_INVALID",
  );
});

test("invalid client id is rejected before any network request", () => {
  assert.throws(
    () => createSecureAblyRealtimeOptions({ clientId: "tiny" }),
    error => error.code === "CLIENT_ID_INVALID",
  );
});
