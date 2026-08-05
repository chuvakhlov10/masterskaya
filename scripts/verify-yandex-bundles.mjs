import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DIST = path.join(REPO_ROOT, 'dist', 'yandex');
const require = createRequire(import.meta.url);

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifestPath = path.join(DIST, 'manifest.json');
assert(fs.existsSync(manifestPath), 'FUNCTION_MANIFEST_MISSING');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

for (const targetName of ['storage', 'ably']) {
  const targetDir = path.join(DIST, targetName);
  const entries = fs.readdirSync(targetDir).sort();
  assert(entries.length === 1 && entries[0] === 'index.js', `${targetName}: ZIP_ROOT_MUST_CONTAIN_ONLY_INDEX_JS`);

  const outputPath = path.join(targetDir, 'index.js');
  const source = fs.readFileSync(outputPath, 'utf8');
  assert(!/require\((['"])\.\.?(?:\/|\\)/.test(source), `${targetName}: LOCAL_REQUIRE_REMAINS`);
  assert(!source.includes('__MASTERSKAYA_BUILD_ID__'), `${targetName}: BUILD_ID_PLACEHOLDER_REMAINS`);
  assert(!source.includes('__MASTERSKAYA_BUILD_DATE__'), `${targetName}: BUILD_DATE_PLACEHOLDER_REMAINS`);
  assert(manifest.targets?.[targetName]?.sha256 === sha256(source), `${targetName}: SHA256_MISMATCH`);

  delete require.cache[require.resolve(outputPath)];
  const loaded = require(outputPath);
  assert(typeof loaded?.handler === 'function', `${targetName}: HANDLER_EXPORT_MISSING`);
  assert(loaded.FUNCTION_VERSION === '1.3.1', `${targetName}: FUNCTION_VERSION_MISMATCH`);
  assert(loaded.PROTOCOL_VERSION === 3, `${targetName}: PROTOCOL_VERSION_MISMATCH`);
}

console.log('Yandex function bundles verified: single index.js, metadata and handler exports are valid.');
