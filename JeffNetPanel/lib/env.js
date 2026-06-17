// lib/env.js — minimal .env loader (no dependency, replaces dotenv).
import fs from "node:fs";
import path from "node:path";

// When packaged into an .exe with pkg, process.cwd() is the folder the .exe is
// launched from, so a .env placed NEXT TO the .exe is picked up automatically.
export function loadEnv(file = ".env") {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let [, key, val] = m;
    val = val.replace(/^["']|["']$/g, ""); // strip surrounding quotes
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
