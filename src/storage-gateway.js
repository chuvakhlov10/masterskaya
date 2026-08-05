import {
  recordSessionRenewal,
  recordStorageRequestResult,
} from "./diagnostics.js";

const DEFAULT_ENDPOINT = "https://functions.yandexcloud.net/d4ep5fmjtp6t09f06tvt";
const SESSION_KEY = "masterskaya_storage_session_v1";
const DEVICE_ID_KEY = "masterskaya_device_id_v1";
const PROBE_RESULT_KEY = "masterskaya_storage_probe_v1";
const REQUEST_TIMEOUT_MS = 20_000;
const SESSION_RENEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const RENEW_RETRY_BASE_MS = 5 * 60 * 1000;
const RENEW_RETRY_JITTER_MS = 60 * 1000;
const RETRY_DELAYS_MS = [450, 1_400];

export const STORAGE_GATEWAY_ENDPOINT = DEFAULT_ENDPOINT;
export const STORAGE_SESSION_EVENT = "masterskaya-storage-session";

export const TERMINAL_SESSION_ERRORS = new Set([
  "SESSION_REQUIRED",
  "SESSION_INVALID",
  "SESSION_EXPIRED",
  "DEVICE_REVOKED",
  "DEVICE_NOT_FOUND",
]);

const TRANSIENT_ERROR_CODES = new Set([
  "FETCH_UNAVAILABLE",
  "GATEWAY_REQUEST_TIMEOUT",
  "GATEWAY_REQUEST_FAILED",
  "GATEWAY_RESPONSE_INVALID",
  "GITHUB_REQUEST_TIMEOUT",
  "GITHUB_REQUEST_FAILED",
  "GITHUB_ACCESS_CHECK_FAILED",
  "GITHUB_APP_TOKEN_FAILED",
  "GITHUB_INSTALLATION_LOOKUP_FAILED",
  "DEVICE_AUTH_CHECK_TIMEOUT",
  "DEVICE_AUTH_CHECK_FAILED",
]);

function makeError(code, cause, status) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

function errorCode(error) {
  return String(error?.code || error?.message || "GATEWAY_REQUEST_FAILED");
}

export function isTerminalSessionError(error) {
  return TERMINAL_SESSION_ERRORS.has(errorCode(error));
}

export function isTransientGatewayError(error) {
  const code = errorCode(error);
  if (TRANSIENT_ERROR_CODES.has(code)) return true;
  const status = Number(error?.status);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const match = /^GATEWAY_HTTP_(\d{3})$/.exec(code);
  return !!match && [408, 425, 429, 500, 502, 503, 504].includes(Number(match[1]));
}

function safeGet(storage, key) {
  try { return storage?.getItem?.(key) || ""; }
  catch { return ""; }
}

function safeSet(storage, key, value) {
  try { storage?.setItem?.(key, String(value)); }
  catch {}
}

function safeRemove(storage, key) {
  try { storage?.removeItem?.(key); }
  catch {}
}

function randomId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `web-${uuid}`;
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

export function getOrCreateStorageDeviceId(storage = globalThis.localStorage) {
  const existing = String(safeGet(storage, DEVICE_ID_KEY)).trim();
  if (/^[A-Za-z0-9._:-]{8,128}$/.test(existing)) return existing;
  const created = randomId().slice(0, 128);
  safeSet(storage, DEVICE_ID_KEY, created);
  return created;
}

export function readStoredStorageSession(storage = globalThis.localStorage) {
  try {
    const raw = safeGet(storage, SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token !== "string" || parsed.token.split(".").length !== 3) return null;
    if (!Number.isFinite(Number(parsed.expiresAt))) return null;
    if (typeof parsed.clientId !== "string") return null;
    return {
      token: parsed.token,
      expiresAt: Number(parsed.expiresAt),
      clientId: parsed.clientId,
    };
  } catch {
    return null;
  }
}

export function clearStoredStorageSession(storage = globalThis.localStorage) {
  safeRemove(storage, SESSION_KEY);
}

function dispatchSessionEvent(code, eventTarget = globalThis) {
  try {
    if (typeof eventTarget?.dispatchEvent !== "function") return;
    const EventCtor = eventTarget.CustomEvent || globalThis.CustomEvent;
    if (typeof EventCtor === "function") {
      eventTarget.dispatchEvent(new EventCtor(STORAGE_SESSION_EVENT, { detail: { code } }));
      return;
    }
    eventTarget.dispatchEvent({ type: STORAGE_SESSION_EVENT, detail: { code } });
  } catch {}
}

