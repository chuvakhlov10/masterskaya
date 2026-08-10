import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

test("client cannot recreate stock init operations from retired legacy snapshots", () => {
  assert.doesNotMatch(appSource, /sGet\("stock"\)/);
  assert.doesNotMatch(appSource, /sGet\("stock:main"\)/);
  assert.doesNotMatch(appSource, /client:\s*["']migration["']/);
  assert.match(appSource, /legacy-миграция отключена/);
});
