import { useState, useEffect, useCallback, useRef, Component } from "react";
import { dbGet, dbSet, hasToken, setToken, clearToken, verifyToken, photoGet, photoSet, photoDelete } from "./github-storage.js";

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
const INCOME_PCT = 0.4;
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
function dateOf(ts){ const d=new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function monthOf(ts){ const d=new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; }
const MONTH_NAMES = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

// Знак для агрегации: продажа = +1, возврат = -1
function signOf(r){ return r.recordType === "refund" ? -1 : 1; }

// Сколько заготовок списать со склада:
// - refund: 0 (заготовка уже списана при продаже)
// - sale для "Прочие услуги": 0 (это услуги, не заготовки)
// - sale для обычных категорий: qty + defect (все изготовленные — годные + брак)
// - sale с qty=0 и defect=0: 0 (пустая запись)
function stockDelta(r){
  if(r.recordType === "refund") return 0;
  if(r.category === "Прочие услуги") return 0;
  return (r.qty || 0) + (r.defect || 0);
}

// Сортировка категорий по алфавиту (А → Я)
function sortedCategories(markers){
  return Object.keys(markers).sort((a,b)=>a.localeCompare(b,"ru"));
}
function sortedCategoryEntries(markers){
  return sortedCategories(markers).map(cat=>[cat, markers[cat]]);
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
function StepperInput({ value, onChange, step = 1, min = 0, style, inputStyle }) {
  const dec = () => {
    const v = Math.max((value || 0) - step, min);
    onChange(v);
  };
  const inc = () => {
    const v = (value || 0) + step;
    onChange(v);
  };
  const btnStyle = {
    width: 32,
    height: 36,
    background: C.bgInput,
    border: `1px solid ${C.border}`,
    color: C.text,
    cursor: "pointer",
    fontSize: 18,
    fontWeight: 700,
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    userSelect: "none",
    flexShrink: 0,
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, ...style }}>
      <button type="button" onClick={dec} style={{ ...btnStyle, opacity: (value||0) <= min ? 0.4 : 1 }}>−</button>
      <NumInput value={value} onChange={onChange} min={String(min)} style={{ textAlign: "center", width: 60, padding: "6px 4px", fontSize: 13, ...inputStyle }}/>
      <button type="button" onClick={inc} style={btnStyle}>+</button>
    </div>
  );
}


async function sGet(key){ return dbGet(key); }
async function sSet(key,val){ return dbSet(key,val); }

// Защита: получить объект из любого значения (для prices, stock, cfg)
function ensureObj(v){ return (v && typeof v === "object" && !Array.isArray(v)) ? v : {}; }
// Защита: получить массив из любого значения (для records)
function ensureArr(v){ return Array.isArray(v) ? v : []; }

const C = {
  bg:"#0f1117", bgCard:"#181c27", bgInput:"#1e2333",
  border:"#2a3048", accent:"#4f8ef7", accentDim:"#1d3a6b",
  warn:"#f59e0b", warnDim:"#3d2a00", danger:"#ef4444", dangerDim:"#3b0f0f",
  success:"#22c55e", successDim:"#0a2e14",
  text:"#e2e8f0", textSub:"#8892a4", textDim:"#525d72",
  smart:"#4f8ef7", begemot:"#a78bfa",
  refund:"#f97316", refundDim:"#3d1f00",
};
const s = {
  app:{ background:C.bg, minHeight:"100vh", color:C.text, fontFamily:"'Inter',system-ui,sans-serif", fontSize:14 },
  card:{ background:C.bgCard, borderRadius:12, border:`1px solid ${C.border}`, padding:"14px 16px", marginBottom:10 },
  label:{ fontSize:12, color:C.textSub, marginBottom:4, display:"block" },
  input:{ background:C.bgInput, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, padding:"8px 12px", fontSize:14, width:"100%", boxSizing:"border-box", outline:"none" },
  btn:(v="default")=>({
    background:v==="accent"?C.accent:v==="danger"?C.dangerDim:v==="warn"?C.warnDim:v==="refund"?C.refundDim:C.bgInput,
    color:v==="accent"?"#fff":v==="danger"?C.danger:v==="warn"?C.warn:v==="refund"?C.refund:C.text,
    border:`1px solid ${v==="accent"?C.accent:v==="danger"?C.danger:v==="warn"?C.warn:v==="refund"?C.refund:C.border}`,
    borderRadius:8, padding:"8px 14px", fontSize:13, cursor:"pointer", fontWeight:500,
  }),
  tag:(color)=>({ background:color+"22", color, border:`1px solid ${color}44`, borderRadius:6, padding:"2px 8px", fontSize:12, display:"inline-block" }),
};

function Tabs({ tabs, active, onChange }){
  return (
    <div style={{display:"flex",gap:4,marginBottom:16,background:C.bgCard,borderRadius:10,padding:4,border:`1px solid ${C.border}`}}>
      {tabs.map(t=>(
        <button key={t.id} onClick={()=>onChange(t.id)} style={{
          flex:1,padding:"7px 4px",fontSize:12,fontWeight:600,borderRadius:8,border:"none",cursor:"pointer",
          background:active===t.id?C.accent:"transparent",color:active===t.id?"#fff":C.textSub,transition:"all .15s"
        }}>{t.label}</button>
      ))}
    </div>
  );
}

function StatCard({ label, value, sub, color }){
  return (
    <div style={{...s.card,padding:"12px 14px"}}>
      <div style={{fontSize:11,color:C.textSub,marginBottom:2}}>{label}</div>
      <div style={{fontSize:20,fontWeight:700,color:color||C.text}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:C.textDim,marginTop:2}}>{sub}</div>}
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
  if(recordType === "refund") return <span style={{...s.tag(C.refund), fontSize:10}}>↩ Возврат</span>;
  return null;
}

