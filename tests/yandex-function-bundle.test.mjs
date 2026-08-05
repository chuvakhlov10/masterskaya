import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { buildAll } from '../scripts/build-yandex-functions.mjs';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

test('function builder creates executable single-file bundles with injected metadata', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masterskaya-functions-'));
  try {
    const manifest = buildAll({
      rootDir: ROOT,
      outputDir,
      buildId: 'testbuild123',
      buildDate: '2026-08-05T10:30:00Z',
    });

    for (const targetName of ['storage', 'ably']) {
      const targetDir = path.join(outputDir, targetName);
      assert.deepEqual(fs.readdirSync(targetDir), ['index.js']);
      const outputPath = path.join(targetDir, 'index.js');
      const source = fs.readFileSync(outputPath, 'utf8');
      assert.equal(source.includes("require('./"), false);
      assert.equal(source.includes('__MASTERSKAYA_BUILD_ID__'), false);
      assert.equal(source.includes('__MASTERSKAYA_BUILD_DATE__'), false);
      assert.equal(source.includes('testbuild123'), true);
      assert.equal(source.includes('2026-08-05T10:30:00Z'), true);

      delete require.cache[require.resolve(outputPath)];
      const bundle = require(outputPath);
      assert.equal(typeof bundle.handler, 'function');
      assert.equal(bundle.FUNCTION_VERSION, '1.4.1');
      assert.equal(bundle.PROTOCOL_VERSION, 3);
      assert.equal(bundle.BUILD_ID, 'testbuild123');
    }

    assert.equal(manifest.targets.storage.service, 'masterskaya-storage-gateway');
    assert.equal(manifest.targets.ably.service, 'masterskaya-ably-auth');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
