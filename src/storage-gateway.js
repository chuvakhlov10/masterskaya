const DEFAULT_ENDPOINT = "https://functions.yandexcloud.net/d4ep5fmjtp6t09f06tvt";
const LEGACY_TOKEN_KEY = "github_token_v1";
const SESSION_KEY = "masterskaya_storage_session_v1";
const DEVICE_ID_KEY = "masterskaya_device_id_v1";
const PROBE_RESULT_KEY = "masterskaya_storage_probe_v1";
const REQUEST_TIMEOUT_MS = 20_000;
const SESSION_RENEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export const STORAGE_GATEWAY_ENDPOINT = DEFAULT_ENDPOINT;

function makeError(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
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
  catch (cause) { throw makeError("GATEWAY_RESPONSE_INVALID", cause); }
}

async function postGateway({
  endpoint,
  headers,
  body,
  fetchImpl,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
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
  if (!response.ok) throw makeError(String(payload?.error || `GATEWAY_HTTP_${response.status}`));
  return payload;
}

export async function bootstrapStorageSession({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  clientId = getOrCreateStorageDeviceId(storage),
} = {}) {
  if (typeof fetchImpl !== "function") throw makeError("FETCH_UNAVAILABLE");
  const githubToken = String(safeGet(storage, LEGACY_TOKEN_KEY)).trim();
  if (!githubToken) throw makeError("GITHUB_TOKEN_MISSING");

  const payload = await postGateway({
    endpoint,
    fetchImpl,
    headers: { "X-Masterskaya-GitHub-Token": githubToken },
    body: { action: "bootstrap", clientId },
  });
  if (payload?.clientId !== clientId) throw makeError("SESSION_CLIENT_ID_MISMATCH");
  return storeSession(payload, storage);
}

export async function renewStorageSession({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  session = readStoredStorageSession(storage),
} = {}) {
  if (!session?.token) throw makeError("SESSION_REQUIRED");
  const payload = await postGateway({
    endpoint,
    fetchImpl,
    headers: { "X-Masterskaya-Session": session.token },
    body: { action: "renew" },
  });
  if (payload?.clientId !== session.clientId) throw makeError("SESSION_CLIENT_ID_MISMATCH");
  return storeSession(payload, storage);
}

export async function ensureStorageSession({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  now = Date.now(),
} = {}) {
  const existing = readStoredStorageSession(storage);
  if (!existing || existing.expiresAt <= now) {
    clearStoredStorageSession(storage);
    return bootstrapStorageSession({ endpoint, fetchImpl, storage });
  }
  if (existing.expiresAt - now <= SESSION_RENEW_WINDOW_MS) {
    try {
      return await renewStorageSession({ endpoint, fetchImpl, storage, session: existing });
    } catch {
      clearStoredStorageSession(storage);
      return bootstrapStorageSession({ endpoint, fetchImpl, storage, clientId: existing.clientId });
    }
  }
  return existing;
}

export async function storageGatewayRequest({
  method,
  path,
  ref,
  body,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
} = {}) {
  const session = await ensureStorageSession({ endpoint, fetchImpl, storage });
  const payload = await postGateway({
    endpoint,
    fetchImpl,
    headers: { "X-Masterskaya-Session": session.token },
    body: { action: "github", method, path, ...(ref ? { ref } : {}), ...(body !== undefined ? { body } : {}) },
  });
  return payload;
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
  node.textContent = ok
    ? "GitHub App и Yandex-хранилище готовы"
    : `Проверка хранилища: ${code}`;
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
    if (!safeGet(storage, LEGACY_TOKEN_KEY) && !readStoredStorageSession(storage)) return;
    const checkedAt = Date.now();
    try {
      await verifyStorageGatewayRead({ ...options, storage });
      const result = { ok: true, checkedAt, endpoint: options.endpoint || DEFAULT_ENDPOINT };
      safeSet(storage, PROBE_RESULT_KEY, JSON.stringify(result));
      showNotice(result);
      console.info("[STORAGE GATEWAY] GitHub App read verified");
    } catch (error) {
      const code = String(error?.code || error?.message || "STORAGE_PROBE_FAILED");
      const result = { ok: false, checkedAt, endpoint: options.endpoint || DEFAULT_ENDPOINT, code };
      safeSet(storage, PROBE_RESULT_KEY, JSON.stringify(result));
      showNotice(result);
      console.warn("[STORAGE GATEWAY] Probe failed:", code);
    }
  }, 1_800);
}