export function invalidateStoredStorageSession({
  code = "SESSION_INVALID",
  storage = globalThis.localStorage,
  eventTarget = globalThis,
} = {}) {
  clearStoredStorageSession(storage);
  dispatchSessionEvent(code, eventTarget);
}

function storeSession(details, storage) {
  const normalized = {
    token: details.sessionToken,
    expiresAt: Number(details.expiresAt),
    clientId: details.clientId,
  };
  if (typeof normalized.token !== "string" || normalized.token.split(".").length !== 3) {
    throw makeError("SESSION_TOKEN_INVALID");
  }
  if (!Number.isFinite(normalized.expiresAt)) throw makeError("SESSION_EXPIRY_INVALID");
  safeSet(storage, SESSION_KEY, JSON.stringify(normalized));
  return normalized;
}

async function readJson(response) {
  try { return await response.json(); }
  catch (cause) { throw makeError("GATEWAY_RESPONSE_INVALID", cause, response?.status); }
}

async function postGatewayOnce({ endpoint, headers, body, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw makeError("GATEWAY_REQUEST_TIMEOUT", cause);
    throw makeError("GATEWAY_REQUEST_FAILED", cause);
  } finally {
    clearTimeout(timeout);
  }

  const payload = await readJson(response);
  if (!response.ok) throw makeError(String(payload?.error || `GATEWAY_HTTP_${response.status}`), undefined, response.status);
  return payload;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function postGateway({
  endpoint,
  headers,
  body,
  fetchImpl,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxAttempts = 3,
  waitImpl = wait,
  random = Math.random,
  onRetry,
}) {
  let lastError;
  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt++) {
    try {
      return await postGatewayOnce({ endpoint, headers, body, fetchImpl, timeoutMs });
    } catch (error) {
      lastError = error;
      if (!isTransientGatewayError(error) || attempt >= maxAttempts - 1) throw error;
      try { onRetry?.({ attempt: attempt + 1, code: errorCode(error) }); } catch {}
      const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] || 1_400;
      await waitImpl(base + Math.floor(random() * Math.min(350, base * .25)));
    }
  }
  throw lastError || makeError("GATEWAY_REQUEST_FAILED");
}

export async function renewStorageSession({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  session = readStoredStorageSession(storage),
  waitImpl,
  random,
  onRetry,
} = {}) {
  if (!session?.token) throw makeError("SESSION_REQUIRED");
  const payload = await postGateway({
    endpoint,
    fetchImpl,
    headers: { "X-Masterskaya-Session": session.token },
    body: { action: "renew" },
    waitImpl,
    random,
    onRetry,
  });
  if (payload?.clientId !== session.clientId) throw makeError("SESSION_CLIENT_ID_MISMATCH");
  const renewed = storeSession(payload, storage);
  recordSessionRenewal({ storage });
  return renewed;
}

const renewalInFlight = new Map();
const renewalRetryAfter = new Map();

function renewalKey({ endpoint, session }) {
  return `${endpoint}|${session?.clientId || ""}|${session?.token || ""}`;
}

function sharedRenew(options) {
  const key = renewalKey(options);
  if (!renewalInFlight.has(key)) {
    const request = renewStorageSession(options).finally(() => {
      renewalInFlight.delete(key);
    });
    renewalInFlight.set(key, request);
  }
  return renewalInFlight.get(key);
}

export async function ensureStorageSession({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  now = Date.now(),
  eventTarget = globalThis,
  waitImpl,
  random = Math.random,
  onRetry,
} = {}) {
  const existing = readStoredStorageSession(storage);
  if (!existing) throw makeError("SESSION_REQUIRED");
  if (existing.expiresAt <= now) {
    invalidateStoredStorageSession({ code: "SESSION_EXPIRED", storage, eventTarget });
    throw makeError("SESSION_EXPIRED");
  }
  if (existing.expiresAt - now > SESSION_RENEW_WINDOW_MS) return existing;

  const key = renewalKey({ endpoint, session: existing });
  if ((renewalRetryAfter.get(key) || 0) > now) return existing;

  try {
    const renewed = await sharedRenew({ endpoint, fetchImpl, storage, session: existing, waitImpl, random, onRetry });
    renewalRetryAfter.delete(key);
    return renewed;
  } catch (error) {
    if (isTerminalSessionError(error)) {
      renewalRetryAfter.delete(key);
      invalidateStoredStorageSession({ code: errorCode(error), storage, eventTarget });
      throw error;
    }
    if (isTransientGatewayError(error)) {
      // Старая сессия ещё действует. Сетевой сбой не должен удалять её и
      // переводить устройство на повторное подключение. Следующая попытка
      // продления откладывается, чтобы обычные запросы не тормозили и не
      // создавали шторм запросов во время сбоя.
      renewalRetryAfter.set(key, now + RENEW_RETRY_BASE_MS + Math.floor(random() * RENEW_RETRY_JITTER_MS));
      return existing;
    }
    throw error;
  }
}

