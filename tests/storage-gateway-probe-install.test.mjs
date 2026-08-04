import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

test("App installs the storage gateway probe without replacing the active storage client", () => {
  assert.equal(appSource.includes('from "./storage-gateway.js"'), true);
  assert.equal(appSource.includes("installStorageGatewayProbe();"), true);
  assert.equal(appSource.includes('from "./github-storage.js"'), true);
});
