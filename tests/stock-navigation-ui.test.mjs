import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('workshop switch changes directly to the other workshop', () => {
  assert.match(appSource, /function handleSwitchWorkshop\(\)[\s\S]*nextWorkshop = workshop === "SMART" \? "Бегемот" : "SMART";[\s\S]*selectWorkshop\(nextWorkshop\);/);
  assert.match(appSource, /onClick=\{handleSwitchWorkshop\}/);
  assert.doesNotMatch(appSource, /onClick=\{handleLogout\}/);
});

test('stock exposes both workshops before common stock and movement', () => {
  assert.match(appSource, /\.\.\.WORKSHOPS\.map\(ws=>\[`ws:\$\{ws\}`,ws\]\),\["main","Общий склад"\],\["move","Перемещение"\]/);
  assert.match(appSource, /renderStockCategory\(cat,ensureObj\(safeStockWS\[ws\]\),`ws:\$\{ws\}`\)/);
  assert.match(appSource, /renderStockCategory\(cat,stockMain,"main"\)/);
});

test('stock editing uses the location of the visible stock tab', () => {
  assert.match(appSource, /function renderStockCategory\(cat, stockObj, location\)/);
  assert.match(appSource, /appendStockOp\("delta", \{\s*location,\s*marker: m,/);
});

test('movement quantities remain visible for markers in every category', () => {
  assert.match(appSource, /setCollapsed\(p=>\(\{\.\.\.p,\[cat\]:p\[cat\]===false\}\)\)/);
  assert.match(appSource, /flexShrink:0,whiteSpace:"nowrap"/);
  assert.match(appSource, /extraLabel=\{m=>`общий: \$\{safeStockMain\[m\]\|\|0\}`\}/);
  assert.match(appSource, /extraLabel=\{m=>`общий: \$\{safeStockMain\[m\]\|\|0\} · \$\{moveTo\}: \$\{ensureObj\(safeStockWS\[moveTo\]\)\[m\]\|\|0\}`\}/);
});
