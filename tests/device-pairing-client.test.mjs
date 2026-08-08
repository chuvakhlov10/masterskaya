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
  assert.equal(client.normalizeRecoveryCode('aaaa bbbb cccc dddd eeee ffff'), 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF');
});

test('new device redeems a one-time pairing code', async () => {
  const client = await loadModule();
  const storage = new MemoryStorage();
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
  assert.equal(calls[0].headers['X-Masterskaya-Session'], undefined);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.action, 'pairing-redeem');
  assert.equal(body.code, 'ABCDEFGH2345');
  assert.equal(body.deviceName, 'Второй телефон');
  assert.match(body.clientId, /^web-/);
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
  assert.deepEqual(JSON.parse(calls[0].body), { action: 'pairing-create', deviceName: 'Ноутбук' });
});

test('connected device reports only bounded queue counts for remote diagnostics', async () => {
  const client = await loadModule();
  const storage = new MemoryStorage({
    masterskaya_storage_session_v1: JSON.stringify({
      token: 'existing.session.token',
      expiresAt: Date.now() + 60_000,
      clientId: 'web-device-123456',
    }),
    masterskaya_device_name_v1: 'Телефон',
  });
  let sentBody = null;
  const device = await client.reportDeviceDiagnostics({
    appVersion: '1.5.2',
    queues: {
      dataOperations: 1,
      stockOperations: 2,
      quarantinedStockOperations: 1308,
      totalOperations: 999,
    },
  }, {
    storage,
    endpoint: 'https://example.test/gateway',
    fetchImpl: async (_url, options) => {
      sentBody = JSON.parse(options.body);
      return jsonResponse({ ok: true, device: { id: 'web-device-123456', diagnostics: sentBody.diagnostics } });
    },
  });

  assert.equal(sentBody.action, 'device-diagnostics');
  assert.equal(sentBody.deviceName, 'Телефон');
  assert.deepEqual(sentBody.diagnostics, {
    appVersion: '1.5.2',
    queues: {
      dataOperations: 1,
      stockOperations: 2,
      quarantinedStockOperations: 1308,
      totalOperations: 3,
    },
  });
  assert.equal(device.diagnostics.queues.quarantinedStockOperations, 1308);
});

test('recovery keeps the new session in memory until the owner confirms the replacement code', async () => {
  const client = await loadModule();
  assert.equal(client.RECOVERY_REQUEST_TIMEOUT_MS, 75_000);
  const storage = new MemoryStorage();
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const result = await client.redeemRecoveryCode({
    code: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
    deviceName: 'Новый ноутбук',
    storage,
    endpoint: 'https://example.test/gateway',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.action, 'recovery-redeem');
      return jsonResponse({
        ok: true,
        sessionToken: 'recovered.session.signature',
        expiresAt,
        clientId: body.clientId,
        device: { id: body.clientId, name: body.deviceName },
        replacementRecoveryCode: '2222-3333-4444-5555-6666-7777',
      });
    },
  });

  assert.equal(storage.getItem('masterskaya_storage_session_v1'), null);
  assert.equal(result.replacementRecoveryCode, '2222-3333-4444-5555-6666-7777');
  client.acceptDeviceSession(result.pendingSession, storage);
  assert.equal(JSON.parse(storage.getItem('masterskaya_storage_session_v1')).token, 'recovered.session.signature');
  assert.equal([...storage.values.values()].some(value => String(value).includes('2222-3333')), false);
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
