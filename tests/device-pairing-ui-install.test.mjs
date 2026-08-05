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

test('new-device screen uses one-time pairing and does not request a GitHub token', () => {
  assert.match(gateSource, /Подключить устройство/);
  assert.match(gateSource, /Одноразовый код/);
  assert.match(gateSource, /redeemPairingCode/);
  assert.doesNotMatch(gateSource, /Personal Access Token|ghp_/);
});

test('connected-device manager can create and revoke device access', () => {
  assert.match(gateSource, /createPairingCode/);
  assert.match(gateSource, /revokeDevice/);
  assert.match(gateSource, /Подключить новое устройство/);
  assert.match(gateSource, /Отключить/);
});

test('connected application exposes safe server health checks', () => {
  assert.match(mainSource, /import SystemHealthControl from ['"]\.\/SystemHealthControl\.jsx['"]/);
  assert.match(mainSource, /<SystemHealthControl \/>/);
  assert.match(healthSource, /checkServerHealth/);
  assert.match(healthSource, /Хранилище/);
  assert.match(healthSource, /Live-синхронизация/);
});

test('server health release is version 1.3.1', () => {
  assert.match(statusSource, /APP_VERSION = "1\.3\.1"/);
});
