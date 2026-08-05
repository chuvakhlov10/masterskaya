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
  };
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function eventTarget(events) {
  return {
    CustomEvent: class {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    dispatchEvent(event) { events.push(event); return true; },
  };
}

const SESSION_TOKEN = "header.payload.signature";
const CLIENT_ID = "web-device-12345678";
const FUTURE = 1_900_000_000_000;

function storedSession(token = SESSION_TOKEN, expiresAt = FUTURE) {
  return JSON.stringify({ token, expiresAt, clientId: CLIENT_ID });
}

const noWait = async () => {};
const noRandom = () => 0;

test("explicit bootstrap sends the legacy PAT only in the custom header", async () => {
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
      return response({ ok: true, sessionToken: SESSION_TOKEN, expiresAt: FUTURE, clientId: CLIENT_ID });
    },
  });

  assert.equal(result.token, SESSION_TOKEN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["X-Masterskaya-GitHub-Token"], "github_pat_abcdefghijklmnopqrstuvwxyz012345");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: "bootstrap", clientId: CLIENT_ID });
});

test("missing PAT fails before explicit bootstrap network request", async () => {
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
    masterskaya_storage_session_v1: storedSession(),
  });
  const calls = [];
  const payload = await storageGatewayRequest({
    method: "GET",
    path: "status.json",
    ref: "data-backups",
    storage,
    now: 1_800_000_000_000,
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return response({ content: "e30=", sha: "a".repeat(40) });
    },
  });

  assert.equal(payload.sha, "a".repeat(40));
  assert.equal(calls[0].headers["X-Masterskaya-Session"], SESSION_TOKEN);
  assert.equal(calls[0].headers["X-Masterskaya-GitHub-Token"], undefined);
  assert.equal(storage.getItem("github_token_v1"), null);
});

test("renew replaces a near-expiry session without using the PAT", async () => {
  const storage = makeStorage({
    github_token_v1: "github_pat_should_not_be_sent",
    masterskaya_storage_session_v1: storedSession(SESSION_TOKEN, 1_800_000_100_000),
  });
  const calls = [];
  const renewed = await ensureStorageSession({
    storage,
    now: 1_800_000_000_000,
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return response({ ok: true, sessionToken: "renewed.payload.signature", expiresAt: FUTURE, clientId: CLIENT_ID });
    },
    waitImpl: noWait,
    random: noRandom,
  });

  assert.equal(renewed.token, "renewed.payload.signature");
  assert.deepEqual(JSON.parse(calls[0].body), { action: "renew" });
  assert.equal(calls[0].headers["X-Masterskaya-Session"], SESSION_TOKEN);
  assert.equal(calls[0].headers["X-Masterskaya-GitHub-Token"], undefined);
});

test("temporary renew failure keeps the still-valid session", async () => {
  const storage = makeStorage({
    github_token_v1: "legacy-token-must-not-be-used",
    masterskaya_storage_session_v1: storedSession(SESSION_TOKEN, 1_800_000_100_000),
  });
  let calls = 0;
  const session = await ensureStorageSession({
    storage,
    now: 1_800_000_000_000,
    fetchImpl: async () => {
      calls++;
      throw new TypeError("network down");
    },
    waitImpl: noWait,
    random: noRandom,
  });

  assert.equal(calls, 3);
  assert.equal(session.token, SESSION_TOKEN);
  assert.equal(readStoredStorageSession(storage)?.token, SESSION_TOKEN);
  assert.equal(storage.getItem("github_token_v1"), "legacy-token-must-not-be-used");
});

test("concurrent session checks share one renewal request", async () => {
  const storage = makeStorage({
    masterskaya_storage_session_v1: storedSession(SESSION_TOKEN, 1_800_000_100_000),
  });
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => {
    calls++;
    await pending;
    return response({ ok: true, sessionToken: "renewed.payload.signature", expiresAt: FUTURE, clientId: CLIENT_ID });
  };

  const first = ensureStorageSession({ storage, now: 1_800_000_000_000, fetchImpl });
  const second = ensureStorageSession({ storage, now: 1_800_000_000_000, fetchImpl });
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.token, "renewed.payload.signature");
  assert.equal(b.token, "renewed.payload.signature");
  assert.equal(calls, 1);
});

test("expired session is cleared and never bootstrapped automatically", async () => {
  const events = [];
  const storage = makeStorage({
    github_token_v1: "legacy-token-must-not-be-used",
    masterskaya_storage_session_v1: storedSession(SESSION_TOKEN, 1),
  });
  let called = false;
  await assert.rejects(
    ensureStorageSession({
      storage,
      now: 1_800_000_000_000,
      eventTarget: eventTarget(events),
      fetchImpl: async () => { called = true; },
    }),
    error => error.code === "SESSION_EXPIRED",
  );
  assert.equal(called, false);
  assert.equal(readStoredStorageSession(storage), null);
  assert.equal(events[0]?.detail?.code, "SESSION_EXPIRED");
});

test("revoked device clears the session and emits a pairing event", async () => {
  const events = [];
  const storage = makeStorage({ masterskaya_storage_session_v1: storedSession() });
  await assert.rejects(
    storageGatewayRequest({
      method: "GET",
      path: "data/records.json",
      storage,
      now: 1_800_000_000_000,
      eventTarget: eventTarget(events),
      fetchImpl: async () => response({ ok: false, error: "DEVICE_REVOKED" }, 401),
      waitImpl: noWait,
      random: noRandom,
    }),
    error => error.code === "DEVICE_REVOKED",
  );
  assert.equal(readStoredStorageSession(storage), null);
  assert.equal(events[0]?.detail?.code, "DEVICE_REVOKED");
});

test("temporary gateway failure is retried without clearing the session", async () => {
  const storage = makeStorage({ masterskaya_storage_session_v1: storedSession() });
  let calls = 0;
  const payload = await storageGatewayRequest({
    method: "GET",
    path: "data/records.json",
    storage,
    now: 1_800_000_000_000,
    fetchImpl: async () => {
      calls++;
      if (calls < 3) return response({ ok: false, error: "GITHUB_REQUEST_FAILED" }, 503);
      return response({ sha: "a".repeat(40), content: "e30=" });
    },
    waitImpl: noWait,
    random: noRandom,
  });
  assert.equal(calls, 3);
  assert.equal(payload.sha, "a".repeat(40));
  assert.equal(readStoredStorageSession(storage)?.token, SESSION_TOKEN);
});

test("read verification requires a GitHub Contents response", async () => {
  const storage = makeStorage({ masterskaya_storage_session_v1: storedSession() });
  await assert.rejects(
    verifyStorageGatewayRead({
      storage,
      now: 1_800_000_000_000,
      fetchImpl: async () => response({ ok: true }),
    }),
    error => error.code === "GATEWAY_READ_INVALID",
  );
});

test("explicit renew requires a stored session", async () => {
  await assert.rejects(renewStorageSession({ storage: makeStorage() }), error => error.code === "SESSION_REQUIRED");
});
