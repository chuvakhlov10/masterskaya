import { useState, useEffect, useCallback, useRef, Component } from "react";
import { dbGet, dbSet, hasToken, setToken, clearToken, verifyToken, photoGet, photoSet, photoDelete } from "./github-storage.js";
import Ably from "ably";

const ABLY_KEY = "Z2GSmg.BgNkkg:ns6NnvUHHdkQYt0MyDTaDZqWs4-kEqHPYihb39mmUfk";
const CLIENT_ID = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
const ably = new Ably.Realtime({
  key: ABLY_KEY,
  clientId: CLIENT_ID,
  // Настройки для стабильного соединения
  disconnectedRetryTimeout: 2000,   // переподключение через 2 сек после disconnect
  suspendedRetryTimeout: 5000,      // переподключение через 5 сек после suspend
  realtimeRequestTimeout: 15000,    // таймаут запроса 15 сек
  idlePeriod: 5000,                 // ждём 5 сек перед idle check (увеличиваем активность)
  heartbeatInterval: 5000,          // пинг каждые 5 сек чтобы соединение не падало
});

const DEFAULT_MARKERS = {
  "Автомобильные": ["Замена корпуса","HD39RP","Нарезка лезвия","LD-1P","MIT8AP","MIT8RP (п.ч.)","XT27A"],
  "Английские": ["APK-1","TL-3R","BUL5D","45-2","Аблой","Favour","CI51D","UL050M","China 2008","AB015","BUL-7D","BLT1R","Solex","UL-1","YA4","UL-4","ED3R","Apex-04"],
  "Вертикальные": ["BDN5VP","BAO (26mm)","BAO (34mm)","BAO2DP","BUL-1","AVE-1D","Avers_2x","BDN2п","Apecs (матовый)","CI26 (длинный)","Fuaro2","Guardian (3 паза)"],
  "Дверные": ["ELB11D","GRD1D","ELB15D","GRD4D","GRD2D","ELB12D","GPZ2D","GRD6D","ZT1D","SAM1D","SAM4D"],
  "Домофонные": ["Dallas","MiFare","Техком","H7","Proxy","TM-01","Ultra 41 стр.","Ultralight UL-5","Proxy VIP","MiFare VIP","Proxy карта","iMF+"],
  "Крестовые": ["KRO41 (LIAN E-143)","KALE FAYN (KR001)","KR-1","KR-2","KR-3","KR43 (KRO19)","KR54","KR64 (KR026)"],
  "Прочие услуги": ["Заточка ножей","Заточка топоров","Заточка садового инструмента","Исправление чужой работы","Заточка топора"]
};
const WORKSHOPS = ["SMART","Бегемот"];
const INCOME_PCT = 0.4;          // 40% с ключей
const SHARP_INCOME_PCT = 1.0;    // 100% с заточки
// Маркировки, которые считаются «заточкой» — Илья получает 100%
const SHARPING_MARKERS = new Set(["Заточка ножей","Заточка топоров","Заточка садового инструмента","Заточка топора"]);
// «Услуги» — маркировки, которые не учитываются на складе (не заготовки).
// Они всегда показываются в форме записи, даже если остаток 0.
// В разделах склада (общий/мастерская) — не отображаются.
const SERVICE_MARKERS = new Set([
  "Нарезка лезвия",
  "Замена корпуса",
  // Все маркировки из категории «Прочие услуги» тоже услуги — обрабатываются отдельно по категории
]);
const LOCAL_WS_KEY = "workshop_choice_v2";
const LOCAL_AUTH_KEY = "workshop_auth_v2";
const DEFAULT_PASSWORDS = { "SMART": "smart123", "Бегемот": "begemot123" };

// Хэширование SHA-256 через встроенный WebCrypto
async function sha256(text){
  try {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");
  } catch {
    // фолбэк для http (без https) — простой хэш, не криптостойкий
    let h = 5381;
    for(let i=0;i<text.length;i++){ h = ((h<<5)+h) + text.charCodeAt(i); h |= 0; }
    return "fallback_" + (h>>>0).toString(16);
  }
}

