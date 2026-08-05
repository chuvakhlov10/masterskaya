import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor(initial = {}) { this.map = new Map(Object.entries(initial)); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('rejected existing session is not recovered through a stored PAT', async () => {
  const storage = new MemoryStorage({
    github_token_v1: 'legacy-token-must-not-be-used',
    masterskaya_storage_session_v1: JSON.stringify({
      token: 'header.payload.signature',
      expiresAt: Date.now() + 10 * 24 * 60 * 60 * 1000,
      clientId: 'web-device-12345678',
    }),
  });
  globalThis.localStorage = storage;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(options.headers['X-Masterskaya-Session'], 'header.payload.signature');
    assert.equal(options.headers['X-Masterskaya-GitHub-Token'], undefined);
    return jsonResponse({ ok: false, error: 'SESSION_INVALID' }, 401);
  };

  const url = new URL('../src/github-storage.js', import.meta.url);
  url.searchParams.set('resilience', `${Date.now()}-${Math.random()}`);
  const module = await import(url.href);

  await assert.rejects(() => module.dbGet('records'), /SESSION_INVALID/);
  assert.equal(calls, 1);
  assert.equal(storage.getItem('masterskaya_storage_session_v1'), null);
  assert.equal(storage.getItem('github_token_v1'), 'legacy-token-must-not-be-used');
});
