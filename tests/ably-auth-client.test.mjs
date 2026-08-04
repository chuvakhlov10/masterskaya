import test from "node:test";
import assert from "node:assert/strict";

import {
  requestSecureAblyToken,
  verifySecureAblyConnection,
} from "../src/ably-auth.js";

function storageWith(token = "github-token-abcdefghijklmnopqrstuvwxyz") {
  const values = new Map([["github_token_v1", token]]);
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test("secure token request sends the stored GitHub token only in the custom header", async () => {
  const calls = [];
  const details = await requestSecureAblyToken({
    clientId: "probe-client-123",
    endpoint: "https://function.example/token",
    storage: storageWith(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({
        ok: true,
        token: "header.payload.signature",
        clientId: "probe-client-123",
        expiresAt: 1_800_000_000_000,
      });
    },
  });

  assert.equal(details.token, "header.payload.signature");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Masterskaya-GitHub-Token"], "github-token-abcdefghijklmnopqrstuvwxyz");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].options.body), { clientId: "probe-client-123" });
});

test("missing local GitHub token fails before a network request", async () => {
  let called = false;
  await assert.rejects(
    requestSecureAblyToken({
      clientId: "probe-client-123",
      storage: storageWith(""),
      fetchImpl: async () => { called = true; },
    }),
    error => error.code === "GITHUB_TOKEN_MISSING",
  );
  assert.equal(called, false);
});

test("function error code is preserved without exposing its response body", async () => {
  await assert.rejects(
    requestSecureAblyToken({
      clientId: "probe-client-123",
      storage: storageWith(),
      fetchImpl: async () => response({ ok: false, error: "ABLY_AUTH_NOT_CONFIGURED" }, 503),
    }),
    error => error.code === "ABLY_AUTH_NOT_CONFIGURED",
  );
});

test("invalid JWT response is rejected", async () => {
  await assert.rejects(
    requestSecureAblyToken({
      clientId: "probe-client-123",
      storage: storageWith(),
      fetchImpl: async () => response({
        ok: true,
        token: "not-a-jwt",
        clientId: "probe-client-123",
        expiresAt: 1_800_000_000_000,
      }),
    }),
    error => error.code === "AUTH_TOKEN_INVALID",
  );
});

test("probe verifies the returned JWT with a real Realtime-style connection and closes it", async () => {
  let options;
  let closed = false;
  const handlers = new Map();

  class FakeRealtime {
    constructor(value) {
      options = value;
      this.connection = {
        state: "connecting",
        on(name, handler) {
          handlers.set(name, handler);
          if (name === "connected") queueMicrotask(handler);
        },
        off(name) { handlers.delete(name); },
      };
    }
    close() { closed = true; }
  }

  const result = await verifySecureAblyConnection({
    AblyCtor: { Realtime: FakeRealtime },
    clientId: "probe-client-123",
    storage: storageWith(),
    fetchImpl: async () => response({
      ok: true,
      token: "header.payload.signature",
      clientId: "probe-client-123",
      expiresAt: 1_800_000_000_000,
    }),
    connectionTimeoutMs: 100,
  });

  assert.equal(result.ok, true);
  assert.equal(options.token, "header.payload.signature");
  assert.equal(options.clientId, "probe-client-123");
  assert.equal(closed, true);
});

test("probe rejects an Ably failed connection and still closes it", async () => {
  let closed = false;

  class FailedRealtime {
    constructor() {
      this.connection = {
        state: "connecting",
        on(name, handler) {
          if (name === "failed") queueMicrotask(() => handler({ reason: new Error("invalid token") }));
        },
        off() {},
      };
    }
    close() { closed = true; }
  }

  await assert.rejects(
    verifySecureAblyConnection({
      AblyCtor: { Realtime: FailedRealtime },
      clientId: "probe-client-123",
      storage: storageWith(),
      fetchImpl: async () => response({
        ok: true,
        token: "header.payload.signature",
        clientId: "probe-client-123",
        expiresAt: 1_800_000_000_000,
      }),
      connectionTimeoutMs: 100,
    }),
    error => error.code === "ABLY_JWT_REJECTED",
  );
  assert.equal(closed, true);
});
