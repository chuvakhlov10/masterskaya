// Хранилище данных через Yandex Cloud Function и GitHub App.
// GitHub Contents API не является БД, поэтому каждая конкурентная запись
// выполняет read → merge → write с актуальным SHA и повтором при конфликте.

import {
  clearStoredStorageSession,
  readStoredStorageSession,
  storageGatewayRequest,
} from "./storage-gateway.js";

const DATA_PREFIX = "data/";
const PHOTO_PREFIX = "photos/";

export function disconnectStorage() {
  clearStoredStorageSession();
}

export function hasStorageAccess() {
  const session = readStoredStorageSession();
  return !!(session?.token && session.expiresAt > Date.now());
}

const shaCache = Object.create(null);
const writeQueue = Object.create(null);

// Строгая последовательность записей одного файла. Разные файлы могут писаться
// параллельно, но два PUT одного key никогда не стартуют одновременно.
function withWriteQueue(key, fn) {
  const previous = writeQueue[key] || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  writeQueue[key] = current;
  return current.finally(() => {
    if (writeQueue[key] === current) delete writeQueue[key];
  });
}

function assertSafeKey(key) {
  if (typeof key !== "string" || !key.trim()) throw new Error("INVALID_KEY");
  if (key.includes("/") || key.includes("\\") || key.includes("..")) throw new Error("INVALID_KEY");
}

function keyToFileName(key) {
  assertSafeKey(key);
  return key.replace(/:/g, "-");
}

function makeError(message, status, cause) {
  const error = new Error(message);
  if (status !== undefined) error.status = status;
  if (cause) error.cause = cause;
  return error;
}

function normalizeGatewayError(error) {
  const code = String(error?.code || error?.message || "GATEWAY_REQUEST_FAILED");
  const statusMatch = /^GATEWAY_HTTP_(\d{3})$/.exec(code);
  const status = statusMatch ? Number(statusMatch[1]) : error?.status;
  return makeError(code, Number.isInteger(status) ? status : undefined, error);
}

// Все операции используют только подписанную сессию устройства.
async function ghRequest(method, path, body, options = {}) {
  try {
    return await storageGatewayRequest({
      method,
      path,
      body,
      ref: options.ref,
    });
  } catch (error) {
    throw normalizeGatewayError(error);
  }
}

function encodeB64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeB64(base64) {
  const binary = atob(String(base64 || "").replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function parseJsonFile(key, encodedContent) {
  try { return JSON.parse(decodeB64(encodedContent)); }
  catch (cause) { throw makeError(`INVALID_JSON: ${key}`, undefined, cause); }
}

export async function backupStatusGet() {
  try {
    const data = await ghRequest("GET", "status.json", undefined, { ref: "data-backups" });
    if (!data) return null;
    return parseJsonFile("backup-status", data.content);
  } catch (error) {
    if (error.status === 404) return null;
    console.warn("[backupStatusGet]", error.message);
    throw error;
  }
}

export async function dbGet(key) {
  const path = `${DATA_PREFIX}${keyToFileName(key)}.json`;
  try {
    const data = await ghRequest("GET", path);
    if (!data) return null;
    shaCache[key] = data.sha;
    return parseJsonFile(key, data.content);
  } catch (error) {
    if (error.status === 404) return null;
    console.warn(`[dbGet] "${key}":`, error.message);
    throw error;
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelay(attempt) {
  const base = [0, 500, 1_500, 3_000, 5_000, 8_000][attempt] || 8_000;
  return base + Math.random() * 1_000;
}

// Возвращает фактически записанное value. При merge это важно: локальный UI
// должен получить объединённую версию, а не продолжать жить со старым snapshot.
export async function dbSet(key, value, mergeFn) {
  return withWriteQueue(key, async () => {
    const path = `${DATA_PREFIX}${keyToFileName(key)}.json`;
    const maxAttempts = 6;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = retryDelay(attempt - 1);
        console.warn(`[dbSet] conflict on "${key}", retry ${attempt - 1}/${maxAttempts - 1} after ${Math.round(delay)}ms`);
        await wait(delay);
      }

      try {
        let existing = null;
        let finalValue = value;

        // Для merge всегда читаем актуальный файл. Для last-write-wins данных
        // чтение нужно только когда SHA ещё неизвестен или после конфликта.
        if (mergeFn || !shaCache[key] || attempt > 1) {
          try {
            existing = await ghRequest("GET", path);
          } catch (error) {
            if (error.status !== 404) throw error;
          }
        }

        if (mergeFn && existing?.content) {
          const remoteValue = parseJsonFile(key, existing.content);
          // Ошибка merge должна остановить запись. Никогда не откатываемся к
          // локальному snapshot с новым SHA: это снова уничтожило бы remote.
          finalValue = mergeFn(remoteValue, value);
        }

        const requestBody = {
          message: attempt === 1 ? `update ${key}` : `update ${key} (retry ${attempt - 1})`,
          content: encodeB64(JSON.stringify(finalValue)),
        };
        const sha = existing?.sha || (!mergeFn ? shaCache[key] : null);
        if (sha) requestBody.sha = sha;

        const result = await ghRequest("PUT", path, requestBody);
        if (result?.content?.sha) shaCache[key] = result.content.sha;
        return {
          ok: true,
          merged: !!mergeFn,
          value: finalValue,
          sha: result?.content?.sha || null,
        };
      } catch (error) {
        if (error.status === 409 || error.status === 422) {
          delete shaCache[key];
          if (attempt < maxAttempts) continue;
        }
        console.error(`[dbSet] "${key}":`, error.message);
        return { ok: false, error: error.message, status: error.status };
      }
    }

    return { ok: false, error: "MAX_RETRIES_EXCEEDED" };
  });
}

export async function dbDelete(key) {
  return withWriteQueue(key, async () => {
    const path = `${DATA_PREFIX}${keyToFileName(key)}.json`;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        let existing;
        try { existing = await ghRequest("GET", path); }
        catch (error) {
          if (error.status === 404) return { ok: true };
          throw error;
        }
        if (!existing?.sha) return { ok: true };
        await ghRequest("DELETE", path, { message: `delete ${key}`, sha: existing.sha });
        delete shaCache[key];
        return { ok: true };
      } catch (error) {
        if ((error.status === 409 || error.status === 422) && attempt < 4) {
          await wait(300 * attempt + Math.random() * 500);
          continue;
        }
        if (error.status === 404) return { ok: true };
        console.warn(`[dbDelete] "${key}":`, error.message);
        return { ok: false, error: error.message };
      }
    }
    return { ok: false, error: "MAX_RETRIES_EXCEEDED" };
  });
}

