from pathlib import Path

app_path = Path('src/App.jsx')
storage_path = Path('src/github-storage.js')
app = app_path.read_text(encoding='utf-8')
storage = storage_path.read_text(encoding='utf-8')

old = '''async function ghRequest(method, path, body) {
  const token = getToken();
  if (!token) throw makeError("NO_TOKEN");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodePath(path)}`;
'''
new = '''async function ghRequest(method, path, body, options = {}) {
  const token = getToken();
  if (!token) throw makeError("NO_TOKEN");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const query = new URLSearchParams();
  if (options.ref) query.set("ref", String(options.ref));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodePath(path)}${suffix}`;
'''
if old not in storage:
    raise SystemExit('ghRequest anchor not found')
storage = storage.replace(old, new, 1)

anchor = '''export async function dbGet(key) {
  const path = `${DATA_PREFIX}${keyToFileName(key)}.json`;
'''
addition = '''export async function backupStatusGet() {
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

'''
if anchor not in storage:
    raise SystemExit('dbGet anchor not found')
storage = storage.replace(anchor, addition + anchor, 1)
storage_path.write_text(storage, encoding='utf-8')

old = 'import { dbGet, dbSet, hasToken, setToken, clearToken, verifyToken, photoGet, photoSet, photoDelete } from "./github-storage.js";'
new = 'import { dbGet, dbSet, backupStatusGet, hasToken, setToken, clearToken, verifyToken, photoGet, photoSet, photoDelete } from "./github-storage.js";'
if old not in app:
    raise SystemExit('storage import anchor not found')
app = app.replace(old, new, 1)

anchor = '''} from "./sync-core.js";

const ABLY_KEY'''
replacement = '''} from "./sync-core.js";
import { APP_VERSION, deriveSyncView, normalizeBackupStatus } from "./status-core.js";

const ABLY_KEY'''
if anchor not in app:
    raise SystemExit('sync import anchor not found')
app = app.replace(anchor, replacement, 1)

anchor = '''  const [pendingCount, setPendingCount] = useState(() => getQueue().length + getStockOutbox().length);
  const isPollingRef = useRef(false);
'''
replacement = '''  const [pendingCount, setPendingCount] = useState(() => getQueue().length + getStockOutbox().length);
  const [dataStatusOpen, setDataStatusOpen] = useState(false);
  const [backupStatus, setBackupStatus] = useState(null);
  const [backupStatusLoading, setBackupStatusLoading] = useState(false);
  const [backupStatusError, setBackupStatusError] = useState("");
  const [manualSyncBusy, setManualSyncBusy] = useState(false);
  const [lastSyncError, setLastSyncError] = useState("");
  const [lastSyncAt, setLastSyncAt] = useState(() => {
    try { return Number(localStorage.getItem("last_successful_sync_v1")) || null; }
    catch { return null; }
  });
  const isPollingRef = useRef(false);
'''
if anchor not in app:
    raise SystemExit('sync state anchor not found')
app = app.replace(anchor, replacement, 1)

anchor = '''  const flushQueueRef = useRef(null); // ссылка на функцию flushQueue для вызова из useEffect

  // Универсальное сохранение'''
replacement = '''  const flushQueueRef = useRef(null); // ссылка на функцию flushQueue для вызова из useEffect

  useEffect(() => {
    if (!isOnline || pendingCount > 0) return;
    if (syncStatus !== "ws" && syncStatus !== "synced") return;
    const timestamp = Date.now();
    setLastSyncAt(timestamp);
    setLastSyncError("");
    try { localStorage.setItem("last_successful_sync_v1", String(timestamp)); } catch {}
  }, [isOnline, pendingCount, syncStatus]);

  // Универсальное сохранение'''
if anchor not in app:
    raise SystemExit('flush ref anchor not found')
app = app.replace(anchor, replacement, 1)

old = '''    } catch (error) {
      syncRetriesRef.current++;
      console.warn('[syncStockOps] Ошибка:', error.message);
'''
new = '''    } catch (error) {
      syncRetriesRef.current++;
      setLastSyncError(error.message || "Ошибка отправки склада");
      console.warn('[syncStockOps] Ошибка:', error.message);
'''
if old not in app:
    raise SystemExit('stock error anchor not found')
app = app.replace(old, new, 1)

old = '''  } catch (error) {
    console.warn('[STOCK REFRESH] Ошибка:', error.message);
    return { ok: false, error: error.message };
'''
new = '''  } catch (error) {
    setLastSyncError(error.message || "Ошибка обновления склада");
    console.warn('[STOCK REFRESH] Ошибка:', error.message);
    return { ok: false, error: error.message };
'''
if old not in app:
    raise SystemExit('stock refresh error anchor not found')
app = app.replace(old, new, 1)