function MarkerPicker({ markers, value, onChange, extraLabel }){
  const [search, setSearch] = useState("");
  const allM = Object.entries(markers).flatMap(([cat,ms])=>ms.map(m=>({cat,m})));
  const filtered = search.trim()
    ? allM.filter(({cat,m})=>m.toLowerCase().includes(search.toLowerCase())||cat.toLowerCase().includes(search.toLowerCase()))
    : allM;
  const grouped = {};
  filtered.forEach(({cat,m})=>{ if(!grouped[cat]) grouped[cat]=[]; grouped[cat].push(m); });
  return (
    <div>
      <input value={search} onChange={e=>setSearch(e.target.value)}
        placeholder="Поиск маркировки..." style={{...s.input,marginBottom:8}}/>
      <div style={{maxHeight:200,overflowY:"auto",border:`1px solid ${C.border}`,borderRadius:8,background:C.bgInput}}>
        {Object.entries(grouped).length===0
          ? <div style={{padding:"10px 14px",fontSize:13,color:C.textDim}}>Ничего не найдено</div>
          : Object.entries(grouped).map(([cat,ms])=>(
            <div key={cat}>
              <div style={{padding:"5px 12px",fontSize:11,fontWeight:700,color:C.textDim,background:"#13161f",
                borderBottom:`1px solid ${C.border}`,textTransform:"uppercase"}}>{cat}</div>
              {ms.map(m=>(
                <div key={m} onClick={()=>{onChange(m);setSearch("");}}
                  style={{padding:"8px 14px",fontSize:13,cursor:"pointer",display:"flex",justifyContent:"space-between",
                    background:value===m?C.accentDim:"transparent",color:value===m?C.accent:C.text,
                    borderBottom:`1px solid ${C.border}22`}}>
                  <span>{m}</span>
                  {extraLabel&&<span style={{color:C.textDim,fontSize:12}}>{extraLabel(m)}</span>}
                </div>
              ))}
            </div>
          ))
        }
      </div>
      {value&&<div style={{marginTop:6,fontSize:12,color:C.accent}}>Выбрано: <b>{value}</b></div>}
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
              border:`1px solid ${recordType===id?(id==="refund"?C.refund:C.accent):C.border}`,
              background:recordType===id?(id==="refund"?C.refundDim:C.accentDim):C.bgInput,
              color:recordType===id?(id==="refund"?C.refund:C.accent):C.textSub
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
              background:mrk===m?C.accentDim:C.bgInput,
              border:`1px solid ${mrk===m?C.accent:C.border}`,color:mrk===m?C.accent:C.text
            }}>{m}</button>
          ))}
        </div>
        <input value={mrk} onChange={e=>setMrk(e.target.value)} style={{...s.input,marginBottom:10}} placeholder="или своя маркировка"/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
          <div><label style={s.label}>Готовых <span style={{color:C.textDim,fontSize:10}}>(годные)</span></label><StepperInput value={qty} onChange={setQty} style={{width:"100%"}} inputStyle={{width:"100%"}}/></div>
          <div><label style={s.label}>Брак <span style={{color:C.textDim,fontSize:10}}>(испорченные)</span></label><StepperInput value={defect} onChange={setDefect} style={{width:"100%"}} inputStyle={{width:"100%"}}/></div>
        </div>
        {recordType==="sale"&&qty>0&&defect>0&&(
          <div style={{fontSize:11,color:C.textDim,marginBottom:10,lineHeight:1.5}}>
            Всего изготовлено: <b>{qty+defect} шт</b> · Списание со склада: <b>{qty+defect} шт</b> · Сумма: <b>{qty} шт</b> × цена
          </div>
        )}
        <label style={s.label}>Сумма, руб {recordType==="refund"&&<span style={{color:C.refund}}>(будет вычтена)</span>}</label>
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
    if(!byCategory[r.category]) byCategory[r.category]={qty:0,defect:0,amount:0,markers:{}};
    byCategory[r.category].qty += r.qty * sign;
    byCategory[r.category].defect += r.defect;
    byCategory[r.category].amount += r.amount * sign;
    const mk=r.marker;
    if(!byCategory[r.category].markers[mk]) byCategory[r.category].markers[mk]={qty:0,defect:0,amount:0};
    byCategory[r.category].markers[mk].qty += r.qty * sign;
    byCategory[r.category].markers[mk].defect += r.defect;
    byCategory[r.category].markers[mk].amount += r.amount * sign;
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
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontWeight:700,fontSize:13}}>{cat}</span>
              {d.defect>0&&<span style={s.tag(C.warn)}>{d.defect} брак</span>}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{textAlign:"right"}}>
                <div style={{color:d.amount>=0?C.accent:C.refund,fontWeight:700,fontSize:13}}>{fmt(d.amount)} р</div>
                <div style={{fontSize:11,color:C.textSub}}>{fmt(d.qty)} шт · {totalAmt>0?(Math.abs(d.amount)/Math.abs(totalAmt)*100).toFixed(0):0}%</div>
              </div>
              <span style={{color:C.textDim,fontSize:12}}>{expanded[cat]?"▲":"▼"}</span>
            </div>
          </div>
          {expanded[cat]&&(
            <div style={{borderTop:`1px solid ${C.border}`}}>
              {Object.entries(d.markers).sort((a,b)=>b[1].qty-a[1].qty).map(([mk,md])=>(
                <div key={mk} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                  padding:"7px 14px",borderBottom:`1px solid ${C.border}22`,fontSize:13}}>
                  <span style={{color:C.textSub}}>{mk}</span>
                  <div style={{textAlign:"right"}}>
                    <div style={{color:md.amount>=0?C.accent:C.refund}}>{fmt(md.amount)} р</div>
                    <div style={{fontSize:11,color:C.textDim}}>{fmt(md.qty)} шт{md.defect?` · брак ${md.defect}`:""}</div>
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
  dayRecs.forEach(r=>{
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
      <StatsBreakdown data={dayRecs} totalAmt={totalAmt} totalQty={totalQtySold-totalQtyRefund}/>
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
                style={{...s.card,cursor:"pointer",borderLeft:`3px solid ${isRefund?C.refund:isOnlyDefect?C.warn:C.accent+"88"}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    {isRefund
                      ? <span style={{color:C.refund,fontWeight:700,fontSize:16}}>↩</span>
                      : isOnlyDefect
                        ? <span style={{color:C.warn,fontWeight:700,fontSize:16}}>⚠</span>
                        : <span style={{color:C.success,fontWeight:700,fontSize:16}}>↑</span>}
                    <span style={{fontWeight:600}}>{r.marker}</span>
                    {isRefund&&<TypeBadge recordType="refund"/>}
                    {isOnlyDefect&&<span style={{...s.tag(C.warn),fontSize:10}}>только брак</span>}
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span style={{fontSize:12,color:isRefund?C.refund:isOnlyDefect?C.warn:C.textSub}}>
                      {isRefund?"−":""}{r.qty} шт{r.defect>0?` · брак ${r.defect}`:""} · {fmt(r.amount)} р
                    </span>
                    <span style={{fontSize:11,color:C.accent}}>✎</span>
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
            <div style={{color:monthData.amount>=0?C.accent:C.refund,fontWeight:700,fontSize:14}}>{fmt(monthData.amount)} р</div>
            <div style={{fontSize:11,color:C.textSub}}>{fmt(monthData.qty)} шт · {monthData.days.size} дн.</div>
          </div>
          <span style={{color:C.textDim,fontSize:14}}>{expanded?"▲":"▼"}</span>
        </div>
      </div>
      {!expanded && (
        <div style={{display:"flex",gap:16,padding:"0 14px 10px",fontSize:11,color:C.textDim,flexWrap:"wrap"}}>
          <span>Среднее: {fmt(avgPerDay)} р/день</span>
          {workshop==="SMART" && <span style={{color:C.success}}>Доход: {fmt(monthData.amount*INCOME_PCT)} р</span>}
        </div>
      )}
      {expanded && (
        <div style={{borderTop:`1px solid ${C.border}`,padding:"12px 14px"}}>
          {/* ПОЛНАЯ СТАТИСТИКА — как во вкладке "Месяц" */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            <StatCard label="Всего ключей" value={fmt(monthData.qty)}/>
            <StatCard label="Общая сумма" value={fmt(monthData.amount)+" р"}/>
            <StatCard label="Брак" value={fmt(monthData.defect)} color={monthData.defect>0?C.warn:undefined}/>
            <StatCard label="% брака" value={monthData.qty>0?(monthData.defect/Math.abs(monthData.qty)*100).toFixed(1)+"%":"0%"} color={monthData.defect>0?C.warn:undefined}/>
            <StatCard label="Рабочих дней" value={monthData.days.size} sub="дней с записями"/>
            <StatCard label="Среднее/день" value={fmt(avgPerDay)+" р"} sub="по рабочим дням"/>
            {workshop==="SMART"&&<StatCard label="Доход 40%" value={fmt(monthData.amount*INCOME_PCT)+" р"} color={C.success}/>}
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
          <span style={{color:dayData.amount>=0?C.accent:C.refund,fontWeight:600}}>{fmt(dayData.amount)} р</span>
          <span style={{color:C.textDim}}>{dayData.qty} шт{dayData.defect>0?` · брак ${dayData.defect}`:""}</span>
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
                  <span style={{color:isRefund?C.refund:isOnlyDefect?C.warn:C.success}}>
                    {isRefund?"↩":isOnlyDefect?"⚠":"↑"}
                  </span>
                  <span style={{color:C.text}}>{r.marker}</span>
                  {isRefund && <span style={{...s.tag(C.refund),fontSize:9,padding:"1px 5px"}}>возврат</span>}
                  {isOnlyDefect && <span style={{...s.tag(C.warn),fontSize:9,padding:"1px 5px"}}>брак</span>}
                </div>
                <div style={{display:"flex",gap:6,fontSize:11,color:C.textSub}}>
                  <span>{isRefund?"−":""}{r.qty} шт{r.defect>0?`/${r.defect}`:""}</span>
                  <span style={{color:isRefund?C.refund:C.accent}}>{fmt(r.amount)} р</span>
                  <span style={{color:C.accent}}>✎</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Топ-15 популярных маркировок за год (для текущей мастерской и категории) ──
// Категории, для которых НЕ показываем топ (мало наименований):
const NO_TOP_CATEGORIES = ["Домофонные", "Крестовые", "Прочие услуги"];

function TopMarkersBlock({ records, workshop, wsStock, stockCfg, onPick, selected, category }){
  // Не показываем топ для некоторых категорий
  if(NO_TOP_CATEGORIES.includes(category)){
    return null;
  }
  const [expanded, setExpanded] = useState(true);
  const now = new Date();
  const yearAgo = now.getTime() - 365 * 24 * 60 * 60 * 1000;
  // Считаем количество проданных ключей (qty) за последний год, только sale, только текущая категория
  const counts = {};
  records.forEach(r=>{
    if(r.workshop !== workshop) return;
    if(r.recordType === "refund") return;
    if(r.category !== category) return;
    if(r.timestamp < yearAgo) return;
    counts[r.marker] = (counts[r.marker] || 0) + (r.qty || 0);
  });
  const top = Object.entries(counts)
    .sort((a,b)=>b[1]-a[1])
    .slice(0, 15)
    .filter(([m,c])=>c > 0);

  if(top.length === 0){
    return (
      <div style={{...s.card,marginBottom:12,padding:"10px 14px",borderColor:C.accent+"33"}}>
        <div style={{fontSize:11,color:C.textDim,lineHeight:1.5}}>
          ⭐ Топ-15 по категории «{category}» появится после первых продаж
        </div>
      </div>
    );
  }

  return (
    <div style={{...s.card,marginBottom:12,padding:0,overflow:"hidden",borderColor:C.accent+"44"}}>
      <div onClick={()=>setExpanded(v=>!v)}
        style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",cursor:"pointer",
          background:C.accentDim}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{color:C.accent,fontSize:14}}>⭐</span>
          <span style={{fontWeight:700,fontSize:12,color:C.accent}}>ТОП-{top.length} · {category}</span>
        </div>
        <span style={{color:C.textDim,fontSize:11}}>{expanded?"▲":"▼"}</span>
      </div>
      {expanded && (
        <div style={{padding:"8px 12px",display:"flex",flexWrap:"wrap",gap:5}}>
          {top.map(([m,c],i)=>{
            const wq = wsStock[m]||0;
            const cfg = stockCfg[m]||{};
            const low = cfg.threshold > 0 && wq <= cfg.threshold && wq > 0;
            const empty = wq === 0;
            const isSelected = selected === m;
            // Цвета: красный только если реально 0 (не для услуг), жёлтый если ниже порога, иначе нейтрально
            const bgColor = isSelected ? C.accent : (empty ? C.dangerDim : low ? C.warnDim : C.bgInput);
            const borderColor = isSelected ? C.accent : (empty ? C.danger+"88" : low ? C.warn+"88" : C.border);
            const textColor = isSelected ? "#fff" : (empty ? C.danger : low ? C.warn : C.text);
            return (
              <button key={m} onClick={()=>onPick(m)} title={`${c} ключей за год · остаток ${wq} шт`}
                style={{
                  fontSize:12, padding:"5px 10px", borderRadius:7, cursor:"pointer",
                  background: bgColor,
                  border: `1px solid ${borderColor}`,
                  color: textColor,
                  display:"flex", alignItems:"center", gap:4,
                }}>
                <span style={{fontSize:10,opacity:.7}}>{i+1}.</span>
                <span>{m}</span>
                {wq > 0 && <span style={{fontSize:10,opacity:.7}}>{wq}</span>}
                <span style={{fontSize:9,opacity:.5}}>({c})</span>
              </button>
            );
          })}
        </div>
      )}
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
          <div style={{fontSize:13,fontWeight:600,color:C.accent}}>{oldName}</div>
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
  const [prices, setPrices] = useState({});
  const [stockMain, setStockMain] = useState({});
  const [stockWS, setStockWS] = useState({SMART:{},Бегемот:{}});
  const [stockCfg, setStockCfg] = useState({});
  const [markers, setMarkers] = useState(DEFAULT_MARKERS);

  // форма записи
  const [category, setCategory] = useState("Домофонные");
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
  const [expandedCats, setExpandedCats] = useState({});
  const [stockSort, setStockSort] = useState("alpha"); // alpha | qty-desc | qty-asc | empty-first
  const [stockFilter, setStockFilter] = useState("all"); // all | with-stock | empty | low
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

  // переименование маркировки
  const [renameModal, setRenameModal] = useState(null); // {cat, oldName}

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
      const [r,p,sm,sS,sCfg,sm2] = await Promise.all([
        sGet("records"), sGet("prices"),
        sGet("stock:main"), Promise.all(WORKSHOPS.map(w=>sGet(`stock:ws:${w}`))),
        sGet("stock:cfg"), sGet("custom:markers"),
      ]);
      // Защита: гарантируем, что у нас правильные типы (массив/объект),
      // иначе рендер упадёт с белым экраном
      if(Array.isArray(r)) setRecords(r);
      if(p && typeof p === "object" && !Array.isArray(p)) setPrices(p);
      if(sm && typeof sm === "object" && !Array.isArray(sm)) setStockMain(sm);
      const wsObj = {};
      WORKSHOPS.forEach((w,i)=>{
        const v = sS[i];
        wsObj[w] = (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
      });
      setStockWS(wsObj);
      if(sCfg && typeof sCfg === "object" && !Array.isArray(sCfg)) setStockCfg(sCfg);
      if(sm2 && typeof sm2 === "object" && !Array.isArray(sm2)) setMarkers(sm2);

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
  useEffect(()=>{
    if(!marker){setMarkerPhoto(null);return;}
    const cached=photoCache[marker];
    if(cached!==undefined){setMarkerPhoto(cached);return;}
    photoGet(marker).then(v=>{ setPhotoCache(p=>({...p,[marker]:v})); setMarkerPhoto(v); });
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
    setPasswords(next);
    await sSet("passwords", next);
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
    setRecords(next); await sSet("records", next);

    // Склад: списываем через stockDelta (для refund = 0, для sale = qty или defect)
    const delta = stockDelta(rec);
    if(delta > 0){
      const wsStk = {...stockWS[workshop]};
      wsStk[m] = Math.max((wsStk[m]||0) - delta, 0);
      setStockWS(p=>({...p,[workshop]:wsStk})); await sSet(`stock:ws:${workshop}`, wsStk);
    }

    // Сброс формы — qty/defect по 0 (как просил пользователь)
    setMarker(""); setQty(0); setDefect(0); setAmount(0);
    setManualAmount(false); setComment(""); setRecordType("sale");
    setSubmitMsg({ok:true, text: rec.recordType==="refund" ? "Возврат оформлен" : (rec.qty===0&&rec.defect>0 ? `Брак оформлен (${rec.defect} шт)` : "Запись добавлена")});
    setTimeout(()=>setSubmitMsg(null), 2000);
  }

  // ── сохранение редактируемой записи ──
  async function handleEditSave(updated){
    const old = records[editRec.globalIdx];
    const wsStk = {...(stockWS[updated.workshop]||{})};

    // 1) Возвращаем старое списание (через stockDelta: для refund = 0, для sale = qty или defect)
    const oldDelta = stockDelta(old);
    if(oldDelta > 0){
      wsStk[old.marker] = (wsStk[old.marker]||0) + oldDelta;
    }
    // 2) Применяем новое списание (через stockDelta)
    const newDelta = stockDelta(updated);
    if(newDelta > 0){
      wsStk[updated.marker] = Math.max((wsStk[updated.marker]||0) - newDelta, 0);
    }

    const next = records.map((r,i)=>i===editRec.globalIdx?updated:r);
    setRecords(next); await sSet("records", next);
    setStockWS(p=>({...p,[updated.workshop]:wsStk})); await sSet(`stock:ws:${updated.workshop}`, wsStk);
    setEditRec(null);
  }

  async function handleEditDelete(gi){
    if(!confirm("Удалить эту запись?")) return;
    const old = records[gi];
    const wsStk = {...(stockWS[old.workshop]||{})};
    // Возвращаем списание через stockDelta (для refund = 0, для sale = qty или defect)
    const oldDelta = stockDelta(old);
    if(oldDelta > 0){
      wsStk[old.marker] = (wsStk[old.marker]||0) + oldDelta;
    }
    const next = records.filter((_,i)=>i!==gi);
    setRecords(next); await sSet("records", next);
    setStockWS(p=>({...p,[old.workshop]:wsStk})); await sSet(`stock:ws:${old.workshop}`, wsStk);
    setEditRec(null);
  }

  // ── склад: перемещение ──
  async function doMove(){
    if(!moveMarker){setMoveMsg({ok:false,text:"Выберите маркировку"});return;}
    if(moveQty<=0){setMoveMsg({ok:false,text:"Количество > 0"});return;}
    const avail = stockMain[moveMarker]||0;
    if(avail<moveQty){setMoveMsg({ok:false,text:`На складе только ${avail} шт`});return;}
    const nm = {...stockMain, [moveMarker]: avail-moveQty};
    const ws = {...stockWS[moveTo], [moveMarker]:(stockWS[moveTo][moveMarker]||0)+moveQty};
    setStockMain(nm); await sSet("stock:main", nm);
    setStockWS(p=>({...p,[moveTo]:ws})); await sSet(`stock:ws:${moveTo}`, ws);
    setMoveMsg({ok:true, text:`${moveQty} шт «${moveMarker}» → ${moveTo}`});
    setMoveQty(1); setMoveMarker(""); setTimeout(()=>setMoveMsg(null), 3000);
  }

  // ── маркировки: добавить / удалить ──
  async function addMarker(){
    if(!newMarkerCat || !newMarkerName.trim()){setNewMarkerMsg({ok:false,text:"Укажите категорию и название"});return;}
    const nm = newMarkerName.trim();
    if((markers[newMarkerCat]||[]).includes(nm)){setNewMarkerMsg({ok:false,text:"Уже есть"});return;}
    const next = {...markers, [newMarkerCat]:[...(markers[newMarkerCat]||[]), nm]};
    setMarkers(next); await sSet("custom:markers", next);
    setNewMarkerName(""); setNewMarkerMsg({ok:true, text:`«${nm}» добавлена`});
    setTimeout(()=>setNewMarkerMsg(null), 2000);
  }
  async function deleteMarker(cat,m){
    if(!confirm(`Удалить «${m}»?`)) return;
    const next = {...markers, [cat]:markers[cat].filter(x=>x!==m)};
    setMarkers(next); await sSet("custom:markers", next);
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
    setMarkers(nextMarkers);
    await sSet("custom:markers", nextMarkers);

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
      setRecords(nextRecords);
      await sSet("records", nextRecords);
    }

    // 3. prices (цены)
    if(prices[oldName] !== undefined){
      const nextPrices = {...prices};
      nextPrices[newName] = nextPrices[oldName];
      delete nextPrices[oldName];
      setPrices(nextPrices);
      await sSet("prices", nextPrices);
    }

    // 4. stock:main (общий склад)
    if(stockMain[oldName] !== undefined){
      const nextStockMain = {...stockMain};
      nextStockMain[newName] = nextStockMain[oldName];
      delete nextStockMain[oldName];
      setStockMain(nextStockMain);
      await sSet("stock:main", nextStockMain);
    }

    // 5. stock:ws:SMART и stock:ws:Бегемот
    for(const ws of WORKSHOPS){
      if(stockWS[ws] && stockWS[ws][oldName] !== undefined){
        const nextWs = {...stockWS[ws]};
        nextWs[newName] = nextWs[oldName];
        delete nextWs[oldName];
        setStockWS(p=>({...p, [ws]: nextWs}));
        await sSet(`stock:ws:${ws}`, nextWs);
      }
    }

    // 6. stock:cfg (пороги)
    if(stockCfg[oldName] !== undefined){
      const nextCfg = {...stockCfg};
      nextCfg[newName] = nextCfg[oldName];
      delete nextCfg[oldName];
      setStockCfg(nextCfg);
      await sSet("stock:cfg", nextCfg);
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

  // ── Панель управления складом: поиск + сортировка + фильтры ──
  function StockControls({ search, setSearch, sort, setSort, filter, setFilter }){
    const filterBtn = (id, label, color) => (
      <button type="button" onClick={()=>setFilter(id)} style={{
        padding:"5px 10px",fontSize:11,fontWeight:600,borderRadius:6,cursor:"pointer",
        border:`1px solid ${filter===id?(color||C.accent):C.border}`,
        background:filter===id?((color||C.accent)+"22"):C.bgInput,
        color:filter===id?(color||C.accent):C.textSub,
      }}>{label}</button>
    );
    return (
      <div style={{marginBottom:12}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Поиск по маркировке..." style={{...s.input,marginBottom:8}}/>
        <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
          {filterBtn("all","Все",C.accent)}
          {filterBtn("with-stock","С остатком",C.success)}
          {filterBtn("empty","Пустые",C.danger)}
          {filterBtn("low","⚠ Мало",C.warn)}
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center",fontSize:11,color:C.textSub,marginBottom:8}}>
          <span>Сорт.:</span>
          <select value={sort} onChange={e=>setSort(e.target.value)} style={{...s.input,padding:"4px 8px",fontSize:11,flex:1}}>
            <option value="alpha">По алфавиту (А→Я)</option>
            <option value="qty-desc">По остатку (больше → меньше)</option>
            <option value="qty-asc">По остатку (меньше → больше)</option>
            <option value="empty-first">Сначала пустые</option>
          </select>
        </div>
        <div style={{display:"flex",gap:6}}>
          <button type="button" onClick={()=>setExpandedCats({})} style={{...s.btn(),padding:"4px 10px",fontSize:11}}>
            ▼ Раскрыть все
          </button>
          <button type="button" onClick={()=>{
            const all = {};
            sortedCategories(safeMarkers).forEach(c => all[c] = false);
            setExpandedCats(all);
          }} style={{...s.btn(),padding:"4px 10px",fontSize:11}}>
            ▲ Свернуть все
          </button>
        </div>
      </div>
    );
  }

  function renderStockCategory(cat, stockObj, isWS){
    // «Прочие услуги» — не показываем в складах (это услуги, не заготовки)
    if(cat === "Прочие услуги") return null;
    const ms = markers[cat]||[];
    const search = stockSearch.toLowerCase();
    // Поиск
    let filtered = search ? ms.filter(m=>m.toLowerCase().includes(search)) : ms.slice();
    // Фильтр
    filtered = filtered.filter(m=>{
      const q = stockObj[m]||0;
      const cfg = stockCfg[m]||{};
      const isLow = cfg.threshold > 0 && q <= cfg.threshold;
      if(stockFilter === "with-stock") return q > 0;
      if(stockFilter === "empty") return q === 0;
      if(stockFilter === "low") return isLow;
      return true; // all
    });
    if(filtered.length===0) return null;
    // Сортировка (сохраняем оригинальный индекс для stable sort)
    filtered = filtered.map((m, idx) => ({ m, idx }));
    if(stockSort === "alpha"){
      filtered.sort((a,b) => a.m.localeCompare(b.m, "ru"));
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
    const expanded = expandedCats[cat]!==false;
    return (
      <div key={cat} style={{...s.card,padding:0,overflow:"hidden",marginBottom:8}}>
        <div onClick={()=>setExpandedCats(p=>({...p,[cat]:!expanded}))}
          style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",cursor:"pointer",background:expanded?C.bgCard:"#141826"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <span style={{fontWeight:700,fontSize:13}}>{cat}</span>
            <span style={{fontSize:11,color:C.textDim}}>
              {filteredMs.length} шт
              {withStockCount > 0 && <span style={{color:C.success}}> · {withStockCount} с остатком</span>}
              {emptyCount > 0 && <span style={{color:C.danger}}> · {emptyCount} пустых</span>}
            </span>
            {hasLow&&<span style={{...s.tag(C.warn),fontSize:10,padding:"1px 6px"}}>⚠ мало</span>}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:12,color:C.textSub}}>итого: <b style={{color:C.text}}>{total}</b></span>
            <span style={{color:C.textDim,fontSize:12}}>{expanded?"▲":"▼"}</span>
          </div>
        </div>
        {expanded&&(
          <div style={{borderTop:`1px solid ${C.border}`}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 150px",gap:6,
              padding:"6px 14px",fontSize:11,color:C.textDim,borderBottom:`1px solid ${C.border}`,background:"#13161f"}}>
              <span>Маркировка</span><span style={{textAlign:"center"}}>Кол-во</span>
            </div>
            {filteredMs.map(m=>{
              const q=stockObj[m]||0,cfg=stockCfg[m]||{};
              return (
                <div key={m} style={{display:"grid",gridTemplateColumns:"1fr 150px",gap:6,
                  padding:"7px 14px",borderBottom:`1px solid ${C.border}22`,alignItems:"center",
                  background:q===0?"#16111a":q>0&&cfg.threshold>0&&q<=cfg.threshold?"#1f1a0e":"transparent"}}>
                  <span style={{fontSize:13,color:q===0?C.textDim:C.text}}>{m}</span>
                  <StepperInput value={q} onChange={async nq=>{
                    const ns={...stockObj,[m]:nq};
                    if(isWS){
                      setStockWS(p=>({...p,[workshop]:ns}));
                      debouncedSave(`stock:ws:${workshop}`, ns);
                    } else {
                      setStockMain(ns);
                      debouncedSave("stock:main", ns);
                    }
                  }} inputStyle={{
                    color:q===0?C.danger:cfg.threshold>0&&q<=cfg.threshold?C.warn:C.success
                  }}/>
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
      return (
        <div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            <StatCard label="Всего ключей" value={fmt(totalQty)}/>
            <StatCard label="Общая сумма" value={fmt(totalAmt)+" р"}/>
            <StatCard label="Брак" value={fmt(totalDef)} color={totalDef>0?C.warn:undefined}/>
            <StatCard label="% брака" value={totalQty>0?(totalDef/Math.abs(totalQty)*100).toFixed(1)+"%":"0%"} color={totalDef>0?C.warn:undefined}/>
            {workshop==="SMART"&&<StatCard label="Доход 40%" value={fmt(totalAmt*INCOME_PCT)+" р"} color={C.success}/>}
          </div>
          <div style={{fontSize:13,fontWeight:700,color:C.textSub,marginBottom:8}}>ПО КАТЕГОРИЯМ</div>
          <StatsBreakdown data={data} totalAmt={totalAmt} totalQty={totalQty}/>
          <div style={{fontSize:13,fontWeight:700,color:C.textSub,marginBottom:8,marginTop:16}}>ОТЧЁТ ДНЯ · СКЛАД</div>
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
      return (
        <div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            <StatCard label="Всего ключей" value={fmt(totalQty)}/>
            <StatCard label="Общая сумма" value={fmt(totalAmt)+" р"}/>
            <StatCard label="Брак" value={fmt(totalDef)} color={totalDef>0?C.warn:undefined}/>
            <StatCard label="% брака" value={totalQty>0?(totalDef/Math.abs(totalQty)*100).toFixed(1)+"%":"0%"} color={totalDef>0?C.warn:undefined}/>
            <StatCard label="Рабочих дней" value={workDays} sub="дней с записями"/>
            <StatCard label="Среднее/день" value={fmt(avgPerDay)+" р"} sub="по рабочим дням"/>
            {workshop==="SMART"&&<StatCard label="Доход 40%" value={fmt(totalAmt*INCOME_PCT)+" р"} color={C.success}/>}
          </div>
          <div style={{fontSize:13,fontWeight:700,color:C.textSub,marginBottom:8}}>ПО КАТЕГОРИЯМ</div>
          <StatsBreakdown data={data} totalAmt={totalAmt} totalQty={totalQty}/>
          <div style={{fontSize:13,fontWeight:700,color:C.textSub,marginBottom:8,marginTop:16}}>ПО ДНЯМ</div>
          {Object.entries(byDay).sort((a,b)=>a[0].localeCompare(b[0])).map(([dk,d])=>{
            const parts = dk.split("-");
            const label = `${parts[2]}.${parts[1]}`;
            return (
              <div key={dk} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${C.border}`,fontSize:13}}>
                <span style={{color:C.textSub}}>{label}</span>
                <div style={{textAlign:"right"}}>
                  <span style={{color:d.amount>=0?C.accent:C.refund,marginRight:12}}>{fmt(d.amount)} р</span>
                  <span style={{color:C.textSub,fontSize:12}}>{d.qty} шт{d.defect?` · брак ${d.defect}`:""}</span>
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
            <StatCard label="Общая сумма" value={fmt(totalAmt)+" р"}/>
            <StatCard label="Брак" value={fmt(totalDef)} color={totalDef>0?C.warn:undefined}/>
            <StatCard label="% брака" value={totalQty>0?(totalDef/Math.abs(totalQty)*100).toFixed(1)+"%":"0%"} color={totalDef>0?C.warn:undefined}/>
            {workshop==="SMART"&&<StatCard label="Доход 40%" value={fmt(totalAmt*INCOME_PCT)+" р"} color={C.success}/>}
          </div>
          <div style={{fontSize:13,fontWeight:700,color:C.textSub,marginBottom:8}}>ПО МЕСЯЦАМ — нажмите для раскрытия по дням</div>
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
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{fontSize:32,marginBottom:8}}>🔑</div>
          <div style={{fontSize:22,fontWeight:700}}>Мастерская</div>
          <div style={{fontSize:13,color:C.textSub,marginTop:4}}>Подключение к хранилищу</div>
        </div>
        <div style={{...s.card,marginBottom:16,background:C.bgInput,padding:"10px 12px"}}>
          <div style={{fontSize:11,color:C.textSub,lineHeight:1.5}}>
            📦 Данные хранятся в GitHub (приватный репозиторий).<br/>
            Введите Personal Access Token от вашего GitHub.
          </div>
        </div>
        <label style={s.label}>GitHub Personal Access Token</label>
        <input type="password" value={tokenInput}
          onChange={e=>setTokenInput(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"&&!tokenChecking)handleTokenSubmit();}}
          placeholder="ghp_xxxxxxxxxxxx"
          style={{...s.input,marginBottom:10,fontSize:13}}/>
        {tokenError&&<div style={{fontSize:12,color:C.danger,marginBottom:10}}>{tokenError}</div>}
        <button onClick={handleTokenSubmit} disabled={tokenChecking}
          style={{...s.btn("accent"),width:"100%",padding:"12px 0",fontSize:15,fontWeight:700,opacity:tokenChecking?.6:1}}>
          {tokenChecking ? "Проверка..." : "Подключиться"}
        </button>
        <div style={{fontSize:11,color:C.textDim,marginTop:12,lineHeight:1.5}}>
          Токен создаётся в:<br/>
          GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)<br/>
          Нужны права: <b>repo</b> (полный доступ к репозиториям).
        </div>
      </div>
    </div>
  );

  if(loading || !pwdLoaded) return (
    <div style={{...s.app,display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh"}}>
      <div style={{textAlign:"center"}}><div style={{fontSize:32,marginBottom:12}}>🔑</div><div style={{fontSize:14,color:C.textSub}}>Загрузка...</div></div>
    </div>
  );

  // Экран ввода пароля
  if(!authed) return (
    <div style={{...s.app,display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh"}}>
      <div style={{width:"100%",maxWidth:320,padding:24}}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{fontSize:32,marginBottom:8}}>🔑</div>
          <div style={{fontSize:22,fontWeight:700}}>Мастерская</div>
          <div style={{fontSize:13,color:C.textSub,marginTop:4}}>Простое Решение</div>
        </div>
        <label style={s.label}>Введите пароль</label>
        <input type="password" value={passwordInput}
          onChange={e=>setPasswordInput(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter")handleLogin();}}
          placeholder="Пароль"
          style={{...s.input,marginBottom:12,textAlign:"center",fontSize:16,letterSpacing:2}}/>
        {authError&&<div style={{fontSize:12,color:C.danger,marginBottom:10,textAlign:"center"}}>{authError}</div>}
        <button onClick={handleLogin} style={{...s.btn("accent"),width:"100%",padding:"14px 0",fontSize:16,fontWeight:700}}>Войти</button>
        <div style={{fontSize:11,color:C.textDim,textAlign:"center",marginTop:12,lineHeight:1.5}}>
          Пароль определяет мастерскую<br/>
          (по умолчанию: smart123 / begemot123)
        </div>
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
  const wsStock = ensureObj(safeStockWS[workshop]);
  const tabs = [
    {id:"record",label:"📝 Запись"},
    {id:"stats",label:"📊 Статистика"},
    {id:"stock",label:"📦 Склад"},
    {id:"prices",label:"💰 Цены"}
  ];

  return (
    <div style={s.app}>
      {editRec&&<EditModal record={editRec.record} idx={editRec.globalIdx} markers={safeMarkers}
        onSave={handleEditSave} onDelete={handleEditDelete} onClose={()=>setEditRec(null)}/>}
      {pwdModalOpen&&<PasswordModal workshop={workshop}
        onChange={handleChangePassword} onClose={()=>setPwdModalOpen(false)}/>}
      {renameModal&&<RenameMarkerModal cat={renameModal.cat} oldName={renameModal.oldName}
        onRename={renameMarker} onClose={()=>setRenameModal(null)}/>}
      <div style={{maxWidth:600,margin:"0 auto",padding:"12px 12px 40px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{...s.tag(wsColor),fontSize:13,fontWeight:700}}>{workshop}</span>
            <span style={{fontSize:12,color:C.textDim}}>{todayStr()}</span>
            {/* Индикатор статуса сохранения */}
            {Object.entries(saveStatus).map(([key, status]) => (
              <span key={key} style={{
                fontSize:10,
                padding:"2px 6px",
                borderRadius:4,
                background: status === "saving" ? C.warnDim : status === "error" ? C.dangerDim : C.successDim,
                color: status === "saving" ? C.warn : status === "error" ? C.danger : C.success,
                border: `1px solid ${status === "saving" ? C.warn : status === "error" ? C.danger : C.success}44`,
              }}>
                {status === "saving" ? "⏳ Сохранение..." : status === "error" ? "⚠ Ошибка" : "✓ Сохранено"}
              </span>
            ))}
          </div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={()=>setPwdModalOpen(true)} style={{...s.btn(),padding:"5px 10px",fontSize:12}}>🔑 Пароль</button>
            <button onClick={handleLogout} style={{...s.btn(),padding:"5px 10px",fontSize:12}}>Сменить мастерскую</button>
            <button onClick={handleTokenLogout} style={{...s.btn("danger"),padding:"5px 10px",fontSize:12}}>Отключить хранилище</button>
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
                    border:`1px solid ${recordType===id?(id==="refund"?C.refund:C.accent):C.border}`,
                    background:recordType===id?(id==="refund"?C.refundDim:C.accentDim):C.bgInput,
                    color:recordType===id?(id==="refund"?C.refund:C.accent):C.textSub
                  }}>{label}</button>
                ))}
              </div>
              {recordType==="refund"&&(
                <div style={{fontSize:11,color:C.refund,marginTop:4,lineHeight:1.5}}>
                  ↩ Сумма будет вычтена из статистики. Заготовка на склад не возвращается.
                </div>
              )}
            </div>

            {/* Топ-15 популярных маркировок за год — только для продажи */}
            {recordType==="sale" && <TopMarkersBlock records={records} workshop={workshop}
              wsStock={wsStock} stockCfg={safeStockCfg} onPick={setMarker} selected={marker}
              category={category}/>}

            <div style={{marginBottom:12}}>
              <label style={s.label}>Категория</label>
              <select value={category} onChange={e=>{setCategory(e.target.value);setMarker("");}} style={s.input}>
                {sortedCategories(safeMarkers)
                  .filter(c => recordType !== "refund" || c !== "Прочие услуги")
                  .map(c=><option key={c}>{c}</option>)}
              </select>
            </div>
            <div style={{marginBottom:12}}>
              <label style={s.label}>Маркировка</label>
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
                {(safeMarkers[category]||[]).map(m=>{
                  const isService = category === "Прочие услуги";
                  const wq = isService ? 0 : (wsStock[m]||0);
                  const cfg = safeStockCfg[m]||{};
                  const low = !isService && cfg.threshold>0 && wq<=cfg.threshold;
                  const empty = !isService && wq===0;
                  const showStockWarning = !isService;
                  return (
                    <button key={m} onClick={()=>setMarker(m)} style={{
                      fontSize:12,padding:"5px 10px",borderRadius:7,cursor:"pointer",
                      background:marker===m?C.accentDim:C.bgInput,
                      border:`1px solid ${marker===m?C.accent:(showStockWarning&&empty)?C.danger+"88":low?C.warn+"88":C.border}`,
                      color:marker===m?C.accent:(showStockWarning&&empty)?C.danger:low?C.warn:C.text,
                    }}>{m}{!isService&&wq>0&&<span style={{fontSize:10,opacity:.7,marginLeft:4}}>{wq}</span>}</button>
                  );
                })}
              </div>
              <input value={marker} onChange={e=>setMarker(e.target.value)} placeholder="Или введите свою маркировку" style={s.input}/>
            </div>
            {markerPhoto&&(
              <div style={{marginBottom:12}}>
                <label style={s.label}>Фото заготовки</label>
                <img src={markerPhoto} alt="" style={{maxWidth:110,maxHeight:110,borderRadius:8,border:`1px solid ${C.border}`,display:"block"}}/>
              </div>
            )}
            <div style={{marginBottom:12}}>
              <label style={s.label}>Фото для этой маркировки</label>
              <input type="file" accept="image/*" style={{...s.input,padding:"6px"}} onChange={async e=>{
                const f=e.target.files[0]; if(!f||!marker) return;
                const reader=new FileReader();
                reader.onload=async()=>{
                  const url=reader.result;
                  await photoSet(marker.trim(),url);
                  setPhotoCache(p=>({...p,[marker.trim()]:url})); setMarkerPhoto(url);
                  setSubmitMsg({ok:true,text:"Фото сохранено"}); setTimeout(()=>setSubmitMsg(null),2000);
                };
                reader.readAsDataURL(f);
              }}/>
            </div>
            {marker && category !== "Прочие услуги" && (
              <div style={{...s.card,padding:"8px 12px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:12,color:C.textSub}}>Остаток в {workshop}</span>
                <StockBadge qty={wsStock[marker.trim()]||0} threshold={(stockCfg[marker.trim()]||{}).threshold||0}/>
              </div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              <div>
                <label style={s.label}>Готовых {recordType==="sale"&&<span style={{color:C.textDim,fontSize:10}}>(годные ключи)</span>}</label>
                <StepperInput value={qty} onChange={setQty} style={{width:"100%"}} inputStyle={{width:"100%"}}/>
              </div>
              <div>
                <label style={s.label}>Брак {recordType==="sale"&&<span style={{color:C.textDim,fontSize:10}}>(испорченные)</span>}</label>
                <StepperInput value={defect} onChange={setDefect} style={{width:"100%"}} inputStyle={{width:"100%"}}/>
              </div>
            </div>
            {recordType==="sale"&&qty>0&&defect>0&&(
              <div style={{...s.card,padding:"8px 12px",marginBottom:10,background:C.warnDim,borderColor:C.warn+"44"}}>
                <div style={{fontSize:12,color:C.warn,lineHeight:1.5}}>
                  ⚠ Всего изготовлено: <b>{qty+defect} шт</b> ({qty} готовых + {defect} брак)<br/>
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
                    onChange={e=>setManualAmount(e.target.checked)} style={{width:"auto"}}/> вручную
                </label>
              </div>
              <NumInput value={amount} onChange={v=>{if(manualAmount||recordType==="refund"||!prices[marker])setAmount(v);}}
                style={{...s.input,opacity:(!manualAmount&&recordType!=="refund"&&!!prices[marker])?.6:1}}/>
              {recordType==="refund"
                ? <div style={{fontSize:11,color:C.refund,marginTop:3}}>Возврат: сумма вводится вручную</div>
                : prices[marker]&&!manualAmount && <div style={{fontSize:11,color:C.textDim,marginTop:3}}>Цена за ед.: {fmt(prices[marker])} р · авто</div>}
            </div>
            <div style={{marginBottom:16}}>
              <label style={s.label}>Комментарий</label>
              <textarea value={comment} onChange={e=>setComment(e.target.value)} rows={2} placeholder="Необязательно" style={{...s.input,resize:"vertical"}}/>
            </div>
            <button onClick={submitRecord}
              style={{...s.btn(recordType==="refund"?"refund":"accent"),width:"100%",padding:"11px 0",fontSize:15,fontWeight:700}}>
              {recordType==="refund" ? "Оформить возврат" : "Добавить запись"}
            </button>
            {submitMsg&&<div style={{textAlign:"center",marginTop:8,fontSize:13,color:submitMsg.ok?C.success:C.danger}}>{submitMsg.text}</div>}
            {records.filter(r=>r.workshop===workshop).length>0&&(
              <div style={{marginTop:20}}>
                <div style={{fontSize:12,color:C.textSub,marginBottom:8}}>Последние записи — нажмите для редактирования</div>
                {records.map((r,gi)=>r.workshop===workshop?{r,gi}:null).filter(Boolean).slice(-5).reverse().map(({r,gi})=>{
                  const isRefund = r.recordType==="refund";
                  return (
                    <div key={gi} style={{...s.card,cursor:"pointer",borderLeft:`3px solid ${isRefund?C.refund:C.accent+"88"}`}} onClick={()=>setEditRec({record:r,globalIdx:gi})}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span style={{color:isRefund?C.refund:C.success,fontWeight:700,fontSize:16}}>{isRefund?"↩":"↑"}</span>
                          <span style={{fontWeight:600}}>{r.marker}</span>
                          {isRefund&&<TypeBadge recordType="refund"/>}
                        </div>
                        <div style={{display:"flex",gap:8,alignItems:"center"}}>
                          <span style={{fontSize:12,color:isRefund?C.refund:C.textSub}}>{isRefund?"−":""}{r.qty} шт · {fmt(r.amount)} р</span>
                          <span style={{fontSize:11,color:C.accent}}>✎</span>
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
            <div style={{display:"flex",gap:6,marginBottom:10}}>
              {[["day","День"],["month","Месяц"],["year","Год"]].map(([id,label])=>(
                <button key={id} onClick={()=>setStatsPeriod(id)} style={{
                  flex:1,padding:"7px 0",fontSize:12,fontWeight:600,borderRadius:8,
                  border:`1px solid ${statsPeriod===id?C.accent:C.border}`,
                  background:statsPeriod===id?C.accentDim:C.bgInput,
                  color:statsPeriod===id?C.accent:C.textSub,cursor:"pointer"
                }}>{label}</button>
              ))}
            </div>
            <div style={{marginBottom:14}}>
              <input type="date" value={statsDate} onChange={e=>setStatsDate(e.target.value)}
                style={{
                  ...s.input,
                  cursor:"pointer",
                  colorScheme:"dark",
                  color: statsDate ? C.text : C.textDim,
                  fontWeight:500,
                }}/>
            </div>
            {renderStats()}
          </div>
        )}

        {/* ══ СКЛАД ══ */}
        {tab==="stock"&&(
          <div>
            <div style={{display:"flex",gap:6,marginBottom:14}}>
              {[["ws","Мастерская"],["main","Общий склад"],["move","Перемещение"]].map(([id,label])=>(
                <button key={id} onClick={()=>setStockTab(id)} style={{
                  flex:1,padding:"6px 4px",fontSize:12,fontWeight:600,borderRadius:8,
                  border:`1px solid ${stockTab===id?C.accent:C.border}`,
                  background:stockTab===id?C.accentDim:C.bgInput,
                  color:stockTab===id?C.accent:C.textSub,cursor:"pointer"
                }}>{label}</button>
              ))}
            </div>
            {stockTab==="ws"&&(
              <div>
                <div style={{fontSize:13,color:C.textSub,marginBottom:10}}>Остатки · <b style={{color:wsColor}}>{workshop}</b></div>
                <StockControls search={stockSearch} setSearch={setStockSearch} sort={stockSort} setSort={setStockSort} filter={stockFilter} setFilter={setStockFilter}/>
                {sortedCategories(safeMarkers).map(cat=>renderStockCategory(cat,wsStock,true))}
                <div style={{fontSize:11,color:C.textDim,marginTop:4}}>«Прочие услуги» в складе не отображаются</div>
              </div>
            )}
            {stockTab==="main"&&(
              <div>
                <div style={{fontSize:13,color:C.textSub,marginBottom:10}}>Общий склад</div>
                <StockControls search={stockSearch} setSearch={setStockSearch} sort={stockSort} setSort={setStockSort} filter={stockFilter} setFilter={setStockFilter}/>
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
                    const ns={...stockMain,[moveMarker]:(stockMain[moveMarker]||0)+moveQty};
                    setStockMain(ns); await sSet("stock:main",ns);
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
              </div>
            )}
          </div>
        )}

        {/* ══ ЦЕНЫ ══ */}
        {tab==="prices"&&(
          <div>
            <div style={{...s.card,marginBottom:16,borderColor:C.accent+"44"}}>
              <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:C.accent}}>+ Добавить маркировку</div>
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
              const filtered = ms.filter(m=>m.toLowerCase().includes(priceSearch.toLowerCase()));
              if(filtered.length===0) return null;
              const expanded = priceExpandedCats[cat]!==false;
              const withPrice = filtered.filter(m=>safePrices[m]).length;
              return (
                <div key={cat} style={{...s.card,padding:0,overflow:"hidden",marginBottom:8}}>
                  <div onClick={()=>setPriceExpandedCats(p=>({...p,[cat]:!expanded}))}
                    style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",
                      cursor:"pointer",background:expanded?C.bgCard:"#141826"}}>
                    <span style={{fontWeight:700,fontSize:13}}>{cat}</span>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <span style={{fontSize:12,color:C.textSub}}>{withPrice}/{filtered.length} с ценой</span>
                      <span style={{color:C.textDim,fontSize:12}}>{expanded?"▲":"▼"}</span>
                    </div>
                  </div>
                  {expanded&&(
                    <div style={{borderTop:`1px solid ${C.border}`}}>
                      {filtered.map(m=>(
                        <div key={m} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                          padding:"8px 14px",borderBottom:`1px solid ${C.border}22`,gap:8,flexWrap:"wrap"}}>
                          <span style={{fontSize:13,flex:1,minWidth:80}}>{m}</span>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <StepperInput
                              value={safePrices[m]||0}
                              onChange={async (val) => {
                                const np = {...safePrices};
                                if(val > 0) np[m] = val;
                                else delete np[m];
                                setPrices(np);
                                debouncedSave("prices", np);
                              }}
                              step={10}
                              />
                            <span style={{fontSize:12,color:C.textSub,whiteSpace:"nowrap"}}>р/шт</span>
                            <button onClick={()=>setRenameModal({cat, oldName:m})} title="Переименовать"
                              style={{...s.btn(),padding:"5px 8px",fontSize:11}}>✎</button>
                            <button onClick={()=>deleteMarker(cat,m)} title="Удалить"
                              style={{...s.btn("danger"),padding:"5px 8px",fontSize:11}}>✕</button>
                          </div>
                        </div>
                      ))}
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
