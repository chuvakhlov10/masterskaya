const DIAGNOSTICS_KEY = "masterskaya_diagnostics_v1";
const SESSION_KEY = "masterskaya_storage_session_v1";
const DEVICE_NAME_KEY = "masterskaya_device_name_v1";
const PENDING_WRITES_KEY = "pending_writes";
const STOCK_OUTBOX_KEY = "stock_ops_outbox_v1";
const LAST_SYNC_KEY = "last_successful_sync_v1";
const SELF_CHECK_OPERATIONS = new Set(["GET status.json"]);

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

function normalizeMetrics(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    lastStorageSuccessAt: positiveTimestamp(source.lastStorageSuccessAt),
    lastStorageErrorAt: positiveTimestamp(source.lastStorageErrorAt),
    lastStorageErrorCode: typeof source.lastStorageErrorCode === "string" ? source.lastStorageErrorCode.slice(0, 120) : "",
    lastStorageOperation: typeof source.lastStorageOperation === "string" ? source.lastStorageOperation.slice(0, 160) : "",
    lastStorageRetries: Number.isInteger(Number(source.lastStorageRetries)) ? Math.max(0, Number(source.lastStorageRetries)) : 0,
    totalStorageRetries: Number.isInteger(Number(source.totalStorageRetries)) ? Math.max(0, Number(source.totalStorageRetries)) : 0,
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
    lastStorageOperation: normalizedOperation,
    lastStorageRetries: retryCount,
    totalStorageRetries: previous.totalStorageRetries + retryCount,
  };
  if (ok) {
    next.lastStorageSuccessAt = now;
  } else {
    next.lastStorageErrorAt = now;
    next.lastStorageErrorCode = String(code || "STORAGE_REQUEST_FAILED").slice(0, 120);
  }
  safeSet(storage, DIAGNOSTICS_KEY, JSON.stringify(next));
  return next;
}

export function recordSessionRenewal({ now = Date.now(), storage = globalThis.localStorage } = {}) {
  const next = { ...readDiagnosticMetrics(storage), lastSessionRenewedAt: now };
  safeSet(storage, DIAGNOSTICS_KEY, JSON.stringify(next));
  return next;
}

export function readQueueBreakdown(storage = globalThis.localStorage) {
  const dataOperations = safeArrayLength(storage, PENDING_WRITES_KEY);
  const stockOperations = safeArrayLength(storage, STOCK_OUTBOX_KEY);
  return {
    dataOperations,
    stockOperations,
    totalOperations: dataOperations + stockOperations,
  };
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
    `Последний успешный запрос хранилища: ${reportDate(data.storage?.lastStorageSuccessAt)}`,
    `Последняя ошибка хранилища: ${data.storage?.lastStorageErrorCode || "нет"}`,
    `Время последней ошибки: ${reportDate(data.storage?.lastStorageErrorAt)}`,
    `Повторов в последнем запросе: ${data.storage?.lastStorageRetries ?? 0}`,
    `Повторов всего на устройстве: ${data.storage?.totalStorageRetries ?? 0}`,
    `Последнее продление сессии: ${reportDate(data.storage?.lastSessionRenewedAt)}`,
    `Storage Gateway: ${data.servers?.storage?.ok ? "работает" : "ошибка"} · ${data.servers?.storage?.version || "нет версии"} · протокол ${data.servers?.storage?.protocolVersion ?? "—"}`,
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
