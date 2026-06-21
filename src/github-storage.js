// GitHub Storage — заменяет Supabase для работы без VPN в России
// Использует GitHub API + приватный репо для хранения данных

const OWNER = "chuvakhlov10";
const REPO = "masterskaya-data";
const TOKEN_KEY = "github_token_v1";
const DATA_PREFIX = "data/";
const PHOTO_PREFIX = "photos/";

function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch { return ""; }
}
export function setToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch {}
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
}
export function hasToken() {
  return !!getToken();
}

// ── Кэш SHA для каждого файла (чтобы не делать лишних запросов) ──
const shaCache = {};
// ── Очередь записей, чтобы избежать параллельных PUT на один файл ──
const writeQueue = {};

// ── Выполнить операцию последовательно для одного ключа ──
async function withWriteQueue(key, fn) {
  // Если для этого ключа уже идёт запись — ждём её окончания
  while (writeQueue[key]) {
    await writeQueue[key];
  }
  let resolve;
  writeQueue[key] = new Promise(r => { resolve = r; });
  try {
    return await fn();
  } finally {
    delete writeQueue[key];
    resolve();
  }
}

// ── GitHub API helpers ──
// Кодируем путь по сегментам: / не трогаем, остальные спецсимволы кодируем
function encodePath(path){
  return path.split("/").map(seg => encodeURIComponent(seg)).join("/");
}

// Имя файла для ключа: заменяем двоеточия на дефисы (':' не работает в путях GitHub)
function keyToFileName(key){
  return key.replace(/:/g, "-");
}

async function ghRequest(method, path, body) {
  const token = getToken();
  if (!token) throw new Error("NO_TOKEN");
  // path уже содержит data/ — не кодируем его целиком, а по сегментам
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodePath(path)}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      errMsg = err.message || errMsg;
    } catch {}
    const e = new Error(errMsg);
    e.status = res.status;
    throw e;
  }
  if (res.status === 204) return null;
  return res.json();
}

// Кодирование/декодирование base64 для GitHub API
function encodeB64(text) {
  // Для текста (JSON) — кодируем в UTF-8, потом в base64
  return btoa(unescape(encodeURIComponent(text)));
}
function decodeB64(b64) {
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return atob(b64);
  }
}

// ── dbGet: прочитать JSON из файла в репо ──
export async function dbGet(key) {
  try {
    const path = `${DATA_PREFIX}${keyToFileName(key)}.json`;
    const data = await ghRequest("GET", path);
    if (!data) return null;
    // Сохраняем SHA для последующих обновлений
    shaCache[key] = data.sha;
    // Декодируем содержимое
    const text = decodeB64(data.content);
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (e) {
    if (e.status === 404) return null; // файл не найден — норм
    console.warn(`[dbGet] "${key}":`, e.message);
    return null;
  }
}

// ── dbSet: записать JSON в файл (с SHA для обновления) ──
export async function dbSet(key, value) {
  return withWriteQueue(key, async () => {
    try {
      const path = `${DATA_PREFIX}${keyToFileName(key)}.json`;
      const content = JSON.stringify(value);
      const body = {
        message: `update ${key}`,
        content: encodeB64(content),
      };
      // Если есть SHA — добавляем (update), если нет — create
      if (shaCache[key]) {
        body.sha = shaCache[key];
      } else {
        // Попробуем получить текущий SHA
        try {
          const existing = await ghRequest("GET", path);
          if (existing && existing.sha) {
            shaCache[key] = existing.sha;
            body.sha = existing.sha;
          }
        } catch (e) {
          if (e.status !== 404) console.warn(`[dbSet] get SHA for "${key}":`, e.message);
        }
      }
      const result = await ghRequest("PUT", path, body);
      if (result && result.content && result.content.sha) {
        shaCache[key] = result.content.sha;
      }
      return { ok: true };
    } catch (e) {
      if (e.status === 409 || e.status === 422) {
        // Conflict — SHA устарел. Сбрасываем кэш и пробуем ещё раз (1 раз)
        delete shaCache[key];
        console.warn(`[dbSet] conflict on "${key}", retrying...`);
        try {
          const path = `${DATA_PREFIX}${keyToFileName(key)}.json`;
          const existing = await ghRequest("GET", path);
          const body = {
            message: `update ${key} (retry)`,
            content: encodeB64(JSON.stringify(value)),
          };
          if (existing && existing.sha) body.sha = existing.sha;
          const result = await ghRequest("PUT", path, body);
          if (result && result.content && result.content.sha) {
            shaCache[key] = result.content.sha;
          }
          return { ok: true };
        } catch (e2) {
          console.error(`[dbSet] retry failed for "${key}":`, e2.message);
          return { ok: false, error: e2.message };
        }
      }
      console.error(`[dbSet] "${key}":`, e.message);
      return { ok: false, error: e.message };
    }
  });
}

// ── dbDelete: удалить файл (для фото и т.п.) ──
export async function dbDelete(key) {
  try {
    const path = `${DATA_PREFIX}${keyToFileName(key)}.json`;
    // Сначала получить SHA
    let sha = shaCache[key];
    if (!sha) {
      const existing = await ghRequest("GET", path);
      sha = existing?.sha;
    }
    if (!sha) return { ok: true }; // уже удалён
    await ghRequest("DELETE", path, { message: `delete ${key}`, sha });
    delete shaCache[key];
    return { ok: true };
  } catch (e) {
    if (e.status === 404) return { ok: true };
    console.warn(`[dbDelete] "${key}":`, e.message);
    return { ok: false, error: e.message };
  }
}

// ── Фото: хранятся как base64 в отдельных файлах ──
// ВАЖНО: не кодируем marker здесь — encodePath в ghRequest сделает это сам.
// Иначе получится двойное кодирование (% → %25).
export async function photoGet(marker) {
  try {
    const path = `${PHOTO_PREFIX}${marker}.txt`;
    const data = await ghRequest("GET", path);
    if (!data) return null;
    return decodeB64(data.content);
  } catch (e) {
    if (e.status === 404) return null;
    console.warn(`[photoGet] "${marker}":`, e.message);
    return null;
  }
}

export async function photoSet(marker, base64data) {
  try {
    const path = `${PHOTO_PREFIX}${marker}.txt`;
    const body = {
      message: `photo: ${marker}`,
      content: encodeB64(base64data),
    };
    // Если уже есть — получить SHA
    try {
      const existing = await ghRequest("GET", path);
      if (existing && existing.sha) body.sha = existing.sha;
    } catch (e) {
      if (e.status !== 404) console.warn(`[photoSet] get SHA:`, e.message);
    }
    const result = await ghRequest("PUT", path, body);
    return { ok: true };
  } catch (e) {
    console.error(`[photoSet] "${marker}":`, e.message);
    return { ok: false, error: e.message };
  }
}

export async function photoDelete(marker) {
  try {
    const path = `${PHOTO_PREFIX}${marker}.txt`;
    const existing = await ghRequest("GET", path);
    if (!existing) return { ok: true };
    await ghRequest("DELETE", path, { message: `delete photo: ${marker}`, sha: existing.sha });
    return { ok: true };
  } catch (e) {
    if (e.status === 404) return { ok: true };
    return { ok: false, error: e.message };
  }
}

// ── Проверка токена: пробуем получить содержимое репо ──
export async function verifyToken(token) {
  try {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: err.message || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
