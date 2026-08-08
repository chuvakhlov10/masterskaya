import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const gateSource = await readFile(new URL('../src/DevicePairingGate.jsx', import.meta.url), 'utf8');
const healthSource = await readFile(new URL('../src/SystemHealthControl.jsx', import.meta.url), 'utf8');
const statusSource = await readFile(new URL('../src/status-core.js', import.meta.url), 'utf8');

test('main application is wrapped by the device pairing gate', () => {
  assert.match(mainSource, /import DevicePairingGate from ['"]\.\/DevicePairingGate\.jsx['"]/);
  assert.match(mainSource, /<DevicePairingGate>[\s\S]*<App \/>[\s\S]*<\/DevicePairingGate>/);
});

test('new-device screen uses pairing and offline recovery codes', () => {
  assert.match(gateSource, /Подключить устройство/);
  assert.match(gateSource, /Одноразовый код/);
  assert.match(gateSource, /redeemPairingCode/);
  assert.match(gateSource, /redeemRecoveryCode/);
  assert.match(gateSource, /Я сохранил код/);
  assert.doesNotMatch(gateSource, /Authorization|Bearer/);
});

test('connected-device manager can create and revoke device access', () => {
  assert.match(gateSource, /createPairingCode/);
  assert.match(gateSource, /revokeDevice/);
  assert.match(gateSource, /Подключить новое устройство/);
  assert.match(gateSource, /Отключить/);
  assert.match(gateSource, /reportDeviceDiagnostics/);
  assert.match(gateSource, /безопасный карантин/);
});

test('expired or revoked sessions return the device to pairing', () => {
  assert.match(gateSource, /STORAGE_SESSION_EVENT/);
  assert.match(gateSource, /DEVICE_REVOKED/);
  assert.match(gateSource, /SESSION_EXPIRED/);
  assert.match(gateSource, /setSessionEpoch/);
});

test('connected application exposes safe server health and diagnostics', () => {
  assert.match(mainSource, /import SystemHealthControl from ['"]\.\/SystemHealthControl\.jsx['"]/);
  assert.match(mainSource, /<SystemHealthControl \/>/);
  assert.match(healthSource, /checkServerHealth/);
  assert.match(healthSource, /collectClientDiagnostics/);
  assert.match(healthSource, /Скопировать диагностику/);
  assert.match(healthSource, /Операции данных/);
  assert.match(healthSource, /Складские операции/);
  assert.match(healthSource, /Безопасный карантин/);
});

test('stock navigation release is version 1.5.4', () => {
  assert.match(statusSource, /APP_VERSION = "1\.5\.4"/);
});