old = '''      } catch(error) {
        console.warn('[POLL] Ошибка:', error.message);
        setSyncStatus(navigator.onLine ? "idle" : "offline");
'''
new = '''      } catch(error) {
        setLastSyncError(error.message || "Ошибка обновления данных");
        console.warn('[POLL] Ошибка:', error.message);
        setSyncStatus(navigator.onLine ? "idle" : "offline");
'''
if old not in app:
    raise SystemExit('poll error anchor not found')
app = app.replace(old, new, 1)

old = '''          } catch (error) {
            console.warn(`[OFFLINE] Ошибка отправки "${item.key}":`, error.message);
          }
'''
new = '''          } catch (error) {
            setLastSyncError(error.message || `Ошибка отправки ${item.key}`);
            console.warn(`[OFFLINE] Ошибка отправки "${item.key}":`, error.message);
          }
'''
if old not in app:
    raise SystemExit('flush error anchor not found')
app = app.replace(old, new, 1)

anchor = '''  // ── Резервная копия всех данных (скачать JSON) ──
  async function downloadBackup(){
'''
addition = '''  async function loadBackupStatus(){
    setBackupStatusLoading(true);
    setBackupStatusError("");
    try {
      const raw = await backupStatusGet();
      const normalized = normalizeBackupStatus(raw);
      setBackupStatus(normalized);
      return normalized;
    } catch(error) {
      const message = error.message || "Не удалось прочитать состояние резервных копий";
      setBackupStatusError(message);
      return null;
    } finally {
      setBackupStatusLoading(false);
    }
  }

  async function runManualSync(retryOnly = false){
    if (manualSyncBusy) return;
    setManualSyncBusy(true);
    setLastSyncError("");
    try {
      if (!navigator.onLine) throw new Error("Нет подключения к интернету");
      await flushQueueRef.current?.();
      if (getStockOutbox().length > 0) await syncStockOpsRef.current?.();
      if (!retryOnly || getQueue().length + getStockOutbox().length === 0) {
        await doPollRef.current?.();
      }
      await loadBackupStatus();
      const remaining = getQueue().length + getStockOutbox().length;
      setPendingCount(remaining);
      if (remaining > 0) throw new Error(`Осталось операций в очереди: ${remaining}`);
      setSyncStatus(wsConnectedRef.current ? "ws" : "synced");
    } catch(error) {
      setLastSyncError(error.message || "Ошибка синхронизации");
      setSyncStatus(navigator.onLine ? "idle" : "offline");
    } finally {
      setManualSyncBusy(false);
    }
  }

  useEffect(() => {
    if (!authed) return;
    loadBackupStatus();
  }, [authed]);

  // ── Резервная копия всех данных (скачать JSON) ──
  async function downloadBackup(){
'''
if anchor not in app:
    raise SystemExit('download backup anchor not found')
app = app.replace(anchor, addition, 1)

anchor = '''  const wsStock = ensureObj(safeStockWS[workshop]);
  const tabs = [
'''
replacement = '''  const wsStock = ensureObj(safeStockWS[workshop]);
  const syncView = deriveSyncView({
    online: isOnline,
    syncStatus,
    pendingCount,
    lastError: lastSyncError,
    busy: manualSyncBusy,
  });
  const syncTone = {
    saved: { bg:C.successDim, color:C.success },
    live: { bg:C.brandDim, color:C.brand },
    sending: { bg:C.smartDim, color:C.smart },
    offline: { bg:C.warnDim, color:C.warn },
    error: { bg:C.dangerDim, color:C.danger },
  }[syncView.kind] || { bg:C.bgSection, color:C.textSub };
  const tabs = [
'''
if anchor not in app:
    raise SystemExit('tabs anchor not found')
app = app.replace(anchor, replacement, 1)