export async function storageGatewayRequest({
  method,
  path,
  ref,
  body,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  eventTarget = globalThis,
  maxAttempts = 3,
  waitImpl,
  random,
} = {}) {
  let retries = 0;
  const onRetry = () => { retries += 1; };
  const operation = `${String(method || "REQUEST").toUpperCase()} ${String(path || "gateway")}`;

  try {
    const session = await ensureStorageSession({ endpoint, fetchImpl, storage, eventTarget, waitImpl, random, onRetry });
    const payload = await postGateway({
      endpoint,
      fetchImpl,
      headers: { "X-Masterskaya-Session": session.token },
      body: {
        action: "github",
        storageProtocolVersion: 4,
        method,
        path,
        ...(ref ? { ref } : {}),
        ...(body !== undefined ? { body } : {}),
      },
      maxAttempts,
      waitImpl,
      random,
      onRetry,
    });
    recordStorageRequestResult({ ok: true, operation, retries, storage });
    return payload;
  } catch (error) {
    recordStorageRequestResult({ ok: false, code: errorCode(error), operation, retries, storage });
    if (isTerminalSessionError(error)) {
      invalidateStoredStorageSession({ code: errorCode(error), storage, eventTarget });
    }
    throw error;
  }
}

export async function verifyStorageGatewayRead(options = {}) {
  const payload = await storageGatewayRequest({
    method: "GET",
    path: "status.json",
    ref: "data-backups",
    ...options,
  });
  if (typeof payload?.content !== "string" || typeof payload?.sha !== "string") {
    throw makeError("GATEWAY_READ_INVALID");
  }
  return { ok: true, sha: payload.sha };
}

function showNotice({ ok, code }) {
  if (typeof document === "undefined" || !document.body) return;
  document.getElementById("masterskaya-storage-probe")?.remove();
  const node = document.createElement("div");
  node.id = "masterskaya-storage-probe";
  node.textContent = ok ? "GitHub App и Yandex-хранилище готовы" : `Проверка хранилища: ${code}`;
  Object.assign(node.style, {
    position: "fixed",
    right: "12px",
    bottom: "12px",
    zIndex: "100000",
    maxWidth: "calc(100vw - 24px)",
    padding: "11px 14px",
    borderRadius: "8px",
    background: ok ? "#166534" : "#9a3412",
    color: "#ffffff",
    fontFamily: "system-ui, sans-serif",
    fontSize: "13px",
    fontWeight: "700",
    boxShadow: "0 8px 24px rgba(0,0,0,.28)",
  });
  document.body.appendChild(node);
  setTimeout(() => node.remove(), ok ? 12_000 : 20_000);
}

let installed = false;

export function installStorageGatewayProbe(options = {}) {
  if (installed || typeof window === "undefined") return;
  installed = true;
  setTimeout(async () => {
    const storage = options.storage || globalThis.localStorage;
    if (!readStoredStorageSession(storage)) return;
    const checkedAt = Date.now();
    try {
      await verifyStorageGatewayRead({ ...options, storage });
      const result = { ok: true, checkedAt, endpoint: options.endpoint || DEFAULT_ENDPOINT };
      safeSet(storage, PROBE_RESULT_KEY, JSON.stringify(result));
      showNotice(result);
      console.info("[STORAGE GATEWAY] GitHub App read verified");
    } catch (error) {
      const code = errorCode(error);
      const result = { ok: false, checkedAt, endpoint: options.endpoint || DEFAULT_ENDPOINT, code };
      safeSet(storage, PROBE_RESULT_KEY, JSON.stringify(result));
      showNotice(result);
      console.warn("[STORAGE GATEWAY] Probe failed:", code);
    }
  }, 1_800);
}
