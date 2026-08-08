import { countQuarantinedStockOps } from "./stock-outbox-quarantine.js";

const DIAGNOSTICS_KEY = "masterskaya_diagnostics_v1";
const SESSION_KEY = "masterskaya_storage_session_v1";
const DEVICE_NAME_KEY = "masterskaya_device_name_v1";
const PENDING_WRITES_KEY = "pending_writes";
const STOCK_OUTBOX_KEY = "stock_ops_outbox_v1";
const LAST_SYNC_KEY = "last_successful_sync_v1";
const SELF_CHECK_OPERATIONS = new Set(["GET status.json"]);
const CONFLICT_ERROR_CODES = new Set(["GATEWAY_HTTP_409", "GATEWAY_HTTP_422"]);
export const DEVICE_DIAGNOSTICS_CHANGED_EVENT = "masterskaya:device-diagnostics-changed";

function safeGet(storage, key) {
  try { return storage?.getItem?.(key) || ""; }
  catch { return ""; }
}

function safeSet(storage, key, value) {
  try { storage?.setItem?.(key, String(value)); }
  catch {}
}

function safeJson(value, fallback) {
  try { return JSON.parse(String(value || "")); }
  catch { return fallback; }
}

function safeArrayLength(storage, key) {
  const value = safeJson(safeGet(storage, key), []);
  return Array.isArray(value) ? value.length : 0;
}

function positiveTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function safeText(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function operationMethod(operation) {
  return String(operation || "").trim().split(/\s+/, 1)[0].toUpperCase();
}

function isWriteOperation(operation) {
  return ["PUT", "POST", "PATCH", "DELETE"].includes(operationMethod(operation));
}

function successRecoversFailure(successOperation, failureOperation) {
  const successMethod = operationMethod(successOperation);
  const failureMethod = operationMethod(failureOperation);
  if (!successMethod) return false;
  if (isWriteOperation(failureOperation)) return isWriteOperation(successOperation);
  return !failureMethod || successMethod === failureMethod || isWriteOperation(successOperation);
}

function normalizeMetrics(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const lastStorageSuccessAt = positiveTimestamp(source.lastStorageSuccessAt);
  const lastStorageErrorAt = positiveTimestamp(source.lastStorageErrorAt);
  const legacyOperation = safeText(source.lastStorageOperation, 160);
  const schemaVersion = nonNegativeInteger(source.schemaVersion);
  const legacyErrorIsNewer = !!lastStorageErrorAt && (!lastStorageSuccessAt || lastStorageErrorAt > lastStorageSuccessAt);
  const lastStorageErrorCode = safeText(source.lastStorageErrorCode, 120);
  const explicitConflictState = ["pending", "resolved", "failed", "historical"].includes(source.lastStorageConflictState)
    ? source.lastStorageConflictState
    : "";
  const legacyConflictState = schemaVersion < 2 && CONFLICT_ERROR_CODES.has(lastStorageErrorCode)
    ? "historical"
    : "";
  return {
    schemaVersion: 2,
    lastStorageSuccessAt,
    lastStorageSuccessOperation: safeText(source.lastStorageSuccessOperation, 160)
      || (schemaVersion < 2 && lastStorageSuccessAt && !legacyErrorIsNewer ? legacyOperation : ""),
    lastStorageErrorAt,
    lastStorageErrorCode,
    lastStorageErrorOperation: safeText(source.lastStorageErrorOperation, 160)
      || (schemaVersion < 2 && legacyErrorIsNewer ? legacyOperation : ""),
    activeStorageErrorCode: safeText(source.activeStorageErrorCode, 120)
      || (schemaVersion < 2 && legacyErrorIsNewer && !CONFLICT_ERROR_CODES.has(lastStorageErrorCode) ? lastStorageErrorCode : ""),
    activeStorageErrorOperation: safeText(source.activeStorageErrorOperation, 160)
      || (schemaVersion < 2 && legacyErrorIsNewer && !CONFLICT_ERROR_CODES.has(lastStorageErrorCode) ? legacyOperation : ""),
    consecutiveStorageFailures: schemaVersion >= 2
      ? nonNegativeInteger(source.consecutiveStorageFailures)
      : (legacyErrorIsNewer && !CONFLICT_ERROR_CODES.has(lastStorageErrorCode) ? 1 : 0),
    lastStorageOperation: legacyOperation,
    lastStorageRetries: nonNegativeInteger(source.lastStorageRetries),
    totalStorageRetries: nonNegativeInteger(source.totalStorageRetries),
    lastStorageConflictState: explicitConflictState || legacyConflictState,
    lastStorageConflictAt: positiveTimestamp(source.lastStorageConflictAt)
      || (legacyConflictState ? lastStorageErrorAt : null),
    lastStorageConflictOperation: safeText(source.lastStorageConflictOperation, 160),
    lastStorageConflictCode: safeText(source.lastStorageConflictCode, 120)
      || (legacyConflictState ? lastStorageErrorCode : ""),
    lastStorageConflictAttempts: nonNegativeInteger(source.lastStorageConflictAttempts),
    totalResolvedStorageConflicts: nonNegativeInteger(source.totalResolvedStorageConflicts),
    lastSessionRenewedAt: positiveTimestamp(source.lastSessionRenewedAt),
  };
}

export function readDiagnosticMetrics(storage = globalThis.localStorage) {
  return normalizeMetrics(safeJson(safeGet(storage, DIAGNOSTICS_KEY), {}));
}

export function recordStorageRequestResult({
  ok,
  code = "",
  operation = "",
  retries = 0,
  now = Date.now(),
  storage = globalThis.localStorage,
} = {}) {
  const previous = readDiagnosticMetrics(storage);
  const normalizedOperation = String(operation || "").slice(0, 160);
  if (SELF_CHECK_OPERATIONS.has(normalizedOperation)) return previous;

  const retryCount = Number.isInteger(Number(retries)) ? Math.max(0, Number(retries)) : 0;
  const next = {
    ...previous,
    schemaVersion: 2,
    lastStorageOperation: normalizedOperation,
    lastStorageRetries: retryCount,
    totalStorageRetries: previous.totalStorageRetries + retryCount,
  };
  if (ok) {
    next.lastStorageSuccessAt = now;
    next.lastStorageSuccessOperation = normalizedOperation;
    if (previous.activeStorageErrorCode && successRecoversFailure(normalizedOperation, previous.activeStorageErrorOperation)) {
      next.activeStorageErrorCode = "";
      next.activeStorageErrorOperation = "";
      next.consecutiveStorageFailures = 0;
    }
  } else {
    next.lastStorageErrorAt = now;
    next.lastStorageErrorCode = String(code || "STORAGE_REQUEST_FAILED").slice(0, 120);
    next.lastStorageErrorOperation = normalizedOperation;
    if (CONFLICT_ERROR_CODES.has(next.lastStorageErrorCode)) {
      next.lastStorageConflictState = "pending";
      next.lastStorageConflictAt = now;
      next.lastStorageConflictOperation = normalizedOperation;
      next.lastStorageConflictCode = next.lastStorageErrorCode;
      next.lastStorageConflictAttempts = 1;
    } else {
      next.activeStorageErrorCode = next.lastStorageErrorCode;
      next.activeStorageErrorOperation = normalizedOperation;
      next.consecutiveStorageFailures = previous.consecutiveStorageFailures + 1;
    }
  }
  safeSet(storage, DIAGNOSTICS_KEY, JSON.stringify(next));
  return next;
}

export function recordStorageConflictResolved({
  operation = "",
  attempts = 1,
  now = Date.now(),
  storage = globalThis.localStorage,
} = {}) {
  const previous = readDiagnosticMetrics(storage);
  const next = {
    ...previous,
    schemaVersion: 2,
    lastStorageConflictState: "resolved",
    lastStorageConflictAt: now,
    lastStorageConflictOperation: String(operation || previous.lastStorageConflictOperation || "").slice(0, 160),
    lastStorageConflictCode: previous.lastStorageConflictCode || "GATEWAY_HTTP_409",
    lastStorageConflictAttempts: Math.max(1, nonNegativeInteger(attempts)),
    totalResolvedStorageConflicts: previous.totalResolvedStorageConflicts + 1,
  };
  safeSet(storage, DIAGNOSTICS_KEY, JSON.stringify(next));
  return next;
}

export function recordStorageConflictFailed({
  operation = "",
  code = "GATEWAY_HTTP_409",
  activeCode = code,
  attempts = 1,
  now = Date.now(),
  storage = globalThis.localStorage,
} = {}) {
  const previous = readDiagnosticMetrics(storage);
  const normalizedConflictCode = String(code || "GATEWAY_HTTP_409").slice(0, 120);
  const normalizedActiveCode = String(activeCode || normalizedConflictCode).slice(0, 120);
  const normalizedOperation = String(operation || previous.lastStorageConflictOperation || "").slice(0, 160);
  const alreadyRecorded = previous.activeStorageErrorCode === normalizedActiveCode
    && previous.activeStorageErrorOperation === normalizedOperation;
  const next = {
    ...previous,
    schemaVersion: 2,
    lastStorageConflictState: "failed",
    lastStorageConflictAt: now,
    lastStorageConflictOperation: normalizedOperation,
    lastStorageConflictCode: normalizedConflictCode,
    lastStorageConflictAttempts: Math.max(1, nonNegativeInteger(attempts)),
    lastStorageErrorAt: alreadyRecorded ? previous.lastStorageErrorAt : now,
    lastStorageErrorCode: normalizedActiveCode,
    lastStorageErrorOperation: normalizedOperation,
    activeStorageErrorCode: normalizedActiveCode,
    activeStorageErrorOperation: normalizedOperation,
    consecutiveStorageFailures: alreadyRecorded
      ? previous.consecutiveStorageFailures
      : previous.consecutiveStorageFailures + 1,
  };
  safeSet(storage, DIAGNOSTICS_KEY, JSON.stringify(next));
  return next;
}

export function deriveStorageRequestState(metrics) {
  const data = normalizeMetrics(metrics);
  if (data.activeStorageErrorCode || data.consecutiveStorageFailures > 0 || data.lastStorageConflictState === "failed") {
    return { kind: "error", label: "Ошибка требует внимания" };
  }
  if (data.lastStorageConflictState === "pending") {
    return { kind: "warning", label: "Устраняется конфликт" };
  }
  if (data.lastStorageConflictState === "resolved") {
    return { kind: "resolved", label: "Конфликт автоматически разрешён" };
  }
  if (data.lastStorageErrorCode || data.lastStorageConflictState === "historical") {
    return { kind: "history", label: "Работает · есть история" };
  }
  return { kind: "ok", label: "Работает без ошибок" };
}

export function recordSessionRenewal({ now = Date.now(), storage = globalThis.localStorage } = {}) {
  const next = { ...readDiagnosticMetrics(storage), lastSessionRenewedAt: now };
  safeSet(storage, DIAGNOSTICS_KEY, JSON.stringify(next));
  return next;
}

export function readQueueBreakdown(storage = globalThis.localStorage) {
  const dataOperations = safeArrayLength(storage, PENDING_WRITES_KEY);
  const stockOperations = safeArrayLength(storage, STOCK_OUTBOX_KEY);
  const quarantinedStockOperations = countQuarantinedStockOps(storage);
  return {
    dataOperations,
    stockOperations,
    quarantinedStockOperations,
    totalOperations: dataOperations + stockOperations,
  };
}

export function notifyDeviceDiagnosticsChanged(eventTarget = globalThis) {
  try {
    if (typeof eventTarget?.dispatchEvent !== "function") return;
    const EventCtor = eventTarget.CustomEvent || globalThis.CustomEvent;
    if (typeof EventCtor === "function") {
      eventTarget.dispatchEvent(new EventCtor(DEVICE_DIAGNOSTICS_CHANGED_EVENT));
      return;
    }
    eventTarget.dispatchEvent({ type: DEVICE_DIAGNOSTICS_CHANGED_EVENT });
  } catch {}
}

function readSession(storage) {
  const parsed = safeJson(safeGet(storage, SESSION_KEY), null);
  if (!parsed || typeof parsed !== "object") return null;
  const expiresAt = positiveTimestamp(parsed.expiresAt);
  const clientId = typeof parsed.clientId === "string" ? parsed.clientId : "";
  return expiresAt && clientId ? { expiresAt, clientId } : null;
}

function findVisibleSyncLabel(documentObj) {
  try {
    const nodes = documentObj?.querySelectorAll?.("span") || [];
    for (const node of nodes) {
      const text = String(node?.textContent || "").trim();
      if (/^(Сохранено(?: · Live)?|Проверка\.\.\.|Обновление\.\.\.|Офлайн|Ошибка|Отправляется)/.test(text)) {
        return text.slice(0, 120);
      }
    }
  } catch {}
  return "";
}

async function readPwaState({ navigatorObj, cachesObj }) {
  const serviceWorker = navigatorObj?.serviceWorker;
  let registration = null;
  try { registration = await serviceWorker?.getRegistration?.(); }
  catch {}

  let cacheNames = [];
  try {
    const names = await cachesObj?.keys?.();
    if (Array.isArray(names)) cacheNames = names.filter(name => typeof name === "string").slice(0, 20);
  } catch {}

  const worker = registration?.active || registration?.waiting || registration?.installing || null;
  return {
    supported: !!serviceWorker,
    controlled: !!serviceWorker?.controller,
    workerState: worker?.state || "нет данных",
    updateWaiting: !!registration?.waiting,
    cacheNames,
  };
}

function maskClientId(value) {
  const text = String(value || "");
  if (!text) return "нет данных";
  if (text.length <= 10) return text;
  return `…${text.slice(-8)}`;
}

export async function collectClientDiagnostics({
  storage = globalThis.localStorage,
  navigatorObj = globalThis.navigator,
  documentObj = globalThis.document,
  cachesObj = globalThis.caches,
  now = Date.now(),
  health = null,
  backup = null,
} = {}) {
  const session = readSession(storage);
  const queues = readQueueBreakdown(storage);
  const metrics = readDiagnosticMetrics(storage);
  const online = navigatorObj?.onLine !== false;
  const visibleSyncLabel = findVisibleSyncLabel(documentObj);
  const pwa = await readPwaState({ navigatorObj, cachesObj });
  const lastSyncAt = positiveTimestamp(safeGet(storage, LAST_SYNC_KEY));
  const deviceName = String(safeGet(storage, DEVICE_NAME_KEY)).trim() || "Устройство";

  return {
    collectedAt: now,
    online,
    device: {
      name: deviceName.slice(0, 60),
      clientIdMasked: maskClientId(session?.clientId || health?.session?.clientId),
      sessionExpiresAt: session?.expiresAt || health?.session?.expiresAt || null,
    },
    sync: {
      label: visibleSyncLabel || (online ? "Нет данных" : "Офлайн"),
      lastSuccessfulAt: lastSyncAt,
      queues,
    },
    storage: metrics,
    pwa,
    backup: backup || null,
    servers: health ? {
      storage: {
        ok: health.storage?.ok === true,
        version: health.storage?.version || null,
        protocolVersion: health.storage?.protocolVersion ?? null,
        storageProtocolVersion: health.storage?.storageProtocolVersion ?? null,
        minimumStorageProtocol: health.storage?.minimumStorageProtocol ?? null,
        requiredStockEpoch: health.storage?.requiredStockEpoch ?? null,
      },
      ably: {
        ok: health.ably?.ok === true,
        version: health.ably?.version || null,
        protocolVersion: health.ably?.protocolVersion ?? null,
      },
    } : null,
  };
}

function reportDate(value) {
  const timestamp = positiveTimestamp(value);
  return timestamp ? new Date(timestamp).toISOString() : "нет данных";
}

function yesNo(value) {
  return value ? "да" : "нет";
}

export function buildDiagnosticReport(snapshot, appVersion = "unknown") {
  const data = snapshot || {};
  const backup = data.backup || {};
  const lines = [
    "Мастерская — диагностика",
    `Приложение: ${appVersion}`,
    `Сформировано: ${reportDate(data.collectedAt)}`,
    `Интернет: ${data.online ? "онлайн" : "офлайн"}`,
    `Устройство: ${data.device?.name || "нет данных"}`,
    `ID устройства: ${data.device?.clientIdMasked || "нет данных"}`,
    `Сессия до: ${reportDate(data.device?.sessionExpiresAt)}`,
    `Статус синхронизации: ${data.sync?.label || "нет данных"}`,
    `Последняя успешная синхронизация: ${reportDate(data.sync?.lastSuccessfulAt)}`,
    `Ожидает отправки — данные: ${data.sync?.queues?.dataOperations ?? 0}`,
    `Ожидает отправки — склад: ${data.sync?.queues?.stockOperations ?? 0}`,
    `Ожидает отправки — всего: ${data.sync?.queues?.totalOperations ?? 0}`,
    `Безопасный карантин — склад: ${data.sync?.queues?.quarantinedStockOperations ?? 0}`,
    `Состояние запросов к хранилищу: ${deriveStorageRequestState(data.storage).label}`,
    `Последний успешный запрос хранилища: ${reportDate(data.storage?.lastStorageSuccessAt)}`,
    `Операция последнего успешного запроса: ${data.storage?.lastStorageSuccessOperation || "нет данных"}`,
    `Активная ошибка хранилища: ${data.storage?.activeStorageErrorCode || "нет"}`,
    `Последняя ошибка в истории: ${data.storage?.lastStorageErrorCode || "нет"}`,
    `Операция последней ошибки: ${data.storage?.lastStorageErrorOperation || "нет данных"}`,
    `Время последней ошибки: ${reportDate(data.storage?.lastStorageErrorAt)}`,
    `Последовательных окончательных ошибок: ${data.storage?.consecutiveStorageFailures ?? 0}`,
    `Сетевых автоповторов в последнем запросе: ${data.storage?.lastStorageRetries ?? 0}`,
    `Сетевых автоповторов за всё время: ${data.storage?.totalStorageRetries ?? 0}`,
    `Последний конфликт записи: ${data.storage?.lastStorageConflictState || "нет"}`,
    `Операция последнего конфликта: ${data.storage?.lastStorageConflictOperation || "нет данных"}`,
    `Время последнего конфликта: ${reportDate(data.storage?.lastStorageConflictAt)}`,
    `Разрешённых конфликтов за всё время: ${data.storage?.totalResolvedStorageConflicts ?? 0}`,
    `Последнее продление сессии: ${reportDate(data.storage?.lastSessionRenewedAt)}`,
    `Storage Gateway: ${data.servers?.storage?.ok ? "работает" : "ошибка"} · ${data.servers?.storage?.version || "нет версии"} · протокол ${data.servers?.storage?.protocolVersion ?? "—"}`,
    `Протокол архива склада: клиент 4 · сервер ${data.servers?.storage?.storageProtocolVersion ?? "—"} · минимум ${data.servers?.storage?.minimumStorageProtocol ?? "—"} · эпоха ${data.servers?.storage?.requiredStockEpoch ?? "—"}`,
    `Ably Auth: ${data.servers?.ably?.ok ? "работает" : "ошибка"} · ${data.servers?.ably?.version || "нет версии"} · протокол ${data.servers?.ably?.protocolVersion ?? "—"}`,
    `Service Worker поддерживается: ${yesNo(data.pwa?.supported)}`,
    `Страница управляется Service Worker: ${yesNo(data.pwa?.controlled)}`,
    `Состояние Service Worker: ${data.pwa?.workerState || "нет данных"}`,
    `Ожидает обновления PWA: ${yesNo(data.pwa?.updateWaiting)}`,
    `Кеши приложения: ${(data.pwa?.cacheNames || []).join(", ") || "нет данных"}`,
    `Резервная копия: ${backup.valid ? "валидна" : backup.available ? "требует внимания" : "нет данных"}`,
    `Дата резервной копии: ${backup.backupAt || "нет данных"}`,
    `Записей в резервной копии: ${backup.counts?.records ?? 0}`,
    `Складских операций в резервной копии: ${backup.counts?.stockOps ?? 0}`,
    `Ошибок резервной копии: ${Array.isArray(backup.errors) ? backup.errors.length : 0}`,
    `Предупреждений резервной копии: ${Array.isArray(backup.warnings) ? backup.warnings.length : 0}`,
  ];
  return lines.join("\n");
}
