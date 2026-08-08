import {
  STORAGE_GATEWAY_ENDPOINT,
  getOrCreateStorageDeviceId,
  readStoredStorageSession,
  clearStoredStorageSession,
} from "./storage-gateway.js";

const SESSION_KEY = "masterskaya_storage_session_v1";
const DEVICE_NAME_KEY = "masterskaya_device_name_v1";
const REQUEST_TIMEOUT_MS = 20_000;
// Recovery performs several sequential GitHub reads/writes inside one function
// invocation. The browser must wait longer than the Cloud Function's dedicated
// 60-second execution timeout so it can receive either the completed response or
// the real server-side error instead of aborting the request first.
export const RECOVERY_REQUEST_TIMEOUT_MS = 75_000;

function makeError(code, cause) {
  const error = new Error(String(code || "DEVICE_REQUEST_FAILED"));
  error.code = error.message;
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

export function normalizePairingCode(value) {
  const raw = String(value || "").toUpperCase().replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ2-9]/g, "").slice(0, 12);
  return [raw.slice(0, 4), raw.slice(4, 8), raw.slice(8, 12)].filter(Boolean).join("-");
}

export function normalizeRecoveryCode(value) {
  const raw = String(value || "").toUpperCase().replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ2-9]/g, "").slice(0, 24);
  return raw.match(/.{1,4}/g)?.join("-") || "";
}

export function inferDeviceName(userAgent = globalThis.navigator?.userAgent || "") {
  const mobile = /Android|iPhone|iPad|Mobile/i.test(String(userAgent));
  return mobile ? "Телефон" : "Ноутбук";
}

export function readDeviceName(storage = globalThis.localStorage) {
  return String(safeGet(storage, DEVICE_NAME_KEY)).trim() || inferDeviceName();
}

export function saveDeviceName(name, storage = globalThis.localStorage) {
  const normalized = String(name || "").replace(/\s+/g, " ").trim().slice(0, 60) || inferDeviceName();
  safeSet(storage, DEVICE_NAME_KEY, normalized);
  return normalized;
}

export function hasActivePairingSession(storage = globalThis.localStorage, now = Date.now()) {
  const session = readStoredStorageSession(storage);
  return !!(session?.token && session.expiresAt > now);
}

export function acceptDeviceSession(payload, storage = globalThis.localStorage) {
  const session = {
    token: String(payload?.sessionToken || ""),
    expiresAt: Number(payload?.expiresAt),
    clientId: String(payload?.clientId || ""),
  };
  if (session.token.split(".").length !== 3) throw makeError("SESSION_TOKEN_INVALID");
  if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) throw makeError("SESSION_EXPIRY_INVALID");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(session.clientId)) throw makeError("SESSION_CLIENT_ID_INVALID");
  safeSet(storage, SESSION_KEY, JSON.stringify(session));
  return session;
}

async function postGateway({
  body,
  sessionToken = "",
  endpoint = STORAGE_GATEWAY_ENDPOINT,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function") throw makeError("FETCH_UNAVAILABLE");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sessionToken ? { "X-Masterskaya-Session": sessionToken } : {}),
      },
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

  let payload;
  try { payload = await response.json(); }
  catch (cause) { throw makeError("GATEWAY_RESPONSE_INVALID", cause); }
  if (!response.ok) throw makeError(payload?.error || `GATEWAY_HTTP_${response.status}`);
  return payload;
}

async function authorizedAction(action, fields = {}, options = {}) {
  const storage = options.storage || globalThis.localStorage;
  const session = readStoredStorageSession(storage);
  if (!session?.token || session.expiresAt <= Date.now()) {
    clearStoredStorageSession(storage);
    throw makeError("SESSION_REQUIRED");
  }
  return postGateway({
    ...options,
    body: { action, ...fields },
    sessionToken: session.token,
  });
}

export async function redeemPairingCode({ code, deviceName, ...options } = {}) {
  const storage = options.storage || globalThis.localStorage;
  const clientId = getOrCreateStorageDeviceId(storage);
  const normalizedCode = normalizePairingCode(code).replaceAll("-", "");
  if (normalizedCode.length !== 12) throw makeError("PAIRING_CODE_INVALID");
  const name = saveDeviceName(deviceName, storage);
  const payload = await postGateway({
    ...options,
    body: {
      action: "pairing-redeem",
      code: normalizedCode,
      clientId,
      deviceName: name,
    },
  });
  if (payload?.clientId !== clientId) throw makeError("SESSION_CLIENT_ID_MISMATCH");
  return { session: acceptDeviceSession(payload, storage), device: payload.device || null };
}

