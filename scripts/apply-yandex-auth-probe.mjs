import fs from "node:fs";

const path = "src/App.jsx";
let source = fs.readFileSync(path, "utf8");

const importLine = 'import Ably from "ably";';
const probeImport = 'import { installSecureAblyProbe } from "./ably-auth.js";';
if (!source.includes(probeImport)) {
  if (!source.includes(importLine)) throw new Error("Ably import not found");
  source = source.replace(importLine, `${importLine}\n${probeImport}`);
}

if (!source.includes("installSecureAblyProbe(Ably);")) {
  const startMarker = "const ably = new Ably.Realtime({";
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error("Ably client block not found");
  const end = source.indexOf("\n});", start);
  if (end < 0) throw new Error("Ably client block end not found");
  const insertAt = end + "\n});".length;
  source = `${source.slice(0, insertAt)}\ninstallSecureAblyProbe(Ably);${source.slice(insertAt)}`;
}

fs.writeFileSync(path, source);
console.log("Applied secure Yandex Ably auth probe to src/App.jsx");