// Фото. Имя кодируется как один сегмент, чтобы маркировка с '/' не создавала
// случайные подпапки. Для чтения предусмотрен fallback к старому пути.
function photoPath(marker) {
  return `${PHOTO_PREFIX}${encodeURIComponent(String(marker))}.txt`;
}
function legacyPhotoPath(marker) {
  return `${PHOTO_PREFIX}${String(marker)}.txt`;
}

export async function photoGet(marker) {
  const paths = [photoPath(marker), legacyPhotoPath(marker)];
  let lastError = null;
  for (const path of [...new Set(paths)]) {
    try {
      const data = await ghRequest("GET", path);
      return data ? decodeB64(data.content) : null;
    } catch (error) {
      if (error.status === 404) continue;
      lastError = error;
      break;
    }
  }
  if (lastError) {
    console.warn(`[photoGet] "${marker}":`, lastError.message);
    throw lastError;
  }
  return null;
}

export async function photoSet(marker, base64data) {
  const path = photoPath(marker);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      let existing = null;
      try { existing = await ghRequest("GET", path); }
      catch (error) { if (error.status !== 404) throw error; }
      const requestBody = { message: `photo: ${marker}`, content: encodeB64(base64data) };
      if (existing?.sha) requestBody.sha = existing.sha;
      await ghRequest("PUT", path, requestBody);
      return { ok: true };
    } catch (error) {
      if ((error.status === 409 || error.status === 422) && attempt < 4) {
        await wait(300 * attempt + Math.random() * 700);
        continue;
      }
      console.error(`[photoSet] "${marker}":`, error.message);
      return { ok: false, error: error.message };
    }
  }
  return { ok: false, error: "MAX_RETRIES_EXCEEDED" };
}

export async function photoDelete(marker) {
  const paths = [...new Set([photoPath(marker), legacyPhotoPath(marker)])];
  let deleted = false;
  for (const path of paths) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const existing = await ghRequest("GET", path);
        if (!existing?.sha) break;
        await ghRequest("DELETE", path, { message: `delete photo: ${marker}`, sha: existing.sha });
        deleted = true;
        break;
      } catch (error) {
        if (error.status === 404) break;
        if ((error.status === 409 || error.status === 422) && attempt < 4) {
          await wait(300 * attempt + Math.random() * 700);
          continue;
        }
        console.warn(`[photoDelete] "${marker}":`, error.message);
        return { ok: false, error: error.message };
      }
    }
  }
  return { ok: true, deleted };
}
