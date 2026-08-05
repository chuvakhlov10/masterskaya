import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const gatewaySource = await readFile(new URL('../src/storage-gateway.js', import.meta.url), 'utf8');
const ablySource = await readFile(new URL('../src/ably-session-auth.js', import.meta.url), 'utf8');
const storageSource = await readFile(new URL('../src/github-storage.js', import.meta.url), 'utf8');
const gateSource = await readFile(new URL('../src/DevicePairingGate.jsx', import.meta.url), 'utf8');

test('temporary renewal failure returns the still-valid session', () => {
  assert.match(gatewaySource, /isTransientGatewayError\(error\)[\s\S]*return existing/);
});

test('session renewal is single-flight', () => {
  assert.match(gatewaySource, /renewalInFlight/);
  assert.match(gatewaySource, /sharedRenew/);
});

test('rejected sessions dispatch the pairing event', () => {
  assert.match(gatewaySource, /STORAGE_SESSION_EVENT/);
  assert.match(gatewaySource, /invalidateStoredStorageSession/);
  assert.match(gateSource, /addEventListener\?\.\(STORAGE_SESSION_EVENT/);
});

test('automatic Ably authorization has only the shared-session path', () => {
  assert.match(ablySource, /ensureStorageSession/);
  assert.doesNotMatch(ablySource, /Fallback|Authorization/);
});

test('data storage has only the shared-session gateway path', () => {
  assert.doesNotMatch(storageSource, /SESSION_AUTH_ERRORS/);
  assert.match(storageSource, /storageGatewayRequest\(\{/);
  assert.doesNotMatch(storageSource, /Authorization|Bearer/);
});
