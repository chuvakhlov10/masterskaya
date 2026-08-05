import test from "node:test";
import assert from "node:assert/strict";

import {
  requestSessionAuthorizedAblyToken,
} from "../src/ably-session-auth.js";

const CLIENT_ID = "client-12345678";
const DEVICE_ID = "web-device-12345678";
const PAT = "github_pat_abcdefghijklmnopqrstuvwxyz012345";
const SESSION_OLD = "old.header.signature";
const SESSION_NEW = "new.header.signature";
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

function storedSession(token, expiresAt = Date.now() + 10 * 24 * 60 * 60 * 1000) {
  return JSON.stringify({ token, expiresAt, clientId: DEVICE_ID });
}

test("valid shared session authorizes Ably without sending the PAT", async () => {
  const storage = makeStorage({
    github_token_v1: PAT,
    masterskaya_storage_session_v1: storedSession(SESSION_NEW),
  });
  const calls = [];
  const details = await requestSessionAuthorizedAblyToken({
    clientId: CLIENT_ID,
    endpoint: ABLY_ENDPOINT,
    storageEndpoint: STORAGE_ENDPOINT,
    storage,
    allowLegacyFallback: false,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ ok: true, token: ABLY_TOKEN, clientId: CLIENT_ID, expiresAt: 1_900_000_000_000 });
    },
  });

  assert.equal(details.authMode, "session");
  assert.equal(details.token, ABLY_TOKEN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ABLY_ENDPOINT);
  assert.equal(calls[0].options.headers["X-Masterskaya-Session"], SESSION_NEW);
  assert.equal(calls[0].options.headers["X-Masterskaya-GitHub-Token"], undefined);
});

test("server-rejected old session is replaced through one-time PAT bootstrap and retried", async () => {
  const storage = makeStorage({
    github_token_v1: PAT,
    masterskaya_device_id_v1: DEVICE_ID,
    masterskaya_storage_session_v1: storedSession(SESSION_OLD),
  });
  const calls = [];
  const details = await requestSessionAuthorizedAblyToken({
    clientId: CLIENT_ID,
    endpoint: ABLY_ENDPOINT,
    storageEndpoint: STORAGE_ENDPOINT,
    storage,
    allowLegacyFallback: false,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, options, body });
      if (url === ABLY_ENDPOINT && options.headers["X-Masterskaya-Session"] === SESSION_OLD) {
        return response({ ok: false, error: "SESSION_INVALID" }, 401);
      }
      if (url === STORAGE_ENDPOINT && body.action === "bootstrap") {
        assert.equal(options.headers["X-Masterskaya-GitHub-Token"], PAT);
        return response({
          ok: true,
          sessionToken: SESSION_NEW,
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
          clientId: DEVICE_ID,
        });
      }
      if (url === ABLY_ENDPOINT && options.headers["X-Masterskaya-Session"] === SESSION_NEW) {
        return response({ ok: true, token: ABLY_TOKEN, clientId: CLIENT_ID, expiresAt: 1_900_000_000_000 });
      }
      assert.fail(`unexpected request ${url}`);
    },
  });

  assert.equal(details.authMode, "session");
  assert.equal(calls.length, 3);
  assert.match(storage.getItem("masterskaya_storage_session_v1"), /new\.header\.signature/);
});

test("legacy PAT remains a temporary fallback when the storage session service is unavailable", async () => {
  const storage = makeStorage({
    github_token_v1: PAT,
    masterskaya_device_id_v1: DEVICE_ID,
  });
  const calls = [];
  const details = await requestSessionAuthorizedAblyToken({
    clientId: CLIENT_ID,
    endpoint: ABLY_ENDPOINT,
    storageEndpoint: STORAGE_ENDPOINT,
    storage,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      if (url === STORAGE_ENDPOINT) return response({ ok: false, error: "GATEWAY_TEMPORARY_FAILURE" }, 503);
      assert.equal(options.headers["X-Masterskaya-GitHub-Token"], PAT);
      return response({ ok: true, token: ABLY_TOKEN, clientId: CLIENT_ID, expiresAt: 1_900_000_000_000 });
    },
  });

  assert.equal(details.authMode, "legacy");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, ABLY_ENDPOINT);
});

test("fallback can be disabled for fail-closed verification", async () => {
  const storage = makeStorage({
    github_token_v1: PAT,
    masterskaya_device_id_v1: DEVICE_ID,
  });
  await assert.rejects(
    requestSessionAuthorizedAblyToken({
      clientId: CLIENT_ID,
      endpoint: ABLY_ENDPOINT,
      storageEndpoint: STORAGE_ENDPOINT,
      storage,
      allowLegacyFallback: false,
      fetchImpl: async () => response({ ok: false, error: "SESSION_AUTH_NOT_CONFIGURED" }, 503),
    }),
    error => error.code === "SESSION_AUTH_NOT_CONFIGURED",
  );
});
