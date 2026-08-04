import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('Vercel Ably endpoint loads with the installed server SDK', () => {
  const handler = require('../api/ably-token.js');
  assert.equal(typeof handler, 'function');
});