anchor = '''      {editRec&&<EditModal record={editRec.record} id={editRec.id} markers={safeMarkers}
'''
modal = '''      {dataStatusOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.58)",zIndex:1100,display:"flex",alignItems:"center",justifyContent:"center",padding:14}}
          onMouseDown={e=>{if(e.target===e.currentTarget)setDataStatusOpen(false);}}>
          <div style={{background:C.bgCard,border:`1px solid ${C.border}`,width:"100%",maxWidth:480,maxHeight:"90vh",overflowY:"auto",padding:18,boxShadow:"0 12px 40px rgba(0,0,0,.35)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:16}}>
              <div>
                <div style={{fontSize:17,fontWeight:800,color:C.text}}>Состояние данных</div>
                <div style={{fontSize:10,color:C.textDim,marginTop:3}}>Версия приложения {APP_VERSION}</div>
              </div>
              <button onClick={()=>setDataStatusOpen(false)} style={{...s.btn(),padding:"6px 10px"}}>✕</button>
            </div>

            <div style={{...s.card,padding:14,marginBottom:10,borderColor:syncTone.color+"55"}}>
              <div style={{display:"flex",justifyContent:"space-between",gap:12,alignItems:"center"}}>
                <span style={{fontSize:12,color:C.textSub}}>Синхронизация</span>
                <span style={{fontSize:12,fontWeight:800,color:syncTone.color}}>{syncView.label}</span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:12,fontSize:11}}>
                <div style={{background:C.bgSection,padding:9}}><div style={{color:C.textDim}}>В очереди</div><div style={{fontSize:16,fontWeight:800,color:pendingCount?C.warn:C.text}}>{pendingCount}</div></div>
                <div style={{background:C.bgSection,padding:9}}><div style={{color:C.textDim}}>Последняя отправка</div><div style={{fontSize:12,fontWeight:700,color:C.text,marginTop:3}}>{lastSyncAt ? new Date(lastSyncAt).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "Нет данных"}</div></div>
              </div>
              {lastSyncError&&<div style={{fontSize:11,color:C.danger,marginTop:10,lineHeight:1.45}}>Ошибка: {lastSyncError}</div>}
            </div>

            <div style={{...s.card,padding:14,marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,marginBottom:10}}>
                <span style={{fontSize:12,color:C.textSub}}>Проверка и резервная копия</span>
                <span style={{fontSize:11,fontWeight:800,color:backupStatus?.valid?C.success:backupStatusLoading?C.smart:C.danger}}>
                  {backupStatusLoading ? "Проверка..." : backupStatus?.valid ? "Исправно" : "Нет подтверждения"}
                </span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,fontSize:11}}>
                <div style={{background:C.bgSection,padding:9}}><div style={{color:C.textDim}}>Записей</div><div style={{fontSize:16,fontWeight:800}}>{backupStatus?.counts?.records ?? records.length}</div></div>
                <div style={{background:C.bgSection,padding:9}}><div style={{color:C.textDim}}>Операций склада</div><div style={{fontSize:16,fontWeight:800}}>{backupStatus?.counts?.stockOps ?? stockOps.length}</div></div>
              </div>
              <div style={{fontSize:11,color:C.textSub,marginTop:10,lineHeight:1.55}}>
                Последняя копия: {backupStatus?.backupAt ? new Date(backupStatus.backupAt).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}) : "не найдена"}<br/>
                Ежедневная: {backupStatus?.dailyPath || "—"}<br/>
                Ежемесячная: {backupStatus?.monthlyPath || "—"}
              </div>
              {backupStatusError&&<div style={{fontSize:11,color:C.danger,marginTop:8}}>Не удалось прочитать отчёт: {backupStatusError}</div>}
              {(backupStatus?.errors||[]).map((message,index)=><div key={`err-${index}`} style={{fontSize:11,color:C.danger,marginTop:6}}>• {message}</div>)}
              {(backupStatus?.warnings||[]).map((message,index)=><div key={`warn-${index}`} style={{fontSize:11,color:C.warn,marginTop:6}}>• {message}</div>)}
            </div>

            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <button disabled={manualSyncBusy} onClick={()=>runManualSync(false)} style={{...s.btn("accent"),flex:"1 1 190px",padding:"11px",opacity:manualSyncBusy?.6:1}}>
                {manualSyncBusy ? "Обновление..." : "Обновить данные"}
              </button>
              <button disabled={manualSyncBusy||pendingCount===0} onClick={()=>runManualSync(true)} style={{...s.btn(),flex:"1 1 190px",padding:"11px",opacity:(manualSyncBusy||pendingCount===0)?.5:1}}>
                Повторить отправку{pendingCount>0?` (${pendingCount})`:""}
              </button>
            </div>
          </div>
        </div>
      )}
      {editRec&&<EditModal record={editRec.record} id={editRec.id} markers={safeMarkers}
'''
if anchor not in app:
    raise SystemExit('edit modal anchor not found')
app = app.replace(anchor, modal, 1)

start = '''            {/* Индикатор статуса сохранения */}
            {Object.entries(saveStatus).map(([key, status]) => (
'''
end = '''            )}
          </div>
        </div>
        <Tabs tabs={tabs} active={tab} onChange={setTab}/>
'''
start_index = app.find(start)
end_index = app.find(end, start_index)
if start_index < 0 or end_index < 0:
    raise SystemExit('status indicator block not found')
replacement = '''            {/* Единый кликабельный индикатор синхронизации */}
            <button type="button" onClick={()=>{setDataStatusOpen(true);loadBackupStatus();}} title="Открыть состояние данных" style={{
              fontSize:10,padding:"3px 8px",background:syncTone.bg,color:syncTone.color,
              border:`1px solid ${syncTone.color}55`,fontWeight:800,cursor:"pointer",
              display:"inline-flex",alignItems:"center",gap:5,
            }}>
              <span>{syncView.icon}</span><span>{syncView.label}</span>
            </button>
          </div>
        </div>
        <Tabs tabs={tabs} active={tab} onChange={setTab}/>
'''
app = app[:start_index] + replacement + app[end_index + len(end):]

app_path.write_text(app, encoding='utf-8')
print('Applied data status screen patch')
