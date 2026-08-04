import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../src/App.jsx", import.meta.url);
let source = await readFile(path, "utf8");

if (source.includes("installStorageGatewayProbe")) {
  console.log("Storage gateway probe already installed");
  process.exit(0);
}

const importMarker = 'import { createSecureAblyRealtimeOptions } from "./ably-secure-client.js";';
if (!source.includes(importMarker)) {
  throw new Error("Secure Ably import marker not found");
}
source = source.replace(
  importMarker,
  `${importMarker}\nimport { installStorageGatewayProbe } from "./storage-gateway.js";`,
);

const realtimeMarker = `const ably = new Ably.Realtime(createSecureAblyRealtimeOptions({\n  clientId: CLIENT_ID,\n  autoConnect: hasToken(),\n}));`;
if (!source.includes(realtimeMarker)) {
  throw new Error("Ably realtime marker not found");
}
source = source.replace(
  realtimeMarker,
  `${realtimeMarker}\ninstallStorageGatewayProbe();`,
);

await writeFile(path, source, "utf8");
console.log("Applied storage gateway probe to src/App.jsx");
