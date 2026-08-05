import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor(){ this.map = new Map(); }
  getItem(key){ return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value){ this.map.set(key, String(value)); }
  removeItem(key){ this.map.delete(key); }
  clear(){ this.map.clear(); }
  key(index){ return [...this.map.keys()][index] ?? null; }
  get length(){ return this.map.size; }
}

function encodeJson(value){
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}
function gatewayBody(options){
  return JSON.parse(options.body);
}
function repoBody(options){
  return gatewayBody(options).body;
}
function decodeWrittenValue(options){
  return JSON.parse(Buffer.from(repoBody(options).content, 'base64').toString('utf8'));
}
function jsonResponse(value, status = 200){
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadStorage(fetchImpl){
  globalThis.localStorage = new MemoryStorage();
  globalThis.localStorage.setItem('masterskaya_storage_session_v1', JSON.stringify({
    token: 'header.payload.signature',
    expiresAt: Date.now() + 10 * 24 * 60 * 60 * 1000,
    clientId: 'web-device-12345678',
  }));
  globalThis.fetch = fetchImpl;
  const url = new URL('../src/github-storage.js', import.meta.url);
  url.searchParams.set('test', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function repoMethod(options){
  return gatewayBody(options).method;
}

test('dbSet reads current remote value through the gateway and writes matching SHA', async () => {
  const requests = [];
  const storage = await loadStorage(async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (repoMethod(options) === 'GET') {
      return jsonResponse({ sha: 'sha-current', content: encodeJson([{ opId: 'remote' }]) });
    }
    return jsonResponse({ content: { sha: 'sha-after' } });
  });

  const result = await storage.dbSet(
    'stock-ops',
    [{ opId: 'local' }],
    (remote, local) => [...remote, ...local],
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [{ opId: 'remote' }, { opId: 'local' }]);
  const put = requests.find(request => repoMethod(request.options) === 'PUT');
  assert.ok(put, 'gateway PUT request was made');
  assert.equal(repoBody(put.options).sha, 'sha-current');
  assert.deepEqual(decodeWrittenValue(put.options), [{ opId: 'remote' }, { opId: 'local' }]);
  assert.match(put.url, /^https:\/\/functions\.yandexcloud\.net\//);
  assert.equal(put.options.headers['X-Masterskaya-Session'], 'header.payload.signature');
  assert.equal(put.url.includes('github.com'), false);
  assert.ok(globalThis.localStorage.getItem('masterskaya_storage_session_v1'));
});

test('dbSet retries a gateway conflict by reading again and never uses a stale local snapshot', async () => {
  let getCount = 0;
  let putCount = 0;
  const writes = [];
  const storage = await loadStorage(async (_url, options = {}) => {
    const method = repoMethod(options);
    if (method === 'GET') {
      getCount++;
      const remote = getCount === 1
        ? [{ opId: 'remote-1' }]
        : [{ opId: 'remote-1' }, { opId: 'remote-2' }];
      return jsonResponse({ sha: `sha-${getCount}`, content: encodeJson(remote) });
    }
    putCount++;
    writes.push({ body: repoBody(options), value: decodeWrittenValue(options) });
    if (putCount === 1) return jsonResponse({ message: 'sha does not match' }, 409);
    return jsonResponse({ content: { sha: 'sha-success' } });
  });

  const result = await storage.dbSet(
    'stock-ops',
    [{ opId: 'local' }],
    (remote, local) => {
      const byId = new Map([...remote, ...local].map(item => [item.opId, item]));
      return [...byId.values()];
    },
  );

  assert.equal(result.ok, true);
  assert.equal(putCount, 2);
  assert.equal(writes[1].body.sha, 'sha-2');
  assert.deepEqual(writes[1].value.map(item => item.opId), ['remote-1', 'remote-2', 'local']);
});

test('a merge error aborts the gateway write instead of overwriting remote data', async () => {
  let putCount = 0;
  const storage = await loadStorage(async (_url, options = {}) => {
    if (repoMethod(options) === 'GET') {
      return jsonResponse({ sha: 'sha-current', content: encodeJson({ server: true }) });
    }
    putCount++;
    return jsonResponse({ content: { sha: 'unexpected' } });
  });

  const result = await storage.dbSet('prices', { local: true }, () => {
    throw new Error('MERGE_FAILED');
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /MERGE_FAILED/);
  assert.equal(putCount, 0);
});

test('dbGet distinguishes a gateway network failure from a missing file', async () => {
  const storage = await loadStorage(async () => {
    throw new TypeError('network down');
  });
  await assert.rejects(() => storage.dbGet('records'), /GATEWAY_REQUEST_FAILED/);
});

test('writes to one key remain serialized through the gateway', async () => {
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let sha = 0;
  const storage = await loadStorage(async (_url, options = {}) => {
    activeRequests++;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise(resolve => setTimeout(resolve, 15));
    const method = repoMethod(options);
    let response;
    if (method === 'GET') {
      response = jsonResponse({ sha: `sha-${sha}`, content: encodeJson([]) });
    } else {
      sha++;
      response = jsonResponse({ content: { sha: `sha-${sha}` } });
    }
    activeRequests--;
    return response;
  });

  await Promise.all([
    storage.dbSet('stock-ops', [{ opId: 'a' }], (_remote, local) => local),
    storage.dbSet('stock-ops', [{ opId: 'b' }], (_remote, local) => local),
  ]);

  assert.equal(maxActiveRequests, 1);
});

test('backup status is requested through the gateway from data-backups', async () => {
  let request;
  const expected = { last_attempt: { valid: true }, latest_good: { counts: { records: 10 } } };
  const storage = await loadStorage(async (url, options) => {
    request = { url: String(url), options };
    return jsonResponse({ sha: 'status-sha', content: encodeJson(expected) });
  });

  const result = await storage.backupStatusGet();
  assert.deepEqual(result, expected);
  assert.match(request.url, /^https:\/\/functions\.yandexcloud\.net\//);
  assert.deepEqual(gatewayBody(request.options), {
    action: 'github',
    method: 'GET',
    path: 'status.json',
    ref: 'data-backups',
  });
});

test('hasStorageAccess accepts an active device session', async () => {
  const storage = await loadStorage(async () => jsonResponse({}));
  assert.equal(storage.hasStorageAccess(), true);
});
