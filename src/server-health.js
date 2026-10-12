import { gatewayFailover } from "./gateway-failover.js";
import reserveConfig from "./reserve-gateway-config.js";
import { SECURE_ABLY_AUTH_ENDPOINT } from "./ably-session-auth.js";
import {
  STORAGE_GATEWAY_ENDPOINT,
  readStoredStorageSession,
  verifyStorageGatewayRead,
} from "./storage-gateway.js";

const REQUEST_TIMEOUT_MS = 12_000;
export const reserveHealthConfigured = Boolean(reserveConfig.storage && reserveConfig.ably);

function makeError(code, cause) {
  const error = new Error(String(code || "HEALTH_REQUEST_FAILED"));
  error.code = error.message;
  if (cause) error.cause = cause;
  return error;
}

async function postHealth({ endpoint, sessionToken, fetchImpl, timeoutMs }) {
  const payload = await gatewayFailover.send({endpoint,fetchImpl,timeoutMs,errorPrefix:"HEALTH",
    headers:sessionToken ? {"X-Masterskaya-Session":sessionToken} : {},body:{action:"health"}});
  if(payload?.ok !== true) throw makeError(payload?.error || "HEALTH_RESPONSE_INVALID");
  if (typeof payload?.service !== "string" || typeof payload?.version !== "string") {
    throw makeError("HEALTH_RESPONSE_INVALID");
  }
  return {...payload,gatewayRoute:gatewayFailover.lastRoute(endpoint)?.route || "primary"};
}

function failedHealth(service, error) {
  return {
    ok: false,
    service,
    version: null,
    protocolVersion: null,
    buildId: null,
    buildDate: null,
    checks: {},
    error: String(error?.code || error?.message || "HEALTH_REQUEST_FAILED"),
  };
}

export function healthErrorText(code) {
  const messages = {
    HEALTH_REQUEST_TIMEOUT: "Сервер не ответил вовремя",
    HEALTH_REQUEST_FAILED: "Нет связи с сервером",
    HEALTH_RESPONSE_INVALID: "Сервер вернул некорректный ответ",
    SESSION_REQUIRED: "Сессия устройства отсутствует",
    SESSION_INVALID: "Сессия устройства недействительна",
    SESSION_EXPIRED: "Сессия устройства истекла",
    DEVICE_REVOKED: "Доступ устройства отключён",
    DEVICE_NOT_REGISTERED: "Устройство не зарегистрировано",
  };
  return messages[code] || String(code || "Неизвестная ошибка");
}

export async function checkServerHealth({
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch,
  storageEndpoint = STORAGE_GATEWAY_ENDPOINT,
  ablyEndpoint = SECURE_ABLY_AUTH_ENDPOINT,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw makeError("FETCH_UNAVAILABLE");
  const session = readStoredStorageSession(storage);
  const sessionToken = session?.token || "";

  const [storageResult, ablyResult] = await Promise.allSettled([
    postHealth({ endpoint: storageEndpoint, sessionToken, fetchImpl, timeoutMs }),
    postHealth({ endpoint: ablyEndpoint, sessionToken, fetchImpl, timeoutMs }),
  ]);

  return {
    checkedAt: Date.now(),
    session: session ? {
      clientId: session.clientId,
      expiresAt: session.expiresAt,
    } : null,
    storage: storageResult.status === "fulfilled"
      ? storageResult.value
      : failedHealth("masterskaya-storage-gateway", storageResult.reason),
    ably: ablyResult.status === "fulfilled"
      ? ablyResult.value
      : failedHealth("masterskaya-ably-auth", ablyResult.reason),
  };
}

// This explicit diagnostic does not use fallback and does not discard a valid
// primary session if the reserve has a mismatched key or configuration.
export async function checkReserveHealth({
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch,
  storageEndpoint = reserveConfig.storage,
  ablyEndpoint = reserveConfig.ably,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!storageEndpoint || !ablyEndpoint) return { ready: false, error: 'RESERVE_NOT_CONFIGURED' };
  const health = await checkServerHealth({ storage, fetchImpl, storageEndpoint, ablyEndpoint, timeoutMs });
  health.storage.gatewayRoute = 'reserve';
  health.ably.gatewayRoute = 'reserve';
  const authorized = Boolean(health.session && health.storage.ok && health.ably.ok &&
    health.storage.authenticated === true && health.ably.authenticated === true &&
    health.storage.checks.deviceRegistry === 'ok' && health.storage.checks.githubApp === 'ok' &&
    health.ably.checks.deviceRegistry === 'ok');
  if (!authorized) return { ...health, ready: false, readOk: false };
  try {
    await verifyStorageGatewayRead({ endpoint: storageEndpoint, reserveEndpoint: '', storage, fetchImpl, maxAttempts: 1 });
    return { ...health, ready: true, readOk: true };
  } catch (cause) {
    return { ...health, ready: false, readOk: false, error: String(cause?.code || cause?.message || 'GATEWAY_READ_INVALID') };
  }
}
