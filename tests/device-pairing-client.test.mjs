import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../src/device-pairing-client.js', import.meta.url);

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadModule() {
  return import(`${moduleUrl.href}?test=${Date.now()}-${Math.random()}`);
}

test('pairing code formatting is uppercase and grouped', async () => {
  const client = await loadModule();
  assert.equal(client.normalizePairingCode('abcd efgh-2345'), 'ABCD-EFGH-2345');
  assert.equal(client.normalizePairingCode('abc'), 'ABC');
});

test('new device redeems a one-time code without sending a GitHub PAT', async () => {
  const client = await loadModule();
  const storage = new MemoryStorage({ github_token_v1: 'stale-token' });
  const calls = [];
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    const body = JSON.parse(options.body);
    return jsonResponse({
      ok: true,
      sessionToken: 'header.payload.signature',
      expiresAt,
      clientId: body.clientId,
      device: { id: body.clientId, name: body.deviceName },
    });
  };

  const result = await client.redeemPairingCode({
    code: 'ABCD-EFGH-2345',
    deviceName: 'Второй телефон',
    storage,
    fetchImpl,
    endpoint: 'https://example.test/gateway',
  });

  assert.equal(result.device.name, 'Второй телефон');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['X-Masterskaya-GitHub-Token'], undefined);
  assert.equal(calls[0].headers['X-Masterskaya-Session'], undefined);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.action, 'pairing-redeem');
  assert.equal(body.code, 'ABCDEFGH2345');
  assert.equal(body.deviceName, 'Второй телефон');
  assert.match(body.clientId, /^web-/);
  assert.equal(storage.getItem('github_token_v1'), null);
  assert.equal(JSON.parse(storage.getItem('masterskaya_storage_session_v1')).token, 'header.payload.signature');
});

test('connected device creates a code using only its shared session', async () => {
  const client = await loadModule();
  const storage = new MemoryStorage({
    masterskaya_storage_session_v1: JSON.stringify({
      token: 'existing.session.token',
      expiresAt: Date.now() + 60_000,
      clientId: 'web-device-123456',
    }),
    masterskaya_device_name_v1: 'Ноутбук',
  });
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    return jsonResponse({ ok: true, code: 'ABCD-EFGH-2345', expiresAt: Date.now() + 600_000 });
  };

  const result = await client.createPairingCode({ storage, fetchImpl, endpoint: 'https://example.test/gateway' });
  assert.equal(result.code, 'ABCD-EFGH-2345');
  assert.equal(calls[0].headers['X-Masterskaya-Session'], 'existing.session.token');
  assert.equal(calls[0].headers['X-Masterskaya-GitHub-Token'], undefined);
  assert.deepEqual(JSON.parse(calls[0].body), { action: 'pairing-create', deviceName: 'Ноутбук' });
});

test('server pairing errors are preserved and translated for the UI', async () => {
  const client = await loadModule();
  const storage = new MemoryStorage();
  const fetchImpl = async () => jsonResponse({ ok: false, error: 'PAIRING_CODE_EXPIRED' }, 410);

  await assert.rejects(
    () => client.redeemPairingCode({
      code: 'ABCD-EFGH-2345',
      deviceName: 'Телефон',
      storage,
      fetchImpl,
      endpoint: 'https://example.test/gateway',
    }),
    error => error.code === 'PAIRING_CODE_EXPIRED',
  );
  assert.match(client.pairingErrorText({ code: 'PAIRING_CODE_EXPIRED' }), /истёк/i);
});
