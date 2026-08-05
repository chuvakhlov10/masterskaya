import {
  SECURE_ABLY_AUTH_ENDPOINT,
  requestSecureAblyToken as requestLegacyAblyToken,
} from "./ably-auth.js";
import {
  bootstrapStorageSession,
  clearStoredStorageSession,
  ensureStorageSession,
} from "./storage-gateway.js";

const REQUEST_TIMEOUT_MS = 15_000;
const SESSION_AUTH_ERRORS = new Set([
  "SESSION_REQUIRED",
  "SESSION_INVALID",
  "SESSION_EXPIRED",
  "SESSION_AUTH_NOT_CONFIGURED",
]);

function makeError(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function readJson(response) {
  try { return await response.json(); }
  catch (cause) { throw makeError("AUTH_RESPONSE_INVALID", cause); }
}

async function postSessionAblyToken({
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
  if (!response.ok) throw makeError(String(payload?.error || `AUTH_HTTP_${response.status}`));
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

async function requestWithFreshSession({
  clientId,
  endpoint,
  storageEndpoint,
  fetchImpl,
  storage,
  timeoutMs,
}) {
  let session = await ensureStorageSession({
    endpoint: storageEndpoint,
    fetchImpl,
    storage,
  });

  try {
    return await postSessionAblyToken({ clientId, session, endpoint, fetchImpl, timeoutMs });
  } catch (error) {
    if (!SESSION_AUTH_ERRORS.has(String(error?.code || error?.message || ""))) throw error;
    clearStoredStorageSession(storage);
    session = await bootstrapStorageSession({
      endpoint: storageEndpoint,
      fetchImpl,
      storage,
    });
    return postSessionAblyToken({ clientId, session, endpoint, fetchImpl, timeoutMs });
  }
}

let noticeShown = false;

function showAuthNotice(mode) {
  if (noticeShown || typeof document === "undefined" || !document.body) return;
  noticeShown = true;
  const node = document.createElement("div");
  node.id = "masterskaya-session-auth-notice";
  node.textContent = mode === "session"
    ? "Ably через общую сессию готово"
    : "Ably временно использует резервный PAT";
  Object.assign(node.style, {
    position: "fixed",
    right: "12px",
    bottom: "12px",
    zIndex: "100000",
    maxWidth: "calc(100vw - 24px)",
    padding: "11px 14px",
    borderRadius: "8px",
    background: mode === "session" ? "#166534" : "#9a3412",
    color: "#ffffff",
    fontFamily: "system-ui, sans-serif",
    fontSize: "13px",
    fontWeight: "700",
    boxShadow: "0 8px 24px rgba(0,0,0,.28)",
  });
  document.body.appendChild(node);
  setTimeout(() => node.remove(), mode === "session" ? 12_000 : 20_000);
}

export async function requestSessionAuthorizedAblyToken({
  clientId,
  endpoint = SECURE_ABLY_AUTH_ENDPOINT,
  storageEndpoint,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  timeoutMs = REQUEST_TIMEOUT_MS,
  allowLegacyFallback = true,
} = {}) {
  if (typeof fetchImpl !== "function") throw makeError("FETCH_UNAVAILABLE");

  try {
    const details = await requestWithFreshSession({
      clientId,
      endpoint,
      storageEndpoint,
      fetchImpl,
      storage,
      timeoutMs,
    });
    showAuthNotice("session");
    return details;
  } catch (sessionError) {
    if (!allowLegacyFallback) throw sessionError;
    const details = await requestLegacyAblyToken({
      clientId,
      endpoint,
      fetchImpl,
      storage,
      timeoutMs,
    });
    showAuthNotice("legacy");
    return { ...details, authMode: "legacy" };
  }
}
