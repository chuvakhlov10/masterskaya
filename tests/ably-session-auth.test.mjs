import test from "node:test";
import assert from "node:assert/strict";

import {
  requestSessionAuthorizedAblyToken,
} from "../src/ably-session-auth.js";

const CLIENT_ID = "client-12345678";
const DEVICE_ID = "web-device-12345678";
const SESSION = "shared.header.signature";
const ABLY_TOKEN = "ably.header.signature";
const ABLY_ENDPOINT = "https://function.example/ably";
const STORAGE_ENDPOINT = "https://function.example/storage";

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

function storedSession(token = SESSION, expiresAt = Date.now() + 10 * 24 * 60 * 60 * 1000) {
  return JSON.stringify({ token, expiresAt, clientId: DEVICE_ID });
}

function eventTarget(events) {
  return {
    CustomEvent: class {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    dispatchEvent(event) { events.push(event); return true; },
  };
}

const noWait = async () => {};
const noRandom = () => 0;

test("valid shared session authorizes Ably", async () => {
  const storage = makeStorage({ masterskaya_storage_session_v1: storedSession() });
  const calls = [];
  const details = await requestSessionAuthorizedAblyToken({
    clientId: CLIENT_ID,
    endpoint: ABLY_ENDPOINT,
    storageEndpoint: STORAGE_ENDPOINT,
    storage,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ ok: true, token: ABLY_TOKEN, clientId: CLIENT_ID, expiresAt: 1_900_000_000_000 });
    },
  });

  assert.equal(details.authMode, "session");
  assert.equal(details.token, ABLY_TOKEN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ABLY_ENDPOINT);
  assert.equal(calls[0].options.headers["X-Masterskaya-Session"], SESSION);
});

test("temporary Ably auth failure is retried and keeps the shared session", async () => {
  const originalSession = storedSession();
  const storage = makeStorage({ masterskaya_storage_session_v1: originalSession });
  let calls = 0;
  const details = await requestSessionAuthorizedAblyToken({
    clientId: CLIENT_ID,
    endpoint: ABLY_ENDPOINT,
    storageEndpoint: STORAGE_ENDPOINT,
    storage,
    fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.headers["X-Masterskaya-Session"], SESSION);
      if (calls < 3) return response({ ok: false, error: "DEVICE_AUTH_CHECK_FAILED" }, 503);
      return response({ ok: true, token: ABLY_TOKEN, clientId: CLIENT_ID, expiresAt: 1_900_000_000_000 });
    },
    waitImpl: noWait,
    random: noRandom,
  });

  assert.equal(calls, 3);
  assert.equal(details.authMode, "session");
  assert.equal(storage.getItem("masterskaya_storage_session_v1"), originalSession);
});

test("server-rejected session clears it and returns device to pairing", async () => {
  const events = [];
  const storage = makeStorage({ masterskaya_storage_session_v1: storedSession() });
  let calls = 0;
  await assert.rejects(
    requestSessionAuthorizedAblyToken({
      clientId: CLIENT_ID,
      endpoint: ABLY_ENDPOINT,
      storageEndpoint: STORAGE_ENDPOINT,
      storage,
      eventTarget: eventTarget(events),
      fetchImpl: async () => {
        calls++;
        return response({ ok: false, error: "SESSION_INVALID" }, 401);
      },
      waitImpl: noWait,
      random: noRandom,
    }),
    error => error.code === "SESSION_INVALID",
  );

  assert.equal(calls, 1);
  assert.equal(storage.getItem("masterskaya_storage_session_v1"), null);
  assert.equal(events[0]?.detail?.code, "SESSION_INVALID");
});

test("automatic Ably authorization does not use another credential path", async () => {
  const storage = makeStorage({ masterskaya_storage_session_v1: storedSession() });
  const calls = [];
  await assert.rejects(
    requestSessionAuthorizedAblyToken({
      clientId: CLIENT_ID,
      endpoint: ABLY_ENDPOINT,
      storageEndpoint: STORAGE_ENDPOINT,
      storage,
      fetchImpl: async (_url, options) => {
        calls.push(options);
        return response({ ok: false, error: "SESSION_INVALID" }, 401);
      },
      waitImpl: noWait,
      random: noRandom,
    }),
    error => error.code === "SESSION_INVALID",
  );
  assert.equal(calls.length, 1);
});
