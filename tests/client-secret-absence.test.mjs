import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Этот тест должен падать при любой попытке вернуть постоянный Ably-ключ в браузер.
const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

test("browser App source contains no permanent Ably API key configuration", () => {
  assert.equal(appSource.includes("const ABLY_KEY"), false);
  assert.equal(/new\s+Ably\.Realtime\s*\(\s*\{[\s\S]*?\bkey\s*:/m.test(appSource), false);
  assert.equal(appSource.includes("installSecureAblyProbe"), false);
  assert.equal(appSource.includes("createSecureAblyRealtimeOptions"), true);
});
