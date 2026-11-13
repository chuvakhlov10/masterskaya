import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';

const app=fs.readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
const section=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
const source=[
  section('function fmt(', 'function todayStr('),
  section('function sortedCategories(', 'function sortedCategoryEntries('),
  section('function NumInput(', '// ── Офлайн-кеш'),
  section('const C = {', 'function Tabs('),
  section('function EditModal(', '// ── Сводная карточка'),
  'exports.EditModal=EditModal;',
].join('\n');
const sale={workshop:'SMART',category:'Test',marker:'Test',qty:1,defect:0,amount:1000,
  payments:[{method:'cash',amount:300},{method:'card',amount:700}]};
function editTree(record,onSave) {
  const components={};
  let hook=0;
  vm.runInNewContext(transformSync(source,{loader:'jsx'}).code,{
    React,useState:initial=>{
      const index=hook++;
      // Change the amount to a value that no longer balances old payment parts.
      return [index===4 ? 1250 : typeof initial==='function'?initial():initial,()=>{}];
    },useEffect:React.useEffect,useRef:React.useRef,exports:components,
  });
  return components.EditModal({record,markers:{Test:['Test']},onClose(){},onSave,onDelete(){}});
}
function findButton(node,label) {
  if (!React.isValidElement(node)) return;
  if(node.type==='button' && node.props.children===label) return node;
  for(const child of React.Children.toArray(node.props.children)) {
    const found=findButton(child,label);
    if(found) return found;
  }
}
for(const workshop of ['SMART','Бегемот']) {
  for(const recordType of ['sale','refund']) {
    test(`${workshop} ${recordType} edits save changed amounts without payment selection and retain legacy data`,()=>{
      for(const legacy of [true,false]) {
        const record={...sale,workshop,recordType};
        if(!legacy) delete record.payments;
        const before=JSON.stringify(record);
        let saved;
        const tree=editTree(record,value=>{saved=value;});
        const html=renderToStaticMarkup(tree);
        assert.doesNotMatch(html,/Способ оплаты|Способ возврата денег|Смешанная|Наличные|QR-код/);
        findButton(tree,'Сохранить').props.onClick();
        assert.equal(saved.amount,1250);
        assert.equal(saved.recordType,recordType);
        assert.equal(saved.payments,record.payments);
        assert.equal(JSON.stringify(record),before);
      }
    });
    test(`${workshop} ${recordType} can be created without payment data`,async()=>{
      let saved;
      const context=vm.createContext({workshop,recordType,marker:'Test',category:'Test',qty:1,defect:0,amount:1000,comment:'',
        recordsRef:{current:[]},makeRecordMutationId:id=>'mutation-'+id,
        saveRecordAndStock:(records)=>{saved=records[0];return {ok:true,savePromise:Promise.resolve({ok:true})};},
        scheduleStockSync(){},checkCommittedRecordMutation(){},recordStorageFailure:error=>assert.fail(error),
        setSubmitMsg:message=>{assert.equal(message.ok,true);},
        setMarker(){},setQty(){},setDefect(){},setAmount(){},setManualAmount(){},setComment(){},setRecordType(){},setTimeout(){},
      });
      vm.runInContext(section('  async function submitRecord(){','  // ── сохранение редактируемой записи')+'\nglobalThis.submit=submitRecord;',context);
      await context.submit();
      assert.equal(saved.workshop,workshop);
      assert.equal(saved.recordType,recordType);
      assert.equal(saved.amount,1000);
      assert.equal(Object.hasOwn(saved,'payments'),false);
    });
  }
}
test('entry, history and statistics no longer contain payment presentation or validation',()=>{
  assert.doesNotMatch(app,/PaymentFields|PaymentSummary|PaymentDetails|paymentLabel|paymentTotals|buildPayments|paymentDraft|usesPaymentMethods/);
});
