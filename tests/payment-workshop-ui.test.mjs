import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import * as payments from '../src/payments.js';

// Exercise the real JSX components without starting Ably or a production gateway.
const app=fs.readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
const section=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
const source=[
  section('function fmt(', 'function todayStr('),
  section('function sortedCategories(', 'function sortedCategoryEntries('),
  section('function NumInput(', '// ── Офлайн-кеш'),
  section('const C = {', 'function Tabs('),
  section('function PaymentFields(', '// ── Сводная карточка'),
  'Object.assign(exports,{PaymentFields,PaymentSummary,PaymentDetails,EditModal});',
].join('\n');
const components={};
vm.runInNewContext(transformSync(source,{loader:'jsx'}).code,{
  React,useState:React.useState,useEffect:React.useEffect,useRef:React.useRef,
  ...payments,exports:components,
});
const render=(name,props)=>renderToStaticMarkup(React.createElement(components[name],props));
const sale={workshop:'SMART',category:'Test',marker:'Test',qty:1,defect:0,amount:1000,
  payments:[{method:'cash',amount:300},{method:'card',amount:700}]};

test('SMART shows payment selector, split inputs, summary and record details',()=>{
  const fields=render('PaymentFields',{workshop:'SMART',amount:1000,value:payments.paymentDraft(sale),onChange:()=>{}});
  assert.match(fields,/Наличные/);
  assert.match(fields,/Карта/);
  assert.match(fields,/QR-код/);
  assert.match(fields,/Смешанная/);
  assert.match(fields,/value="300"/);
  assert.match(fields,/value="700"/);
  assert.match(render('PaymentSummary',{workshop:'SMART',records:[sale]}),/По способам оплаты/);
  assert.match(render('PaymentDetails',{record:sale}),/Карта: 700/);
});

test('Begemot has no payment fields, zero-amount prompt, summary or history label',()=>{
  for(const amount of [0,1000]) {
    assert.equal(render('PaymentFields',{workshop:'Бегемот',amount,value:payments.paymentDraft(sale),onChange:()=>{}}),'');
  }
  assert.equal(render('PaymentSummary',{workshop:'Бегемот',records:[sale]}),'');
  for(const record of [{...sale,workshop:'Бегемот'},{workshop:'Бегемот',amount:200}]) {
    assert.equal(render('PaymentDetails',{record}),'');
  }
});

test('editing Begemot sale or refund hides payment controls even when old payment fields are present',()=>{
  for(const recordType of ['sale','refund']) {
    const props={record:{...sale,workshop:'Бегемот',recordType},markers:{Test:['Test']},onClose:()=>{},onSave:()=>{},onDelete:()=>{}};
    const html=render('EditModal',props);
    assert.match(html,/Сохранить/);
    assert.doesNotMatch(html,/Способ оплаты|Способ возврата денег|Смешанная|Наличные|QR-код/);
    assert.match(render('EditModal',{...props,record:{...props.record,workshop:'SMART'}}),/Смешанная/);
  }
});