export async function redeemRecoveryCode({ code, deviceName, ...options } = {}) {
  const storage = options.storage || globalThis.localStorage;
  const clientId = getOrCreateStorageDeviceId(storage);
  const normalizedCode = normalizeRecoveryCode(code).replaceAll("-", "");
  if (normalizedCode.length !== 24) throw makeError("RECOVERY_CODE_INVALID");
  const name = saveDeviceName(deviceName, storage);
  const payload = await postGateway({
    ...options,
    timeoutMs: options.timeoutMs ?? RECOVERY_REQUEST_TIMEOUT_MS,
    body: {
      action: "recovery-redeem",
      code: normalizedCode,
      clientId,
      deviceName: name,
    },
  });
  if (payload?.clientId !== clientId) throw makeError("SESSION_CLIENT_ID_MISMATCH");
  const replacementRecoveryCode = normalizeRecoveryCode(payload?.replacementRecoveryCode);
  if (replacementRecoveryCode.replaceAll("-", "").length !== 24) {
    throw makeError("RECOVERY_RESPONSE_INVALID");
  }
  return {
    pendingSession: payload,
    device: payload.device || null,
    replacementRecoveryCode,
  };
}

export async function listDevices(options = {}) {
  const storage = options.storage || globalThis.localStorage;
  const deviceName = readDeviceName(storage);
  const payload = await authorizedAction("devices", { deviceName }, options);
  return Array.isArray(payload?.devices) ? payload.devices : [];
}

export async function reportDeviceDiagnostics({ appVersion, queues } = {}, options = {}) {
  const storage = options.storage || globalThis.localStorage;
  const source = queues && typeof queues === "object" ? queues : {};
  const dataOperations = Math.max(0, Math.trunc(Number(source.dataOperations) || 0));
  const stockOperations = Math.max(0, Math.trunc(Number(source.stockOperations) || 0));
  const diagnostics = {
    appVersion: String(appVersion || "unknown").slice(0, 30),
    queues: {
      dataOperations,
      stockOperations,
      quarantinedStockOperations: Math.max(0, Math.trunc(Number(source.quarantinedStockOperations) || 0)),
      totalOperations: dataOperations + stockOperations,
    },
  };
  const payload = await authorizedAction("device-diagnostics", {
    diagnostics,
    deviceName: readDeviceName(storage),
  }, options);
  return payload?.device || null;
}

export async function createPairingCode(options = {}) {
  const storage = options.storage || globalThis.localStorage;
  const payload = await authorizedAction("pairing-create", { deviceName: readDeviceName(storage) }, options);
  if (typeof payload?.code !== "string" || !Number.isFinite(Number(payload?.expiresAt))) {
    throw makeError("PAIRING_RESPONSE_INVALID");
  }
  return { code: normalizePairingCode(payload.code), expiresAt: Number(payload.expiresAt) };
}

export async function rotateRecoveryCode(options = {}) {
  const storage = options.storage || globalThis.localStorage;
  const payload = await authorizedAction("recovery-rotate", { deviceName: readDeviceName(storage) }, options);
  const recoveryCode = normalizeRecoveryCode(payload?.recoveryCode);
  if (recoveryCode.replaceAll("-", "").length !== 24) throw makeError("RECOVERY_RESPONSE_INVALID");
  return { recoveryCode, generation: Number(payload?.generation) || null };
}

export async function renameDevice(targetClientId, deviceName, options = {}) {
  const storage = options.storage || globalThis.localStorage;
  const name = String(deviceName || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) throw makeError("DEVICE_NAME_REQUIRED");
  const payload = await authorizedAction("device-rename", { targetClientId, deviceName: name }, options);
  const session = readStoredStorageSession(storage);
  if (session?.clientId === targetClientId) saveDeviceName(name, storage);
  return payload?.device || null;
}

export async function revokeDevice(targetClientId, options = {}) {
  const payload = await authorizedAction("device-revoke", { targetClientId }, options);
  return payload?.device || null;
}

export function pairingErrorText(error) {
  const code = String(error?.code || error?.message || "UNKNOWN_ERROR");
  const messages = {
    PAIRING_CODE_INVALID: "Введите полный 12-символьный код",
    PAIRING_CODE_NOT_FOUND: "Код не найден или уже использован",
    PAIRING_CODE_EXPIRED: "Срок действия кода истёк. Создайте новый код",
    RECOVERY_CODE_INVALID: "Введите полный recovery-код",
    RECOVERY_CODE_NOT_FOUND: "Recovery-код недействителен или уже заменён",
    RECOVERY_NOT_CONFIGURED: "Серверное восстановление ещё не настроено",
    RECOVERY_RESPONSE_INVALID: "Сервер вернул некорректный recovery-код",
    SESSION_REQUIRED: "Сессия устройства отсутствует. Перезапустите приложение",
    SESSION_INVALID: "Сессия устройства недействительна",
    SESSION_EXPIRED: "Сессия устройства истекла",
    DEVICE_REVOKED: "Доступ этого устройства отключён",
    DEVICE_NOT_REGISTERED: "Устройство не зарегистрировано",
    GATEWAY_REQUEST_TIMEOUT: "Сервер не ответил вовремя. Повторите попытку",
    GATEWAY_REQUEST_FAILED: "Нет связи с сервером. Проверьте интернет",
    DEVICE_SELF_REVOKE_DENIED: "Нельзя отключить текущее устройство",
  };
  return messages[code] || `Ошибка: ${code}`;
}