function fmt(n){ return new Intl.NumberFormat("ru-RU").format(Math.round((n||0)*100)/100); }
function todayStr(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function todayFullStr(){
  const d = new Date();
  const days = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"];
  const dayName = days[d.getDay()];
  const time = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  return `${dayName}, ${todayStr()} · ${time}`;
}
function todayTimeStr(){
  const d = new Date();
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}
function dateOf(ts){ const d=new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function monthOf(ts){ const d=new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; }
const MONTH_NAMES = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

// Знак для агрегации: продажа = +1, возврат = -1
function signOf(r){ return r.recordType === "refund" ? -1 : 1; }

// Сколько заготовок списать со склада:
// - refund: 0 (заготовка уже списана при продаже)
// - sale для "Прочие услуги": 0 (это услуги, не заготовки)
// - sale для SERVICE_MARKERS (Нарезка лезвия, Замена корпуса): 0
// - sale для обычных категорий: qty + defect (все изготовленные — годные + брак)
// - sale с qty=0 и defect=0: 0 (пустая запись)
function stockDelta(r){
  if(r.recordType === "refund") return 0;
  if(r.category === "Прочие услуги") return 0;
  if(SERVICE_MARKERS.has(r.marker)) return 0;
  return (r.qty || 0) + (r.defect || 0);
}

// Является ли маркировка услугой (не учитывается на складе)
function isServiceMarker(marker, category){
  if(category === "Прочие услуги") return true;
  if(SERVICE_MARKERS.has(marker)) return true;
  return false;
}

// Расчёт зарплаты Ильи (только для SMART):
// - 40% с ключей (обычные категории)
// - 100% с заточки (маркировки из SHARPING_MARKERS)
// - «Исправление чужой работы» и другие не-заточечные услуги — 40%
function calcEarnings(recs){
  let total = 0;
  let fromKeys = 0;
  let fromSharping = 0;
  for(const r of recs){
    const sign = signOf(r);
    const amt = (r.amount || 0) * sign;
    if(SHARPING_MARKERS.has(r.marker)){
      total += amt * SHARP_INCOME_PCT;
      fromSharping += amt * SHARP_INCOME_PCT;
    } else {
      total += amt * INCOME_PCT;
      fromKeys += amt * INCOME_PCT;
    }
  }
  return { total, fromKeys, fromSharping };
}

// Сортировка категорий по алфавиту (А → Я)
function sortedCategories(markers){
  return Object.keys(markers).sort((a,b)=>a.localeCompare(b,"ru"));
}
function sortedCategoryEntries(markers){
  // Каждую категорию сортируем внутри по алфавиту
  return sortedCategories(markers).map(cat=>{
    const sortedList = [...(markers[cat]||[])].sort((a,b)=>a.localeCompare(b,"ru"));
    return [cat, sortedList];
  });
}

function NumInput({ value, onChange, style, min="0", placeholder="" }) {
  const [local, setLocal] = useState(String(value ?? ""));
  useEffect(() => { setLocal(String(value ?? "")); }, [value]);
  return (
    <input type="text" inputMode="numeric" pattern="[0-9]*" value={local} placeholder={placeholder}
      onChange={e => {
        const v = e.target.value.replace(/[^0-9]/g,"");
        setLocal(v);
        const n = v===""?0:parseInt(v,10);
        if(!isNaN(n) && n>=(+min)) onChange(n);
      }}
      onBlur={() => {
        const n = local===""?0:parseInt(local,10);
        setLocal(isNaN(n)||(+min)>n ? String(+min) : String(n));
        onChange(isNaN(n)||(+min)>n ? +min : n);
      }}
      style={style}
    />
  );
}

// ── Инпут с кнопками + и - ──
// silentSave(v) — вызывается при вводе точного значения в поле (set)
// silentSaveDelta(delta) — вызывается при нажатии +/- (delta, не конфликтует)
// Если silentSaveDelta передан — кнопки +/- используют delta (надёжная синхронизация)
// Если нет — кнопки используют silentSave/set (старое поведение)
function StepperInput({ value, onChange, step = 1, min = 0, style, inputStyle, silentSave = null, silentSaveDelta = null }) {
  const [localVal, setLocalVal] = useState(String(value ?? ""));

  useEffect(() => {
    setLocalVal(String(value ?? ""));
  }, [value]);

  const dec = () => {
    const cur = parseInt(localVal || "0", 10);
    const newVal = Math.max(cur - step, min);
    setLocalVal(String(newVal));
    if (silentSaveDelta && cur > min) {
      // Используем delta (-step), не конфликтует с другими устройствами
      silentSaveDelta(-step);
    } else if (silentSave) {
      silentSave(newVal);
    } else {
      onChange(newVal);
    }
  };
  const inc = () => {
    const cur = parseInt(localVal || "0", 10);
    const newVal = cur + step;
    setLocalVal(String(newVal));
    if (silentSaveDelta) {
      // Используем delta (+step), не конфликтует с другими устройствами
      silentSaveDelta(step);
    } else if (silentSave) {
      silentSave(newVal);
    } else {
      onChange(newVal);
    }
  };

  const btnStyle = {
    width: 36,
    height: 36,
    background: C.bgSection,
    border: "none",
    color: C.textSub,
    cursor: "pointer",
    fontSize: 18,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    userSelect: "none",
    flexShrink: 0,
    transition: "all .15s",
  };
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 0, background: C.bgCard, border: `1px solid ${C.border}`, ...style }}>
      <button type="button" onClick={dec} style={{ ...btnStyle, opacity: parseInt(localVal||"0") <= min ? 0.4 : 1 }}
        onMouseEnter={e=>{if(parseInt(localVal||"0")>min){e.target.style.background=C.brand;e.target.style.color="#fff";}}}
        onMouseLeave={e=>{e.target.style.background=C.bgSection;e.target.style.color=C.textSub;}}>−</button>
      <input type="text" inputMode="numeric" value={localVal}
        onChange={e => {
          const v = e.target.value.replace(/[^0-9]/g,"");
          setLocalVal(v);
        }}
        onBlur={() => {
          const n = localVal===""?0:parseInt(localVal,10);
          const final = isNaN(n)||n<min ? min : n;
          setLocalVal(String(final));
          // Поле ввода = точное значение → set (может конфликтовать, покажет модалку)
          if (silentSave) silentSave(final);
          else if (onChange) onChange(final);
        }}
        style={{ textAlign: "center", width: 50, padding: "6px 4px", fontSize: 14, fontWeight: 700, border: "none", borderLeft: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`, background: C.bgCard, fontVariantNumeric: "tabular-nums", outline: "none", ...inputStyle }}/>
      <button type="button" onClick={inc} style={btnStyle}
        onMouseEnter={e=>{e.target.style.background=C.brand;e.target.style.color="#fff";}}
        onMouseLeave={e=>{e.target.style.background=C.bgSection;e.target.style.color=C.textSub;}}>+</button>
    </div>
  );
}


// ── Офлайн-кеш и очередь мутаций ──
const OFFLINE_CACHE_PREFIX = "offline_cache_";
const PENDING_WRITES_KEY = "pending_writes";

function cacheGet(key){
  try {
    const raw = localStorage.getItem(OFFLINE_CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function cacheSet(key, val){
  try { localStorage.setItem(OFFLINE_CACHE_PREFIX + key, JSON.stringify(val)); } catch {}
}
function getQueue(){
  try { return JSON.parse(localStorage.getItem(PENDING_WRITES_KEY) || "[]"); } catch { return []; }
}
function setQueue(q){
  try { localStorage.setItem(PENDING_WRITES_KEY, JSON.stringify(q)); } catch {}
}

async function sGet(key){
  // Пробуем GitHub (только если онлайн)
  if (navigator.onLine) {
    try {
      const val = await dbGet(key);
      if (val !== null && val !== undefined) {
        cacheSet(key, val);
        return val;
      }
      // Если null — возможно файла нет; но кеш тоже вернём как fallback при следующем запросе
      return null;
    } catch (e) {
      console.warn(`[sGet] GitHub failed for "${key}", using cache:`, e.message);
    }
  }
  // Fallback: локальный кеш
  return cacheGet(key);
}

// Merge function для records: объединяем записи из remote и local по timestamp
// Если одна запись есть и там и там — берём из local (наша версия новее)
function mergeRecords(remote, local){
  if(!Array.isArray(remote)) return local;
  if(!Array.isArray(local)) return remote;
  const seen = new Set();
  const result = [];
  // Сначала remote
  for(const r of remote){
    const id = r.timestamp + '|' + r.marker + '|' + r.workshop;
    if(!seen.has(id)){
      seen.add(id);
      result.push(r);
    }
  }
  // Потом local (перекрывает при дубликате по id)
  for(const r of local){
    const id = r.timestamp + '|' + r.marker + '|' + r.workshop;
    if(!seen.has(id)){
      seen.add(id);
      result.push(r);
    }
  }
  // Сортируем по timestamp
  result.sort((a,b) => (a.timestamp||0) - (b.timestamp||0));
  return result;
}

// Merge function для stock-ops: union всех операций по opId (event sourcing)
// КРИТИЧНО: при 409 conflict нельзя перезаписывать — иначе теряем ops другого устройства
// Правильно: берём все уникальные операции из remote + local, сортируем по ts
function mergeStockOps(remote, local){
  if(!Array.isArray(remote)) return local;
  if(!Array.isArray(local)) return remote;
  const seen = new Set();
  const result = [];
  // Добавляем все операции (дедупликация по opId)
  for(const op of [...remote, ...local]){
    const id = op.opId || (op.ts + '|' + op.type + '|' + (op.marker || op.oldMarker || '') + '|' + (op.location || op.from || '') + '|' + (op.client || ''));
    if(!seen.has(id)){
      seen.add(id);
      result.push(op);
    }
  }
  // Сортируем по ts для детерминированности
  result.sort((a,b) => (a.ts||0) - (b.ts||0));
  console.log(`[mergeStockOps] remote=${remote.length} local=${local.length} merged=${result.length}`);
  return result;
}

// Merge function для объектов (prices, markers, aliases, notes, stock:cfg, subcategories, passwords)
// Простое объединение: remote поля + local поля (local перекрывает при конфликте)
// Не идеально для удаления ключей, но спасает от полной потери данных
function mergeObject(remote, local){
  if(!remote || typeof remote !== "object" || Array.isArray(remote)) return local;
  if(!local || typeof local !== "object" || Array.isArray(local)) return remote;
  return {...remote, ...local};
}

// Merge function для массивов с id (stock-moves)
function mergeById(remote, local){
  if(!Array.isArray(remote)) return local;
  if(!Array.isArray(local)) return remote;
  const map = new Map();
  for(const x of remote) map.set(x.id, x);
  for(const x of local) map.set(x.id, x); // local побеждает
  return [...map.values()];
}

// Универсальный выбор mergeFn по ключу
function getMergeFn(key){
  if (key === "records") return mergeRecords;
  if (key === "stock-ops") return mergeStockOps;
  if (key === "stock-moves") return mergeById;
  if (["prices","custom:markers","marker-aliases","marker-notes","stock:cfg","subcategories","passwords"].includes(key)) return mergeObject;
  return undefined;
}

async function sSet(key, val){
  // Всегда обновляем локальный кеш (для мгновенного отображения и офлайн-доступа)
  cacheSet(key, val);
  
  // Если офлайн — кладём в очередь, не вызываем GitHub
  if (!navigator.onLine) {
    const q = getQueue();
    // Если уже есть запись для этого key — заменяем (последняя версия выигрывает)
    const filtered = q.filter(item => item.key !== key);
    filtered.push({ key, val, ts: Date.now() });
    setQueue(filtered);
    return { ok: true, queued: true };
  }
  
  // Онлайн — пишем в GitHub
  // Для всех ключей с potential concurrent writes — передаём mergeFn
  // Это предотвращает потерю данных при 409 conflict (два устройства одновременно пишут)
  const mergeFn = getMergeFn(key);
  try {
    const result = await dbSet(key, val, mergeFn);
    if (!result.ok) {
      // Не получилось — в очередь на повтор
      const q = getQueue();
      const filtered = q.filter(item => item.key !== key);
      filtered.push({ key, val, ts: Date.now() });
      setQueue(filtered);
    }
    return result;
  } catch (e) {
    // Сетевая ошибка — в очередь
    const q = getQueue();
    const filtered = q.filter(item => item.key !== key);
    filtered.push({ key, val, ts: Date.now() });
    setQueue(filtered);
    return { ok: true, queued: true };
  }
}

// Защита: получить объект из любого значения (для prices, stock, cfg)
function ensureObj(v){ return (v && typeof v === "object" && !Array.isArray(v)) ? v : {}; }
// Защита: получить массив из любого значения (для records)
function ensureArr(v){ return Array.isArray(v) ? v : []; }

// ── Палитра «Простое Решение» (красно-белая + семантические цвета) ──
const C = {
  // Фирменные
  bg:"#fafafa",          // основной фон — почти белый
  bgCard:"#ffffff",      // карточки — чисто белый
  bgInput:"#ffffff",     // инпуты — белые с границей
  bgSection:"#f8f9fa",   // секции — чуть серее
  border:"#e0e0e0",      // тонкие границы
  borderStrong:"#1a1a1a",// чёрная граница (для акцента)
  brand:"#C70000",       // фирменный красный (как вывеска)
  brandDim:"#fff5f5",    // светлый красный фон
  // Семантические
  text:"#1a1a1a",        // основной текст — чёрный
  textSub:"#666666",     // вторичный — серый
  textDim:"#999999",     // подсказки — светло-серый
  success:"#2e7d32",     // успех, доход
  successDim:"#e8f5e9",
  warn:"#e65100",        // предупреждение, брак, мало
  warnDim:"#fff3e0",
  danger:"#c62828",      // ошибка, 0 шт
  dangerDim:"#ffebee",
  // Мастерские
  smart:"#1976d2",       // SMART — синий
  smartDim:"#e3f2fd",
  begemot:"#7c3aed",     // Бегемот — фиолетовый
  begemotDim:"#f3e8ff",
  // Типы записей
  refund:"#f97316",      // возврат — оранжевый
  dangerDim:"#fff7ed",
};

const s = {
  app:{ background:C.bg, minHeight:"100vh", color:C.text, fontFamily:"-apple-system,system-ui,'Segoe UI',Roboto,sans-serif", fontSize:14, fontVariantNumeric:"tabular-nums" },
  card:{ background:C.bgCard, border:`1px solid ${C.border}`, borderRadius:0, padding:"14px 16px", marginBottom:10 },
  label:{ fontSize:10, color:C.textSub, marginBottom:6, display:"block", fontWeight:700, textTransform:"uppercase", letterSpacing:"1px" },
  input:{ background:C.bgInput, border:`1px solid ${C.border}`, borderRadius:0, color:C.text, padding:"8px 12px", fontSize:14, width:"100%", boxSizing:"border-box", outline:"none", fontFamily:"inherit" },
  btn:(v="default")=>({
    background:v==="accent"?C.brand:v==="danger"?C.dangerDim:v==="warn"?C.warnDim:v==="refund"?C.dangerDim:v==="success"?C.success:v==="dark"?C.text:C.bgCard,
    color:v==="accent"?"#fff":v==="danger"?C.danger:v==="warn"?C.warn:v==="refund"?C.danger:v==="success"?"#fff":v==="dark"?"#fff":C.text,
    border:`1px solid ${v==="accent"?C.brand:v==="danger"?C.danger:v==="warn"?C.warn:v==="refund"?C.danger:v==="success"?C.success:v==="dark"?C.text:C.border}`,
    borderRadius:0, padding:"8px 14px", fontSize:13, cursor:"pointer", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.5px",
  }),
  tag:(color)=>({ background:color+"22", color, border:`1px solid ${color}44`, borderRadius:0, padding:"2px 8px", fontSize:11, display:"inline-block", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.5px" }),
};

function Tabs({ tabs, active, onChange }){
  return (
    <div style={{display:"flex",gap:1,marginBottom:24,background:C.border,padding:1}}>
      {tabs.map(t=>{
        const isActive = active === t.id;
        return (
          <button key={t.id} onClick={()=>onChange(t.id)} style={{
            flex:1,padding:"14px 4px",fontSize:11,fontWeight:800,border:"none",cursor:"pointer",
            background:isActive?C.bgCard:C.bgSection,
            color:isActive?C.brand:C.textSub,
            borderTop:`3px solid ${isActive?C.brand:"transparent"}`,
            textTransform:"uppercase",letterSpacing:"0.8px",
            transition:"all .2s cubic-bezier(0.16,1,0.3,1)",
            display:"flex",flexDirection:"column",alignItems:"center",gap:4,
          }}>
            <span style={{fontSize:16}}>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function StatCard({ label, value, sub, color }){
  return (
    <div style={{background:C.bgCard,padding:16,border:`1px solid ${C.border}`}}>
      <div style={{fontSize:10,color:C.textDim,marginBottom:6,textTransform:"uppercase",letterSpacing:"1px",fontWeight:700}}>{label}</div>
      <div style={{fontSize:26,fontWeight:800,color:color||C.text,letterSpacing:"-0.5px",fontVariantNumeric:"tabular-nums"}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:C.textDim,marginTop:4}}>{sub}</div>}
    </div>
  );
}

function StockBadge({ qty, threshold }){
  const low=threshold>0&&qty<=threshold, empty=qty<=0;
  if(empty) return <span style={s.tag(C.danger)}>0</span>;
  if(low) return <span style={s.tag(C.warn)}>{qty} ⚠</span>;
  return <span style={{color:C.success,fontWeight:600}}>{qty}</span>;
}

// Бейдж типа записи
function TypeBadge({ recordType }){
  if(recordType === "refund") return <span style={{...s.tag(C.danger), fontSize:10}}>↩ Возврат</span>;
  return null;
}

function MarkerPicker({ markers, value, onChange, extraLabel }){
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState({});
  const allM = Object.entries(markers).flatMap(([cat,ms])=>ms.map(m=>({cat,m})));
  const filtered = search.trim()
    ? allM.filter(({cat,m})=>m.toLowerCase().includes(search.toLowerCase())||cat.toLowerCase().includes(search.toLowerCase()))
    : allM;
  const grouped = {};
  filtered.forEach(({cat,m})=>{ if(!grouped[cat]) grouped[cat]=[]; grouped[cat].push(m); });
  Object.keys(grouped).forEach(cat => grouped[cat].sort((a,b)=>a.localeCompare(b,"ru")));
  return (
    <div>
      <input value={search} onChange={e=>setSearch(e.target.value)}
        placeholder="Поиск маркировки..." style={{...s.input,marginBottom:8}}/>
      <div style={{maxHeight:240,overflowY:"auto",border:`1px solid ${C.border}`,background:C.bgCard}}>
        {Object.entries(grouped).sort((a,b)=>a[0].localeCompare(b[0],"ru")).length===0
          ? <div style={{padding:"10px 14px",fontSize:13,color:C.textDim}}>Ничего не найдено</div>
          : Object.entries(grouped).sort((a,b)=>a[0].localeCompare(b[0],"ru")).map(([cat,ms])=>{
            const isCollapsed = !search ? (collapsed[cat] !== false) : false;
            return (
            <div key={cat}>
              <div onClick={()=>setCollapsed(p=>({...p,[cat]:!p[cat]}))}
                style={{padding:"6px 12px",fontSize:11,fontWeight:800,color:C.text,background:C.bgSection,
                borderBottom:`1px solid ${C.border}`,textTransform:"uppercase",letterSpacing:"1px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span>{cat}</span>
                <span style={{fontSize:10}}>{isCollapsed?"▼":"▲"}</span>
              </div>
              {!isCollapsed && ms.map(m=>(
                <div key={m} onClick={()=>{onChange(m);setSearch("");}}
                  style={{padding:"8px 14px",fontSize:13,cursor:"pointer",display:"flex",justifyContent:"space-between",
                    background:value===m?C.brandDim:"transparent",color:value===m?C.brand:C.text,
                    borderBottom:`1px solid ${C.border}22`}}>
                  <span>{m}</span>
                  {extraLabel&&<span style={{color:C.text,fontSize:12,fontWeight:600}}>{extraLabel(m)}</span>}
                </div>
              ))}
            </div>
            );
          })
        }
      </div>
      {value&&<div style={{marginTop:6,fontSize:12,color:C.brand,fontWeight:700}}>Выбрано: <b>{value}</b></div>}
    </div>
  );
}

function EditModal({ record, idx, markers, onSave, onDelete, onClose }){
  const [cat, setCat] = useState(record.category);
  const [mrk, setMrk] = useState(record.marker);
  const [qty, setQty] = useState(record.qty);
  const [defect, setDefect] = useState(record.defect);
  const [amount, setAmount] = useState(record.amount);
  const [comment, setComment] = useState(record.comment||"");
  const [recordType, setRecordType] = useState(record.recordType || "sale");
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:100,display:"flex",alignItems:"flex-end",justifyContent:"center"}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:C.bgCard,borderRadius:"16px 16px 0 0",border:`1px solid ${C.border}`,padding:20,
        width:"100%",maxWidth:600,maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <span style={{fontWeight:700,fontSize:16}}>Редактировать запись</span>
          <button onClick={onClose} style={{...s.btn(),padding:"4px 10px",fontSize:12}}>✕</button>
        </div>

        {/* Тип записи */}
        <label style={s.label}>Тип записи</label>
        <div style={{display:"flex",gap:6,marginBottom:10}}>
          {[["sale","Продажа"],["refund","Возврат от клиента"]].map(([id,label])=>(
            <button key={id} type="button" onClick={()=>setRecordType(id)} style={{
              flex:1,padding:"7px 0",fontSize:12,fontWeight:600,borderRadius:8,cursor:"pointer",
              border:`1px solid ${recordType===id?(id==="refund"?C.danger:C.brand):C.border}`,
              background:recordType===id?(id==="refund"?C.dangerDim:C.brandDim):C.bgInput,
              color:recordType===id?(id==="refund"?C.danger:C.brand):C.textSub
            }}>{label}</button>
          ))}
        </div>

        <label style={s.label}>Категория</label>
        <select value={cat} onChange={e=>setCat(e.target.value)} style={{...s.input,marginBottom:10}}>
          {sortedCategories(markers).map(c=><option key={c}>{c}</option>)}
        </select>
        <label style={s.label}>Маркировка</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:6}}>
          {(markers[cat]||[]).map(m=>(
            <button key={m} type="button" onClick={()=>setMrk(m)} style={{
              fontSize:11,padding:"4px 8px",borderRadius:6,cursor:"pointer",
              background:mrk===m?C.brandDim:C.bgInput,
              border:`1px solid ${mrk===m?C.brand:C.border}`,color:mrk===m?C.brand:C.text
            }}>{m}</button>
          ))}
        </div>
        <input value={mrk} onChange={e=>setMrk(e.target.value)} style={{...s.input,marginBottom:10}} placeholder="или своя маркировка"/>
        <div style={{display:"grid",gridTemplateColumns:recordType==="refund"?"1fr":"1fr 1fr",gap:10,marginBottom:10}}>
          <div><label style={s.label}>Количество</label><StepperInput value={qty} onChange={setQty} style={{width:"100%"}} inputStyle={{width:"100%"}}/></div>
          {recordType!=="refund" && <div><label style={s.label}>Брак</label><StepperInput value={defect} onChange={setDefect} style={{width:"100%"}} inputStyle={{width:"100%"}}/></div>}
        </div>
        {recordType==="sale"&&qty>0&&defect>0&&(
          <div style={{fontSize:11,color:C.textDim,marginBottom:10,lineHeight:1.5}}>
            Всего изготовлено: <b>{qty+defect} шт</b> · Списание со склада: <b>{qty+defect} шт</b> · Сумма: <b>{qty} шт</b> × цена
          </div>
        )}
        <label style={s.label}>Сумма, руб {recordType==="refund"&&<span style={{color:C.danger}}>(будет вычтена)</span>}</label>
        <NumInput value={amount} onChange={setAmount} min="0" style={{...s.input,marginBottom:10}}/>
        <label style={s.label}>Комментарий</label>
        <textarea value={comment} onChange={e=>setComment(e.target.value)} rows={2} style={{...s.input,resize:"vertical",marginBottom:16}}/>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>onSave({...record,category:cat,marker:mrk.trim(),qty,defect,amount,comment,recordType})}
            style={{...s.btn("accent"),flex:1,padding:"10px 0"}}>Сохранить</button>
          <button onClick={()=>onDelete(idx)} style={{...s.btn("danger"),padding:"10px 14px"}}>Удалить</button>
        </div>
        {recordType==="refund"&&(
          <div style={{marginTop:10,fontSize:11,color:C.textDim,lineHeight:1.5}}>
            ↩ Возврат от клиента: сумма вычитается из статистики, заготовка на склад не возвращается.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Сводная карточка статистики (категории + маркировки внутри) ──
function StatsBreakdown({ data, totalAmt, totalQty }){
  const [expanded, setExpanded] = useState({});
  const byCategory = {};
  data.forEach(r=>{
    const sign = signOf(r);
    if(!byCategory[r.category]) byCategory[r.category]={qty:0,defect:0,amount:0,refundQty:0,markers:{}};
    byCategory[r.category].qty += r.qty * sign;
    byCategory[r.category].defect += r.defect;
    byCategory[r.category].amount += r.amount * sign;
    if(r.recordType === "refund") byCategory[r.category].refundQty = (byCategory[r.category].refundQty||0) + r.qty;
    const mk=r.marker;
    if(!byCategory[r.category].markers[mk]) byCategory[r.category].markers[mk]={qty:0,defect:0,amount:0,refundQty:0};
    byCategory[r.category].markers[mk].qty += r.qty * sign;
    byCategory[r.category].markers[mk].defect += r.defect;
    byCategory[r.category].markers[mk].amount += r.amount * sign;
    if(r.recordType === "refund") byCategory[r.category].markers[mk].refundQty = (byCategory[r.category].markers[mk].refundQty||0) + r.qty;
  });
  if(Object.keys(byCategory).length===0) return <div style={{fontSize:13,color:C.textDim}}>Нет данных</div>;
  return (
    <div>
      {Object.entries(byCategory).sort((a,b)=>{
        // сортируем по алфавиту (А → Я), потом по сумме
        const nameCompare = a[0].localeCompare(b[0], "ru");
        if(nameCompare !== 0) return nameCompare;
        return b[1].amount - a[1].amount;
      }).map(([cat,d])=>(
        <div key={cat} style={{...s.card,padding:0,overflow:"hidden",marginBottom:8}}>
          <div onClick={()=>setExpanded(p=>({...p,[cat]:!p[cat]}))}
            style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              <span style={{fontWeight:700,fontSize:13}}>{cat}</span>
              {d.defect>0&&<span style={s.tag(C.danger)}>{d.defect} брак</span>}
              {d.refundQty>0&&<span style={s.tag(C.danger)}>{d.refundQty} возврат</span>}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{textAlign:"right"}}>
                <div style={{color:d.amount>=0?C.text:C.danger,fontWeight:700,fontSize:13}}>{fmt(d.amount)} р</div>
                <div style={{fontSize:11,color:C.textSub}}>{fmt(d.qty)} шт · {totalAmt>0?(Math.abs(d.amount)/Math.abs(totalAmt)*100).toFixed(0):0}%</div>
              </div>
              <span style={{color:C.textDim,fontSize:12}}>{expanded[cat]?"▲":"▼"}</span>
            </div>
          </div>
          {expanded[cat]&&(
            <div style={{borderTop:`1px solid ${C.border}`}}>
              {Object.entries(d.markers).sort((a,b)=>b[1].qty-a[1].qty).map(([mk,md])=>(
                <div key={mk} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                  padding:"7px 14px",borderBottom:`1px solid ${C.border}22`,fontSize:13,
                  background:md.defect>0?C.dangerDim+"55":"transparent"}}>
                  <span style={{color:C.text,fontWeight:600}}>{mk}</span>
                  <div style={{textAlign:"right"}}>
                    <div style={{color:md.amount>=0?C.text:C.danger,fontWeight:700}}>{fmt(md.amount)} р</div>
                    <div style={{fontSize:12,color:C.text,fontWeight:600}}>
                      {fmt(md.qty)} шт
                      {md.defect>0&&<span style={{color:C.danger,fontWeight:700,marginLeft:6}}>· брак {md.defect}</span>}
                      {md.refundQty>0&&<span style={{color:C.danger,fontWeight:700,marginLeft:6}}>· возврат {md.refundQty}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Отчёт дня с кликабельными записями ──────────────────────────
function DayReport({ records, workshop, wsStock, stockCfg, dateStr, onEditRecord }){
  const wsColor = workshop==="SMART"?C.smart:C.begemot;
  const dayRecs = records.filter(r=>r.workshop===workshop&&dateOf(r.timestamp)===dateStr);
  const totalAmt = dayRecs.reduce((s,r)=>s+r.amount*signOf(r),0);
  const totalQtySold = dayRecs.filter(r=>r.recordType!=="refund").reduce((s,r)=>s+r.qty,0);
  const totalQtyRefund = dayRecs.filter(r=>r.recordType==="refund").reduce((s,r)=>s+r.qty,0);
  const byM={};
  // Для блока «БЫЛО → СТАЛО» — игнорируем услуги (не заготовки, склад по ним не ведётся):
  // - «Прочие услуги» (категория целиком)
  // - SERVICE_MARKERS (Нарезка лезвия, Замена корпуса)
  dayRecs.filter(r => !isServiceMarker(r.marker, r.category)).forEach(r=>{
    const sign = signOf(r);
    if(!byM[r.marker]) byM[r.marker]={qty:0,defect:0,amount:0,stockUsed:0,refundQty:0};
    byM[r.marker].qty += r.qty * sign;
    byM[r.marker].defect += r.defect;
    byM[r.marker].amount += r.amount * sign;
    byM[r.marker].stockUsed += stockDelta(r);
    if(r.recordType === "refund") byM[r.marker].refundQty = (byM[r.marker].refundQty||0) + r.qty;
  });
  const report=Object.entries(byM).sort((a,b)=>b[1].qty-a[1].qty);

  if(report.length===0) return <div style={{fontSize:13,color:C.textDim,padding:"8px 0"}}>Записей нет</div>;
  return (
    <div>
      <div style={{fontSize:12,fontWeight:700,color:C.textSub,marginBottom:8,marginTop:12}}>БЫЛО → СТАЛО</div>
      {report.map(([m,d])=>{
        const stockNow=wsStock[m]||0,stockBefore=stockNow+d.stockUsed;
        return (
          <div key={m} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
            padding:"7px 0",borderBottom:`1px solid ${C.border}`,fontSize:13}}>
            <span style={{fontWeight:600}}>{m}</span>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{color:C.textDim}}>{stockBefore}</span>
              <span style={{color:C.textDim}}>→</span>
              <StockBadge qty={stockNow} threshold={(stockCfg[m]||{}).threshold||0}/>
            </div>
          </div>
        );
      })}
      {report.filter(([m])=>{const q=wsStock[m]||0,t=(stockCfg[m]||{}).threshold||0;return t>0&&q<=t;}).length>0&&(
        <div style={{...s.card,background:C.warnDim,borderColor:C.warn+"66",marginTop:12}}>
          <div style={{fontSize:13,fontWeight:700,color:C.warn,marginBottom:6}}>⚠ Мало заготовок</div>
          {report.filter(([m])=>{const q=wsStock[m]||0,t=(stockCfg[m]||{}).threshold||0;return t>0&&q<=t;})
            .map(([m])=><div key={m} style={{fontSize:13,color:C.warn,padding:"3px 0"}}>{m} — {wsStock[m]||0} шт (порог {(stockCfg[m]||{}).threshold})</div>)}
        </div>
      )}

      {/* Все записи дня — сворачиваемый блок, по умолчанию свёрнут */}
      <DayRecordsList dayRecs={dayRecs} records={records} onEditRecord={onEditRecord}/>
    </div>
  );
}

// ── Сворачиваемый список записей дня ──
function DayRecordsList({ dayRecs, records, onEditRecord }){
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{marginTop:16}}>
      <div onClick={()=>setExpanded(v=>!v)}
        style={{
          display:"flex",justifyContent:"space-between",alignItems:"center",
          padding:"10px 14px",background:C.bgCard,border:`1px solid ${C.border}`,
          borderRadius:8,cursor:"pointer",userSelect:"none"
        }}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:12,fontWeight:700,color:C.textSub}}>
            ВСЕ ЗАПИСИ ДНЯ ({dayRecs.length})
          </span>
        </div>
        <span style={{color:C.textDim,fontSize:14}}>{expanded?"▲":"▼"}</span>
      </div>
      {expanded && (
        <div style={{marginTop:8}}>
          <div style={{fontSize:11,color:C.textDim,marginBottom:8}}>Нажмите на запись, чтобы изменить или удалить</div>
          {dayRecs.map((r,i)=>{
            const globalIdx = records.findIndex(rr=>rr===r);
            const isRefund = r.recordType === "refund";
            const isOnlyDefect = !isRefund && r.qty === 0 && r.defect > 0;
            return (
              <div key={i} onClick={()=>onEditRecord({record:r,globalIdx})}
                style={{...s.card,cursor:"pointer",borderLeft:`3px solid ${isRefund?C.danger:isOnlyDefect?C.warn:C.brand+"88"}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    {isRefund
                      ? <span style={{color:C.danger,fontWeight:700,fontSize:16}}>↩</span>
                      : isOnlyDefect
                        ? <span style={{color:C.warn,fontWeight:700,fontSize:16}}>⚠</span>
                        : <span style={{color:C.success,fontWeight:700,fontSize:16}}>↑</span>}
                    <span style={{fontWeight:600}}>{r.marker}</span>
                    {isRefund&&<TypeBadge recordType="refund"/>}
                    {isOnlyDefect&&<span style={{...s.tag(C.warn),fontSize:10}}>только брак</span>}
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span style={{fontSize:12,color:isRefund?C.danger:isOnlyDefect?C.warn:C.textSub}}>
                      {isRefund?"−":""}{r.qty} шт{r.defect>0?` · брак ${r.defect}`:""}{isRefund?` · возврат`:""} · {fmt(r.amount)} р
                    </span>
                    <span style={{fontSize:11,color:C.brand}}>✎</span>
                  </div>
                </div>
                <div style={{fontSize:12,color:C.textDim,marginTop:2}}>
                  {r.category}{r.comment&&` · ${r.comment}`}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── ErrorBoundary: ловит ошибки рендера, не даёт белый экран ──
export class ErrorBoundary extends Component {
  constructor(props){ super(props); this.state = { hasError:false, error:null }; }
  static getDerivedStateFromError(error){ return { hasError:true, error }; }
  componentDidCatch(error, info){ console.error("App render error:", error, info); }
  render(){
    if(this.state.hasError){
      return (
        <div style={{minHeight:"100vh",background:"#0f1117",color:"#e2e8f0",padding:24,fontFamily:"system-ui,sans-serif"}}>
          <div style={{maxWidth:600,margin:"0 auto"}}>
            <h2 style={{color:"#ef4444",marginBottom:12}}>⚠ Ошибка рендера</h2>
            <p style={{color:"#8892a4",marginBottom:16}}>Что-то пошло не так. Попробуй перезагрузить страницу.</p>
            <pre style={{background:"#181c27",padding:12,borderRadius:8,fontSize:12,overflow:"auto",color:"#f59e0b",border:"1px solid #2a3048"}}>
              {String(this.state.error?.message || this.state.error || "Unknown error")}
            </pre>
            <button onClick={()=>{this.setState({hasError:false,error:null});try{localStorage.removeItem("workshop_auth_v2");localStorage.removeItem("workshop_choice_v2");}catch{}}}
              style={{marginTop:16,padding:"10px 20px",background:"#4f8ef7",color:"#fff",border:"none",borderRadius:8,cursor:"pointer"}}>
              Сбросить авторизацию и попробовать снова
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Месяц в годовой статистике — разворачивается по дням ──
function YearMonthCard({ monthKey, monthData, monthName, workshop, onEditRecord, allRecords }){
  const [expanded, setExpanded] = useState(false);
  const mn = monthName;
  const avgPerDay = monthData.days.size > 0 ? monthData.amount / monthData.days.size : 0;

  // Подсчёт по дням внутри месяца
  const byDay = {};
  monthData.recList.forEach(r=>{
    const dk = dateOf(r.timestamp);
    if(!byDay[dk]) byDay[dk] = { qty:0, amount:0, defect:0, records:[] };
    const s = signOf(r);
    byDay[dk].qty += r.qty * s;
    byDay[dk].amount += r.amount * s;
    byDay[dk].defect += r.defect;
    byDay[dk].records.push(r);
  });

  return (
    <div style={{...s.card,padding:0,overflow:"hidden",marginBottom:8}}>
      <div onClick={()=>setExpanded(v=>!v)}
        style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 14px",cursor:"pointer"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontWeight:700,fontSize:14}}>{MONTH_NAMES[mn]}</span>
          {monthData.defect>0 && <span style={{...s.tag(C.warn),fontSize:10}}>брак {monthData.defect}</span>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{textAlign:"right"}}>
            <div style={{color:monthData.amount>=0?C.text:C.danger,fontWeight:700,fontSize:14}}>{fmt(monthData.amount)} р</div>
            <div style={{fontSize:11,color:C.textSub}}>{fmt(monthData.qty)} шт · {monthData.days.size} дн.</div>
          </div>
          <span style={{color:C.textDim,fontSize:14}}>{expanded?"▲":"▼"}</span>
        </div>
      </div>
      {!expanded && (
        <div style={{display:"flex",gap:16,padding:"0 14px 10px",fontSize:11,color:C.textDim,flexWrap:"wrap"}}>
          <span>Среднее: {fmt(avgPerDay)} р/день</span>
          {workshop==="SMART" && <span style={{color:C.success}}>Зарплата: {fmt(calcEarnings(monthData.recList).total)} р</span>}
        </div>
      )}
      {expanded && (
        <div style={{borderTop:`1px solid ${C.border}`,padding:"12px 14px"}}>
          {/* ПОЛНАЯ СТАТИСТИКА — как во вкладке "Месяц" */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            <StatCard label="Всего ключей" value={fmt(monthData.qty)}/>
            <StatCard label="Общая сумма" value={fmt(monthData.amount)+" р"} color={C.success}/>
            <StatCard label="Брак" value={fmt(monthData.defect)} color={monthData.defect>0?C.danger:undefined}/>
            <StatCard label="% брака" value={monthData.qty>0?(monthData.defect/Math.abs(monthData.qty)*100).toFixed(1)+"%":"0%"} color={monthData.defect>0?C.danger:undefined}/>
            <StatCard label="Рабочих дней" value={monthData.days.size} sub="дней с записями"/>
            {workshop==="SMART"&&(() => { const e = calcEarnings(monthData.recList); return <StatCard label="Зарплата" value={fmt(e.total)+" р"} sub={`ключи: ${fmt(e.fromKeys)} · заточка: ${fmt(e.fromSharping)}`} color={C.success}/>; })()}
          </div>

          {/* По категориям */}
          <div style={{fontSize:13,fontWeight:700,color:C.textSub,marginBottom:8}}>ПО КАТЕГОРИЯМ</div>
          <StatsBreakdown data={monthData.recList} totalAmt={monthData.amount} totalQty={monthData.qty}/>

          {/* По дням — кликабельные, разворачиваются в записи */}
          <div style={{fontSize:13,fontWeight:700,color:C.textSub,marginBottom:8,marginTop:16}}>ПО ДНЯМ — нажмите для записей</div>
          {Object.entries(byDay).sort((a,b)=>b[0].localeCompare(a[0])).map(([dk,d])=>{
            const parts = dk.split("-");
            const label = `${parts[2]}.${parts[1]}`;
            return (
              <DayRow key={dk} dateLabel={label} dayData={d} workshop={workshop}
                onEditRecord={onEditRecord} allRecords={allRecords}/>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── День внутри месяца (со сворачиваемыми записями) ──
function DayRow({ dateLabel, dayData, workshop, onEditRecord, allRecords }){
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{marginBottom:6,border:`1px solid ${C.border}22`,borderRadius:6,overflow:"hidden"}}>
      <div onClick={()=>setExpanded(v=>!v)}
        style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",cursor:"pointer",background:C.bgInput}}>
        <span style={{color:C.textSub,fontSize:12}}>{dateLabel}</span>
        <div style={{display:"flex",gap:10,alignItems:"center",fontSize:12}}>
          <span style={{color:dayData.amount>=0?C.text:C.danger,fontWeight:600}}>{fmt(dayData.amount)} р</span>
          <span style={{color:C.textDim}}>{dayData.qty} шт{dayData.defect>0?` · брак ${dayData.defect}`:""}{dayData.records.some(r=>r.recordType==="refund")?` · возврат ${dayData.records.filter(r=>r.recordType==="refund").reduce((s,r)=>s+r.qty,0)}`:""}</span>
          <span style={{color:C.textDim,fontSize:10}}>{expanded?"▲":"▼"}</span>
        </div>
      </div>
      {expanded && (
        <div style={{padding:"6px 12px 10px"}}>
          {dayData.records.map((r,i)=>{
            const globalIdx = allRecords.findIndex(rr=>rr===r);
            const isRefund = r.recordType === "refund";
            const isOnlyDefect = !isRefund && r.qty === 0 && r.defect > 0;
            return (
              <div key={i} onClick={()=>onEditRecord({record:r,globalIdx})}
                style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                  padding:"5px 0",cursor:"pointer",borderBottom:`1px solid ${C.border}22`}}>
                <div style={{display:"flex",alignItems:"center",gap:6,fontSize:12}}>
                  <span style={{color:isRefund?C.danger:isOnlyDefect?C.warn:C.success}}>
                    {isRefund?"↩":isOnlyDefect?"⚠":"↑"}
                  </span>
                  <span style={{color:C.text}}>{r.marker}</span>
                  {isRefund && <span style={{...s.tag(C.danger),fontSize:9,padding:"1px 5px"}}>возврат</span>}
                  {isOnlyDefect && <span style={{...s.tag(C.warn),fontSize:9,padding:"1px 5px"}}>брак</span>}
                </div>
                <div style={{display:"flex",gap:6,fontSize:11,color:C.textSub}}>
                  <span>{isRefund?"−":""}{r.qty} шт{r.defect>0?`/${r.defect}`:""}</span>
                  <span style={{color:isRefund?C.danger:C.brand}}>{fmt(r.amount)} р</span>
                  <span style={{color:C.brand}}>✎</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Мини-фото маркировки для раздела «Маркировки» ──
// Показывает текущее фото (кликабельное) или кнопку загрузки
function MarkerPhotoThumb({ markerName, photo, onPhotoLoaded, onPhotoClick }){
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);

  // Кеш «нет фото» в localStorage — чтобы не дёргать GitHub повторно
  // для маркировок, у которых фото точно нет (иначе 100+ запросов 404 при раскрытии склада)
  const NO_PHOTO_KEY = "no_photo_markers";
  function isKnownNoPhoto(m){
    try {
      const set = JSON.parse(localStorage.getItem(NO_PHOTO_KEY) || "[]");
      return set.includes(m);
    } catch { return false; }
  }
  function markNoPhoto(m){
    try {
      const set = JSON.parse(localStorage.getItem(NO_PHOTO_KEY) || "[]");
      if(!set.includes(m)){
        set.push(m);
        // Ограничиваем размер — последние 500
        if(set.length > 500) set.splice(0, set.length - 500);
        localStorage.setItem(NO_PHOTO_KEY, JSON.stringify(set));
      }
    } catch {}
  }

  // Если фото ещё не загружено — попробуем загрузить (один раз)
  useEffect(() => {
    if(photo === undefined && markerName){
      // Если мы уже знаем, что фото нет — не дёргаем GitHub
      if(isKnownNoPhoto(markerName)){
        onPhotoLoaded(null);
        return;
      }
      photoGet(markerName).then(url => {
        if(url === null) markNoPhoto(markerName);
        onPhotoLoaded(url);
      });
    }
  }, [markerName]);

  async function handleFile(e){
    const f = e.target.files[0];
    if(!f) return;
    setLoading(true);
    setMsg(null);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const url = reader.result;
        await photoSet(markerName, url);
        // Снимаем флаг «нет фото» — теперь оно есть
        try {
          const set = JSON.parse(localStorage.getItem(NO_PHOTO_KEY) || "[]");
          const filtered = set.filter(x => x !== markerName);
          localStorage.setItem(NO_PHOTO_KEY, JSON.stringify(filtered));
        } catch {}
        onPhotoLoaded(url);
        setLoading(false);
        setMsg({ok:true, text:"Фото сохранено"});
        setTimeout(()=>setMsg(null), 1500);
      };
      reader.readAsDataURL(f);
    } catch(e) {
      setLoading(false);
      setMsg({ok:false, text:"Ошибка загрузки"});
    }
  }

  async function handleDelete(e){
    e.stopPropagation();
    if(!confirm("Удалить фото?")) return;
    setLoading(true);
    await photoDelete(markerName);
    markNoPhoto(markerName); // помечаем, что фото нет
    onPhotoLoaded(null);
    setLoading(false);
  }

  // Стили
  const thumbSize = 48;
  const containerStyle = {
    width: thumbSize,
    height: thumbSize,
    flexShrink: 0,
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    overflow: "hidden",
    position: "relative",
    cursor: photo ? "pointer" : "default",
    background: C.bgInput,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  if(loading){
    return (
      <div style={{...containerStyle, cursor:"wait"}}>
        <span style={{fontSize:10,color:C.textSub}}>⏳</span>
      </div>
    );
  }

  if(photo){
    return (
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
        <div style={containerStyle} onClick={onPhotoClick} title="Нажмите, чтобы увеличить">
          <img src={photo} alt={markerName} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
        </div>
        <button onClick={handleDelete} title="Удалить фото"
          style={{fontSize:9,padding:"1px 4px",borderRadius:4,cursor:"pointer",
            background:"transparent",color:C.danger,border:`1px solid ${C.danger}44`}}>✕</button>
      </div>
    );
  }

  // Нет фото — кнопка загрузки
  return (
    <label style={{...containerStyle, cursor:"pointer"}} title="Загрузить фото">
      <input type="file" accept="image/*" style={{display:"none"}} onChange={handleFile}/>
      <span style={{fontSize:18,color:C.textSub}}>📷</span>
    </label>
  );
}

// ── Модалка просмотра фото в полном размере ──
function PhotoViewModal({ photo, markerName, onClose }){
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.95)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",padding:20}}
      onClick={onClose}>
      <div style={{position:"absolute",top:16,right:16,display:"flex",gap:8,alignItems:"center"}}>
        <span style={{color:"#fff",fontSize:13,opacity:.7}}>{markerName}</span>
        <button onClick={onClose} style={{
          background:"rgba(255,255,255,.1)",color:"#fff",border:"1px solid rgba(255,255,255,.2)",
          borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:14,
        }}>✕</button>
      </div>
      <img src={photo} alt={markerName}
        style={{maxWidth:"95%",maxHeight:"85vh",borderRadius:8,boxShadow:"0 8px 32px rgba(0,0,0,.5)"}}/>
      <div style={{color:"#fff",fontSize:11,opacity:.5,marginTop:12}}>Кликните в любом месте, чтобы закрыть</div>
    </div>
  );
}

// ── Модалка управления подкатегориями ──
function SubcategoryModal({ cat, markers, subcategories, onCreate, onDelete, onRename, onAssign, onUnassign, onClose }){
  const [newName, setNewName] = useState("");
  const [msg, setMsg] = useState(null);
  const [renaming, setRenaming] = useState(null); // {oldName, newName}
  const [assigning, setAssigning] = useState(null); // markerName being assigned

  const catSubs = ensureObj(subcategories[cat]);
  const subNames = Object.keys(catSubs);
  const allCatMarkers = markers[cat] || [];

  function showMsg(r){
    setMsg(r);
    setTimeout(()=>setMsg(null), 2000);
  }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:100,display:"flex",alignItems:"flex-end",justifyContent:"center"}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:C.bgCard,borderRadius:"16px 16px 0 0",border:`1px solid ${C.border}`,padding:20,
        width:"100%",maxWidth:600,maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div>
            <div style={{fontWeight:700,fontSize:16}}>📁 Подкатегории</div>
            <div style={{fontSize:11,color:C.textSub,marginTop:2}}>Категория: {cat}</div>
          </div>
          <button onClick={onClose} style={{...s.btn(),padding:"4px 10px",fontSize:12}}>✕</button>
        </div>

        {/* Создать новую */}
        <label style={s.label}>Создать подкатегорию</label>
        <div style={{display:"flex",gap:8,marginBottom:16}}>
          <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Например: ВАЗ, BMW, Toyota..."
            style={s.input} onKeyDown={e=>{if(e.key==="Enter"&&newName.trim()){onCreate(cat,newName).then(showMsg);setNewName("");}}}/>
          <button onClick={()=>{if(newName.trim()){onCreate(cat,newName).then(showMsg);setNewName("");}}}
            style={{...s.btn("accent"),whiteSpace:"nowrap",padding:"8px 16px"}}>+ Создать</button>
        </div>

        {/* Список существующих подкатегорий */}
        {subNames.length > 0 && (
          <div style={{marginBottom:20}}>
            <div style={{...s.label,marginBottom:8}}>Существующие подкатегории ({subNames.length})</div>
            {subNames.map(sn => {
              const subMarkers = catSubs[sn]||[];
              return (
                <div key={sn} style={{...s.card,padding:"10px 12px",marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    {renaming && renaming.oldName === sn ? (
                      <div style={{display:"flex",gap:6,flex:1}}>
                        <input value={renaming.newName} onChange={e=>setRenaming({oldName:sn,newName:e.target.value})}
                          style={{...s.input,fontSize:13}} autoFocus onKeyDown={e=>{
                            if(e.key==="Enter"){onRename(cat,sn,renaming.newName).then(showMsg);setRenaming(null);}
                            if(e.key==="Escape") setRenaming(null);
                          }}/>
                        <button onClick={()=>{onRename(cat,sn,renaming.newName).then(showMsg);setRenaming(null);}}
                          style={{...s.btn("accent"),padding:"6px 10px",fontSize:11}}>✓</button>
                        <button onClick={()=>setRenaming(null)} style={{...s.btn(),padding:"6px 10px",fontSize:11}}>✕</button>
                      </div>
                    ) : (
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontWeight:700,fontSize:14}}>{sn}</span>
                        <span style={{fontSize:11,color:C.textDim}}>{subMarkers.length} шт</span>
                      </div>
                    )}
                    {!(renaming && renaming.oldName === sn) && (
                      <div style={{display:"flex",gap:4}}>
                        <button onClick={()=>setRenaming({oldName:sn,newName:sn})}
                          style={{...s.btn(),padding:"4px 8px",fontSize:11}} title="Переименовать">✎</button>
                        <button onClick={()=>{if(confirm(`Удалить «${sn}»?`)){onDelete(cat,sn);}}}
                          style={{...s.btn("danger"),padding:"4px 8px",fontSize:11}} title="Удалить">✕</button>
                      </div>
                    )}
                  </div>
                  {/* Маркировки в подкатегории */}
                  {subMarkers.length > 0 && (
                    <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:6}}>
                      {subMarkers.map(m => (
                        <span key={m} style={{display:"inline-flex",alignItems:"center",gap:4,background:C.bgSection,padding:"3px 8px",borderRadius:0,fontSize:12,border:`1px solid ${C.border}`}}>
                          {m}
                          <button onClick={()=>onUnassign(cat,sn,m)} style={{background:"transparent",border:"none",color:C.danger,cursor:"pointer",fontSize:11,padding:0}}>✕</button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Назначить маркировку в подкатегорию */}
        {subNames.length > 0 && (
          <div style={{marginBottom:16}}>
            <div style={{...s.label,marginBottom:8}}>Назначить маркировку</div>
            <div style={{maxHeight:300,overflowY:"auto",border:`1px solid ${C.border}`,background:C.bgCard}}>
              {allCatMarkers.sort((a,b)=>a.localeCompare(b,"ru")).map(m => {
                const currentSub = getMarkerSubcategoryStatic(catSubs, m);
                return (
                  <div key={m} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                    padding:"6px 12px",borderBottom:`1px solid ${C.border}22`,fontSize:12}}>
                    <span style={{color:C.text,fontWeight:600}}>{m}</span>
                    <select value={currentSub||""} onChange={e=>{
                      if(e.target.value){
                        onAssign(cat, e.target.value, m);
                      } else if(currentSub){
                        onUnassign(cat, currentSub, m);
                      }
                    }} style={{...s.input,padding:"4px 8px",fontSize:11,width:120}}>
                      <option value="">— без подкатегории —</option>
                      {subNames.map(sn => <option key={sn} value={sn}>{sn}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {msg && <div style={{fontSize:12,marginBottom:10,color:msg.ok?C.success:C.danger,fontWeight:700}}>{msg.text}</div>}
        <div style={{fontSize:11,color:C.textDim,lineHeight:1.5}}>
          💡 Подкатегории помогают группировать маркировки внутри категории.<br/>
          Например: «ВАЗ», «BMW», «Toyota» внутри «Автомобильных».
        </div>
      </div>
    </div>
  );
}

function getMarkerSubcategoryStatic(catSubs, markerName){
  for(const [subName, markers] of Object.entries(catSubs)){
    if(markers.includes(markerName)) return subName;
  }
  return null;
}

// ── Модалка комментария к маркировке ──
function NoteModal({ markerName, currentNote, onSave, onClose }){
  const [text, setText] = useState(currentNote || "");
  const [msg, setMsg] = useState(null);
  const [loading, setLoading] = useState(false);

  async function submit(){
    setLoading(true); setMsg(null);
    const r = await onSave(markerName, text);
    setLoading(false);
    setMsg({ok: r.ok, text: r.text});
    if(r.ok) setTimeout(()=>onClose(), 1000);
  }

  async function remove(){
    if(!currentNote) return;
    if(!confirm("Удалить комментарий?")) return;
    setText("");
    setLoading(true); setMsg(null);
    const r = await onSave(markerName, "");
    setLoading(false);
    setMsg({ok: r.ok, text: r.text});
    if(r.ok) setTimeout(()=>onClose(), 1000);
  }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:100,display:"flex",alignItems:"flex-end",justifyContent:"center"}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:C.bgCard,borderRadius:"16px 16px 0 0",border:`1px solid ${C.border}`,padding:20,
        width:"100%",maxWidth:600,maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div>
            <div style={{fontWeight:700,fontSize:16}}>💬 Комментарий</div>
            <div style={{fontSize:11,color:C.textSub,marginTop:2}}>{markerName}</div>
          </div>
          <button onClick={onClose} style={{...s.btn(),padding:"4px 10px",fontSize:12}}>✕</button>
        </div>
        <label style={s.label}>Текст комментария</label>
        <textarea value={text} onChange={e=>setText(e.target.value)}
          rows={4} autoFocus
          placeholder="Например: использовать только для BMW 2015+, нет на базах, замена для..."
          style={{...s.input,resize:"vertical",marginBottom:12,fontSize:14}}/>
        {msg && <div style={{fontSize:12,marginBottom:10,color:msg.ok?C.success:C.danger}}>{msg.text}</div>}
        <div style={{display:"flex",gap:8}}>
          <button onClick={submit} disabled={loading}
            style={{...s.btn("accent"),flex:1,padding:"10px 0",opacity:loading?.6:1}}>
            {loading ? "Сохранение..." : "Сохранить"}
          </button>
          {currentNote && (
            <button onClick={remove} disabled={loading}
              style={{...s.btn("danger"),padding:"10px 14px",opacity:loading?.6:1}}>
              Удалить
            </button>
          )}
        </div>
        <div style={{fontSize:11,color:C.textDim,marginTop:10,lineHeight:1.5}}>
          💡 Комментарий виден в ценах, на складе и в форме записи (как подсказка).
        </div>
      </div>
    </div>
  );
}

// ── Модалка управления алиасами ──
function AliasesModal({ cat, markerName, aliases, onAdd, onRemove, onPromote, onClose }){
  const [newAlias, setNewAlias] = useState("");
  const [msg, setMsg] = useState(null);
  const [loading, setLoading] = useState(false);

  async function submitAdd(){
    setLoading(true); setMsg(null);
    const r = await onAdd(markerName, newAlias);
    setLoading(false);
    if(r.ok){
      setNewAlias("");
      setMsg({ok:true, text:r.text});
      setTimeout(()=>setMsg(null), 2000);
    } else {
      setMsg({ok:false, text:r.text});
    }
  }

  async function submitRemove(alias){
    if(!confirm(`Удалить алиас «${alias}»?`)) return;
    setLoading(true); setMsg(null);
    const r = await onRemove(markerName, alias);
    setLoading(false);
    setMsg({ok: r.ok, text: r.text});
    if(r.ok) setTimeout(()=>setMsg(null), 2000);
  }

  async function submitPromote(alias){
    if(!confirm(`Сделать «${alias}» основным именем? Старое имя «${markerName}» станет алиасом.`)) return;
    setLoading(true); setMsg(null);
    const r = await onPromote(cat, markerName, alias);
    setLoading(false);
    if(r.ok){
      setMsg({ok:true, text:r.text});
      setTimeout(()=>onClose(), 1500);
    } else {
      setMsg({ok:false, text:r.text});
    }
  }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:100,display:"flex",alignItems:"flex-end",justifyContent:"center"}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:C.bgCard,borderRadius:"16px 16px 0 0",border:`1px solid ${C.border}`,padding:20,
        width:"100%",maxWidth:600,maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div>
            <div style={{fontWeight:700,fontSize:16}}>Алиасы маркировки</div>
            <div style={{fontSize:11,color:C.textSub,marginTop:2}}>Категория: {cat}</div>
          </div>
          <button onClick={onClose} style={{...s.btn(),padding:"4px 10px",fontSize:12}}>✕</button>
        </div>

        {/* Основное имя */}
        <div style={{...s.card,padding:"10px 12px",marginBottom:14,background:C.bgInput,borderColor:C.brand+"66"}}>
          <div style={{fontSize:11,color:C.textSub}}>Основное имя (выделено в списках)</div>
          <div style={{fontSize:15,fontWeight:700,color:C.brand}}>{markerName}</div>
        </div>

        {/* Список алиасов */}
        <div style={{fontSize:13,fontWeight:700,color:C.textSub,marginBottom:8}}>Альтернативные названия ({aliases.length})</div>
        {aliases.length === 0 ? (
          <div style={{...s.card,padding:"10px 14px",color:C.textDim,fontSize:12}}>Алиасов пока нет. Добавьте ниже.</div>
        ) : (
          <div style={{marginBottom:14}}>
            {aliases.map(alias => (
              <div key={alias} style={{...s.card,padding:"8px 12px",display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <span style={{fontSize:13,color:C.text}}>{alias}</span>
                <div style={{display:"flex",gap:6}}>
                  <button type="button" onClick={()=>submitPromote(alias)} disabled={loading}
                    style={{...s.btn(),padding:"4px 8px",fontSize:11,opacity:loading?.6:1}} title="Сделать основным именем">
                    ⭐ Основное
                  </button>
                  <button type="button" onClick={()=>submitRemove(alias)} disabled={loading}
                    style={{...s.btn("danger"),padding:"4px 8px",fontSize:11,opacity:loading?.6:1}}>
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Добавить новый алиас */}
        <label style={s.label}>Добавить алиас</label>
        <div style={{display:"flex",gap:8,marginBottom:10}}>
          <input value={newAlias} onChange={e=>setNewAlias(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter"&&!loading)submitAdd();}}
            style={s.input} placeholder="Например: BA7R"/>
          <button type="button" onClick={submitAdd} disabled={loading}
            style={{...s.btn("accent"),padding:"8px 14px",opacity:loading?.6:1}}>
            {loading ? "..." : "Добавить"}
          </button>
        </div>
        {msg && <div style={{fontSize:12,marginBottom:10,color:msg.ok?C.success:C.danger}}>{msg.text}</div>}

        <div style={{fontSize:11,color:C.textDim,lineHeight:1.5,marginTop:10}}>
          💡 Алиасы — это альтернативные названия одной и той же маркировки.<br/>
          Поиск по складу и форме записи найдёт маркировку по любому имени.<br/>
          «⭐ Основное» — поменять основное имя местами с алиасом (старое станет алиасом).
        </div>
      </div>
    </div>
  );
}

// ── Модалка переименования маркировки ──
function RenameMarkerModal({ cat, oldName, onRename, onClose }){
  const [newName, setNewName] = useState(oldName);
  const [msg, setMsg] = useState(null);
  const [loading, setLoading] = useState(false);

  async function submit(){
    setLoading(true);
    setMsg(null);
    const result = await onRename(cat, oldName, newName);
    setLoading(false);
    if(result.ok){
      setMsg({ok:true, text:result.text});
      setTimeout(()=>{onClose();}, 1000);
    } else {
      setMsg({ok:false, text:result.text});
    }
  }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:100,display:"flex",alignItems:"flex-end",justifyContent:"center"}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:C.bgCard,borderRadius:"16px 16px 0 0",border:`1px solid ${C.border}`,padding:20,
        width:"100%",maxWidth:600,maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <span style={{fontWeight:700,fontSize:16}}>Переименовать маркировку</span>
          <button onClick={onClose} style={{...s.btn(),padding:"4px 10px",fontSize:12}}>✕</button>
        </div>
        <div style={{...s.card,padding:"8px 12px",marginBottom:14,background:C.bgInput}}>
          <div style={{fontSize:11,color:C.textSub}}>Категория</div>
          <div style={{fontSize:13,fontWeight:600}}>{cat}</div>
          <div style={{fontSize:11,color:C.textSub,marginTop:6}}>Текущее название</div>
          <div style={{fontSize:13,fontWeight:600,color:C.brand}}>{oldName}</div>
        </div>
        <label style={s.label}>Новое название</label>
        <input value={newName} onChange={e=>setNewName(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"&&!loading)submit();}}
          style={{...s.input,marginBottom:16}} autoFocus/>
        {msg&&<div style={{fontSize:12,marginBottom:10,color:msg.ok?C.success:C.danger}}>{msg.text}</div>}
        <button onClick={submit} disabled={loading}
          style={{...s.btn("accent"),width:"100%",padding:"10px 0",opacity:loading?.6:1}}>
          {loading ? "Сохранение..." : "Переименовать"}
        </button>
        <div style={{fontSize:11,color:C.textDim,marginTop:10,lineHeight:1.5}}>
          ⚠ Изменения применятся ко всем существующим записям, ценам, остаткам склада, порогам и фото.
        </div>
      </div>
    </div>
  );
}

// ── Модалка смены пароля ──
function PasswordModal({ workshop, onChange, onClose }){
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [msg, setMsg] = useState(null);
  const [loading, setLoading] = useState(false);

  async function submit(){
    setLoading(true);
    setMsg(null);
    const result = await onChange(oldPwd, newPwd, confirmPwd);
    setLoading(false);
    if(result.ok){
      setMsg({ok:true, text:result.text});
      setTimeout(()=>{onClose();}, 1200);
    } else {
      setMsg({ok:false, text:result.text});
    }
  }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:100,display:"flex",alignItems:"flex-end",justifyContent:"center"}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:C.bgCard,borderRadius:"16px 16px 0 0",border:`1px solid ${C.border}`,padding:20,
        width:"100%",maxWidth:600,maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <span style={{fontWeight:700,fontSize:16}}>Сменить пароль · {workshop}</span>
          <button onClick={onClose} style={{...s.btn(),padding:"4px 10px",fontSize:12}}>✕</button>
        </div>
        <label style={s.label}>Старый пароль</label>
        <input type="password" value={oldPwd} onChange={e=>setOldPwd(e.target.value)}
          style={{...s.input,marginBottom:10}} placeholder="Текущий пароль"/>
        <label style={s.label}>Новый пароль</label>
        <input type="password" value={newPwd} onChange={e=>setNewPwd(e.target.value)}
          style={{...s.input,marginBottom:10}} placeholder="Минимум 4 символа"/>
        <label style={s.label}>Повторите новый пароль</label>
        <input type="password" value={confirmPwd} onChange={e=>setConfirmPwd(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"&&!loading)submit();}}
          style={{...s.input,marginBottom:16}} placeholder="Ещё раз"/>
        {msg&&<div style={{fontSize:12,marginBottom:10,color:msg.ok?C.success:C.danger}}>{msg.text}</div>}
        <button onClick={submit} disabled={loading}
          style={{...s.btn("accent"),width:"100%",padding:"10px 0",opacity:loading?.6:1}}>
          {loading ? "Сохранение..." : "Обновить пароль"}
        </button>
        <div style={{fontSize:11,color:C.textDim,marginTop:10,lineHeight:1.5}}>
          Пароль применяется только к мастерской <b>{workshop}</b>.<br/>
          Хранится в Supabase как SHA-256 хэш — прочитать его невозможно.
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
//  Панель управления складом (поиск + раскрыть/свернуть все)
//  ВАЖНО: определён на уровне модуля, а не внутри App.
//  Если определить внутри App — при каждом ре-рендере App компонент
//  будет пересоздан, React размонтирует input → потеря фокуса при вводе.
// ──────────────────────────────────────────────────────────────
function StockControls({ search, setSearch, onExpandAll, onCollapseAll }){
  const [localSearch, setLocalSearch] = useState(search);
  useEffect(() => { setLocalSearch(search); }, [search]);
  return (
    <div style={{marginBottom:12}}>
      <input value={localSearch} onChange={e=>{
        setLocalSearch(e.target.value);
        setSearch(e.target.value);
      }} placeholder="🔍 Поиск по маркировке..." style={{...s.input,marginBottom:8}}/>
      <div style={{display:"flex",gap:6}}>
        <button type="button" onClick={onExpandAll} style={{...s.btn(),padding:"4px 10px",fontSize:11}}>
          ▼ Раскрыть все
        </button>
        <button type="button" onClick={onCollapseAll} style={{...s.btn(),padding:"4px 10px",fontSize:11}}>
          ▲ Свернуть все
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
//  ГЛАВНЫЙ КОМПОНЕНТ
// ──────────────────────────────────────────────────────────────
export default function App(){
  // ── GitHub токен ──
  const [tokenOk, setTokenOk] = useState(hasToken());
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState("");
  const [tokenChecking, setTokenChecking] = useState(false);

  // ── авторизация ──
  const [authed, setAuthed] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwords, setPasswords] = useState({});      // хэши паролей
  const [authError, setAuthError] = useState("");
  const [pwdLoaded, setPwdLoaded] = useState(false);

  // ── данные ──
  const [workshop, setWorkshop] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("record");
  const [records, setRecords] = useState([]);
  // recordsRef — всегда актуальная копия records (для debounce saveAndSync)
  // без этого debounce 400мс может записать устаревший массив поверх свежего
  const recordsRef = useRef([]);
  useEffect(() => { recordsRef.current = records; }, [records]);
  const [prices, setPrices] = useState({});
  const pricesRef = useRef({});
  useEffect(() => { pricesRef.current = prices; }, [prices]);
  // ── EVENT SOURCING для склада ──
  // stockOps — журнал всех операций (источник правды)
  // stock — пересчитанное состояние (кеш для UI)
  // Операции только добавляются (append-only), что исключает конфликты при merge
  const [stockOps, setStockOps] = useState([]);
  const stockOpsRef = useRef([]);
  useEffect(() => { stockOpsRef.current = stockOps; }, [stockOps]);
  const [stock, setStock] = useState({ main: {}, ws: { SMART: {}, Бегемот: {} } });
  const stockMain = stock.main || {};
  const stockWS = stock.ws || { SMART: {}, Бегемот: {} };
  const stockRef = useRef(stock);
  useEffect(() => { stockRef.current = stock; }, [stock]);
  // Лог перемещений (для истории в UI)
  const [stockMoves, setStockMoves] = useState([]);
  const stockMovesRef = useRef([]);
  useEffect(() => { stockMovesRef.current = stockMoves; }, [stockMoves]);
  // Конфликты, требующие решения пользователя
  const [stockConflicts, setStockConflicts] = useState([]);
  const [stockCfg, setStockCfg] = useState({});
  const stockCfgRef = useRef({});
  useEffect(() => { stockCfgRef.current = stockCfg; }, [stockCfg]);
  const [markers, setMarkers] = useState(DEFAULT_MARKERS);
  const markersRef = useRef(markers);
  useEffect(() => { markersRef.current = markers; }, [markers]);
  const [aliases, setAliases] = useState({});  // {основное_имя: [альтернативные]}
  const aliasesRef = useRef({});
  useEffect(() => { aliasesRef.current = aliases; }, [aliases]);
  const [notes, setNotes] = useState({});      // {маркировка: "комментарий"}
  const notesRef = useRef({});
  useEffect(() => { notesRef.current = notes; }, [notes]);
  const [subcategories, setSubcategories] = useState({});  // {категория: {подкатегория: [маркировки]}}
  const subcategoriesRef = useRef({});
  useEffect(() => { subcategoriesRef.current = subcategories; }, [subcategories]);

  // форма записи
  const [category, setCategory] = useState("Автомобильные");
  const [marker, setMarker] = useState("");
  const [qty, setQty] = useState(0);
  const [defect, setDefect] = useState(0);
  const [amount, setAmount] = useState(0);
  const [manualAmount, setManualAmount] = useState(false);
  const [comment, setComment] = useState("");
  const [recordType, setRecordType] = useState("sale");
  const [submitMsg, setSubmitMsg] = useState(null);
  const [markerPhoto, setMarkerPhoto] = useState(null);
  const [photoCache, setPhotoCache] = useState({});

  // статистика
  const [statsPeriod, setStatsPeriod] = useState("day");
  const [statsDate, setStatsDate] = useState(todayStr());

  // склад
  const [stockTab, setStockTab] = useState("ws");
  // Запоминаем позицию скролла для каждой вкладки склада
  const stockScrollRef = useRef({}); // {ws: 0, main: 0, move: 0}
  const switchStockTab = (newTab) => {
    // Сохраняем позицию текущей вкладки
    stockScrollRef.current[stockTab] = window.scrollY;
    setStockTab(newTab);
    // Восстанавливаем позицию новой вкладки (после рендера)
    setTimeout(() => {
      window.scrollTo(0, stockScrollRef.current[newTab] || 0);
    }, 0);
  };
  const [expandedCats, setExpandedCats] = useState({});
  const [expandedSubcats, setExpandedSubcats] = useState({}); // {"cat|subName": true/false}
  const [stockSort, setStockSort] = useState("alpha"); // alpha | qty-desc | qty-asc | empty-first
  const [stockFilter, setStockFilter] = useState("all"); // all | with-stock | empty | low
  const [catFilter, setCatFilter] = useState({}); // {категория: "all" | "with-stock" | "empty"}
  const [moveMarker, setMoveMarker] = useState("");
  const [moveTo, setMoveTo] = useState("SMART");
  const [moveQty, setMoveQty] = useState(1);
  const [moveMsg, setMoveMsg] = useState(null);
  const [stockSearch, setStockSearch] = useState("");

  // цены
  const [priceSearch, setPriceSearch] = useState("");
  const [priceExpandedCats, setPriceExpandedCats] = useState({});
  const [newMarkerCat, setNewMarkerCat] = useState("");
  const [newMarkerName, setNewMarkerName] = useState("");
  const [newMarkerMsg, setNewMarkerMsg] = useState(null);

  // редактирование
  const [editRec, setEditRec] = useState(null);

  // ── форма записи: режим отображения маркировок ──
  const [showAllMarkers, setShowAllMarkers] = useState(false);
  const [markerSearch, setMarkerSearch] = useState("");

  // ── Дебаунс-система для отложенного сохранения в GitHub ──
  // Решает проблему race condition при быстром вводе цифр
  const [saveStatus, setSaveStatus] = useState({}); // {key: "saving" | "saved" | "error"}
  const saveTimers = useRef({});
  function debouncedSave(key, value, delayMs = 800){
    // Мгновенно обновляем UI-статус
    setSaveStatus(p => ({...p, [key]: "saving"}));
    // Отменяем предыдущий таймер
    if(saveTimers.current[key]){
      clearTimeout(saveTimers.current[key]);
    }
    // Ставим новый
    saveTimers.current[key] = setTimeout(async () => {
      const result = await sSet(key, value);
      setSaveStatus(p => ({...p, [key]: result.ok ? "saved" : "error"}));
      // Через 2 сек убираем статус "saved"
      if(result.ok){
        setTimeout(() => {
          setSaveStatus(p => {
            const np = {...p};
            delete np[key];
            return np;
          });
        }, 2000);
      }
    }, delayMs);
  }
  // Эффект для очистки таймеров при размонтировании
  useEffect(() => {
    return () => {
      Object.values(saveTimers.current).forEach(t => clearTimeout(t));
    };
  }, []);

  // ── Подкатегории: создать / удалить / добавить маркировку / убрать ──
  async function createSubcategory(cat, subName){
    subName = (subName||"").trim();
    if(!subName) return {ok:false, text:"Введите название"};
    const subs = ensureObj(safeSubcategories[cat]);
    if(subs[subName]) return {ok:false, text:"Такая подкатегория уже есть"};
    const next = {...safeSubcategories, [cat]: {...subs, [subName]: []}};
    await saveAndSync("subcategories", next, setSubcategories);
    return {ok:true, text:`Подкатегория «${subName}» создана`};
  }

  async function deleteSubcategory(cat, subName){
    if(!confirm(`Удалить подкатегорию «${subName}»?`)) return;
    const subs = ensureObj(safeSubcategories[cat]);
    const nextSubs = {...subs};
    delete nextSubs[subName];
    const next = {...safeSubcategories, [cat]: nextSubs};
    await saveAndSync("subcategories", next, setSubcategories);
  }

  async function addMarkerToSubcategory(cat, subName, markerName){
    const subs = ensureObj(safeSubcategories[cat]);
    const existing = subs[subName] || [];
    if(existing.includes(markerName)) return {ok:false, text:"Уже в подкатегории"};
    // Убираем из других подкатегорий этой категории
    const nextSubs = {};
    for(const [sn, ms] of Object.entries(subs)){
      if(sn === subName){
        nextSubs[sn] = [...ms, markerName];
      } else {
        nextSubs[sn] = ms.filter(m => m !== markerName);
      }
    }
    const next = {...safeSubcategories, [cat]: nextSubs};
    await saveAndSync("subcategories", next, setSubcategories);
    return {ok:true, text:`«${markerName}» → ${subName}`};
  }

  async function removeMarkerFromSubcategory(cat, subName, markerName){
    const subs = ensureObj(safeSubcategories[cat]);
    const nextSubs = {...subs};
    nextSubs[subName] = (nextSubs[subName]||[]).filter(m => m !== markerName);
    const next = {...safeSubcategories, [cat]: nextSubs};
    await saveAndSync("subcategories", next, setSubcategories);
  }

  async function renameSubcategory(cat, oldName, newName){
    newName = (newName||"").trim();
    if(!newName) return {ok:false, text:"Введите название"};
    if(oldName === newName) return {ok:false, text:"Имя не изменилось"};
    const subs = ensureObj(safeSubcategories[cat]);
    if(subs[newName]) return {ok:false, text:"Такая подкатегория уже есть"};
    const nextSubs = {};
    for(const [sn, ms] of Object.entries(subs)){
      if(sn === oldName) nextSubs[newName] = ms;
      else nextSubs[sn] = ms;
    }
    const next = {...safeSubcategories, [cat]: nextSubs};
    await saveAndSync("subcategories", next, setSubcategories);
    return {ok:true, text:`«${oldName}» → «${newName}»`};
  }

  // переименование маркировки
  const [renameModal, setRenameModal] = useState(null); // {cat, oldName}
  // алиасы — модалка
  const [aliasesModal, setAliasesModal] = useState(null); // {cat, markerName}
  // комментарий — модалка
  const [noteModal, setNoteModal] = useState(null); // {markerName}
  // фото — модалка просмотра в полном размере
  const [photoModal, setPhotoModal] = useState(null); // {url, markerName}
  // создание подкатегории — ввод названия
  const [newSubInput, setNewSubInput] = useState({});
  // модалка управления подкатегориями
  const [subModal, setSubModal] = useState(null); // {cat}
  // текущее время (тикает каждую минуту)
  const [nowTime, setNowTime] = useState(new Date());

  // ── WebSocket + Polling синхронизация ──
  const [syncStatus, setSyncStatus] = useState("idle"); // idle | syncing | synced | ws | offline
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(() => getQueue().length);
  const lastDataHashRef = useRef("");
  const skipPollRef = useRef(0);
  const wsRef = useRef(null);
  const wsConnectedRef = useRef(false);
  const ablyChannelRef = useRef(null);
  const doPollRef = useRef(null); // ссылка на функцию poll для вызова из WS
  const stateSettersRef = useRef({}); // маппинг key → setter для мгновенного применения Ably-обновлений
  const lastBroadcastTsRef = useRef({}); // {key: ts} — защита от эха собственных сообщений
  const clientIdRef = useRef(CLIENT_ID); // ID этого клиента для фильтрации собственных сообщений
  const flushQueueRef = useRef(null); // ссылка на функцию flushQueue для вызова из useEffect

  // Универсальное сохранение: обновляет state + пишет в GitHub + мгновенно рассылает данные через Ably
  // Debounce для GitHub: 7 быстрых нажатий +/- = 1 PUT запрос (через 400мс после последнего)
  const saveTimersRef = useRef({}); // {key: setTimeout_id}
  async function saveAndSync(key, value, setter) {
    if (setter) setter(value);
    skipPollRef.current = 3;
    
    // Ably publish — мгновенно, без debounce (другое устройство должно видеть сразу)
    if (navigator.onLine && ablyChannelRef.current) {
      try {
        const ts = Date.now();
        lastBroadcastTsRef.current[key] = ts;
        const payload = { key, value, ts, from: clientIdRef.current };
        const size = new TextEncoder().encode(JSON.stringify(payload)).length;
        if (size < 60000) {
          ablyChannelRef.current.publish('update', payload);
        } else {
          ablyChannelRef.current.publish('changed', { key, ts, from: clientIdRef.current });
        }
      } catch(e) {
        console.warn('[ABLY] publish error', e);
      }
    }
    
    // GitHub запись — с debounce 400мс (для одного key)
    // Если уже есть отложенная запись для этого key — отменяем её
    if (saveTimersRef.current[key]) {
      clearTimeout(saveTimersRef.current[key]);
    }
    return new Promise((resolve) => {
      saveTimersRef.current[key] = setTimeout(async () => {
        delete saveTimersRef.current[key];
        // Читаем актуальное значение из ref, не захваченное в замыкание
        // Это защищает от race condition: за 400мс дебаунса могло прийти обновление через Ably
        // и state уже обновился, но захваченное value было бы устаревшим
        const refMap = {
          "records": recordsRef,
          "prices": pricesRef,
          "custom:markers": markersRef,
          "marker-aliases": aliasesRef,
          "marker-notes": notesRef,
          "stock:cfg": stockCfgRef,
          "subcategories": subcategoriesRef,
          "stock-moves": stockMovesRef,
          // stock-ops записывается через appendStockOp, не через saveAndSync
        };
        const ref = refMap[key];
        const valueToSave = ref ? ref.current : value;
        const result = await sSet(key, valueToSave);
        setPendingCount(getQueue().length);
        // Если произошёл merge — перечитываем с сервера чтобы получить объединённые данные
        if (result && result.ok && result.merged && ref) {
          try {
            const remoteVal = await dbGet(key);
            if (remoteVal !== null && remoteVal !== undefined) {
              console.log(`[saveAndSync] Merge detected for "${key}", обновляем локальный state`);
              // Обновляем state через соответствующий setter
              const setterMap = stateSettersRef.current;
              if (setterMap[key]) setterMap[key](remoteVal);
            }
          } catch (e) {
            console.warn(`[saveAndSync] Не удалось перечитать "${key}":`, e.message);
          }
        }
        resolve();
      }, 400);
    });
  }

  // Старое имя для совместимости (3 места уже используют его)
  const silentSaveState = saveAndSync;

  // Атомарное сохранение stock: один файл stock.json для всех складов
  // Используется при перемещениях и любых изменениях остатков
  // Гарантирует: либо запишутся ВСЕ склады, либо НИ ОДИН (нет рассинхрона)
  async function saveStock(newStock, opts = {}) {
    setStock(newStock);
    skipPollRef.current = 3;
    // Ably — мгновенно отправляем новое состояние
    if (navigator.onLine && ablyChannelRef.current) {
      try {
        const ts = Date.now();
        lastBroadcastTsRef.current["stock"] = ts;
        const payload = { key: "stock", value: newStock, ts, from: clientIdRef.current };
        const size = new TextEncoder().encode(JSON.stringify(payload)).length;
        if (size < 60000) {
          ablyChannelRef.current.publish('update', payload);
        } else {
          ablyChannelRef.current.publish('changed', { key: "stock", ts, from: clientIdRef.current });
        }
      } catch {}
    }
    // Debounce 400мс на GitHub запись
    if (saveTimersRef.current["stock"]) clearTimeout(saveTimersRef.current["stock"]);
    return new Promise((resolve) => {
      saveTimersRef.current["stock"] = setTimeout(async () => {
        delete saveTimersRef.current["stock"];
        const valueToSave = stockRef.current; // актуальное значение
        const result = await sSet("stock", valueToSave);
        setPendingCount(getQueue().length);
        resolve(result);
      }, 400);
    });
  }

  // Лог перемещений: добавляем запись и сохраняем весь лог
  async function logStockMove(move) {
    const newMoves = [...stockMovesRef.current, { ...move, id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}` }];
    setStockMoves(newMoves);
    // Сохраняем лог (не блокируя UI)
    saveAndSync("stock-moves", newMoves, setStockMoves).catch(()=>{});
  }

  // ──────────────────────────────────────────────────────────────
  // EVENT SOURCING для склада
  // ──────────────────────────────────────────────────────────────
  // Все изменения склада = append-only операции в stock-ops.json
  // Типы операций:
  //   { type: "set",    location, marker, value, ts, client, opId }
  //   { type: "delta",  location, marker, delta, ts, client, opId }   delta может быть отрицательным
  //   { type: "init",   location, marker, value, ts, client, opId }   стартовое значение (миграция)
  //   { type: "move",   from, to, marker, qty, ts, client, opId }
  //   { type: "rename", oldMarker, newMarker, ts, client, opId }
  // location: "main" | "ws:SMART" | "ws:Бегемот"
  //
  // Конфликты: только set-операции могут конфликтовать (два устройства установили
  // разные значения одновременно). move/delta/init — складываются без конфликтов.

  // Пересчёт stock из журнала операций
  function applyOpsToStock(ops) {
    const result = { main: {}, ws: { SMART: {}, Бегемот: {} } };
    const sortedOps = [...ops].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    
    for (const op of sortedOps) {
      if (op.type === "set" || op.type === "init") {
        const [scope, ws] = parseLocation(op.location);
        if (scope === "main") {
          result.main[op.marker] = op.value;
        } else {
          result.ws[ws] = result.ws[ws] || {};
          result.ws[ws][op.marker] = op.value;
        }
      } else if (op.type === "delta") {
        const [scope, ws] = parseLocation(op.location);
        if (scope === "main") {
          result.main[op.marker] = Math.max((result.main[op.marker] || 0) + op.delta, 0);
        } else {
          result.ws[ws] = result.ws[ws] || {};
          result.ws[ws][op.marker] = Math.max((result.ws[ws][op.marker] || 0) + op.delta, 0);
        }
      } else if (op.type === "move") {
        // from → to
        const [fScope, fWs] = parseLocation(op.from);
        const [tScope, tWs] = parseLocation(op.to);
        // списываем с from
        if (fScope === "main") {
          result.main[op.marker] = Math.max((result.main[op.marker] || 0) - op.qty, 0);
        } else {
          result.ws[fWs] = result.ws[fWs] || {};
          result.ws[fWs][op.marker] = Math.max((result.ws[fWs][op.marker] || 0) - op.qty, 0);
        }
        // добавляем к to
        if (tScope === "main") {
          result.main[op.marker] = (result.main[op.marker] || 0) + op.qty;
        } else {
          result.ws[tWs] = result.ws[tWs] || {};
          result.ws[tWs][op.marker] = (result.ws[tWs][op.marker] || 0) + op.qty;
        }
      } else if (op.type === "rename") {
        // Перенос значений всех складов со старого имени на новое
        if (result.main[op.oldMarker] !== undefined) {
          result.main[op.newMarker] = result.main[op.oldMarker];
          delete result.main[op.oldMarker];
        }
        for (const ws of WORKSHOPS) {
          if (result.ws[ws] && result.ws[ws][op.oldMarker] !== undefined) {
            result.ws[ws][op.newMarker] = result.ws[ws][op.oldMarker];
            delete result.ws[ws][op.oldMarker];
          }
        }
      }
    }
    return result;
  }

  function parseLocation(loc) {
    if (loc === "main") return ["main", null];
    if (loc.startsWith("ws:")) return ["ws", loc.slice(3)];
    return ["main", null];
  }

  function makeOpId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // Добавить операцию в журнал и пересчитать stock
  // type: 'set' | 'delta' | 'move' | 'rename' | 'init'
  // payload: зависит от type
  // ВАЖНО: операция добавляется в local state мгновенно (UI обновляется сразу),
  // но запись в GitHub может не дойти из-за обрыва сети или 409 конфликта.
  // Поэтому каждая операция также попадает в unsyncedOpsRef — список операций,
  // которые мы должны гарантированно доставить на сервер.
  // После успешной записи (или merge) список чистится.
  const unsyncedOpsRef = useRef(new Set()); // Set opId которые ещё не подтверждены на сервере
  async function appendStockOp(type, payload) {
    const op = {
      ...payload,
      type,
      ts: Date.now(),
      client: clientIdRef.current,
      opId: makeOpId(),
    };
    // Помечаем как несинхронизированную
    unsyncedOpsRef.current.add(op.opId);
    const newOps = [...stockOpsRef.current, op];
    setStockOps(newOps);
    // Пересчитываем stock
    const newStock = applyOpsToStock(newOps);
    setStock(newStock);
    // Отправляем через Ably (инкрементально — только новую операцию)
    if (navigator.onLine && ablyChannelRef.current) {
      try {
        ablyChannelRef.current.publish('stock-op', { op, from: clientIdRef.current });
      } catch {}
    }
    // Сохраняем весь журнал (debounce)
    if (saveTimersRef.current["stock-ops"]) clearTimeout(saveTimersRef.current["stock-ops"]);
    return new Promise((resolve) => {
      saveTimersRef.current["stock-ops"] = setTimeout(async () => {
        delete saveTimersRef.current["stock-ops"];
        // Перед записью — перечитываем сервер, чтобы получить все операции других устройств
        // Это гарантирует что наша запись будет включать все актуальные данные
        let opsToSave = stockOpsRef.current;
        try {
          const remoteOps = await dbGet("stock-ops");
          if (Array.isArray(remoteOps)) {
            // Merge: remote + локальные (включая наши несинхронизированные)
            const localIds = new Set(opsToSave.map(o => o.opId));
            const merged = [...remoteOps];
            for (const op of opsToSave) {
              if (!remoteOps.some(r => r.opId === op.opId)) {
                merged.push(op);
              }
            }
            if (merged.length !== opsToSave.length) {
              console.log(`[appendStockOp] Pre-write merge: ${opsToSave.length} → ${merged.length}`);
              opsToSave = merged;
              setStockOps(merged);
              setStock(applyOpsToStock(merged));
            }
          }
        } catch (e) {
          console.warn('[appendStockOp] Pre-read failed:', e.message);
        }
        const result = await sSet("stock-ops", opsToSave);
        setPendingCount(getQueue().length);
        // После записи — проверяем, все ли наши операции дошли
        // Перечитываем сервер и убеждаемся, что все opId из unsyncedOpsRef там есть
        if (result && (result.ok || result.queued)) {
          try {
            const finalOps = await dbGet("stock-ops");
            if (Array.isArray(finalOps)) {
              const serverIds = new Set(finalOps.map(o => o.opId));
              const stillMissing = [...unsyncedOpsRef.current].filter(id => !serverIds.has(id));
              if (stillMissing.length === 0) {
                // Все операции дошли — обновляем state и чистим unsynced
                unsyncedOpsRef.current.clear();
                setStockOps(finalOps);
                setStock(applyOpsToStock(finalOps));
                console.log(`[appendStockOp] All ops synced (${finalOps.length} total)`);
              } else {
                console.warn(`[appendStockOp] ${stillMissing.length} ops still missing on server, retrying...`);
                // Принудительно добавляем недостающие операции и записываем снова
                const retryOps = [...finalOps];
                for (const op of opsToSave) {
                  if (stillMissing.includes(op.opId) && !retryOps.some(r => r.opId === op.opId)) {
                    retryOps.push(op);
                  }
                }
                setStockOps(retryOps);
                setStock(applyOpsToStock(retryOps));
                await sSet("stock-ops", retryOps);
              }
            }
          } catch (e) {
            console.warn('[appendStockOp] Post-write verify failed:', e.message);
          }
        }
        resolve(result);
      }, 500);
    });
  }

  // Применить операцию, пришедшую с другого устройства через Ably
  function applyRemoteStockOp(op) {
    // Проверка дубликата по opId
    if (stockOpsRef.current.some(o => o.opId === op.opId)) return;
    const newOps = [...stockOpsRef.current, op];
    setStockOps(newOps);
    const newStock = applyOpsToStock(newOps);
    setStock(newStock);
    // Проверка конфликта: если у нас есть локальная set-операция с тем же marker+location
    // и близким ts (±5 сек) — это конфликт
    detectConflict(op);
  }

  // Обнаружение конфликтов set-операций
  function detectConflict(newOp) {
    if (newOp.type !== "set") return;
    // Ищем локальные set-операции с тем же marker+location за последние 30 сек
    const conflicting = stockOpsRef.current.find(o =>
      o.opId !== newOp.opId &&
      o.type === "set" &&
      o.marker === newOp.marker &&
      o.location === newOp.location &&
      Math.abs((o.ts || 0) - (newOp.ts || 0)) < 30000 &&
      o.value !== newOp.value
    );
    if (conflicting) {
      setStockConflicts(prev => {
        // Не добавляем дубликат
        if (prev.some(c => c.local.opId === conflicting.opId && c.remote.opId === newOp.opId)) return prev;
        return [...prev, { local: conflicting, remote: newOp }];
      });
    }
  }

  // Разрешение конфликта пользователем
  async function resolveConflict(conflict, chosenValue) {
    // Добавляем set-операцию с выбранным значением — она перекроет обе
    await appendStockOp("set", {
      location: conflict.local.location,
      marker: conflict.local.marker,
      value: chosenValue,
    });
    // Убираем из списка конфликтов
    setStockConflicts(prev => prev.filter(c => !(c.local.opId === conflict.local.opId && c.remote.opId === conflict.remote.opId)));
  }

  // Сохранить stockOps в GitHub (используется при начальной загрузке и flush)
  async function saveStockOps() {
    if (saveTimersRef.current["stock-ops"]) clearTimeout(saveTimersRef.current["stock-ops"]);
    const result = await sSet("stock-ops", stockOpsRef.current);
    setPendingCount(getQueue().length);
    return result;
  }

  useEffect(() => {
    if (!authed) return;

    // Заполняем маппинг ключей → setters для мгновенного применения Ably-обновлений
    stateSettersRef.current = {
      "records": setRecords,
      "prices": setPrices,
      "stock-ops": (ops) => { setStockOps(ops); setStock(applyOpsToStock(ops)); },
      "stock-moves": setStockMoves,
      "stock:cfg": setStockCfg,
      "custom:markers": setMarkers,
      "marker-aliases": setAliases,
      "marker-notes": setNotes,
      "subcategories": setSubcategories,
      "passwords": setPasswords,
    };

    // ── Ably (мгновенная синхронизация) ──
    const channel = ably.channels.get('masterskaya-sync');
    
    channel.subscribe((msg) => {
      // Защита от получения собственных сообщений
      if (msg.data && msg.data.from === clientIdRef.current) return;
      
      if (msg.name === 'update' && msg.data && msg.data.key) {
        const { key, value, ts } = msg.data;
        // Пропускаем устаревшие сообщения (если уже приняли более свежее)
        const lastTs = lastBroadcastTsRef.current[key] || 0;
        if (ts <= lastTs) return;
        lastBroadcastTsRef.current[key] = ts;
        
        console.log('[ABLY] Получено обновление для:', key);
        skipPollRef.current = 3; // не даём polling'у перезаписать наши данные
        
        // Сохраняем позицию скролла
        const sY = window.scrollY;
        
        // Применяем value через setter
        const setter = stateSettersRef.current[key];
        if (setter) {
          setter(value);
        } else {
          console.warn('[ABLY] Нет setter для ключа:', key);
        }
        
        // Восстанавливаем позицию скролла
        setTimeout(() => window.scrollTo(0, sY), 0);
      } else if (msg.name === 'record-added' && msg.data && msg.data.rec) {
        // Инкрементальное обновление records — не тянем весь массив с GitHub
        const { rec } = msg.data;
        console.log('[ABLY] Новая запись:', rec.marker);
        skipPollRef.current = 3;
        const sY = window.scrollY;
        setRecords(prev => {
          // Защита от дублей (по timestamp)
          if (prev.some(r => r.timestamp === rec.timestamp)) return prev;
          return [...prev, rec];
        });
        setTimeout(() => window.scrollTo(0, sY), 0);
      } else if (msg.name === 'record-updated' && msg.data && msg.data.idx !== undefined) {
        const { idx, rec } = msg.data;
        console.log('[ABLY] Обновлена запись:', idx, rec.marker);
        skipPollRef.current = 3;
        const sY = window.scrollY;
        setRecords(prev => prev.map((r, i) => i === idx ? rec : r));
        setTimeout(() => window.scrollTo(0, sY), 0);
      } else if (msg.name === 'record-deleted' && msg.data && msg.data.idx !== undefined) {
        const { idx } = msg.data;
        console.log('[ABLY] Удалена запись:', idx);
        skipPollRef.current = 3;
        const sY = window.scrollY;
        setRecords(prev => prev.filter((_, i) => i !== idx));
        setTimeout(() => window.scrollTo(0, sY), 0);
      } else if (msg.name === 'stock-op' && msg.data && msg.data.op) {
        // Инкрементальная синхронизация склада через event sourcing
        const { op } = msg.data;
        console.log('[ABLY] Stock op:', op.type, op.marker || op.oldMarker);
        skipPollRef.current = 3;
        applyRemoteStockOp(op);
      } else if (msg.name === 'changed') {
        // Fallback: большой payload, нужно сделать polling
        console.log('[ABLY] Signal changed для:', msg.data?.key);
        if (doPollRef.current) doPollRef.current();
      }
    });

    ably.connection.on('connected', () => {
      console.log('[ABLY] Подключено');
      wsConnectedRef.current = true;
      if (navigator.onLine) setSyncStatus("ws");
    });

    ably.connection.on('disconnected', () => {
      console.log('[ABLY] Отключено, переподключаемся...');
      wsConnectedRef.current = false;
      if (navigator.onLine) setSyncStatus("synced"); // не "idle" — polling продолжит работать
      // Ably сам переподключится через disconnectedRetryTimeout (2 сек)
    });
    
    ably.connection.on('suspended', () => {
      console.log('[ABLY] Suspended, ждём переподключения...');
      wsConnectedRef.current = false;
      if (navigator.onLine) setSyncStatus("synced");
    });
    
    ably.connection.on('failed', (stateChange) => {
      console.error('[ABLY] Failed:', stateChange.reason);
      wsConnectedRef.current = false;
      setSyncStatus("idle");
    });

    // Если уже подключён
    if (ably.connection.state === 'connected') {
      wsConnectedRef.current = true;
      setSyncStatus("ws");
    }

    // Сохраняем channel для saveAndSync
    ablyChannelRef.current = channel;

    // ── Polling (fallback если Ably не работает) ──
    const poll = async () => {
      if (skipPollRef.current > 0) {
        skipPollRef.current--;
        setSyncStatus(wsConnectedRef.current ? "ws" : "synced");
        return;
      }
      setSyncStatus("syncing");
      try {
        const [r,p,ops,sCfg,sm2,al,nt,mvs] = await Promise.all([
          sGet("records"), sGet("prices"),
          sGet("stock-ops"),
          sGet("stock:cfg"), sGet("custom:markers"), sGet("marker-aliases"), sGet("marker-notes"),
          sGet("stock-moves"),
        ]);
        const hash = JSON.stringify({r, p, ops, sCfg, sm2, al, nt, mvs});
        if (hash === lastDataHashRef.current) {
          setSyncStatus(wsConnectedRef.current ? "ws" : "synced");
          return;
        }
        lastDataHashRef.current = hash;
        const sY = window.scrollY;
        if(Array.isArray(r)) setRecords(r);
        if(p && typeof p === "object" && !Array.isArray(p)) setPrices(p);
        // Пересчитываем stock из журнала операций
        if(Array.isArray(ops)){
          setStockOps(ops);
          setStock(applyOpsToStock(ops));
        }
        if(sCfg && typeof sCfg === "object" && !Array.isArray(sCfg)) setStockCfg(sCfg);
        if(sm2 && typeof sm2 === "object" && !Array.isArray(sm2)) setMarkers(sm2);
        if(al && typeof al === "object" && !Array.isArray(al)) setAliases(al);
        if(nt && typeof nt === "object" && !Array.isArray(nt)) setNotes(nt);
        if(Array.isArray(mvs)) setStockMoves(mvs);
        setTimeout(()=>window.scrollTo(0, sY), 0);
        setSyncStatus(wsConnectedRef.current ? "ws" : "synced");
      } catch(e) {
        setSyncStatus("idle");
      }
    };

    doPollRef.current = poll;

    // ── flushQueue: отправляет накопленные в офлайне изменения на GitHub ──
    const flushQueue = async () => {
      const q = getQueue();
      if (q.length === 0) {
        setPendingCount(0);
        // Даже если очередь пуста — перечитываем данные с сервера
        // (телефон мог пропустить изменения пока был офлайн)
        if (doPollRef.current) {
          console.log('[OFFLINE] Очередь пуста, перечитываем данные с сервера');
          doPollRef.current();
        }
        return;
      }
      console.log(`[OFFLINE] Отправляем очередь: ${q.length} элементов`);
      setSyncStatus("syncing");
      const remaining = [];
      for (const item of q) {
        try {
          // Используем mergeFn для всех ключей — иначе теряем данные другого устройства
          const mergeFn = getMergeFn(item.key);
          const result = await dbSet(item.key, item.val, mergeFn);
          if (result.ok) {
            cacheSet(item.key, item.val);
            // Рассылаем через Ably — другие устройства тоже получат обновление
            if (ablyChannelRef.current) {
              try {
                const payload = { key: item.key, value: item.val, ts: Date.now(), from: clientIdRef.current };
                const size = new TextEncoder().encode(JSON.stringify(payload)).length;
                if (size < 60000) {
                  ablyChannelRef.current.publish('update', payload);
                } else {
                  ablyChannelRef.current.publish('changed', { key: item.key, ts: Date.now(), from: clientIdRef.current });
                }
              } catch {}
            }
          } else {
            remaining.push(item);
          }
        } catch (e) {
          console.warn(`[OFFLINE] Ошибка отправки "${item.key}":`, e.message);
          remaining.push(item);
        }
      }
      setQueue(remaining);
      setPendingCount(remaining.length);
      setSyncStatus(remaining.length === 0 ? (wsConnectedRef.current ? "ws" : "synced") : "offline");
      if (remaining.length === 0 && doPollRef.current) {
        // После успешной отправки — подтянем свежие данные
        setTimeout(() => doPollRef.current && doPollRef.current(), 500);
      }
    };
    flushQueueRef.current = flushQueue;

    // ── Слушатели online/offline ──
    const handleOnline = () => {
      console.log('[OFFLINE] Сеть восстановлена');
      setIsOnline(true);
      // Сбрасываем хэш чтобы polling гарантированно применил свежие данные
      // (даже если серверные данные совпадают с нашими устаревшими по структурам,
      // но отличаются по содержимому — это заставит poll перечитать и обновить state)
      lastDataHashRef.current = "";
      // Небольшая задержка чтобы соединение установилось
      setTimeout(() => flushQueueRef.current && flushQueueRef.current(), 1000);
    };
    const handleOffline = () => {
      console.log('[OFFLINE] Сеть потеряна — работаем офлайн');
      setIsOnline(false);
      setSyncStatus("offline");
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    // Если стартовали онлайн, но в очереди что-то есть — отправим
    if (navigator.onLine && getQueue().length > 0) {
      setTimeout(() => flushQueueRef.current && flushQueueRef.current(), 2000);
    }

    const initialTimer = setTimeout(poll, 3000);
    const interval = setInterval(poll, 60000); // polling каждые 60 сек (Ably для мгновенной)

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
      channel.unsubscribe();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [authed]);
  useEffect(() => {
    const t = setInterval(() => setNowTime(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  // ── загрузка при старте ──
  useEffect(()=>{
    (async()=>{
      // Загружаем пароли из Supabase (или инициализируем дефолтные)
      let pwd = await sGet("passwords");
      if(!pwd){
        pwd = {};
        for(const ws of WORKSHOPS){
          pwd[ws] = await sha256(DEFAULT_PASSWORDS[ws]);
        }
        await sSet("passwords", pwd);
      }
      setPasswords(pwd);
      setPwdLoaded(true);

      // Загружаем остальные данные
      const [r,p,ops,stk,sCfg,sm2,al,nt,sub,mvs] = await Promise.all([
        sGet("records"), sGet("prices"),
        sGet("stock-ops"),
        sGet("stock"),
        sGet("stock:cfg"), sGet("custom:markers"), sGet("marker-aliases"), sGet("marker-notes"), sGet("subcategories"),
        sGet("stock-moves"),
      ]);
      // Защита: гарантируем, что у нас правильные типы (массив/объект),
      // иначе рендер упадёт с белым экраном
      if(Array.isArray(r)) setRecords(r);
      if(p && typeof p === "object" && !Array.isArray(p)) setPrices(p);
      
      // Миграция на event sourcing:
      // Если stock-ops.json есть — используем его
      // Если нет — читаем старые stock.json или stock:main + stock:ws:X
      // и преобразуем в начальные init-операции
      if(Array.isArray(ops) && ops.length > 0){
        setStockOps(ops);
        setStock(applyOpsToStock(ops));
        console.log(`[STOCK] Загружено ${ops.length} операций`);
      } else {
        // Миграция: читаем старые данные
        let oldStock = null;
        if(stk && typeof stk === "object" && stk.main){
          oldStock = stk;
        } else {
          const [sm, sS] = await Promise.all([
            sGet("stock:main"),
            Promise.all(WORKSHOPS.map(w=>sGet(`stock:ws:${w}`))),
          ]);
          if(sm || sS.some(v => v)){
            oldStock = {
              main: ensureObj(sm),
              ws: {}
            };
            WORKSHOPS.forEach((w,i)=>{
              const v = sS[i];
              oldStock.ws[w] = (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
            });
          }
        }
        
        if(oldStock){
          // Создаём init-операции для каждой маркировки
          const initOps = [];
          const initTs = Date.now();
          for(const [marker, value] of Object.entries(oldStock.main || {})){
            if(value > 0){
              initOps.push({
                type: "init",
                location: "main",
                marker,
                value,
                ts: initTs,
                client: "migration",
                opId: `${initTs}-main-${marker}-${Math.random().toString(36).slice(2,6)}`,
              });
            }
          }
          for(const ws of WORKSHOPS){
            for(const [marker, value] of Object.entries(oldStock.ws?.[ws] || {})){
              if(value > 0){
                initOps.push({
                  type: "init",
                  location: `ws:${ws}`,
                  marker,
                  value,
                  ts: initTs,
                  client: "migration",
                  opId: `${initTs}-ws${ws}-${marker}-${Math.random().toString(36).slice(2,6)}`,
                });
              }
            }
          }
          setStockOps(initOps);
          setStock(applyOpsToStock(initOps));
          await sSet("stock-ops", initOps);
          console.log(`[MIGRATION] Создано ${initOps.length} init-операций из старого stock`);
        } else {
          setStock({ main: {}, ws: { SMART: {}, Бегемот: {} } });
        }
      }
      
      if(Array.isArray(mvs)) setStockMoves(mvs);
      if(sCfg && typeof sCfg === "object" && !Array.isArray(sCfg)) setStockCfg(sCfg);
      if(sm2 && typeof sm2 === "object" && !Array.isArray(sm2)) setMarkers(sm2);
      if(al && typeof al === "object" && !Array.isArray(al)) setAliases(al);
      if(nt && typeof nt === "object" && !Array.isArray(nt)) setNotes(nt);
      if(sub && typeof sub === "object" && !Array.isArray(sub)) setSubcategories(sub);

      // Проверяем сохранённую авторизацию
      try{
        const savedAuth = localStorage.getItem(LOCAL_AUTH_KEY);
        const savedWs = localStorage.getItem(LOCAL_WS_KEY);
        if(savedAuth==="1" && savedWs && WORKSHOPS.includes(savedWs)){
          setWorkshop(savedWs);
          setAuthed(true);
        }
      }catch{}
      setLoading(false);
    })();
  },[]);

  // ── авто-расчёт суммы для sale ──
  useEffect(()=>{
    if(manualAmount) return;
    if(recordType === "refund") return;  // для возврата всегда ручной ввод
    const p = prices[marker];
    if(p) setAmount(qty * p);   // сумма = только готовые × цена
  },[marker,qty,defect,manualAmount,prices,recordType]);

  // ── фото маркировки ──
  // Тот же кеш «нет фото», что и в MarkerPhotoThumb
  const NO_PHOTO_KEY = "no_photo_markers";
  useEffect(()=>{
    if(!marker){setMarkerPhoto(null);return;}
    const cached=photoCache[marker];
    if(cached!==undefined){setMarkerPhoto(cached);return;}
    // Если знаем что фото нет — не дёргаем GitHub
    try {
      const noPhoto = JSON.parse(localStorage.getItem(NO_PHOTO_KEY) || "[]");
      if(noPhoto.includes(marker)){
        setPhotoCache(p=>({...p,[marker]:null}));
        setMarkerPhoto(null);
        return;
      }
    } catch {}
    photoGet(marker).then(v=>{
      setPhotoCache(p=>({...p,[marker]:v}));
      setMarkerPhoto(v);
      if(v === null){
        try {
          const set = JSON.parse(localStorage.getItem(NO_PHOTO_KEY) || "[]");
          if(!set.includes(marker)){
            set.push(marker);
            if(set.length > 500) set.splice(0, set.length - 500);
            localStorage.setItem(NO_PHOTO_KEY, JSON.stringify(set));
          }
        } catch {}
      }
    });
  },[marker]);

  // ── авторизация ──
  async function handleLogin(){
    setAuthError("");
    if(!passwordInput){ setAuthError("Введите пароль"); return; }
    const hash = await sha256(passwordInput);
    for(const ws of WORKSHOPS){
      if(passwords[ws] === hash){
        setWorkshop(ws);
        setAuthed(true);
        try{
          localStorage.setItem(LOCAL_WS_KEY, ws);
          localStorage.setItem(LOCAL_AUTH_KEY, "1");
        }catch{}
        setPasswordInput("");
        return;
      }
    }
    setAuthError("Неверный пароль");
  }
  function handleLogout(){
    setAuthed(false);
    setWorkshop(null);
    try{
      localStorage.removeItem(LOCAL_WS_KEY);
      localStorage.removeItem(LOCAL_AUTH_KEY);
    }catch{}
  }

  // ── GitHub токен: вход / выход ──
  async function handleTokenSubmit(){
    setTokenError("");
    setTokenChecking(true);
    const result = await verifyToken(tokenInput.trim());
    setTokenChecking(false);
    if(result.ok){
      setToken(tokenInput.trim());
      setTokenOk(true);
      setTokenInput("");
      // Перезагружаем чтобы инициализация прошла с токеном
      window.location.reload();
    } else {
      setTokenError(result.error || "Неверный токен");
    }
  }
  function handleTokenLogout(){
    clearToken();
    setTokenOk(false);
    setAuthed(false);
    setWorkshop(null);
    try{
      localStorage.removeItem(LOCAL_WS_KEY);
      localStorage.removeItem(LOCAL_AUTH_KEY);
    }catch{}
  }

  // ── смена пароля ──
  const [pwdModalOpen, setPwdModalOpen] = useState(false);
  async function handleChangePassword(oldPwd, newPwd, confirmPwd){
    if(!oldPwd || !newPwd){ return {ok:false, text:"Заполните все поля"}; }
    if(newPwd.length < 4){ return {ok:false, text:"Новый пароль слишком короткий (мин. 4 символа)"}; }
    if(newPwd !== confirmPwd){ return {ok:false, text:"Пароли не совпадают"}; }
    const oldHash = await sha256(oldPwd);
    if(passwords[workshop] !== oldHash){
      return {ok:false, text:"Старый пароль неверный"};
    }
    const newHash = await sha256(newPwd);
    const next = {...passwords, [workshop]: newHash};
    await saveAndSync("passwords", next, setPasswords);
    return {ok:true, text:"Пароль обновлён"};
  }

  // ── добавление записи ──
  async function submitRecord(){
    if(!marker.trim()){setSubmitMsg({ok:false,text:"Укажите маркировку"});return;}
    if(recordType==="sale" && qty===0 && defect===0){
      setSubmitMsg({ok:false,text:"Укажите количество или брак"});return;
    }
    if(amount<0){setSubmitMsg({ok:false,text:"Сумма не может быть отрицательной"});return;}

    const m = marker.trim();
    const rec = {
      workshop, category, marker: m, qty, defect, amount, comment,
      recordType, timestamp: Date.now()
    };
    const next = [...records, rec];
    // Не await'им — форма сбрасывается мгновенно, GitHub пишется в фоне
    saveAndSync("records", next, setRecords);
    // Отправляем только новую запись через Ably (не весь массив — он >60KB)
    if (ablyChannelRef.current && navigator.onLine) {
      try {
        ablyChannelRef.current.publish('record-added', { rec, from: clientIdRef.current });
      } catch {}
    }

    // Склад: списываем через stockDelta (для refund = 0, для sale = qty или defect)
    const delta = stockDelta(rec);
    if(delta > 0){
      // Списание через delta-операцию (не конфликтует с другими устройствами)
      appendStockOp("delta", {
        location: `ws:${workshop}`,
        marker: m,
        delta: -delta,
      });
    }

    // Сброс формы — мгновенно, не ждём GitHub
    setMarker(""); setQty(0); setDefect(0); setAmount(0);
    setManualAmount(false); setComment(""); setRecordType("sale");
    setSubmitMsg({ok:true, text: rec.recordType==="refund" ? "Возврат оформлен" : (rec.qty===0&&rec.defect>0 ? `Брак оформлен (${rec.defect} шт)` : "Запись добавлена")});
    setTimeout(()=>setSubmitMsg(null), 2000);
  }

  // ── сохранение редактируемой записи ──
  async function handleEditSave(updated){
    const old = records[editRec.globalIdx];

    // 1) Возвращаем старое списание (через stockDelta)
    const oldDelta = stockDelta(old);
    if(oldDelta > 0){
      appendStockOp("delta", {
        location: `ws:${old.workshop}`,
        marker: old.marker,
        delta: oldDelta,
      });
    }
    // 2) Применяем новое списание (через stockDelta)
    const newDelta = stockDelta(updated);
    if(newDelta > 0){
      appendStockOp("delta", {
        location: `ws:${updated.workshop}`,
        marker: updated.marker,
        delta: -newDelta,
      });
    }

    const next = records.map((r,i)=>i===editRec.globalIdx?updated:r);
    // Не await'им — модалка закрывается мгновенно
    saveAndSync("records", next, setRecords);
    // Отправляем только обновлённую запись через Ably
    if (ablyChannelRef.current && navigator.onLine) {
      try {
        ablyChannelRef.current.publish('record-updated', { idx: editRec.globalIdx, rec: updated, from: clientIdRef.current });
      } catch {}
    }
    setEditRec(null);
  }

  async function handleEditDelete(gi){
    if(!confirm("Удалить эту запись?")) return;
    const old = records[gi];
    // Возвращаем списание через stockDelta
    const oldDelta = stockDelta(old);
    if(oldDelta > 0){
      appendStockOp("delta", {
        location: `ws:${old.workshop}`,
        marker: old.marker,
        delta: oldDelta,
      });
    }
    const next = records.filter((_,i)=>i!==gi);
    // Не await'им — модалка закрывается мгновенно
    saveAndSync("records", next, setRecords);
    // Отправляем только индекс удалённой записи через Ably
    if (ablyChannelRef.current && navigator.onLine) {
      try {
        ablyChannelRef.current.publish('record-deleted', { idx: gi, from: clientIdRef.current });
      } catch {}
    }
    setEditRec(null);
  }

  // ── склад: перемещение ──
  // Event Sourcing: одна move-операция = атомарная запись в журнал
  // Конфликтов не бывает: операции складываются по timestamp
  async function doMove(){
    if(!moveMarker){setMoveMsg({ok:false,text:"Выберите маркировку"});return;}
    if(moveQty<=0){setMoveMsg({ok:false,text:"Количество > 0"});return;}
    const avail = stockMain[moveMarker]||0;
    if(avail<moveQty){setMoveMsg({ok:false,text:`На складе только ${avail} шт`});return;}
    
    setMoveMsg({ok:true, text:`${moveQty} шт «${moveMarker}» → ${moveTo}`});
    setMoveQty(1); setMoveMarker(""); setTimeout(()=>setMoveMsg(null), 3000);
    
    try {
      // Добавляем move-операцию в журнал — она атомарно списывает с 'from' и добавляет к 'to'
      await appendStockOp("move", {
        from: "main",
        to: `ws:${moveTo}`,
        marker: moveMarker,
        qty: moveQty,
      });
      // Лог для UI (история + отмена)
      await logStockMove({
        marker: moveMarker, qty: moveQty, from: "main", to: moveTo,
        timestamp: Date.now(), type: "move"
      });
      const pending = getQueue().length;
      if (pending > 0) {
        setMoveMsg({ok:false, text:`⚠ В очереди ${pending} · отправится автоматически`});
        setTimeout(()=>setMoveMsg(null), 4000);
      } else {
        setMoveMsg({ok:true, text:`✓ Применено: ${moveQty} шт «${moveMarker}» → ${moveTo}`});
        setTimeout(()=>setMoveMsg(null), 2500);
      }
    } catch(e) {
      console.error('[doMove] error:', e);
      setMoveMsg({ok:false, text:"⚠ Сбой. Сохранится автоматически"});
      setTimeout(()=>setMoveMsg(null), 4000);
    }
  }

  // ── отмена перемещения ──
  // Применяет обратное move-операцию и помечает оригинал как reverted
  async function undoMove(originalMove){
    if(!confirm(`Отменить перемещение ${originalMove.qty} шт «${originalMove.marker}»?`)) return;
    const m = originalMove.marker;
    const qty = originalMove.qty;
    const fromLoc = originalMove.from === "main" ? "main" : `ws:${originalMove.from}`;
    const toLoc = originalMove.to === "main" ? "main" : `ws:${originalMove.to}`;
    
    // Проверяем наличие на 'to' (откуда будем списывать при отмене)
    const availOnTo = originalMove.to === "main" 
      ? (stockMain[m]||0)
      : (stockWS[originalMove.to]?.[m]||0);
    if(availOnTo < qty){
      setMoveMsg({ok:false, text:`На складе ${originalMove.to} только ${availOnTo} шт — нельзя отменить`});
      setTimeout(()=>setMoveMsg(null), 4000);
      return;
    }
    
    // Помечаем оригинал как reverted
    const newMoves = stockMoves.map(mv => mv.id === originalMove.id ? { ...mv, reverted: true } : mv);
    setStockMoves(newMoves);
    
    try {
      // Обратная move-операция
      await appendStockOp("move", {
        from: toLoc,
        to: fromLoc,
        marker: m,
        qty: qty,
      });
      await saveAndSync("stock-moves", newMoves, setStockMoves);
      setMoveMsg({ok:true, text:`✓ Отменено: ${qty} шт «${m}» вернулись обратно`});
      setTimeout(()=>setMoveMsg(null), 3000);
    } catch(e) {
      console.error('[undoMove] error:', e);
      setMoveMsg({ok:false, text:"⚠ Сбой отмены. Попробуйте ещё раз"});
      setTimeout(()=>setMoveMsg(null), 4000);
    }
  }

  // ── маркировки: добавить / удалить ──
  async function addMarker(){
    if(!newMarkerCat || !newMarkerName.trim()){setNewMarkerMsg({ok:false,text:"Укажите категорию и название"});return;}
    const nm = newMarkerName.trim();
    if((markers[newMarkerCat]||[]).includes(nm)){setNewMarkerMsg({ok:false,text:"Уже есть"});return;}
    const next = {...markers, [newMarkerCat]:[...(markers[newMarkerCat]||[]), nm]};
    await saveAndSync("custom:markers", next, setMarkers);
    setNewMarkerName(""); setNewMarkerMsg({ok:true, text:`«${nm}» добавлена`});
    setTimeout(()=>setNewMarkerMsg(null), 2000);
  }
  async function deleteMarker(cat,m){
    if(!confirm(`Удалить «${m}»?`)) return;
    const next = {...markers, [cat]:markers[cat].filter(x=>x!==m)};
    await saveAndSync("custom:markers", next, setMarkers);
    // Удалить алиасы тоже
    if(aliases[m]){
      const nextAliases = {...aliases};
      delete nextAliases[m];
      await saveAndSync("marker-aliases", nextAliases, setAliases);
    }
  }

  // ── Алиасы: добавить / удалить / сделать основным ──
  async function addAlias(markerName, alias){
    alias = (alias||"").trim();
    if(!alias) return {ok:false, text:"Введите алиас"};
    if(alias === markerName) return {ok:false, text:"Алиас не может совпадать с основным именем"};
    const existing = aliases[markerName] || [];
    if(existing.includes(alias)) return {ok:false, text:"Такой алиас уже есть"};
    // Проверить что алиас не используется как основное имя или алиас другой маркировки
    for(const [main, alList] of Object.entries(aliases)){
      if(main !== markerName && alList.includes(alias)){
        return {ok:false, text:`Алиас «${alias}» уже используется у «${main}»`};
      }
    }
    // Проверить что алиас не является основной маркировкой в какой-то категории
    for(const cat in markers){
      if(markers[cat].includes(alias)){
        return {ok:false, text:`«${alias}» — уже самостоятельная маркировка в категории «${cat}»`};
      }
    }
    const next = {...aliases, [markerName]: [...existing, alias]};
    await saveAndSync("marker-aliases", next, setAliases);
    return {ok:true, text:`Алиас «${alias}» добавлен`};
  }

  async function removeAlias(markerName, alias){
    const existing = aliases[markerName] || [];
    const next = {...aliases, [markerName]: existing.filter(a => a !== alias)};
    if(next[markerName].length === 0) delete next[markerName];
    await saveAndSync("marker-aliases", next, setAliases);
    return {ok:true, text:`Алиас «${alias}» удалён`};
  }

  // Сделать алиас основным именем (старое основное становится алиасом)
  async function promoteAlias(cat, oldMain, newMain){
    if(oldMain === newMain) return {ok:false, text:"Это уже основное имя"};
    const existing = aliases[oldMain] || [];
    if(!existing.includes(newMain)) return {ok:false, text:"Это не алиас"};

    // 1. Обновить markers.json — заменить oldMain на newMain в категории
    const nextMarkers = {...markers, [cat]: markers[cat].map(m => m === oldMain ? newMain : m)};
    await saveAndSync("custom:markers", nextMarkers, setMarkers);

    // 2. Обновить aliases: newMain больше не алиас, oldMain становится алиасом
    const newAliases = existing.filter(a => a !== newMain);
    newAliases.push(oldMain);
    const nextAliases = {...aliases};
    delete nextAliases[oldMain];
    if(newAliases.length > 0) nextAliases[newMain] = newAliases;
    await saveAndSync("marker-aliases", nextAliases, setAliases);

    // 3. Обновить records
    let recChanged = false;
    const nextRecords = records.map(r => {
      if(r.marker === oldMain){ recChanged = true; return {...r, marker: newMain}; }
      return r;
    });
    if(recChanged){ await saveAndSync("records", nextRecords, setRecords); }

    // 4. Обновить prices
    if(prices[oldMain] !== undefined){
      const nextPrices = {...prices};
      nextPrices[newMain] = nextPrices[oldMain];
      delete nextPrices[oldMain];
      await saveAndSync("prices", nextPrices, setPrices);
    }

    // 5. Обновить склады через rename-операцию (event sourcing)
    {
      const hasInMain = stockMain[oldMain] !== undefined;
      const hasInWS = WORKSHOPS.some(ws => stockWS[ws] && stockWS[ws][oldMain] !== undefined);
      if(hasInMain || hasInWS){
        await appendStockOp("rename", {
          oldMarker: oldMain,
          newMarker: newMain,
        });
      }
    }

    // 6. Обновить stockCfg
    if(stockCfg[oldMain] !== undefined){
      const nextCfg = {...stockCfg};
      nextCfg[newMain] = nextCfg[oldMain];
      delete nextCfg[oldMain];
      await saveAndSync("stock:cfg", nextCfg, setStockCfg);
    }

    // 6a. Обновить notes (комментарии)
    if(notes[oldMain] !== undefined){
      const nextNotes = {...notes};
      nextNotes[newMain] = nextNotes[oldMain];
      delete nextNotes[oldMain];
      await saveAndSync("marker-notes", nextNotes, setNotes);
    }

    // 7. Фото — асинхронно
    photoGet(oldMain).then(async photo => {
      if(photo){
        await photoSet(newMain, photo);
        try { await photoDelete(oldMain); } catch {}
      }
    });

    return {ok:true, text:`«${oldMain}» → «${newMain}» (теперь основное)`};
  }


  // ── переименование маркировки (синхронизируется во ВСЕХ местах) ──
  async function renameMarker(cat, oldName, newName){
    newName = (newName||"").trim();
    if(!newName){ return {ok:false, text:"Введите новое название"}; }
    if(newName === oldName){ return {ok:false, text:"Название не изменилось"}; }
    // Проверка на дубликат во ВСЕХ категориях
    const allNames = Object.values(markers).flat();
    if(allNames.includes(newName)){
      return {ok:false, text:`«${newName}» уже существует`};
    }

    // 1. markers (категории)
    const nextMarkers = {...markers, [cat]: markers[cat].map(x=>x===oldName?newName:x)};
    await saveAndSync("custom:markers", nextMarkers, setMarkers);

    // 2. records (записи)
    let recChanged = false;
    const nextRecords = records.map(r=>{
      if(r.marker === oldName){
        recChanged = true;
        return {...r, marker: newName};
      }
      return r;
    });
    if(recChanged){
      await saveAndSync("records", nextRecords, setRecords);
    }

    // 3. prices (цены)
    if(prices[oldName] !== undefined){
      const nextPrices = {...prices};
      nextPrices[newName] = nextPrices[oldName];
      delete nextPrices[oldName];
      await saveAndSync("prices", nextPrices, setPrices);
    }

    // 4-5. Склады через rename-операцию (event sourcing)
    {
      const hasInMain = stockMain[oldName] !== undefined;
      const hasInWS = WORKSHOPS.some(ws => stockWS[ws] && stockWS[ws][oldName] !== undefined);
      if(hasInMain || hasInWS){
        await appendStockOp("rename", {
          oldMarker: oldName,
          newMarker: newName,
        });
      }
    }

    // 6. stock:cfg (пороги)
    if(stockCfg[oldName] !== undefined){
      const nextCfg = {...stockCfg};
      nextCfg[newName] = nextCfg[oldName];
      delete nextCfg[oldName];
      await saveAndSync("stock:cfg", nextCfg, setStockCfg);
    }

    // 6a. notes (комментарии)
    if(notes[oldName] !== undefined){
      const nextNotes = {...notes};
      nextNotes[newName] = nextNotes[oldName];
      delete nextNotes[oldName];
      await saveAndSync("marker-notes", nextNotes, setNotes);
    }

    // 7. photo (фото заготовки) — асинхронно, не блокируем UI
    photoGet(oldName).then(async photo => {
      if(photo){
        await photoSet(newName, photo);
        // удаляем старое фото
        try { await photoDelete(oldName); } catch {}
        // обновляем кэш
        setPhotoCache(p=>{
          const next = {...p};
          next[newName] = photo;
          delete next[oldName];
          return next;
        });
      }
    });

    return {ok:true, text:`«${oldName}» → «${newName}»`};
  }

  // ── Панель управления складом: StockControls теперь на уровне модуля (см. выше) ──

  // ── Кнопка маркировки в форме записи ──
  function renderMarkerButton(m, isService, yearCount){
    const isSelected = marker === m;
    const mAliases = getAliases(m);
    return (
      <button key={m} type="button" onClick={()=>{setMarker(m);setShowAllMarkers(false);setMarkerSearch("");}}
        style={{
          fontSize:11, padding:"4px 8px", borderRadius:6, cursor:"pointer",
          background: isSelected ? C.brand : C.bgCard,
          border: `1px solid ${isSelected ? C.brand : C.border}`,
          color: isSelected ? "#fff" : C.text,
          display:"flex", alignItems:"center", gap:4, maxWidth:"100%",
        }}>
        <span style={{fontWeight:600}}>{m}</span>
        {mAliases.length > 0 && (
          <span style={{fontSize:9, opacity:0.6, fontStyle:"italic"}}>
            ={mAliases.length > 1 ? `${mAliases[0]} +${mAliases.length-1}` : mAliases[0]}
          </span>
        )}
      </button>
    );
  }

  function renderStockCategory(cat, stockObj, isWS){
    // «Прочие услуги» — не показываем в складах (это услуги, не заготовки)
    if(cat === "Прочие услуги") return null;
    const ms = (markers[cat]||[]).filter(m => !isServiceMarker(m, cat));
    const search = stockSearch.toLowerCase();
    // Поиск
    let filtered = search ? ms.filter(m=>matchesSearch(m, stockSearch)) : ms.slice();
    // Фильтр: локальный (по категории) приоритетнее глобального
    const effectiveFilter = catFilter[cat] || stockFilter;
    filtered = filtered.filter(m=>{
      const q = stockObj[m]||0;
      const cfg = stockCfg[m]||{};
      const isLow = cfg.threshold > 0 && q <= cfg.threshold;
      if(effectiveFilter === "with-stock") return q > 0;
      if(effectiveFilter === "empty") return q === 0;
      if(effectiveFilter === "low") return isLow;
      return true; // all
    });
    if(filtered.length===0) return null;
    // Сортировка (сохраняем оригинальный индекс для stable sort)
    filtered = filtered.map((m, idx) => ({ m, idx }));
    if(stockSort === "alpha"){
      filtered.sort((a,b) => a.m.localeCompare(b.m, "ru"));
    } else if(stockSort === "alpha-desc"){
      filtered.sort((a,b) => b.m.localeCompare(a.m, "ru"));
    } else if(stockSort === "qty-desc"){
      filtered.sort((a,b) => (stockObj[b.m]||0) - (stockObj[a.m]||0));
    } else if(stockSort === "qty-asc"){
      filtered.sort((a,b) => (stockObj[a.m]||0) - (stockObj[b.m]||0));
    } else if(stockSort === "empty-first"){
      filtered.sort((a,b) => {
        const qa = stockObj[a.m]||0, qb = stockObj[b.m]||0;
        if(qa === 0 && qb !== 0) return -1;
        if(qa !== 0 && qb === 0) return 1;
        return a.m.localeCompare(b.m, "ru");
      });
    }
    const filteredMs = filtered.map(x => x.m);
    // Статистика по категории
    const total = filteredMs.reduce((s,m)=>s+(stockObj[m]||0),0);
    const emptyCount = filteredMs.filter(m=>(stockObj[m]||0)===0).length;
    const withStockCount = filteredMs.length - emptyCount;
    const hasLow = filteredMs.some(m=>{ const q=stockObj[m]||0,t=(stockCfg[m]||{}).threshold||0; return t>0&&q<=t; });
    const expanded = expandedCats[cat]===true;
    const activeCatFilter = catFilter[cat] || "all";

    // Мини-кнопка фильтра для категории
    const catFilterBtn = (id, label, color) => {
      const isActive = activeCatFilter === id;
      return (
        <button type="button" onClick={(e)=>{
          e.stopPropagation();
          setCatFilter(p => ({...p, [cat]: id}));
        }} style={{
          padding:"2px 7px",fontSize:10,fontWeight:600,borderRadius:5,cursor:"pointer",
          border:`1px solid ${isActive?(color||C.brand):C.border+"88"}`,
          background:isActive?((color||C.brand)+"22"):"transparent",
          color:isActive?(color||C.brand):C.textSub,
        }}>{label}</button>
      );
    };

    return (
      <div key={cat} style={{...s.card,padding:0,overflow:"hidden",marginBottom:8}}>
        <div onClick={()=>setExpandedCats(p=>({...p,[cat]:!expanded}))}
          style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",cursor:"pointer",background:expanded?C.bgCard:C.bgSection,borderBottom:expanded?`1px solid ${C.border}`:"none"}}>
          <span style={{fontWeight:700,fontSize:13}}>{cat}</span>
          <span style={{color:C.textDim,fontSize:12}}>{expanded?"▲":"▼"}</span>
        </div>
        {expanded&&(
          <div>
            <div style={{display:"grid",gridTemplateColumns:"1fr auto 36px",gap:6,
              padding:"6px 14px",fontSize:11,color:C.textDim,borderBottom:`1px solid ${C.border}`,background:C.bgSection}}>
              <span>Маркировка</span><span style={{textAlign:"center"}}>Кол-во</span><span style={{textAlign:"center"}}>💬</span>
            </div>
            {filteredMs.map(m=>{
              const q=stockObj[m]||0,cfg=stockCfg[m]||{};
              const mAliases = getAliases(m);
              const mNote = getNote(m);
              return (
                <div key={m} style={{display:"grid",gridTemplateColumns:"1fr auto 36px",gap:6,
                  padding:"7px 14px",borderBottom:`1px solid ${C.border}22`,alignItems:"center",
                  background:q===0?C.dangerDim:"transparent"}}>
                  <div>
                    <div style={{fontSize:13,color:q===0?C.textDim:C.text,fontWeight:600}}>{m}</div>
                    {mAliases.length > 0 && <div style={{fontSize:10,color:C.textDim,marginTop:2,lineHeight:1.3}}>= {mAliases.join(", ")}</div>}
                    {mNote && <div style={{fontSize:10,color:C.warn,marginTop:2,lineHeight:1.3,fontStyle:"italic"}}>💬 {mNote}</div>}
                  </div>
                  <StepperInput
                    value={q}
                    // Кнопки +/- → delta (не конфликтует, складывается с действиями отца)
                    silentSaveDelta={async (delta) => {
                      appendStockOp("delta", {
                        location: isWS ? `ws:${workshop}` : "main",
                        marker: m,
                        delta,
                      });
                    }}
                    // Ввод точного значения через поле → set (при конфликте покажет модалку)
                    silentSave={async nq => {
                      appendStockOp("set", {
                        location: isWS ? `ws:${workshop}` : "main",
                        marker: m,
                        value: nq,
                      });
                    }}
                    inputStyle={{color:q===0?C.danger:C.success}}/>
                  <button onClick={()=>setNoteModal({markerName:m})} title="Комментарий"
                    style={{...s.btn(),padding:"5px 6px",fontSize:11,borderColor:mNote?C.warn+"66":C.border,color:mNote?C.warn:C.textSub}}>💬</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── рендер статистики ──
  function renderStats(){
    const [y,m,d] = statsDate.split("-").map(Number);
    const wsRecs = records.filter(r=>r.workshop===workshop);

    if(statsPeriod==="day"){
      const data = wsRecs.filter(r=>{ const rd=new Date(r.timestamp); return rd.getFullYear()===y&&rd.getMonth()+1===m&&rd.getDate()===d; });
      const totalQty = data.reduce((s,r)=>s+r.qty*signOf(r),0);
      const totalDef = data.reduce((s,r)=>s+r.defect,0);
      const totalAmt = data.reduce((s,r)=>s+r.amount*signOf(r),0);
      const refundRecs = data.filter(r=>r.recordType==="refund");
      const totalRefundQty = refundRecs.reduce((s,r)=>s+r.qty,0);
      const totalRefundAmt = refundRecs.reduce((s,r)=>s+r.amount,0);
      return (
        <div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            <StatCard label="Всего ключей" value={fmt(totalQty)}/>
            <StatCard label="Общая сумма" value={fmt(totalAmt)+" р"} color={C.success}/>
            <StatCard label="Брак" value={fmt(totalDef)} color={totalDef>0?C.danger:undefined}/>
            <StatCard label="% брака" value={totalQty>0?(totalDef/Math.abs(totalQty)*100).toFixed(1)+"%":"0%"} color={totalDef>0?C.danger:undefined}/>
            {totalRefundQty > 0 && <StatCard label={`Возвратов: ${totalRefundQty} шт`} value={"−"+fmt(totalRefundAmt)+" р"} color={C.danger}/>}
            {workshop==="SMART"&&(() => { const e = calcEarnings(data); return <StatCard label="Зарплата" value={fmt(e.total)+" р"} sub={`ключи: ${fmt(e.fromKeys)} · заточка: ${fmt(e.fromSharping)}`} color={C.success}/>; })()}
          </div>
          <div style={{fontSize:10,fontWeight:700,color:C.textSub,marginBottom:8,textTransform:"uppercase",letterSpacing:"1px"}}>ПО КАТЕГОРИЯМ</div>
          <StatsBreakdown data={data} totalAmt={totalAmt} totalQty={totalQty}/>
          <div style={{fontSize:10,fontWeight:700,color:C.textSub,marginBottom:8,marginTop:16,textTransform:"uppercase",letterSpacing:"1px"}}>ОТЧЁТ ДНЯ · СКЛАД</div>
          <DayReport records={records} workshop={workshop} wsStock={stockWS[workshop]||{}}
            stockCfg={stockCfg} dateStr={dateOf(new Date(y,m-1,d).getTime())}
            onEditRecord={setEditRec}/>
        </div>
      );
    }

    if(statsPeriod==="month"){
      const data = wsRecs.filter(r=>{ const rd=new Date(r.timestamp); return rd.getFullYear()===y&&rd.getMonth()+1===m; });
      const totalQty = data.reduce((s,r)=>s+r.qty*signOf(r),0);
      const totalDef = data.reduce((s,r)=>s+r.defect,0);
      const totalAmt = data.reduce((s,r)=>s+r.amount*signOf(r),0);
      const workDays = new Set(data.map(r=>dateOf(r.timestamp))).size;
      const avgPerDay = workDays>0 ? totalAmt/workDays : 0;
      const byDay = {};
      data.forEach(r=>{ const dk=dateOf(r.timestamp); if(!byDay[dk]) byDay[dk]={qty:0,amount:0,defect:0}; const s=signOf(r); byDay[dk].qty+=r.qty*s; byDay[dk].amount+=r.amount*s; byDay[dk].defect+=r.defect; });
      const refundRecs = data.filter(r=>r.recordType==="refund");
      const totalRefundQty = refundRecs.reduce((s,r)=>s+r.qty,0);
      const totalRefundAmt = refundRecs.reduce((s,r)=>s+r.amount,0);
      return (
        <div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            <StatCard label="Всего ключей" value={fmt(totalQty)}/>
            <StatCard label="Общая сумма" value={fmt(totalAmt)+" р"} color={C.success}/>
            <StatCard label="Брак" value={fmt(totalDef)} color={totalDef>0?C.danger:undefined}/>
            <StatCard label="% брака" value={totalQty>0?(totalDef/Math.abs(totalQty)*100).toFixed(1)+"%":"0%"} color={totalDef>0?C.danger:undefined}/>
            <StatCard label="Рабочих дней" value={workDays} sub="дней с записями"/>
            {totalRefundQty > 0 && <StatCard label={`Возвратов: ${totalRefundQty} шт`} value={"−"+fmt(totalRefundAmt)+" р"} color={C.danger}/>}
            {workshop==="SMART"&&(() => { const e = calcEarnings(data); return <StatCard label="Зарплата" value={fmt(e.total)+" р"} sub={`ключи: ${fmt(e.fromKeys)} · заточка: ${fmt(e.fromSharping)}`} color={C.success}/>; })()}
          </div>
          <div style={{fontSize:10,fontWeight:700,color:C.textSub,marginBottom:8,textTransform:"uppercase",letterSpacing:"1px"}}>ПО КАТЕГОРИЯМ</div>
          <StatsBreakdown data={data} totalAmt={totalAmt} totalQty={totalQty}/>
          <div style={{fontSize:10,fontWeight:700,color:C.textSub,marginBottom:8,marginTop:16,textTransform:"uppercase",letterSpacing:"1px"}}>ПО ДНЯМ</div>
          {Object.entries(byDay).sort((a,b)=>a[0].localeCompare(b[0])).map(([dk,d])=>{
            const parts = dk.split("-");
            const label = `${parts[2]}.${parts[1]}`;
            return (
              <div key={dk} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${C.border}`,fontSize:13}}>
                <span style={{color:C.textSub}}>{label}</span>
                <div style={{textAlign:"right"}}>
                  <span style={{color:d.amount>=0?C.text:C.danger,marginRight:12,fontWeight:700}}>{fmt(d.amount)} р</span>
                  <span style={{color:C.textSub,fontSize:12}}>{d.qty} шт{d.defect?` · брак ${d.defect}`:""}{(() => { const refundCount = data.filter(r=>dateOf(r.timestamp)===dk && r.recordType==="refund").reduce((s,r)=>s+r.qty,0); return refundCount > 0 ? ` · возврат ${refundCount}` : ""; })()}</span>
                </div>
              </div>
            );
          })}
        </div>
      );
    }

    if(statsPeriod==="year"){
      const data = wsRecs.filter(r=>new Date(r.timestamp).getFullYear()===y);
      const totalQty = data.reduce((s,r)=>s+r.qty*signOf(r),0);
      const totalDef = data.reduce((s,r)=>s+r.defect,0);
      const totalAmt = data.reduce((s,r)=>s+r.amount*signOf(r),0);
      const refundRecs = data.filter(r=>r.recordType==="refund");
      const totalRefundQty = refundRecs.reduce((s,r)=>s+r.qty,0);
      const totalRefundAmt = refundRecs.reduce((s,r)=>s+r.amount,0);
      const byMonth = {};
      data.forEach(r=>{
        const mk = monthOf(r.timestamp);
        if(!byMonth[mk]) byMonth[mk] = { qty:0, amount:0, defect:0, days:new Set(), recList:[] };
        const s = signOf(r);
        byMonth[mk].qty += r.qty * s;
        byMonth[mk].amount += r.amount * s;
        byMonth[mk].defect += r.defect;
        byMonth[mk].days.add(dateOf(r.timestamp));
        byMonth[mk].recList.push(r);
      });
      return (
        <div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            <StatCard label="Всего ключей" value={fmt(totalQty)}/>
            <StatCard label="Общая сумма" value={fmt(totalAmt)+" р"} color={C.success}/>
            <StatCard label="Брак" value={fmt(totalDef)} color={totalDef>0?C.danger:undefined}/>
            <StatCard label="% брака" value={totalQty>0?(totalDef/Math.abs(totalQty)*100).toFixed(1)+"%":"0%"} color={totalDef>0?C.danger:undefined}/>
            {totalRefundQty > 0 && <StatCard label={`Возвратов: ${totalRefundQty} шт`} value={"−"+fmt(totalRefundAmt)+" р"} color={C.danger}/>}
            {workshop==="SMART"&&(() => { const e = calcEarnings(data); return <StatCard label="Зарплата" value={fmt(e.total)+" р"} sub={`ключи: ${fmt(e.fromKeys)} · заточка: ${fmt(e.fromSharping)}`} color={C.success}/>; })()}
          </div>
          <div style={{fontSize:10,fontWeight:700,color:C.textSub,marginBottom:8,textTransform:"uppercase",letterSpacing:"1px"}}>ПО МЕСЯЦАМ — нажмите для раскрытия по дням</div>
          {Object.entries(byMonth).sort((a,b)=>b[0].localeCompare(a[0])).map(([mk,d])=>{
            const mn = parseInt(mk.split("-")[1],10)-1;
            return (
              <YearMonthCard key={mk} monthKey={mk} monthData={d} monthName={mn}
                workshop={workshop} onEditRecord={setEditRec} allRecords={records}/>
            );
          })}
          <div style={{fontSize:13,fontWeight:700,color:C.textSub,marginBottom:8,marginTop:16}}>ПО КАТЕГОРИЯМ</div>
          <StatsBreakdown data={data} totalAmt={totalAmt} totalQty={totalQty}/>
        </div>
      );
    }
  }

  // ── экраны ──
  // Экран ввода GitHub токена (если токена нет)
  if(!tokenOk) return (
    <div style={{...s.app,display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh"}}>
      <div style={{width:"100%",maxWidth:380,padding:24}}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{width:64,height:64,background:C.brand,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",fontSize:32,margin:"0 auto 16px"}}>🔑</div>
          <div style={{fontSize:22,fontWeight:800,letterSpacing:"-0.3px"}}>Мастерская</div>
          <div style={{fontSize:10,fontWeight:700,color:C.brand,letterSpacing:"1px",textTransform:"uppercase",marginTop:4}}>Простое Решение</div>
          <div style={{fontSize:13,color:C.textSub,marginTop:8}}>Подключение к хранилищу</div>
        </div>
        <div style={{background:C.brandDim,border:`1px solid ${C.brand}44`,padding:"10px 12px",marginBottom:16,fontSize:11,color:C.textSub,lineHeight:1.5}}>
          📦 Данные хранятся в GitHub (приватный репозиторий).<br/>
          Введите Personal Access Token от вашего GitHub.
        </div>
        <label style={s.label}>GitHub Personal Access Token</label>
        <input type="password" value={tokenInput}
          onChange={e=>setTokenInput(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"&&!tokenChecking)handleTokenSubmit();}}
          placeholder="ghp_xxxxxxxxxxxx"
          style={{...s.input,marginBottom:10,fontSize:13}}/>
        {tokenError&&<div style={{fontSize:12,color:C.danger,marginBottom:10,fontWeight:700}}>{tokenError}</div>}
        <button onClick={handleTokenSubmit} disabled={tokenChecking}
          style={{...s.btn("accent"),width:"100%",padding:"14px 0",fontSize:14,opacity:tokenChecking?.6:1}}>
          {tokenChecking ? "Проверка..." : "Подключиться"}
        </button>
        <div style={{fontSize:11,color:C.textDim,marginTop:16,lineHeight:1.6}}>
          Токен создаётся в:<br/>
          GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)<br/>
          Нужны права: <b style={{color:C.textSub}}>repo</b> (полный доступ к репозиториям).
        </div>
      </div>
    </div>
  );

  if(loading || !pwdLoaded) return (
    <div style={{...s.app,display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh"}}>
      <div style={{textAlign:"center"}}>
        <div style={{width:64,height:64,background:C.brand,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",fontSize:32,margin:"0 auto 16px"}}>🔑</div>
        <div style={{fontSize:14,color:C.textSub,fontWeight:700,textTransform:"uppercase",letterSpacing:"1px"}}>Загрузка...</div>
      </div>
    </div>
  );

  // Экран ввода пароля
  if(!authed) return (
    <div style={{...s.app,display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh"}}>
      <div style={{width:"100%",maxWidth:320,padding:24}}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{width:64,height:64,background:C.brand,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",fontSize:32,margin:"0 auto 16px"}}>🔑</div>
          <div style={{fontSize:22,fontWeight:800,letterSpacing:"-0.3px"}}>Мастерская</div>
          <div style={{fontSize:10,fontWeight:700,color:C.brand,letterSpacing:"1px",textTransform:"uppercase",marginTop:4}}>Простое Решение</div>
        </div>
        <div style={{fontSize:11,color:C.textDim,textAlign:"center",marginBottom:20,lineHeight:1.6}}>
          Выберите мастерскую
        </div>
        {WORKSHOPS.map(ws=>{
          const wsCol = ws==="SMART"?C.smart:C.begemot;
          return (
            <button key={ws} onClick={()=>{setWorkshop(ws);setAuthed(true);try{localStorage.setItem(LOCAL_WS_KEY,ws);localStorage.setItem(LOCAL_AUTH_KEY,"1");}catch{}}}
              style={{
                width:"100%",padding:"16px 0",fontSize:18,fontWeight:800,cursor:"pointer",
                background:wsCol,color:"#fff",border:"none",borderRadius:0,marginBottom:10,
                textTransform:"uppercase",letterSpacing:"1px",
              }}>{ws}</button>
          );
        })}
      </div>
    </div>
  );

  const wsColor = workshop==="SMART"?C.smart:C.begemot;
  // Гарантируем, что state — правильные типы, чтобы не было белого экрана
  const safePrices = ensureObj(prices);
  const safeStockMain = ensureObj(stockMain);
  const safeStockWS = ensureObj(stockWS);
  const safeStockCfg = ensureObj(stockCfg);
  const safeMarkers = markers && typeof markers === "object" ? markers : DEFAULT_MARKERS;
  const safeAliases = ensureObj(aliases);
  const safeNotes = ensureObj(notes);
  const safeSubcategories = ensureObj(subcategories);

  // Получить подкатегории для категории
  function getSubcategories(cat){
    return ensureObj(safeSubcategories[cat]);
  }

  // Проверить, есть ли маркировка в какой-то подкатегории
  function getMarkerSubcategory(cat, markerName){
    const subs = getSubcategories(cat);
    for(const [subName, markers] of Object.entries(subs)){
      if(markers.includes(markerName)) return subName;
    }
    return null;
  }

  // Получить все имена маркировки (основное + алиасы)
  function getAllNames(markerName){
    return [markerName, ...getAliases(markerName)];
  }
  function getNote(markerName){
    return safeNotes[markerName] || "";
  }

  // Сохранить комментарий
  async function saveNote(markerName, note){
    const next = {...safeNotes};
    const trimmed = (note || "").trim();
    if(trimmed){
      next[markerName] = trimmed;
    } else {
      delete next[markerName];
    }
    setNotes(next);
    await saveAndSync("marker-notes", next);
    return {ok:true, text: trimmed ? "Комментарий сохранён" : "Комментарий удалён"};
  }

  // Найти алиасы для маркировки (возвращает массив)
  function getAliases(markerName){
    return safeAliases[markerName] || [];
  }

  // Проверить, содержит ли строка искомый текст (для поиска)
  function matchesSearch(markerName, search){
    if(!search) return true;
    const s = search.toLowerCase();
    if(markerName.toLowerCase().includes(s)) return true;
    // Проверяем алиасы
    const al = getAliases(markerName);
    return al.some(a => a.toLowerCase().includes(s));
  }

  // Получить все имена маркировки (основное + алиасы)
  function getAllNames(markerName){
    return [markerName, ...getAliases(markerName)];
  }
  const wsStock = ensureObj(safeStockWS[workshop]);
  const tabs = [
    {id:"record",icon:"📝",label:"Запись"},
    {id:"stats",icon:"📊",label:"Статистика"},
    {id:"stock",icon:"📦",label:"Склад"},
    {id:"prices",icon:"🏷️",label:"Маркировки"}
  ];

  return (
    <div style={s.app}>
      {/* Модалка разрешения конфликтов склада */}
      {stockConflicts.length > 0 && (
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:C.bgCard,borderRadius:12,padding:20,maxWidth:420,width:"100%",boxShadow:"0 8px 32px rgba(0,0,0,.3)"}}>
            <div style={{fontSize:16,fontWeight:800,color:C.danger,marginBottom:12}}>⚠ Конфликт склада</div>
            {stockConflicts.map((conf, i) => {
              const localDate = new Date(conf.local.ts);
              const remoteDate = new Date(conf.remote.ts);
              const locLabel = conf.local.location === "main" ? "Общий склад" : `Склад ${conf.local.location.slice(3)}`;
              return (
                <div key={i} style={{...s.card,marginBottom:12,padding:14}}>
                  <div style={{fontSize:13,fontWeight:700,marginBottom:8}}>
                    «{conf.local.marker}» — {locLabel}
                  </div>
                  <div style={{display:"flex",gap:8,marginBottom:8}}>
                    <button onClick={()=>resolveConflict(conf, conf.local.value)}
                      style={{...s.btn(),flex:1,padding:"10px",fontSize:13,fontWeight:700,borderColor:C.brand+"66"}}>
                      Здесь: {conf.local.value} шт<br/><span style={{fontSize:10,color:C.textDim}}>{localDate.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'})}</span>
                    </button>
                    <button onClick={()=>resolveConflict(conf, conf.remote.value)}
                      style={{...s.btn(),flex:1,padding:"10px",fontSize:13,fontWeight:700,borderColor:C.brand+"66"}}>
                      Там: {conf.remote.value} шт<br/><span style={{fontSize:10,color:C.textDim}}>{remoteDate.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'})}</span>
                    </button>
                  </div>
                  <input
                    type="number"
                    placeholder="Или введите своё значение"
                    onKeyDown={async (e) => {
                      if(e.key === "Enter"){
                        const v = parseInt(e.target.value, 10);
                        if(!isNaN(v) && v >= 0){
                          await resolveConflict(conf, v);
                        }
                      }
                    }}
                    style={{...s.input,fontSize:13}}
                  />
                </div>
              );
            })}
            <div style={{fontSize:11,color:C.textDim,textAlign:"center"}}>
              Выберите, какое значение применить. Конфликт возник из-за одновременного ввода на двух устройствах.
            </div>
          </div>
        </div>
      )}
      {editRec&&<EditModal record={editRec.record} idx={editRec.globalIdx} markers={safeMarkers}
        onSave={handleEditSave} onDelete={handleEditDelete} onClose={()=>setEditRec(null)}/>}
      {pwdModalOpen&&<PasswordModal workshop={workshop}
        onChange={handleChangePassword} onClose={()=>setPwdModalOpen(false)}/>}
      {renameModal&&<RenameMarkerModal cat={renameModal.cat} oldName={renameModal.oldName}
        onRename={renameMarker} onClose={()=>setRenameModal(null)}/>}
      {aliasesModal&&<AliasesModal cat={aliasesModal.cat} markerName={aliasesModal.markerName}
        aliases={getAliases(aliasesModal.markerName)}
        onAdd={addAlias} onRemove={removeAlias} onPromote={promoteAlias}
        onClose={()=>setAliasesModal(null)}/>}
      {subModal&&<SubcategoryModal cat={subModal.cat} markers={safeMarkers} subcategories={safeSubcategories}
        onCreate={createSubcategory} onDelete={deleteSubcategory} onRename={renameSubcategory}
        onAssign={addMarkerToSubcategory} onUnassign={removeMarkerFromSubcategory}
        onClose={()=>setSubModal(null)}/>}
      {noteModal&&<NoteModal markerName={noteModal.markerName} currentNote={getNote(noteModal.markerName)}
        onSave={saveNote} onClose={()=>setNoteModal(null)}/>}
      {photoModal&&<PhotoViewModal photo={photoModal.url} markerName={photoModal.markerName}
        onClose={()=>setPhotoModal(null)}/>}
      <div style={{maxWidth:600,margin:"0 auto",padding:"12px 12px 40px"}}>
        {/* Шапка с логотипом */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",background:C.bgCard,borderBottom:`3px solid ${C.brand}`,marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:32,height:32,background:C.brand,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🔑</div>
            <div style={{lineHeight:1.1}}>
              <div style={{fontWeight:800,fontSize:15,color:C.text,letterSpacing:"-0.3px"}}>{workshop}</div>
              <div style={{fontSize:9,fontWeight:700,color:C.brand,letterSpacing:"1px",textTransform:"uppercase"}}>Простое Решение</div>
            </div>
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <button onClick={handleLogout} title="Переключиться на другую мастерскую" style={{background:"transparent",color:C.textSub,border:`1px solid ${C.border}`,padding:"6px 10px",fontSize:10,cursor:"pointer",borderRadius:0,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.5px"}}>
              🔄 → {workshop==="SMART" ? "Бегемот" : "SMART"}
            </button>
            <button onClick={handleTokenLogout} title="Полный выход из приложения" style={{background:"transparent",color:C.danger,border:`1px solid ${C.danger}`,padding:"6px 10px",fontSize:10,cursor:"pointer",borderRadius:0,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.5px"}}>🚪 Выйти</button>
          </div>
        </div>
        {/* Строка с мастерской + датой + статусом */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,padding:"0 4px"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <span style={{background:wsColor,color:"#fff",padding:"4px 12px",borderRadius:0,fontWeight:700,fontSize:11,letterSpacing:"1px",textTransform:"uppercase"}}>{workshop}</span>
            <span style={{fontSize:13,color:C.text,fontWeight:700}}>
              {(() => {
                const days = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"];
                const d = nowTime;
                return days[d.getDay()];
              })()}
            </span>
            <span style={{fontSize:13,color:C.text,fontWeight:700,letterSpacing:"0.3px"}}>
              {`${String(nowTime.getDate()).padStart(2,"0")}.${String(nowTime.getMonth()+1).padStart(2,"0")}.${nowTime.getFullYear()}`}
            </span>
            <span style={{fontSize:13,color:C.brand,fontWeight:800,fontVariantNumeric:"tabular-nums"}}>
              {`${String(nowTime.getHours()).padStart(2,"0")}:${String(nowTime.getMinutes()).padStart(2,"0")}`}
            </span>
            {/* Индикатор статуса сохранения */}
            {Object.entries(saveStatus).map(([key, status]) => (
              <span key={key} style={{
                fontSize:10,
                padding:"2px 6px",
                background: status === "saving" ? C.warnDim : status === "error" ? C.dangerDim : C.successDim,
                color: status === "saving" ? C.warn : status === "error" ? C.danger : C.success,
                border: `1px solid ${status === "saving" ? C.warn : status === "error" ? C.danger : C.success}44`,
                fontWeight: 700,
              }}>
                {status === "saving" ? "⏳ Сохранение..." : status === "error" ? "⚠ Ошибка" : "✓ Сохранено"}
              </span>
            ))}
            {/* Индикатор синхронизации */}
            {!isOnline ? (
              <span style={{
                fontSize:10,
                padding:"2px 6px",
                background: C.warnDim,
                color: C.warn,
                border: `1px solid ${C.warn}44`,
                fontWeight: 700,
              }}>
                📴 Офлайн{pendingCount > 0 ? ` (${pendingCount} в очереди)` : ""}
              </span>
            ) : syncStatus !== "idle" && (
              <span style={{
                fontSize:10,
                padding:"2px 6px",
                background: syncStatus === "syncing" ? C.smartDim : syncStatus === "ws" ? C.brandDim : syncStatus === "offline" ? C.warnDim : C.successDim,
                color: syncStatus === "syncing" ? C.smart : syncStatus === "ws" ? C.brand : syncStatus === "offline" ? C.warn : C.success,
                border: `1px solid ${syncStatus === "syncing" ? C.smart : syncStatus === "ws" ? C.brand : syncStatus === "offline" ? C.warn : C.success}44`,
                fontWeight: 700,
              }}>
                {syncStatus === "syncing" ? "🔄 Синхр..." : syncStatus === "ws" ? "⚡ Live" : syncStatus === "offline" ? "📴 Офлайн" : "✓"}
                {pendingCount > 0 ? ` (${pendingCount})` : ""}
              </span>
            )}
          </div>
        </div>
        <Tabs tabs={tabs} active={tab} onChange={setTab}/>

        {/* ══ ЗАПИСЬ ══ */}
        {tab==="record"&&(
          <div>
            {/* Тип записи */}
            <div style={{marginBottom:12}}>
              <label style={s.label}>Тип записи</label>
              <div style={{display:"flex",gap:6}}>
                {[["sale","↑ Продажа"],["refund","↩ Возврат от клиента"]].map(([id,label])=>(
                  <button key={id} type="button" onClick={()=>{
                    setRecordType(id);
                    // При переключении на возврат — уходим с "Прочие услуги" (возвратов по ним не бывает)
                    if(id === "refund" && category === "Прочие услуги"){
                      const firstNonService = sortedCategories(safeMarkers).find(c => c !== "Прочие услуги");
                      if(firstNonService) setCategory(firstNonService);
                      setMarker("");
                    }
                  }} style={{
                    flex:1,padding:"8px 0",fontSize:12,fontWeight:600,borderRadius:8,cursor:"pointer",
                    border:`1px solid ${recordType===id?(id==="refund"?C.danger:C.brand):C.border}`,
                    background:recordType===id?(id==="refund"?C.dangerDim:C.brandDim):C.bgInput,
                    color:recordType===id?(id==="refund"?C.danger:C.brand):C.textSub
                  }}>{label}</button>
                ))}
              </div>
              {recordType==="refund"&&(
                <div style={{fontSize:11,color:C.danger,marginTop:4,lineHeight:1.5}}>
                  ↩ Сумма будет вычтена из статистики. Заготовка на склад не возвращается.
                </div>
              )}
            </div>

            {/* Топ-15 популярных маркировок за год — только для продажи */}
            {/* Убрали TopMarkersBlock — теперь показываем топ-20 прямо в списке маркировок */}

            <div style={{marginBottom:12}}>
              <label style={s.label}>Категория</label>
              <select value={category} onChange={e=>{setCategory(e.target.value);setMarker("");setShowAllMarkers(false);setMarkerSearch("");}} style={s.input}>
                {sortedCategories(safeMarkers)
                  .filter(c => recordType !== "refund" || c !== "Прочие услуги")
                  .map(c=><option key={c}>{c}</option>)}
              </select>
            </div>
            <div style={{marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <label style={{...s.label,marginBottom:0}}>Маркировка</label>
                {/* Кнопка переключения "Показать все" / "Только топ" — скрываем для услуг */}
                {category !== "Прочие услуги" && (
                  <button type="button" onClick={()=>setShowAllMarkers(v=>!v)} style={{
                    ...s.btn(),
                    padding:"4px 8px",
                    fontSize:10,
                  }}>
                    {showAllMarkers ? "⭐ Топ-20" : `📋 Все (${(safeMarkers[category]||[]).length})`}
                  </button>
                )}
              </div>

              {/* Выбранная маркировка — показываем когда список свёрнут */}
              {marker && !showAllMarkers && category !== "Прочие услуги" && (
                <div style={{...s.card,padding:"8px 12px",marginBottom:8,background:C.brandDim,borderColor:C.brand+"44",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:13,fontWeight:700,color:C.brand}}>{marker}</span>
                  <button type="button" onClick={()=>{setMarker("");setShowAllMarkers(true);}} style={{fontSize:11,color:C.danger,background:"transparent",border:"none",cursor:"pointer",fontWeight:700}}>✕ Изменить</button>
                </div>
              )}

              {/* Поле поиска — показываем только в режиме "Показать все" или для услуг */}
              {(showAllMarkers || category === "Прочие услуги") && (
                <input value={markerSearch} onChange={e=>setMarkerSearch(e.target.value)} placeholder="🔍 Поиск..." style={{...s.input,marginBottom:8}}/>
              )}

              {/* Список маркировок — скрываем если уже выбрана и список свёрнут */}
              {(!marker || showAllMarkers || category === "Прочие услуги") && (
              <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:8,maxHeight:showAllMarkers?400:200,overflowY:"auto",padding:4,background:C.bgInput,border:`1px solid ${C.border}`}}>
                {(() => {
                  const isService = category === "Прочие услуги";
                  const allMarkers = (safeMarkers[category] || []).slice().sort((a,b)=>a.localeCompare(b,"ru"));

                  // Для услуг — показываем все сразу (без топа)
                  if(isService){
                    const search = markerSearch.toLowerCase();
                    const list = search ? allMarkers.filter(m => matchesSearch(m, markerSearch)) : allMarkers;
                    if(list.length === 0) return <div style={{padding:"8px",color:C.textDim,fontSize:12}}>Ничего не найдено</div>;
                    return list.map(m => renderMarkerButton(m, isService));
                  }

                  // Для не-услуг — скрываем маркировки без остатка в этой мастерской
                  // Кроме SERVICE_MARKERS (Нарезка лезвия, Замена корпуса) — они всегда показываются
                  const inStock = allMarkers.filter(m => (wsStock[m]||0) > 0 || isServiceMarker(m, category));

                  // Если показываем все — применяем поиск
                  if(showAllMarkers){
                    const search = markerSearch.toLowerCase();
                    const list = search ? inStock.filter(m => matchesSearch(m, markerSearch)) : inStock;
                    if(list.length === 0) return <div style={{padding:"8px",color:C.textDim,fontSize:12}}>Ничего не найдено. Возможно, остаток на складе 0 — пополните в разделе «Склад».</div>;
                    return list.map(m => renderMarkerButton(m, isService));
                  }

                  // Иначе — топ-20 за год для этой категории (только из тех, что есть в наличии)
                  // Плюс услуги (Нарезка лезвия, Замена корпуса) — показываем всегда, даже без остатка
                  const now = new Date();
                  const yearAgo = now.getTime() - 365 * 24 * 60 * 60 * 1000;
                  const counts = {};
                  records.forEach(r => {
                    if(r.workshop !== workshop) return;
                    if(r.recordType === "refund") return;
                    if(r.category !== category) return;
                    if(r.timestamp < yearAgo) return;
                    counts[r.marker] = (counts[r.marker] || 0) + (r.qty || 0);
                  });
                  const top = Object.entries(counts)
                    .sort((a,b) => b[1] - a[1])
                    .slice(0, 20)
                    .filter(([m,c]) => c > 0 && ((wsStock[m]||0) > 0 || isServiceMarker(m, category)));

                  if(top.length === 0){
                    return <div style={{padding:"8px",color:C.textDim,fontSize:12}}>⭐ Топ-20 появится после первых продаж. Нажмите «📋 Все» выше, чтобы увидеть все маркировки в наличии.</div>;
                  }

                  return top.map(([m, c]) => renderMarkerButton(m, isService, c));
                })()}
              </div>
              )}

            </div>
            {markerPhoto&&(
              <div style={{marginBottom:12}}>
                <label style={s.label}>Фото заготовки (нажмите, чтобы увеличить)</label>
                <img src={markerPhoto} alt="" onClick={()=>setPhotoModal({url: markerPhoto, markerName: marker})}
                  style={{maxWidth:140,maxHeight:140,border:`1px solid ${C.border}`,display:"block",cursor:"pointer"}}/>
                <div style={{fontSize:10,color:C.textDim,marginTop:4}}>Загрузить/изменить фото можно в разделе «Маркировки»</div>
              </div>
            )}
            {marker && getNote(marker.trim()) && (
              <div style={{...s.card,padding:"8px 12px",marginBottom:12,borderColor:C.warn+"44",background:C.warnDim}}>
                <div style={{fontSize:11,color:C.warn,marginBottom:2,fontWeight:600}}>💬 Комментарий к «{marker.trim()}»</div>
                <div style={{fontSize:12,color:C.warn,lineHeight:1.5,fontStyle:"italic"}}>{getNote(marker.trim())}</div>
              </div>
            )}
            <div style={{display:"grid",gridTemplateColumns:recordType==="refund"?"1fr":"1fr 1fr",gap:10,marginBottom:12}}>
              <div>
                <label style={s.label}>Количество</label>
                <StepperInput value={qty} onChange={setQty} style={{width:"100%"}} inputStyle={{width:"100%"}}/>
              </div>
              {recordType!=="refund" && (
              <div>
                <label style={s.label}>Брак</label>
                <StepperInput value={defect} onChange={setDefect} style={{width:"100%"}} inputStyle={{width:"100%"}}/>
              </div>
              )}
            </div>
            {recordType==="sale"&&qty>0&&defect>0&&(
              <div style={{...s.card,padding:"8px 12px",marginBottom:10,background:C.warnDim,borderColor:C.warn+"44"}}>
                <div style={{fontSize:12,color:C.warn,lineHeight:1.5}}>
                  ⚠ Всего изготовлено: <b>{qty+defect} шт</b> ({qty} годных + {defect} брак)<br/>
                  Списания со склада: <b>{qty+defect} шт</b><br/>
                  Сумма: <b>{qty} шт</b> × цена (только годные)
                </div>
              </div>
            )}
            {recordType==="sale"&&qty===0&&defect>0&&(
              <div style={{...s.card,padding:"8px 12px",marginBottom:10,background:C.warnDim,borderColor:C.warn+"44"}}>
                <div style={{fontSize:12,color:C.warn,lineHeight:1.5}}>
                  ⚠ Только брак: со склада спишется <b>{defect} шт</b>. Сумма продажи = 0.
                </div>
              </div>
            )}
            <div style={{marginBottom:16}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                <label style={{...s.label,margin:0}}>Сумма, руб</label>
                <label style={{fontSize:12,color:C.textSub,display:"flex",gap:5,alignItems:"center"}}>
                  <input type="checkbox" checked={manualAmount||recordType==="refund"}
                    disabled={recordType==="refund"}
                    onChange={e=>setManualAmount(e.target.checked)} style={{width:"auto"}}/> Сумма вручную
                </label>
              </div>
              <NumInput value={amount} onChange={v=>{if(manualAmount||recordType==="refund"||!prices[marker])setAmount(v);}}
                style={{...s.input,opacity:(!manualAmount&&recordType!=="refund"&&!!prices[marker])?.6:1}}/>
              {recordType==="refund"
                ? <div style={{fontSize:11,color:C.danger,marginTop:3}}>Возврат: сумма вводится вручную</div>
                : prices[marker]&&!manualAmount && <div style={{fontSize:11,color:C.textDim,marginTop:3}}>Цена за ед.: {fmt(prices[marker])} р · авто</div>}
            </div>
            <div style={{marginBottom:16}}>
              <label style={s.label}>Комментарий</label>
              <textarea value={comment} onChange={e=>setComment(e.target.value)} rows={2} placeholder="Необязательно" style={{...s.input,resize:"vertical"}}/>
            </div>
            <button onClick={submitRecord}
              style={{...s.btn(recordType==="refund"?"refund":"accent"),width:"100%",padding:"14px 0",fontSize:16,fontWeight:800}}>
              {recordType==="refund" ? "Оформить возврат" : "Добавить запись"}
            </button>
            {submitMsg&&<div style={{textAlign:"center",marginTop:8,fontSize:13,color:submitMsg.ok?C.success:C.danger}}>{submitMsg.text}</div>}
            {records.filter(r=>r.workshop===workshop).length>0&&(
              <div style={{marginTop:20}}>
                <div style={{fontSize:12,color:C.textSub,marginBottom:8}}>Последние записи — нажмите для редактирования</div>
                {records.map((r,gi)=>r.workshop===workshop?{r,gi}:null).filter(Boolean).slice(-5).reverse().map(({r,gi})=>{
                  const isRefund = r.recordType==="refund";
                  return (
                    <div key={gi} style={{...s.card,cursor:"pointer",borderLeft:`3px solid ${isRefund?C.danger:C.brand+"88"}`}} onClick={()=>setEditRec({record:r,globalIdx:gi})}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span style={{color:isRefund?C.danger:C.success,fontWeight:700,fontSize:16}}>{isRefund?"↩":"↑"}</span>
                          <span style={{fontWeight:600}}>{r.marker}</span>
                          {isRefund&&<TypeBadge recordType="refund"/>}
                        </div>
                        <div style={{display:"flex",gap:8,alignItems:"center"}}>
                          <span style={{fontSize:12,color:isRefund?C.danger:C.textSub}}>{isRefund?"−":""}{r.qty} шт · {fmt(r.amount)} р</span>
                          <span style={{fontSize:11,color:C.brand}}>✎</span>
                        </div>
                      </div>
                      <div style={{fontSize:12,color:C.textDim,marginTop:2}}>{r.category}{r.defect>0?` · брак ${r.defect}`:""}{r.comment&&` · ${r.comment}`}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ══ СТАТИСТИКА ══ */}
        {tab==="stats"&&(
          <div>
            <div style={{display:"flex",gap:1,marginBottom:16,background:C.border,padding:1}}>
              {[["day","День"],["month","Месяц"],["year","Год"]].map(([id,label])=>(
                <button key={id} onClick={()=>setStatsPeriod(id)} style={{
                  flex:1,padding:"12px 4px",fontSize:12,fontWeight:800,border:"none",cursor:"pointer",
                  background:statsPeriod===id?C.bgCard:C.bgSection,
                  color:statsPeriod===id?C.brand:C.textSub,
                  borderTop:`3px solid ${statsPeriod===id?C.brand:"transparent"}`,
                  textTransform:"uppercase",letterSpacing:"0.8px",transition:"all .2s cubic-bezier(0.16,1,0.3,1)",
                }}>{label}</button>
              ))}
            </div>
            <div style={{marginBottom:14}}>
              {statsPeriod==="day" ? (
                <input type="date" value={statsDate} onChange={e=>setStatsDate(e.target.value)}
                  style={{...s.input,cursor:"pointer",colorScheme:"dark",color:C.text,fontWeight:500}}/>
              ) : statsPeriod==="month" ? (
                <select value={statsDate.slice(0,7)} onChange={e=>setStatsDate(e.target.value+"-15")}
                  style={s.input}>
                  {(() => {
                    const months = [];
                    const now = new Date();
                    for(let year = now.getFullYear(); year >= 2025; year--){
                      for(let month = 11; month >= 0; month--){
                        if(year === now.getFullYear() && month > now.getMonth()) continue;
                        const val = `${year}-${String(month+1).padStart(2,"0")}`;
                        const label = `${MONTH_NAMES[month]} ${year}`;
                        months.push(<option key={val} value={val}>{label}</option>);
                      }
                    }
                    return months;
                  })()}
                </select>
              ) : (
                <select value={statsDate.slice(0,4)} onChange={e=>setStatsDate(e.target.value+"-01-15")}
                  style={s.input}>
                  {(() => {
                    const years = [];
                    const now = new Date();
                    for(let year = now.getFullYear(); year >= 2025; year--){
                      years.push(<option key={year} value={year}>{year} год</option>);
                    }
                    return years;
                  })()}
                </select>
              )}
            </div>
            {renderStats()}
          </div>
        )}

        {/* ══ СКЛАД ══ */}
        {tab==="stock"&&(
          <div>
            <div style={{display:"flex",gap:1,marginBottom:16,background:C.border,padding:1,position:"sticky",top:0,zIndex:10}}>
              {[["ws",workshop],["main","Общий склад"],["move","Перемещение"]].map(([id,label])=>(
                <button key={id} onClick={()=>switchStockTab(id)} style={{
                  flex:1,padding:"12px 4px",fontSize:12,fontWeight:800,border:"none",cursor:"pointer",
                  background:stockTab===id?C.bgCard:C.bgSection,
                  color:stockTab===id?C.brand:C.textSub,
                  borderTop:`3px solid ${stockTab===id?C.brand:"transparent"}`,
                  textTransform:"uppercase",letterSpacing:"0.8px",transition:"all .2s cubic-bezier(0.16,1,0.3,1)",
                }}>{label}</button>
              ))}
            </div>
            {stockTab==="ws"&&(
              <div>
                <div style={{fontSize:13,color:C.textSub,marginBottom:10}}>Остатки · <b style={{color:wsColor}}>{workshop}</b></div>
                <StockControls search={stockSearch} setSearch={setStockSearch}
                  onExpandAll={()=>{const all={};sortedCategories(safeMarkers).forEach(c=>all[c]=true);setExpandedCats(all);}}
                  onCollapseAll={()=>setExpandedCats({})}/>
                {sortedCategories(safeMarkers).map(cat=>renderStockCategory(cat,wsStock,true))}
                <div style={{fontSize:11,color:C.textDim,marginTop:4}}>«Прочие услуги» в складе не отображаются</div>
              </div>
            )}
            {stockTab==="main"&&(
              <div>
                <div style={{fontSize:13,color:C.textSub,marginBottom:10}}>Общий склад</div>
                <StockControls search={stockSearch} setSearch={setStockSearch}
                  onExpandAll={()=>{const all={};sortedCategories(safeMarkers).forEach(c=>all[c]=true);setExpandedCats(all);}}
                  onCollapseAll={()=>setExpandedCats({})}/>
                {sortedCategories(safeMarkers).map(cat=>renderStockCategory(cat,stockMain,false))}
              </div>
            )}
            {stockTab==="move"&&(
              <div>
                <div style={{...s.card,marginBottom:16}}>
                  <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>Поступление на общий склад</div>
                  <label style={s.label}>Маркировка</label>
                  <MarkerPicker markers={safeMarkers} value={moveMarker} onChange={setMoveMarker}/>
                  <label style={{...s.label,marginTop:10}}>Количество</label>
                  <StepperInput value={moveQty} onChange={setMoveQty} min={1} style={{marginBottom:10}}/>
                  <button onClick={async()=>{
                    if(!moveMarker||moveQty<=0){setMoveMsg({ok:false,text:"Заполните поля"});return;}
                    // Поступление на склад = delta (никаких конфликтов)
                    await appendStockOp("delta", {
                      location: "main",
                      marker: moveMarker,
                      delta: moveQty,
                    });
                    setMoveMsg({ok:true,text:`+${moveQty} шт «${moveMarker}» на склад`});
                    setMoveMarker(""); setMoveQty(1); setTimeout(()=>setMoveMsg(null),3000);
                  }} style={{...s.btn("accent"),width:"100%"}}>Добавить на общий склад</button>
                </div>
                <div style={s.card}>
                  <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>Общий склад → Мастерская</div>
                  <label style={s.label}>Маркировка</label>
                  <MarkerPicker markers={safeMarkers} value={moveMarker} onChange={setMoveMarker} extraLabel={m=>`склад: ${safeStockMain[m]||0}`}/>
                  <label style={{...s.label,marginTop:10}}>В мастерскую</label>
                  <select value={moveTo} onChange={e=>setMoveTo(e.target.value)} style={{...s.input,marginBottom:10}}>
                    {WORKSHOPS.map(w=><option key={w}>{w}</option>)}
                  </select>
                  <label style={s.label}>Количество</label>
                  <StepperInput value={moveQty} onChange={setMoveQty} min={1} style={{marginBottom:10}}/>
                  <button onClick={doMove} style={{...s.btn("accent"),width:"100%"}}>Переместить</button>
                </div>
                {moveMsg&&<div style={{textAlign:"center",marginTop:10,fontSize:13,color:moveMsg.ok?C.success:C.danger}}>{moveMsg.text}</div>}
                
                {/* История перемещений */}
                {stockMoves.length > 0 && (
                  <div style={{...s.card,marginTop:16}}>
                    <div style={{fontSize:13,fontWeight:700,marginBottom:10,color:C.textSub}}>ИСТОРИЯ ПЕРЕМЕЩЕНИЙ</div>
                    <div style={{maxHeight:300,overflowY:"auto"}}>
                      {stockMoves.slice().reverse().slice(0, 50).map(mv => {
                        const dt = new Date(mv.timestamp);
                        const dateStr = `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
                        const fromLabel = mv.from === "main" ? "Общий склад" : mv.from;
                        const toLabel = mv.to === "main" ? "Общий склад" : mv.to;
                        return (
                          <div key={mv.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                            padding:"6px 0",borderBottom:`1px solid ${C.border}22`,fontSize:12}}>
                            <div>
                              <div style={{fontWeight:600,color:C.text}}>{mv.marker} × {mv.qty} шт</div>
                              <div style={{color:C.textDim,fontSize:11}}>{dateStr} · {fromLabel} → {toLabel}</div>
                            </div>
                            {mv.reverted ? (
                              <span style={{fontSize:10,color:C.textDim,fontStyle:"italic"}}>отменено</span>
                            ) : (
                              <button onClick={()=>undoMove(mv)} style={{...s.btn(),padding:"3px 8px",fontSize:10}}>↶ Отменить</button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ══ МАРКИРОВКИ (Цены + Алиасы + Комментарии) ══ */}
        {tab==="prices"&&(
          <div>
            <div style={{...s.card,marginBottom:16,borderColor:C.brand+"44"}}>
              <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:C.brand}}>+ Добавить маркировку</div>
              <label style={s.label}>Категория</label>
              <select value={newMarkerCat} onChange={e=>setNewMarkerCat(e.target.value)} style={{...s.input,marginBottom:10}}>
                <option value="">Выбрать...</option>
                {sortedCategories(safeMarkers).map(c=><option key={c}>{c}</option>)}
              </select>
              <label style={s.label}>Название</label>
              <div style={{display:"flex",gap:8}}>
                <input value={newMarkerName} onChange={e=>setNewMarkerName(e.target.value)} placeholder="Например: CI52D"
                  style={s.input} onKeyDown={e=>{if(e.key==="Enter")addMarker();}}/>
                <button onClick={addMarker} style={{...s.btn("accent"),whiteSpace:"nowrap"}}>Добавить</button>
              </div>
              {newMarkerMsg&&<div style={{fontSize:12,marginTop:8,color:newMarkerMsg.ok?C.success:C.danger}}>{newMarkerMsg.text}</div>}
            </div>

            <input value={priceSearch} onChange={e=>setPriceSearch(e.target.value)} placeholder="Поиск маркировки..." style={{...s.input,marginBottom:14}}/>

            {sortedCategoryEntries(safeMarkers).map(([cat,ms])=>{
              const filtered = ms.filter(m=>matchesSearch(m, priceSearch));
              if(filtered.length===0) return null;
              const expanded = priceExpandedCats[cat]===true;
              const withPrice = filtered.filter(m=>safePrices[m]).length;
              return (
                <div key={cat} style={{...s.card,padding:0,overflow:"hidden",marginBottom:8}}>
                  <div onClick={()=>setPriceExpandedCats(p=>({...p,[cat]:!expanded}))}
                    style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",
                      cursor:"pointer",background:expanded?C.bgCard:C.bgSection,borderBottom:expanded?`1px solid ${C.border}`:"none"}}>
                    <span style={{fontWeight:700,fontSize:13,color:C.text}}>{cat}</span>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <span style={{fontSize:11,color:C.textDim,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.5px"}}>{withPrice}/{filtered.length} с ценой</span>
                      <span style={{color:C.textDim,fontSize:12}}>{expanded?"▲":"▼"}</span>
                    </div>
                  </div>
                  {expanded&&(
                    <div style={{borderTop:`1px solid ${C.border}`}}>
                      {filtered.map(m=>{
                        const mAliases = getAliases(m);
                        const mNote = getNote(m);
                        const cachedPhoto = photoCache[m];
                        return (
                        <div key={m} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                          padding:"8px 14px",borderBottom:`1px solid ${C.border}22`,gap:8,flexWrap:"wrap"}}>
                          <MarkerPhotoThumb markerName={m} photo={cachedPhoto} onPhotoLoaded={(url)=>setPhotoCache(p=>({...p,[m]:url}))} onPhotoClick={()=>cachedPhoto && setPhotoModal({url: cachedPhoto, markerName: m})}/>
                          <div style={{flex:1,minWidth:80}}>
                            <div style={{fontSize:13,color:C.text}}>{m}</div>
                            {mAliases.length > 0 && <div style={{fontSize:10,color:C.textDim,marginTop:2}}>= {mAliases.join(", ")}</div>}
                            {mNote && <div style={{fontSize:10,color:C.warn,marginTop:2,fontStyle:"italic"}}>💬 {mNote}</div>}
                          </div>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <StepperInput value={safePrices[m]||0} silentSave={async (val) => { const np = {...safePrices}; if(val > 0) np[m] = val; else delete np[m]; silentSaveState("prices", np, setPrices); }} step={10} />
                            <span style={{fontSize:12,color:C.textSub,whiteSpace:"nowrap"}}>р/шт</span>
                            <button onClick={()=>setNoteModal({markerName:m})} title="Комментарий" style={{...s.btn(),padding:"5px 8px",fontSize:11,borderColor:mNote?C.warn+"66":C.border,color:mNote?C.warn:C.textSub}}>💬</button>
                            <button onClick={()=>setAliasesModal({cat, markerName:m})} title="Алиасы" style={{...s.btn(),padding:"5px 8px",fontSize:11,borderColor:mAliases.length>0?C.brand+"66":C.border,color:mAliases.length>0?C.brand:C.textSub}}>≡</button>
                            <button onClick={()=>setRenameModal({cat, oldName:m})} title="Переименовать" style={{...s.btn(),padding:"5px 8px",fontSize:11}}>✎</button>
                            <button onClick={()=>deleteMarker(cat,m)} title="Удалить" style={{...s.btn("danger"),padding:"5px 8px",fontSize:11}}>✕</button>
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
