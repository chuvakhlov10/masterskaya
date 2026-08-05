import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const storageSource = await readFile(new URL("../src/github-storage.js", import.meta.url), "utf8");

test("App keeps its stable storage API while the implementation uses the Yandex gateway", () => {
  assert.equal(appSource.includes('from "./github-storage.js"'), true);
  assert.equal(storageSource.includes('from "./storage-gateway.js"'), true);
  assert.equal(storageSource.includes("storageGatewayRequest({"), true);
});

test("working data requests do not construct direct GitHub Contents API URLs", () => {
  assert.equal(storageSource.includes('/contents/${encodePath(path)}'), false);
  assert.equal(storageSource.includes("github.com"), false);
  assert.equal(storageSource.includes("Authorization"), false);
});
