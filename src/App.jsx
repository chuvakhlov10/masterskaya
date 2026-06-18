import { useState, useEffect, useCallback, Component } from "react";
import { dbGet, dbSet, dbDumpAll } from "./supabase.js";

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
// - sale: qty + defect (все изготовленные — годные + брак)
// - sale с qty=0 и defect>0: defect (только брак)
// - sale с qty=0 и defect=0: 0 (пустая запись)
function stockDelta(r){
  if(r.recordType === "refund") return 0;
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
          <div><label style={s.label}>Готовых <span style={{color:C.textDim,fontSize:10}}>(годные)</span></label><NumInput value={qty} onChange={setQty} min="0" style={s.input}/></div>
          <div><label style={s.label}>Брак <span style={{color:C.textDim,fontSize:10}}>(испорченные)</span></label><NumInput value={defect} onChange={setDefect} min="0" style={s.input}/></div>
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

  // ── диагностика записи в Supabase ──
  const [diagResult, setDiagResult] = useState(null);
  const [diagRunning, setDiagRunning] = useState(false);
  async function runDiagnostic(){
    setDiagRunning(true);
    setDiagResult(null);
    console.log("═══ НАЧАЛО ДИАГНОСТИКИ SUPABASE ═══");
    // 1. Тест записи
    const testKey = "__diagnostic_test__";
    const testVal = { ts: Date.now(), hello: "world" };
    console.log("[DIAG] Тест 1: запись тестового ключа...");
    const writeResult = await dbSet(testKey, testVal);
    console.log("[DIAG] Результат записи:", writeResult);
    // 2. Тест чтения
    console.log("[DIAG] Тест 2: чтение тестового ключа...");
    const readVal = await dbGet(testKey);
    console.log("[DIAG] Прочитано:", readVal);
    const readOk = readVal && readVal.ts === testVal.ts;
    // 3. Удалить тестовый ключ
    console.log("[DIAG] Тест 3: удалить тестовый ключ...");
    try {
      const { supabase } = await import("./supabase.js");
      await supabase.from("kv_store").delete().eq("key", testKey);
      console.log("[DIAG] Удаление OK");
    } catch(e) {
      console.warn("[DIAG] Не удалось удалить:", e);
    }
    // 4. Дамп всех ключей
    console.log("[DIAG] Тест 4: дамп всех ключей...");
    const allKeys = await dbDumpAll();
    console.log("[DIAG] Всего ключей в БД:", allKeys?.length || 0);
    // Итог
    const result = {
      writeOk: writeResult?.ok || false,
      readOk: readOk,
      totalKeys: allKeys?.length || 0,
      keys: allKeys?.map(r => r.key) || [],
      writeError: writeResult?.error ? JSON.stringify(writeResult.error) : null,
    };
    console.log("═══ ИТОГ ДИАГНОСТИКИ ═══", result);
    setDiagResult(result);
    setDiagRunning(false);
  }

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
    sGet(`photo:${marker}`).then(v=>{ setPhotoCache(p=>({...p,[marker]:v})); setMarkerPhoto(v); });
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

  function renderStockCategory(cat, stockObj, isWS){
    const ms = markers[cat]||[];
    const search = stockSearch.toLowerCase();
    const filtered = search ? ms.filter(m=>m.toLowerCase().includes(search)) : ms;
    if(filtered.length===0) return null;
    const total = filtered.reduce((s,m)=>s+(stockObj[m]||0),0);
    const hasLow = filtered.some(m=>{ const q=stockObj[m]||0,t=(stockCfg[m]||{}).threshold||0; return t>0&&q<=t; });
    const expanded = expandedCats[cat]!==false;
    return (
      <div key={cat} style={{...s.card,padding:0,overflow:"hidden",marginBottom:8}}>
        <div onClick={()=>setExpandedCats(p=>({...p,[cat]:!expanded}))}
          style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",cursor:"pointer",background:expanded?C.bgCard:"#141826"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontWeight:700,fontSize:13}}>{cat}</span>
            {hasLow&&<span style={{...s.tag(C.warn),fontSize:10,padding:"1px 6px"}}>⚠ мало</span>}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:12,color:C.textSub}}>итого: <b style={{color:C.text}}>{total}</b> шт</span>
            <span style={{color:C.textDim,fontSize:12}}>{expanded?"▲":"▼"}</span>
          </div>
        </div>
        {expanded&&(
          <div style={{borderTop:`1px solid ${C.border}`}}>
            <div style={{display:"grid",gridTemplateColumns:`1fr 80px${isWS?" 70px":""}`,gap:6,
              padding:"6px 14px",fontSize:11,color:C.textDim,borderBottom:`1px solid ${C.border}`,background:"#13161f"}}>
              <span>Маркировка</span><span style={{textAlign:"center"}}>Кол-во</span>
              {isWS&&<span style={{textAlign:"center"}}>Порог</span>}
            </div>
            {filtered.map(m=>{
              const q=stockObj[m]||0,cfg=stockCfg[m]||{};
              return (
                <div key={m} style={{display:"grid",gridTemplateColumns:`1fr 80px${isWS?" 70px":""}`,gap:6,
                  padding:"7px 14px",borderBottom:`1px solid ${C.border}22`,alignItems:"center",
                  background:q===0?"#16111a":q>0&&cfg.threshold>0&&q<=cfg.threshold?"#1f1a0e":"transparent"}}>
                  <span style={{fontSize:13,color:q===0?C.textDim:C.text}}>{m}</span>
                  <NumInput value={q} onChange={async nq=>{
                    const ns={...stockObj,[m]:nq};
                    if(isWS){setStockWS(p=>({...p,[workshop]:ns}));await sSet(`stock:ws:${workshop}`,ns);}
                    else{setStockMain(ns);await sSet("stock:main",ns);}
                  }} style={{...s.input,width:"100%",textAlign:"center",padding:"5px 6px",fontSize:13,
                    color:q===0?C.danger:cfg.threshold>0&&q<=cfg.threshold?C.warn:C.success}}/>
                  {isWS&&<NumInput value={cfg.threshold||0} placeholder="—" onChange={async nv=>{
                    const nc={...stockCfg,[m]:{...(stockCfg[m]||{}),threshold:nv}};
                    setStockCfg(nc);await sSet("stock:cfg",nc);
                  }} style={{...s.input,width:"100%",textAlign:"center",padding:"5px 6px",fontSize:12}}/>}
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
      data.forEach(r=>{ const mk=monthOf(r.timestamp); if(!byMonth[mk]) byMonth[mk]={qty:0,amount:0,defect:0,days:new Set()}; const s=signOf(r); byMonth[mk].qty+=r.qty*s; byMonth[mk].amount+=r.amount*s; byMonth[mk].defect+=r.defect; byMonth[mk].days.add(dateOf(r.timestamp)); });
      return (
        <div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            <StatCard label="Всего ключей" value={fmt(totalQty)}/>
            <StatCard label="Общая сумма" value={fmt(totalAmt)+" р"}/>
            <StatCard label="Брак" value={fmt(totalDef)} color={totalDef>0?C.warn:undefined}/>
            <StatCard label="% брака" value={totalQty>0?(totalDef/Math.abs(totalQty)*100).toFixed(1)+"%":"0%"} color={totalDef>0?C.warn:undefined}/>
            {workshop==="SMART"&&<StatCard label="Доход 40%" value={fmt(totalAmt*INCOME_PCT)+" р"} color={C.success}/>}
          </div>
          <div style={{fontSize:13,fontWeight:700,color:C.textSub,marginBottom:8}}>ПО МЕСЯЦАМ</div>
          {Object.entries(byMonth).sort((a,b)=>a[0].localeCompare(b[0])).map(([mk,d])=>{
            const mn = parseInt(mk.split("-")[1],10)-1;
            return (
              <div key={mk} style={s.card}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontWeight:700}}>{MONTH_NAMES[mn]}</span>
                  <span style={{color:d.amount>=0?C.accent:C.refund,fontWeight:700}}>{fmt(d.amount)} р</span>
                </div>
                <div style={{display:"flex",gap:16,marginTop:4,fontSize:12,color:C.textSub,flexWrap:"wrap"}}>
                  <span>{fmt(d.qty)} шт</span>
                  {d.defect>0&&<span style={{color:C.warn}}>брак {d.defect}</span>}
                  <span>{d.days.size} раб. дн.</span>
                  <span>{fmt(d.amount/d.days.size)} р/день</span>
                  {workshop==="SMART"&&<span style={{color:C.success}}>доход {fmt(d.amount*INCOME_PCT)} р</span>}
                </div>
              </div>
            );
          })}
          <div style={{fontSize:13,fontWeight:700,color:C.textSub,marginBottom:8,marginTop:16}}>ПО КАТЕГОРИЯМ</div>
          <StatsBreakdown data={data} totalAmt={totalAmt} totalQty={totalQty}/>
        </div>
      );
    }
  }

  // ── экраны ──
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
      <div style={{maxWidth:600,margin:"0 auto",padding:"12px 12px 40px"}}>
        {/* ── ДИАГНОСТИЧЕСКАЯ ПАНЕЛЬ (временно) ── */}
        <div style={{...s.card,borderColor:C.warn+"66",background:C.warnDim,marginBottom:14}}>
          <div style={{fontSize:12,fontWeight:700,color:C.warn,marginBottom:8}}>🔧 ДИАГНОСТИКА SUPABASE</div>
          <button onClick={runDiagnostic} disabled={diagRunning}
            style={{...s.btn("warn"),padding:"6px 12px",fontSize:12,opacity:diagRunning?.6:1}}>
            {diagRunning ? "Выполняется..." : "Запустить диагностику"}
          </button>
          {diagResult && (
            <div style={{marginTop:10,fontSize:12,lineHeight:1.6}}>
              <div style={{color:diagResult.writeOk?C.success:C.danger}}>
                Запись: {diagResult.writeOk ? "✓ работает" : "✗ не работает"}
              </div>
              <div style={{color:diagResult.readOk?C.success:C.danger}}>
                Чтение: {diagResult.readOk ? "✓ работает" : "✗ не работает"}
              </div>
              <div style={{color:C.text}}>
                Всего ключей в БД: {diagResult.totalKeys}
              </div>
              {diagResult.keys.length > 0 && (
                <div style={{color:C.textSub,marginTop:4,fontSize:11}}>
                  Ключи: {diagResult.keys.join(", ")}
                </div>
              )}
              {diagResult.writeError && (
                <div style={{color:C.danger,marginTop:6,fontSize:11,wordBreak:"break-all"}}>
                  Ошибка: {diagResult.writeError}
                </div>
              )}
              <div style={{color:C.textDim,marginTop:6,fontSize:11}}>
                Подробности — в консоли (F12 → Console)
              </div>
            </div>
          )}
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{...s.tag(wsColor),fontSize:13,fontWeight:700}}>{workshop}</span>
            <span style={{fontSize:12,color:C.textDim}}>{todayStr()}</span>
          </div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={()=>setPwdModalOpen(true)} style={{...s.btn(),padding:"5px 10px",fontSize:12}}>🔑 Пароль</button>
            <button onClick={handleLogout} style={{...s.btn(),padding:"5px 10px",fontSize:12}}>Выйти</button>
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
                  <button key={id} type="button" onClick={()=>setRecordType(id)} style={{
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

            <div style={{marginBottom:12}}>
              <label style={s.label}>Категория</label>
              <select value={category} onChange={e=>{setCategory(e.target.value);setMarker("");}} style={s.input}>
                {sortedCategories(safeMarkers).map(c=><option key={c}>{c}</option>)}
              </select>
            </div>
            <div style={{marginBottom:12}}>
              <label style={s.label}>Маркировка</label>
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
                {(safeMarkers[category]||[]).map(m=>{
                  const wq = wsStock[m]||0;
                  const cfg = safeStockCfg[m]||{};
                  const low = cfg.threshold>0 && wq<=cfg.threshold;
                  const empty = wq===0;
                  return (
                    <button key={m} onClick={()=>setMarker(m)} style={{
                      fontSize:12,padding:"5px 10px",borderRadius:7,cursor:"pointer",
                      background:marker===m?C.accentDim:C.bgInput,
                      border:`1px solid ${marker===m?C.accent:empty?C.danger+"88":low?C.warn+"88":C.border}`,
                      color:marker===m?C.accent:empty?C.danger:low?C.warn:C.text,
                    }}>{m}{wq>0&&<span style={{fontSize:10,opacity:.7,marginLeft:4}}>{wq}</span>}</button>
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
                  await sSet(`photo:${marker.trim()}`,url);
                  setPhotoCache(p=>({...p,[marker.trim()]:url})); setMarkerPhoto(url);
                  setSubmitMsg({ok:true,text:"Фото сохранено"}); setTimeout(()=>setSubmitMsg(null),2000);
                };
                reader.readAsDataURL(f);
              }}/>
            </div>
            {marker&&(
              <div style={{...s.card,padding:"8px 12px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:12,color:C.textSub}}>Остаток в {workshop}</span>
                <StockBadge qty={wsStock[marker.trim()]||0} threshold={(stockCfg[marker.trim()]||{}).threshold||0}/>
              </div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              <div>
                <label style={s.label}>Готовых {recordType==="sale"&&<span style={{color:C.textDim,fontSize:10}}>(годные ключи)</span>}</label>
                <NumInput value={qty} onChange={setQty} min="0" style={s.input}/>
              </div>
              <div>
                <label style={s.label}>Брак {recordType==="sale"&&<span style={{color:C.textDim,fontSize:10}}>(испорченные)</span>}</label>
                <NumInput value={defect} onChange={setDefect} min="0" style={s.input}/>
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
            <div style={{marginBottom:14,position:"relative"}}>
              <label style={{...s.input,position:"relative",display:"flex",alignItems:"center",cursor:"pointer",paddingRight:40}}>
                <input type="date" value={statsDate} onChange={e=>setStatsDate(e.target.value)}
                  style={{
                    position:"absolute",inset:0,opacity:0,cursor:"pointer",
                    width:"100%",height:"100%",border:"none",background:"transparent"
                  }}/>
                <span style={{color:statsDate?C.text:C.textDim}}>
                  {statsDate ? new Date(statsDate+"T00:00:00").toLocaleDateString("ru-RU",{day:"numeric",month:"long",year:"numeric"}) : "Выберите дату"}
                </span>
                <span style={{position:"absolute",right:12,color:C.textSub,fontSize:16,pointerEvents:"none"}}>📅</span>
              </label>
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
                <input value={stockSearch} onChange={e=>setStockSearch(e.target.value)} placeholder="Поиск по маркировке..." style={{...s.input,marginBottom:12}}/>
                {sortedCategories(safeMarkers).map(cat=>renderStockCategory(cat,wsStock,true))}
                <div style={{fontSize:11,color:C.textDim,marginTop:4}}>«Порог» — при каком остатке показывать ⚠</div>
              </div>
            )}
            {stockTab==="main"&&(
              <div>
                <div style={{fontSize:13,color:C.textSub,marginBottom:10}}>Общий склад</div>
                <input value={stockSearch} onChange={e=>setStockSearch(e.target.value)} placeholder="Поиск..." style={{...s.input,marginBottom:12}}/>
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
                  <NumInput value={moveQty} onChange={setMoveQty} min="1" style={{...s.input,marginBottom:10}}/>
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
                  <NumInput value={moveQty} onChange={setMoveQty} min="1" style={{...s.input,marginBottom:10}}/>
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
                          padding:"8px 14px",borderBottom:`1px solid ${C.border}22`}}>
                          <span style={{fontSize:13,flex:1}}>{m}</span>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <input type="number" min="0" step="1" value={safePrices[m]||""} placeholder="—"
                              onChange={async e=>{const val=+e.target.value,np={...safePrices};if(val>0)np[m]=val;else delete np[m];setPrices(np);await sSet("prices",np);}}
                              style={{...s.input,width:80,textAlign:"center",padding:"5px 8px",fontSize:13}}/>
                            <span style={{fontSize:12,color:C.textSub,whiteSpace:"nowrap"}}>р/шт</span>
                            <button onClick={()=>deleteMarker(cat,m)} style={{...s.btn("danger"),padding:"5px 8px",fontSize:11}}>✕</button>
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
