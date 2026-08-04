const DEFAULT_ENDPOINT = "https://functions.yandexcloud.net/d4en94jbo8opqbd4d0co";
const GITHUB_TOKEN_KEY = "github_token_v1";
const PROBE_RESULT_KEY = "ably_secure_probe_v1";
const REQUEST_TIMEOUT_MS = 15_000;
const CONNECTION_TIMEOUT_MS = 15_000;

export const SECURE_ABLY_AUTH_ENDPOINT = DEFAULT_ENDPOINT;

function makeError(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function readGitHubToken(storage = globalThis.localStorage) {
  try {
    return String(storage?.getItem?.(GITHUB_TOKEN_KEY) || "").trim();
  } catch {
    return "";
  }
}

function writeProbeResult(result, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(PROBE_RESULT_KEY, JSON.stringify(result));
  } catch {}
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (cause) {
    throw makeError("AUTH_RESPONSE_INVALID", cause);
  }
}

export async function requestSecureAblyToken({
  clientId,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw makeError("FETCH_UNAVAILABLE");

  const githubToken = readGitHubToken(storage);
  if (!githubToken) throw makeError("GITHUB_TOKEN_MISSING");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Masterskaya-GitHub-Token": githubToken,
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
  };
}

function waitForConnection(realtime, timeoutMs = CONNECTION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;

    const cleanup = () => {
      clearTimeout(timeout);
      realtime.connection.off("connected", onConnected);
      realtime.connection.off("failed", onFailed);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onConnected = () => finish(resolve, true);
    const onFailed = (change) => finish(reject, makeError("ABLY_JWT_REJECTED", change?.reason));

    realtime.connection.on("connected", onConnected);
    realtime.connection.on("failed", onFailed);
    if (realtime.connection.state === "connected") return onConnected();
    if (realtime.connection.state === "failed") return onFailed({ reason: realtime.connection.errorReason });

    timeout = setTimeout(() => finish(reject, makeError("ABLY_JWT_CONNECT_TIMEOUT")), timeoutMs);
  });
}

export async function verifySecureAblyConnection({
  AblyCtor,
  clientId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  connectionTimeoutMs = CONNECTION_TIMEOUT_MS,
} = {}) {
  if (!AblyCtor?.Realtime) throw makeError("ABLY_LIBRARY_UNAVAILABLE");

  const details = await requestSecureAblyToken({
    clientId,
    endpoint,
    fetchImpl,
    storage,
    timeoutMs: requestTimeoutMs,
  });

  const realtime = new AblyCtor.Realtime({
    token: details.token,
    clientId: details.clientId,
    autoConnect: true,
    realtimeRequestTimeout: connectionTimeoutMs,
  });

  try {
    await waitForConnection(realtime, connectionTimeoutMs);
    return { ok: true, clientId: details.clientId, expiresAt: details.expiresAt };
  } finally {
    try { realtime.close(); } catch {}
  }
}

function showProbeNotice({ ok, code }) {
  if (typeof document === "undefined" || !document.body) return;
  document.getElementById("masterskaya-ably-probe")?.remove();

  const node = document.createElement("div");
  node.id = "masterskaya-ably-probe";
  node.textContent = ok
    ? "Безопасное подключение Yandex готово"
    : `Проверка Yandex: ${code}`;
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

let probeInstalled = false;

export function installSecureAblyProbe(AblyCtor, options = {}) {
  if (probeInstalled || typeof window === "undefined") return;
  probeInstalled = true;

  setTimeout(async () => {
    if (!readGitHubToken(options.storage || globalThis.localStorage)) return;
    const checkedAt = Date.now();
    try {
      const result = await verifySecureAblyConnection({ AblyCtor, ...options });
      const stored = { ok: true, checkedAt, endpoint: options.endpoint || DEFAULT_ENDPOINT, expiresAt: result.expiresAt };
      writeProbeResult(stored, options.storage || globalThis.localStorage);
      showProbeNotice(stored);
      console.info("[ABLY AUTH] Secure Yandex JWT accepted");
    } catch (error) {
      const code = String(error?.code || error?.message || "AUTH_PROBE_FAILED");
      const stored = { ok: false, checkedAt, endpoint: options.endpoint || DEFAULT_ENDPOINT, code };
      writeProbeResult(stored, options.storage || globalThis.localStorage);
      showProbeNotice(stored);
      console.warn("[ABLY AUTH] Secure Yandex probe failed:", code);
    }
  }, 1_500);
}
