import {
  ensureStorageSession,
  invalidateStoredStorageSession,
  isTerminalSessionError,
  isTransientGatewayError,
} from "./storage-gateway.js";

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [450, 1_400];
export const SECURE_ABLY_AUTH_ENDPOINT = "https://functions.yandexcloud.net/d4en94jbo8opqbd4d0co";

function makeError(code, cause, status) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readJson(response) {
  try { return await response.json(); }
  catch (cause) { throw makeError("AUTH_RESPONSE_INVALID", cause, response?.status); }
}

function isTransientAuthError(error) {
  if (isTransientGatewayError(error)) return true;
  const code = String(error?.code || error?.message || "");
  if (["AUTH_REQUEST_TIMEOUT", "AUTH_REQUEST_FAILED", "AUTH_RESPONSE_INVALID"].includes(code)) return true;
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(error?.status));
}

async function postSessionAblyTokenOnce({
  clientId,
  session,
  endpoint,
  fetchImpl,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Masterskaya-Session": session.token,
      },
      body: JSON.stringify({ clientId }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw makeError("AUTH_REQUEST_TIMEOUT", cause);
    throw makeError("AUTH_REQUEST_FAILED", cause);
  } finally {
    clearTimeout(timeout);
  }

  const payload = await readJson(response);
  if (!response.ok) throw makeError(String(payload?.error || `AUTH_HTTP_${response.status}`), undefined, response.status);
  if (typeof payload?.token !== "string" || payload.token.split(".").length !== 3) {
    throw makeError("AUTH_TOKEN_INVALID");
  }
  if (payload.clientId !== clientId) throw makeError("AUTH_CLIENT_ID_MISMATCH");
  if (!Number.isFinite(Number(payload.expiresAt))) throw makeError("AUTH_EXPIRY_INVALID");
  return {
    token: payload.token,
    clientId: payload.clientId,
    expiresAt: Number(payload.expiresAt),
    authMode: "session",
  };
}

async function postSessionAblyToken({
  clientId,
  session,
  endpoint,
  fetchImpl,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxAttempts = 3,
  waitImpl = wait,
  random = Math.random,
}) {
  let lastError;
  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt++) {
    try {
      return await postSessionAblyTokenOnce({ clientId, session, endpoint, fetchImpl, timeoutMs });
    } catch (error) {
      lastError = error;
      if (!isTransientAuthError(error) || attempt >= maxAttempts - 1) throw error;
      const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] || 1_400;
      await waitImpl(base + Math.floor(random() * Math.min(350, base * .25)));
    }
  }
  throw lastError || makeError("AUTH_REQUEST_FAILED");
}

async function requestWithFreshSession({
  clientId,
  endpoint,
  storageEndpoint,
  fetchImpl,
  storage,
  eventTarget,
  timeoutMs,
  waitImpl,
  random,
}) {
  const session = await ensureStorageSession({
    endpoint: storageEndpoint,
    fetchImpl,
    storage,
    eventTarget,
    waitImpl,
    random,
  });

  try {
    return await postSessionAblyToken({
      clientId,
      session,
      endpoint,
      fetchImpl,
      timeoutMs,
      waitImpl,
      random,
    });
  } catch (error) {
    if (isTerminalSessionError(error)) {
      invalidateStoredStorageSession({
        code: String(error?.code || error?.message || "SESSION_INVALID"),
        storage,
        eventTarget,
      });
    }
    throw error;
  }
}

let noticeShown = false;

function showAuthNotice() {
  if (noticeShown || typeof document === "undefined" || !document.body) return;
  noticeShown = true;
  const node = document.createElement("div");
  node.id = "masterskaya-session-auth-notice";
  node.textContent = "Ably через общую сессию готово";
  Object.assign(node.style, {
    position: "fixed",
    right: "12px",
    bottom: "12px",
    zIndex: "100000",
    maxWidth: "calc(100vw - 24px)",
    padding: "11px 14px",
    borderRadius: "8px",
    background: "#166534",
    color: "#ffffff",
    fontFamily: "system-ui, sans-serif",
    fontSize: "13px",
    fontWeight: "700",
    boxShadow: "0 8px 24px rgba(0,0,0,.28)",
  });
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 12_000);
}

export async function requestSessionAuthorizedAblyToken({
  clientId,
  endpoint = SECURE_ABLY_AUTH_ENDPOINT,
  storageEndpoint,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  eventTarget = globalThis,
  timeoutMs = REQUEST_TIMEOUT_MS,
  waitImpl,
  random,
} = {}) {
  if (typeof fetchImpl !== "function") throw makeError("FETCH_UNAVAILABLE");

  const details = await requestWithFreshSession({
    clientId,
    endpoint,
    storageEndpoint,
    fetchImpl,
    storage,
    eventTarget,
    timeoutMs,
    waitImpl,
    random,
  });
  showAuthNotice();
  return details;
}
