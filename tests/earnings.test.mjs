import test from 'node:test';
import assert from 'node:assert/strict';
import {calcEarnings,regularIncomeRate} from '../src/earnings.js';

const record=(date,extra={})=>({timestamp:Date.parse(date),marker:'BDN5VP',amount:1000,recordType:'sale',...extra});

test('rate changes precisely at November 2026 midnight in Moscow on every device',()=>{
  assert.equal(regularIncomeRate(Date.parse('2026-10-31T20:59:59.999Z')),0.4);
  assert.equal(regularIncomeRate(Date.parse('2026-10-31T21:00:00.000Z')),0.45);
  assert.equal(regularIncomeRate(Date.parse('2025-11-15T12:00:00+03:00')),0.4);
  assert.equal(regularIncomeRate(Date.parse('2027-01-01T12:00:00+03:00')),0.45);
});

test('a yearly report sums each record at its own historical rate',()=>{
  const october=record('2026-10-31T12:00:00+03:00');
  const november=record('2026-11-01T12:00:00+03:00');
  assert.equal(calcEarnings([october]).total,400);
  assert.equal(calcEarnings([november]).total,450);
  assert.deepEqual(calcEarnings([october,november]),{total:850,fromKeys:850,fromSharping:0});
});

test('sharpening stays at 100 percent and other services use the dated regular rate',()=>{
  for(const date of ['2026-10-31T12:00:00+03:00','2026-11-01T12:00:00+03:00']) {
    for(const marker of ['Заточка ножей','Заточка топоров','Заточка садового инструмента','Заточка топора']) {
      assert.deepEqual(calcEarnings([record(date,{marker})]),{total:1000,fromKeys:0,fromSharping:1000});
    }
  }
  assert.equal(calcEarnings([record('2026-11-01T12:00:00+03:00',{marker:'Исправление чужой работы',category:'Прочие услуги'})]).total,450);
});

test('refunds subtract their dated share and sharpening refunds subtract the full amount',()=>{
  const records=[
    record('2026-10-31T12:00:00+03:00',{recordType:'refund'}),
    record('2026-11-01T12:00:00+03:00',{recordType:'refund'}),
    record('2026-11-01T12:00:00+03:00',{recordType:'refund',marker:'Заточка ножей'}),
  ];
  assert.deepEqual(calcEarnings(records),{total:-1850,fromKeys:-850,fromSharping:-1000});
});

test('editing a historical record does not switch its rate or mutate stored records',()=>{
  const old=Object.freeze(record('2026-10-31T12:00:00+03:00',{updatedAt:Date.parse('2026-11-02T12:00:00+03:00')}));
  const records=Object.freeze([old]);
  const original=JSON.stringify(records);
  assert.equal(calcEarnings(records).total,400);
  assert.equal(JSON.stringify(records),original);
  for(const timestamp of [undefined,null,'invalid',NaN])assert.equal(regularIncomeRate(timestamp),0.4);
  assert.deepEqual(calcEarnings([]),{total:0,fromKeys:0,fromSharping:0});
});
