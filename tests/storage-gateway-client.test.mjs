import test from "node:test";
import assert from "node:assert/strict";

import {
  bootstrapStorageSession,
  ensureStorageSession,
  readStoredStorageSession,
  renewStorageSession,
  storageGatewayRequest,
  verifyStorageGatewayRead,
} from "../src/storage-gateway.js";

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    dump() { return Object.fromEntries(values); },
  };
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

const SESSION_TOKEN = "header.payload.signature";
const CLIENT_ID = "web-device-12345678";

test("bootstrap sends the legacy PAT only in the custom header and stores the returned session", async () => {
  const storage = makeStorage({
    github_token_v1: "github_pat_abcdefghijklmnopqrstuvwxyz012345",
    masterskaya_device_id_v1: CLIENT_ID,
  });
  const calls = [];
  const result = await bootstrapStorageSession({
    endpoint: "https://function.example/storage",
    storage,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({
        ok: true,
        sessionToken: SESSION_TOKEN,
        expiresAt: 1_900_000_000_000,
        clientId: CLIENT_ID,
      });
    },
  });

  assert.equal(result.token, SESSION_TOKEN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["X-Masterskaya-GitHub-Token"], "github_pat_abcdefghijklmnopqrstuvwxyz012345");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: "bootstrap", clientId: CLIENT_ID });
  assert.equal(JSON.parse(calls[0].options.body).githubToken, undefined);
  assert.equal(readStoredStorageSession(storage)?.token, SESSION_TOKEN);
});

test("missing PAT fails before bootstrap network request", async () => {
  let called = false;
  await assert.rejects(
    bootstrapStorageSession({
      storage: makeStorage({ masterskaya_device_id_v1: CLIENT_ID }),
      fetchImpl: async () => { called = true; },
    }),
    error => error.code === "GITHUB_TOKEN_MISSING",
  );
  assert.equal(called, false);
});

test("gateway read uses the stored session and never sends the PAT", async () => {
  const storage = makeStorage({
    github_token_v1: "github_pat_should_not_be_sent",
    masterskaya_storage_session_v1: JSON.stringify({
      token: SESSION_TOKEN,
      expiresAt: Date.now() + 10 * 24 * 60 * 60 * 1000,
      clientId: CLIENT_ID,
    }),
  });
  const calls = [];
  const payload = await storageGatewayRequest({
    method: "GET",
    path: "status.json",
    ref: "data-backups",
    storage,
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return response({ content: "e30=", sha: "a".repeat(40) });
    },
  });

  assert.equal(payload.sha, "a".repeat(40));
  assert.equal(calls[0].headers["X-Masterskaya-Session"], SESSION_TOKEN);
  assert.equal(calls[0].headers["X-Masterskaya-GitHub-Token"], undefined);
  assert.deepEqual(JSON.parse(calls[0].body), {
    action: "github",
    method: "GET",
    path: "status.json",
    ref: "data-backups",
  });
});

test("renew replaces a near-expiry session without using the PAT", async () => {
  const storage = makeStorage({
    github_token_v1: "github_pat_should_not_be_sent",
    masterskaya_storage_session_v1: JSON.stringify({
      token: SESSION_TOKEN,
      expiresAt: 1_800_000_100_000,
      clientId: CLIENT_ID,
    }),
  });
  const calls = [];
  const renewed = await ensureStorageSession({
    storage,
    now: 1_800_000_000_000,
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return response({
        ok: true,
        sessionToken: "renewed.payload.signature",
        expiresAt: 1_900_000_000_000,
        clientId: CLIENT_ID,
      });
    },
  });

  assert.equal(renewed.token, "renewed.payload.signature");
  assert.deepEqual(JSON.parse(calls[0].body), { action: "renew" });
  assert.equal(calls[0].headers["X-Masterskaya-Session"], SESSION_TOKEN);
  assert.equal(calls[0].headers["X-Masterskaya-GitHub-Token"], undefined);
});

test("invalid or expired stored session falls back to one-time bootstrap", async () => {
  const storage = makeStorage({
    github_token_v1: "github_pat_abcdefghijklmnopqrstuvwxyz012345",
    masterskaya_device_id_v1: CLIENT_ID,
    masterskaya_storage_session_v1: JSON.stringify({
      token: SESSION_TOKEN,
      expiresAt: 1,
      clientId: CLIENT_ID,
    }),
  });
  const calls = [];
  const session = await ensureStorageSession({
    storage,
    now: 1_800_000_000_000,
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return response({
        ok: true,
        sessionToken: "fresh.payload.signature",
        expiresAt: 1_900_000_000_000,
        clientId: CLIENT_ID,
      });
    },
  });
  assert.equal(session.token, "fresh.payload.signature");
  assert.deepEqual(JSON.parse(calls[0].body), { action: "bootstrap", clientId: CLIENT_ID });
});

test("gateway error code is preserved", async () => {
  const storage = makeStorage({
    github_token_v1: "github_pat_abcdefghijklmnopqrstuvwxyz012345",
    masterskaya_device_id_v1: CLIENT_ID,
  });
  await assert.rejects(
    bootstrapStorageSession({
      storage,
      fetchImpl: async () => response({ ok: false, error: "GITHUB_APP_NOT_CONFIGURED" }, 503),
    }),
    error => error.code === "GITHUB_APP_NOT_CONFIGURED",
  );
});

test("read verification requires a GitHub Contents response", async () => {
  const storage = makeStorage({
    masterskaya_storage_session_v1: JSON.stringify({
      token: SESSION_TOKEN,
      expiresAt: Date.now() + 10 * 24 * 60 * 60 * 1000,
      clientId: CLIENT_ID,
    }),
  });
  await assert.rejects(
    verifyStorageGatewayRead({ storage, fetchImpl: async () => response({ ok: true }) }),
    error => error.code === "GATEWAY_READ_INVALID",
  );
});

test("explicit renew requires a stored session", async () => {
  await assert.rejects(
    renewStorageSession({ storage: makeStorage() }),
    error => error.code === "SESSION_REQUIRED",
  );
});
