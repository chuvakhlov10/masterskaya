import { readFile, writeFile } from "node:fs/promises";

const appPath = "src/App.jsx";
const statusPath = "src/status-core.js";

let app = await readFile(appPath, "utf8");

const oldImport = 'import { installSecureAblyProbe } from "./ably-auth.js";';
const newImport = 'import { createSecureAblyRealtimeOptions } from "./ably-secure-client.js";';
if (!app.includes(oldImport)) throw new Error("Old probe import not found");
app = app.replace(oldImport, newImport);

const realtimeBlock = /const ABLY_KEY = "[^"]+";\nconst CLIENT_ID = String\(Date\.now\(\)\) \+ '-' \+ Math\.random\(\)\.toString\(36\)\.slice\(2, 8\);\nconst ably = new Ably\.Realtime\(\{[\s\S]*?\n\}\);\ninstallSecureAblyProbe\(Ably\);/;
if (!realtimeBlock.test(app)) throw new Error("Legacy Ably initialization block not found");

app = app.replace(realtimeBlock, `const CLIENT_ID = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);\nconst ably = new Ably.Realtime(createSecureAblyRealtimeOptions({\n  clientId: CLIENT_ID,\n  autoConnect: hasToken(),\n}));`);

if (app.includes("const ABLY_KEY")) throw new Error("Permanent Ably key declaration remains");
if (app.includes("installSecureAblyProbe")) throw new Error("Probe call remains");
if (!app.includes("createSecureAblyRealtimeOptions")) throw new Error("Secure client initialization missing");

await writeFile(appPath, app);

let status = await readFile(statusPath, "utf8");
if (!status.includes('export const APP_VERSION = "1.2.1";')) {
  throw new Error("Expected app version 1.2.1 not found");
}
status = status.replace(
  'export const APP_VERSION = "1.2.1";',
  'export const APP_VERSION = "1.2.2";',
);
await writeFile(statusPath, status);

console.log("Applied secure Ably JWT client and removed permanent browser key");
