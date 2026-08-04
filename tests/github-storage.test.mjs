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
function decodeBody(request){
  return JSON.parse(request.body);
}
function decodeWrittenValue(request){
  const body = decodeBody(request);
  return JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
}
function jsonResponse(value, status = 200){
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadStorage(fetchImpl){
  globalThis.localStorage = new MemoryStorage();
  globalThis.localStorage.setItem('github_token_v1', 'test-token');
  globalThis.fetch = fetchImpl;
  const url = new URL('../src/github-storage.js', import.meta.url);
  url.searchParams.set('test', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test('dbSet always reads current remote value before merge and writes matching SHA', async () => {
  const requests = [];
  const storage = await loadStorage(async (url, options = {}) => {
    requests.push({ url: String(url), ...options });
    if ((options.method || 'GET') === 'GET') {
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
  const put = requests.find(request => request.method === 'PUT');
  assert.ok(put, 'PUT request was made');
  assert.equal(decodeBody(put).sha, 'sha-current');
  assert.deepEqual(decodeWrittenValue(put), [{ opId: 'remote' }, { opId: 'local' }]);
});

test('dbSet retries a conflict by reading again and never falls back to stale local snapshot', async () => {
  let getCount = 0;
  let putCount = 0;
  const writes = [];
  const storage = await loadStorage(async (_url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') {
      getCount++;
      const remote = getCount === 1
        ? [{ opId: 'remote-1' }]
        : [{ opId: 'remote-1' }, { opId: 'remote-2' }];
      return jsonResponse({ sha: `sha-${getCount}`, content: encodeJson(remote) });
    }
    putCount++;
    writes.push({ body: decodeBody(options), value: decodeWrittenValue(options) });
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

test('a merge error aborts the write instead of overwriting remote data', async () => {
  let putCount = 0;
  const storage = await loadStorage(async (_url, options = {}) => {
    if ((options.method || 'GET') === 'GET') {
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

test('dbGet distinguishes a network failure from a missing file', async () => {
  const storage = await loadStorage(async () => {
    throw new TypeError('network down');
  });
  await assert.rejects(() => storage.dbGet('records'), /network down/);
});

test('writes to one key are serialized', async () => {
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let sha = 0;
  const storage = await loadStorage(async (_url, options = {}) => {
    activeRequests++;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise(resolve => setTimeout(resolve, 15));
    const method = options.method || 'GET';
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

test('backup status is read from the data-backups branch', async () => {
  let requestedUrl = '';
  const expected = { last_attempt: { valid: true }, latest_good: { counts: { records: 10 } } };
  const storage = await loadStorage(async (url) => {
    requestedUrl = String(url);
    return jsonResponse({ sha: 'status-sha', content: encodeJson(expected) });
  });

  const result = await storage.backupStatusGet();
  assert.deepEqual(result, expected);
  const parsed = new URL(requestedUrl);
  assert.equal(parsed.pathname.endsWith('/contents/status.json'), true);
  assert.equal(parsed.searchParams.get('ref'), 'data-backups');
});
