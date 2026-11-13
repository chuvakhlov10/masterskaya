import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayments, paymentDraft, recordPayments, paymentLabel, paymentTotals, moneyCents, UNSPECIFIED_PAYMENT } from '../src/payments.js';
import { calcEarnings } from '../src/earnings.js';
import { compactRecordWrite, mergeRecordRefresh } from '../src/record-sync.js';
import { legacyRecordFingerprint, mergeRecords } from '../src/sync-core.js';

const sale = {id:'sale', timestamp:Date.parse('2026-11-12T10:00:00+03:00'), marker:'Proxy', amount:1000, revision:1};
const split = {...paymentDraft(), method:'split', cash:'300', card:'700'};

test('single methods use the current amount; empty selection is required only for new paid records', () => {
  for (const method of ['cash','card','qr']) {
    assert.deepEqual(buildPayments({method},1000).payments,[{method,amount:1000}]);
    assert.deepEqual(buildPayments({method},200).payments,[{method,amount:200}]);
  }
  assert.match(buildPayments(paymentDraft(),100).error,/Выберите/);
  assert.deepEqual(buildPayments(paymentDraft(),100,true),{payments:[]});
  assert.deepEqual(buildPayments(paymentDraft(),0),{payments:[]});
});

test('split payments balance exactly in kopecks and accept decimal commas', () => {
  assert.deepEqual(buildPayments(split,1000).payments,[{method:'cash',amount:300},{method:'card',amount:700}]);
  assert.deepEqual(buildPayments({...split,cash:'0,10',card:'0.20'},0.30).payments,
    [{method:'cash',amount:0.1},{method:'card',amount:0.2}]);
  assert.equal(moneyCents('12,34'),1234);
  assert.equal(moneyCents(99.99 * 3),29997);
  assert.equal(moneyCents(1.234),null);
  for(const value of ['-1','abc','1.234','Infinity','1e2',null,NaN]) assert.equal(moneyCents(value),null);
  for(const draft of [
    {...split,card:'699'}, {...split,card:'701'}, {...split,cash:'-1'},
    {...split,cash:'NaN'}, {...split,cash:'0',card:'1000'}, {...split,cash:'1.111'},
  ]) assert.ok(buildPayments(draft,1000).error);
});

test('legacy records remain unspecified without mutation; split editor restores all amounts', () => {
  const legacy = Object.freeze({...sale});
  const original = JSON.stringify(legacy);
  assert.equal(paymentLabel(legacy),UNSPECIFIED_PAYMENT);
  assert.equal(paymentDraft(legacy).method,'');
  assert.equal(JSON.stringify(legacy),original);
  const paid = {...sale,payments:buildPayments(split,1000).payments};
  assert.deepEqual(buildPayments(paymentDraft(paid),1000).payments,paid.payments);
  assert.match(paymentLabel(paid),/Наличные: 300 ₽ · Карта: 700 ₽/);
  assert.match(buildPayments(paymentDraft(paid),1100).error,/совпадать/);
});

test('totals include legacy sales, services and actual refund methods without changing earnings', () => {
  const records = [
    {...sale,payments:buildPayments(split,1000).payments},
    {...sale,id:'legacy',amount:200},
    {...sale,id:'service',marker:'Заточка ножей',amount:100,payments:[{method:'qr',amount:100}]},
    {...sale,id:'refund',amount:150,recordType:'refund',payments:[{method:'card',amount:100},{method:'qr',amount:50}]},
    {...sale,id:'old-refund',amount:20,recordType:'refund'},
    {...sale,id:'defect',amount:0,payments:[]},
  ];
  assert.deepEqual(paymentTotals(records),{cash:300,card:600,qr:50,unspecified:180});
  assert.equal(Object.values(paymentTotals(records)).reduce((s,v)=>s+v,0),1130);
  assert.deepEqual(calcEarnings(records),calcEarnings(records.map(({payments,...r})=>r)));
});

test('malformed payment breakdowns cannot silently allocate only part of a sale', () => {
  for(const payments of [[{method:'cash',amount:900}], [{method:'other',amount:1000}],
    [{method:'cash',amount:500},{method:'cash',amount:500}], [{method:'cash',amount:-1000}], [null]]) {
    const record = {...sale,payments};
    assert.deepEqual(recordPayments(record),[]);
    assert.deepEqual(paymentTotals([record]),{cash:0,card:0,qr:0,unspecified:1000});
  }
});

test('payment-only edits survive stale refresh, concurrent merge and legacy migration without duplicates', () => {
  const edited = {...sale,revision:2,payments:buildPayments(split,1000).payments};
  const queue = compactRecordWrite([sale],[edited]);
  const reloaded = JSON.parse(JSON.stringify(queue));
  assert.deepEqual(mergeRecordRefresh([sale],[],reloaded),[edited]);
  assert.deepEqual(mergeRecords([edited],[sale]),[edited]);
  const {id,revision,...legacy} = sale;
  const migrated = {...edited,legacyFingerprint:legacyRecordFingerprint(legacy)};
  assert.deepEqual(mergeRecords([legacy],[migrated]),[migrated]);
});

for (const workshop of ['SMART','Бегемот']) {
  test(`${workshop} CSV excludes payment columns and preserves stored payment data`, async () => {
    const fs=await import('node:fs'), vm=await import('node:vm');
    const app=fs.readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
    const start=app.indexOf('  function exportStatsCSV(){'), end=app.indexOf('  // ── Касса дня',start);
    const records=[
      {...sale,workshop,payments:buildPayments(split,1000).payments},
      {...sale,workshop,id:'legacy',amount:200},
      {...sale,workshop,id:'refund',amount:100,recordType:'refund',payments:[{method:'card',amount:100}]},
      {...sale,workshop:'other',id:'other'},
    ];
    const before=JSON.stringify(records);
    let downloaded;
    const context=vm.createContext({records,workshop,Blob,
      signOf:r=>r.recordType==='refund'?-1:1,
      URL:{createObjectURL:blob=>{downloaded=blob;return 'blob:test';},revokeObjectURL:()=>{}},
      document:{createElement:()=>({click:()=>{}})},alert:message=>assert.fail(message),
    });
    vm.runInContext(app.slice(start,end)+'\nexportStatsCSV();',context);
    const csv=await downloaded.text(), rows=csv.trim().split('\n').map(row=>row.split(';'));
    assert.ok(rows.every(row=>row.length===10));
    assert.equal(rows.find(row=>row[3]==='Возврат')[8],'100');
    assert.deepEqual(rows.at(-1).slice(8),['1100','3 записей']);
    assert.doesNotMatch(csv,/Способ оплаты|Наличные|QR-код|Карта/);
    assert.equal(JSON.stringify(records),before);
  });
}
