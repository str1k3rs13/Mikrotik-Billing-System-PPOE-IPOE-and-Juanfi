// ============================================================================
//  JEFF NETWORK SERVICE — Client Portal (standalone, public-facing)
//
//  SAFETY MODEL (read this):
//   - This program is PUBLIC. It runs on a VPS, separate from your main panel.
//   - It ONLY collects applications, payments-intent, and help tickets, and stores
//     them in its OWN small database.
//   - It NEVER connects to your MikroTik router and NEVER holds router credentials.
//   - Your MAIN PANEL (on your private network) PULLS new submissions from here using
//     a secret token, then you review/approve and it provisions on the router.
//   - So even if this public server is breached, the worst case is leaked applications
//     — your router and network stay private.
//
//  Pure Node.js (built-ins only): http, node:sqlite, crypto, fs. Node 22+ required.
//  Run:  SYNC_TOKEN=your-long-secret PORT=8080 node portal.js
// ============================================================================
import http from "node:http";
import https from "node:https";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "portal.db");
// The shared secret your MAIN PANEL uses to pull data. MUST be set and kept private.
const SYNC_TOKEN = process.env.SYNC_TOKEN || "";
// Optional: business name shown on the pages
const BIZ = process.env.BIZ_NAME || "JEFF NETWORK SERVICE";
const PAYMONGO_SECRET = (process.env.PAYMONGO_SECRET || "").trim();
const PAYMONGO_WEBHOOK_SECRET = (process.env.PAYMONGO_WEBHOOK_SECRET || "").trim();
const PAYMONGO_BASE = (process.env.PAYMONGO_BASE || "https://api.paymongo.com/v1").replace(/\/$/, "");

// --- PayMongo helpers (GCash / Maya / card) ---
function pmRequest(pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const auth = "Basic " + Buffer.from(PAYMONGO_SECRET + ":").toString("base64");
    let u; try { u = new URL(PAYMONGO_BASE + pathName); } catch (e) { return reject(e); }
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + u.search, method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 15000 },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json: j }); }); });
    req.on("timeout", () => req.destroy(new Error("PayMongo timeout")));
    req.on("error", reject); req.end(payload);
  });
}
async function pmCreateCheckout({ amountPhp, description, refNo, successUrl }) {
  if (!PAYMONGO_SECRET) throw new Error("PAYMONGO_SECRET not set");
  const r = await pmRequest("/checkout_sessions", { data: { attributes: {
    line_items: [{ name: description || "Internet payment", amount: Math.round(Number(amountPhp) * 100), currency: "PHP", quantity: 1 }],
    payment_method_types: ["gcash", "paymaya", "card"], description: description || "Internet payment",
    reference_number: refNo, success_url: successUrl || "" } } });
  if (r.status < 200 || r.status >= 300 || !r.json || !r.json.data) {
    const msg = r.json && r.json.errors ? r.json.errors.map(e => e.detail).join("; ") : ("HTTP " + r.status);
    throw new Error(msg);
  }
  return { id: r.json.data.id, checkout_url: r.json.data.attributes.checkout_url };
}
function pmVerifyWebhook(rawBody, sigHeader) {
  if (!PAYMONGO_WEBHOOK_SECRET) return false;
  const parts = Object.fromEntries(String(sigHeader || "").split(",").map(kv => kv.split("=")));
  const t = parts.t, sig = parts.te || parts.li;
  if (!t || !sig) return false;
  const mac = crypto.createHmac("sha256", PAYMONGO_WEBHOOK_SECRET).update(t + "." + rawBody).digest("hex");
  if (mac.length !== sig.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sig)); } catch { return false; }
}

if (!SYNC_TOKEN) {
  console.error("\n  ⚠  SYNC_TOKEN is not set. Set a long random secret so only your panel can pull data:");
  console.error("       SYNC_TOKEN=$(openssl rand -hex 24) PORT=8080 node portal.js\n");
  console.error("  Refusing to start without it (the sync API would be unprotected).\n");
  process.exit(1);
}

// ---- database -------------------------------------------------------------
const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,            -- 'apply' | 'pay' | 'help'
    payload TEXT NOT NULL,         -- JSON of the form fields
    created_at TEXT DEFAULT (datetime('now')),
    pulled INTEGER DEFAULT 0,      -- 0 = not yet pulled by the panel, 1 = pulled
    pulled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS customer_summary (
    code TEXT PRIMARY KEY,
    last TEXT NOT NULL,
    name TEXT, plan TEXT, speed TEXT, status TEXT, due TEXT,
    balance REAL DEFAULT 0, rate REAL DEFAULT 0, username TEXT DEFAULT '', conn_type TEXT DEFAULT 'pppoe',
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY, name TEXT, price REAL, speed TEXT, validity_days INTEGER, type TEXT, features TEXT DEFAULT '', sort INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS portal_config (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE, code TEXT, last TEXT, amount REAL,
    purpose TEXT, link_id TEXT, checkout_url TEXT, status TEXT DEFAULT 'pending',
    pulled INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), paid_at TEXT
  );
`);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);

// ---- helpers --------------------------------------------------------------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ""; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 6_000_000) { req.destroy(); resolve(""); } else d += c; });
    req.on("end", () => resolve(d));
    req.on("error", () => resolve(""));
  });
}
function serveFile(res, file, type) {
  try {
    const buf = fs.readFileSync(path.join(__dirname, "public", file));
    res.writeHead(200, { "Content-Type": type });
    res.end(buf);
  } catch { res.writeHead(404); res.end("not found"); }
}
// constant-time token check
function tokenOk(req) {
  const auth = req.headers["authorization"] || "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : (new URL(req.url, "http://x").searchParams.get("token") || "");
  if (!got || got.length !== SYNC_TOKEN.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(SYNC_TOKEN)); } catch { return false; }
}

// ---- server ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type,Authorization" });
    return res.end();
  }

  // --- public pages ---
  if (p === "/" || p === "/index.html") return serveFile(res, "index.html", "text/html; charset=utf-8");
  if (p === "/apply") return serveFile(res, "apply.html", "text/html; charset=utf-8");
  if (p === "/pay") { res.writeHead(302, { Location: "/account" }); return res.end(); }
  if (p === "/account") return serveFile(res, "account.html", "text/html; charset=utf-8");
  if (p === "/help") return serveFile(res, "help.html", "text/html; charset=utf-8");

  // --- public form submissions (stored, NOT sent anywhere live) ---
  if ((p === "/api/apply" || p === "/api/pay" || p === "/api/help") && req.method === "POST") {
    const kind = p === "/api/apply" ? "apply" : p === "/api/pay" ? "pay" : "help";
    const raw = await readBody(req);
    let b; try { b = JSON.parse(raw || "{}"); } catch { return send(res, 400, { ok: false, error: "Bad data." }); }
    // minimal validation per kind
    if (kind === "apply" || kind === "help") {
      if (!b.name || !String(b.name).trim()) return send(res, 400, { ok: false, error: "Please enter your name." });
      if (!b.contact || !String(b.contact).trim()) return send(res, 400, { ok: false, error: "Please enter a contact number." });
    }
    if (kind === "apply" && !b.agreed) return send(res, 400, { ok: false, error: "Please tick the agreement." });

    // ---- flood / fake-submission protection ----
    const okMsg = kind === "apply"
      ? "Thank you! Your application was received. We'll contact you shortly to schedule your installation."
      : kind === "pay" ? "Thank you! We'll confirm your payment shortly."
      : "Thanks! Your message was received. We'll get back to you.";
    // 1) honeypot — hidden field only bots fill
    if ((b.website && String(b.website).trim()) || (b._hp && String(b._hp).trim())) return send(res, 200, { ok: true, message: okMsg });
    // 2) too-fast submit (< 3s) = bot
    const elapsed = Number(b._t || 0);
    if (elapsed > 0 && elapsed < 3000) return send(res, 200, { ok: true, message: okMsg });
    // 3) per-IP rate limit (6/hour)
    try {
      const ip = (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
      const now = Date.now(); const WINDOW = 3600000; const MAX = 6;
      run("CREATE TABLE IF NOT EXISTS rate_hits (ip TEXT, at INTEGER)");
      run("DELETE FROM rate_hits WHERE at < ?", now - WINDOW);
      const n = all("SELECT COUNT(*) n FROM rate_hits WHERE ip=?", ip)[0].n;
      if (n >= MAX) return send(res, 429, { ok: false, error: "Too many submissions. Please try again later." });
      run("INSERT INTO rate_hits (ip,at) VALUES (?,?)", ip, now);
    } catch {}
    // 4) duplicate guard.
    //  - apply/help: block repeat from same name+contact within 10 min (anti double-submit/spam).
    //  - pay: only block a TRUE duplicate (same reference number), since a customer may legitimately
    //    make two different payments close together. Never silently swallow a distinct payment.
    try {
      if (kind === "pay") {
        const ref = String(b.pay_reference || "").replace(/\s+/g, "");
        if (ref) {
          const dup = all("SELECT COUNT(*) n FROM submissions WHERE kind='pay' AND created_at > datetime('now','-1 day') AND replace(json_extract(payload,'$.pay_reference'),' ','')=?", ref)[0].n;
          if (dup > 0) return send(res, 200, { ok: true, message: "We already received a payment with that reference. If this is a new payment, use the correct reference number." });
        }
      } else {
        const dup = all("SELECT COUNT(*) n FROM submissions WHERE kind=? AND created_at > datetime('now','-10 minutes') AND json_extract(payload,'$.contact')=? AND json_extract(payload,'$.name')=?", kind, String(b.contact || ""), String(b.name || ""))[0].n;
        if (dup > 0) return send(res, 200, { ok: true, message: okMsg });
      }
    } catch {}

    // strip anything huge / unexpected; keep only known fields
    const clean = {
      name: String(b.name || "").slice(0, 120),
      contact: String(b.contact || "").slice(0, 60),
      email: String(b.email || "").slice(0, 120),
      address: String(b.address || "").slice(0, 300),
      area: String(b.area || "").slice(0, 80),
      plan: String(b.plan || b.plan_id || "").slice(0, 80),
      conn_type: ["pppoe", "ipoe", "hotspot"].includes(b.conn_type) ? b.conn_type : "pppoe",
      pay_choice: b.pay_choice === "now" ? "now" : "on_install",
      pay_reference: String(b.pay_reference || "").slice(0, 120),
    purpose: ["topup","renew","bill"].includes(b.purpose) ? b.purpose : "topup",
      topic: String(b.topic || "").slice(0, 80),
      message: String(b.message || b.notes || "").slice(0, 2000),
      proof_img: (kind === "pay" && typeof b.proof_img === "string" && b.proof_img.startsWith("data:image/") && b.proof_img.length < 400000) ? b.proof_img : "",
      agreed: kind === "apply" ? 1 : undefined,
    };
    run("INSERT INTO submissions (kind,payload) VALUES (?,?)", kind, JSON.stringify(clean));
    const msg = kind === "apply"
      ? "Thank you! Your application was received. We'll contact you shortly to schedule your installation."
      : kind === "pay"
        ? "Thank you! We'll confirm your payment shortly."
        : "Thanks! Your message was received. We'll get back to you.";
    return send(res, 200, { ok: true, message: msg });
  }

  // --- SYNC: your panel PULLS new submissions (token-protected) ---
  if (p === "/sync/pull" && req.method === "GET") {
    if (!tokenOk(req)) return send(res, 401, { ok: false, error: "unauthorized" });
    const rows = all("SELECT id, kind, payload, created_at FROM submissions WHERE pulled=0 ORDER BY id ASC LIMIT 200");
    return send(res, 200, { ok: true, items: rows.map(r => ({ id: r.id, kind: r.kind, created_at: r.created_at, data: JSON.parse(r.payload) })) });
  }
  // --- SYNC: panel ACKs what it successfully imported, so we don't send again ---
  if (p === "/sync/ack" && req.method === "POST") {
    if (!tokenOk(req)) return send(res, 401, { ok: false, error: "unauthorized" });
    const raw = await readBody(req);
    let b; try { b = JSON.parse(raw || "{}"); } catch { return send(res, 400, { ok: false, error: "bad data" }); }
    const ids = Array.isArray(b.ids) ? b.ids.filter(n => Number.isInteger(n)) : [];
    if (ids.length) {
      const qs = ids.map(() => "?").join(",");
      run(`UPDATE submissions SET pulled=1, pulled_at=datetime('now') WHERE id IN (${qs})`, ...ids);
      // Privacy: strip any payment screenshot once the panel has pulled it (don't retain images).
      try {
        const rows = all(`SELECT id, payload FROM submissions WHERE id IN (${qs})`, ...ids);
        for (const r of rows) {
          if (r.payload && r.payload.includes("proof_img")) {
            let d; try { d = JSON.parse(r.payload); } catch { d = null; }
            if (d && d.proof_img) { d.proof_img = ""; run("UPDATE submissions SET payload=? WHERE id=?", JSON.stringify(d), r.id); }
          }
        }
      } catch {}
    }
    return send(res, 200, { ok: true, acked: ids.length });
  }

  // --- SYNC: panel PUSHES the read-only customer summary (token-protected) ---
  if (p === "/sync/push-summary" && req.method === "POST") {
    if (!tokenOk(req)) return send(res, 401, { ok: false, error: "unauthorized" });
    const raw = await readBody(req);
    let b; try { b = JSON.parse(raw || "{}"); } catch { return send(res, 400, { ok: false, error: "bad data" }); }
    const list = Array.isArray(b.customers) ? b.customers : [];
    run("DELETE FROM customer_summary");
    const ins = db.prepare("INSERT OR REPLACE INTO customer_summary (code,last,name,plan,speed,status,due,balance,rate,username,conn_type,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))");
    let n = 0;
    for (const c of list) {
      if (!c.code || !c.last) continue;
      ins.run(String(c.code), String(c.last).toLowerCase(), String(c.name || ""), String(c.plan || ""), String(c.speed || ""), String(c.status || ""), String(c.due || ""), Number(c.balance || 0), Number(c.rate || 0), String(c.username || "").toLowerCase(), String(c.conn_type || "pppoe"));
      n++;
    }
    return send(res, 200, { ok: true, stored: n });
  }

  // --- SYNC: panel PUSHES plans + config (token-protected) ---
  if (p === "/sync/push-config" && req.method === "POST") {
    if (!tokenOk(req)) return send(res, 401, { ok: false, error: "unauthorized" });
    const raw = await readBody(req);
    let b; try { b = JSON.parse(raw || "{}"); } catch { return send(res, 400, { ok: false, error: "bad data" }); }
    const plans = Array.isArray(b.plans) ? b.plans : [];
    const config = b.config || {};
    run("DELETE FROM plans");
    const ins = db.prepare("INSERT OR REPLACE INTO plans (id,name,price,speed,validity_days,type,features,sort) VALUES (?,?,?,?,?,?,?,?)");
    plans.forEach((p2, i) => ins.run(Number(p2.id) || i + 1, String(p2.name || ""), Number(p2.price || 0), String(p2.speed || ""), Number(p2.validity_days || 30), String(p2.type || "pppoe"), String(p2.features || ""), i));
    const cins = db.prepare("INSERT OR REPLACE INTO portal_config (k,v) VALUES (?,?)");
    for (const [k, v] of Object.entries(config)) cins.run(String(k), String(v == null ? "" : v));
    return send(res, 200, { ok: true, plans: plans.length });
  }

  // --- public: plans + config for the apply form (no token; public marketing info) ---
  if (p === "/api/plans" && req.method === "GET") {
    const plans = all("SELECT id,name,price,speed,validity_days,type,features FROM plans ORDER BY sort ASC, price ASC");
    const cfgRows = all("SELECT k,v FROM portal_config");
    const config = {}; for (const r of cfgRows) config[r.k] = r.v;
    return send(res, 200, { ok: true, plans, config });
  }

  // --- start a real payment (PayMongo checkout) ---
  if (p === "/api/pay-start" && req.method === "POST") {
    const raw = await readBody(req);
    let b; try { b = JSON.parse(raw || "{}"); } catch { return send(res, 400, { ok: false, error: "Bad data." }); }
    const code = String(b.code || "").trim(), last = String(b.last || "").trim().toLowerCase();
    const amount = Math.round(Number(b.amount || 0));
    const purpose = ["topup", "renew", "bill"].includes(b.purpose) ? b.purpose : "topup";
    if (!code || !last) return send(res, 400, { ok: false, error: "Sign in first." });
    if (!(amount >= 20)) return send(res, 400, { ok: false, error: "Minimum payment is \u20B120." });
    const cust = all("SELECT code,name FROM customer_summary WHERE code=? AND last=?", code, last)[0];
    if (!cust) return send(res, 404, { ok: false, error: "Account not found." });
    const ref = "JN-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
    const origin = "http" + (req.socket.encrypted ? "s" : "") + "://" + (req.headers.host || "");
    let checkout;
    try {
      checkout = await pmCreateCheckout({ amountPhp: amount, description: (purpose === "renew" ? "Plan renewal" : purpose === "bill" ? "Bill payment" : "Wallet top-up") + " — " + cust.name, refNo: ref, successUrl: origin + "/account?paid=1" });
    } catch (e) { return send(res, 502, { ok: false, error: "Payment setup failed: " + e.message }); }
    run("INSERT INTO payments (ref,code,last,amount,purpose,link_id,checkout_url,status) VALUES (?,?,?,?,?,?,?,'pending')", ref, code, last, amount, purpose, checkout.id, checkout.checkout_url);
    return send(res, 200, { ok: true, checkout_url: checkout.checkout_url, ref });
  }

  // --- PayMongo webhook (marks a payment paid; signature-verified, idempotent) ---
  if (p === "/api/paymongo-webhook" && req.method === "POST") {
    const raw = await readBody(req);
    if (!pmVerifyWebhook(raw, req.headers["paymongo-signature"] || "")) return send(res, 401, { ok: false, error: "bad signature" });
    let evt; try { evt = JSON.parse(raw); } catch { return send(res, 400, { ok: false }); }
    const type = (evt && evt.data && evt.data.attributes && evt.data.attributes.type) || "";
    const data = (evt && evt.data && evt.data.attributes && evt.data.attributes.data) || {};
    if (!/paid/i.test(type)) return send(res, 200, { ok: true, ignored: type });
    const attrs = data.attributes || {};
    const ref = attrs.reference_number || (attrs.payment_intent && attrs.payment_intent.attributes && attrs.payment_intent.attributes.reference_number) || "";
    if (ref) run("UPDATE payments SET status='paid', paid_at=datetime('now') WHERE ref=? AND status!='paid'", ref);
    else if (data.id) run("UPDATE payments SET status='paid', paid_at=datetime('now') WHERE link_id=? AND status!='paid'", data.id);
    return send(res, 200, { ok: true });
  }

  // --- panel pulls PAID, not-yet-credited payments (token) ---
  if (p === "/sync/pull-payments" && req.method === "GET") {
    if (!tokenOk(req)) return send(res, 401, { ok: false, error: "unauthorized" });
    const rows = all("SELECT id,ref,code,last,amount,purpose,paid_at FROM payments WHERE status='paid' AND pulled=0 ORDER BY id ASC LIMIT 100");
    return send(res, 200, { ok: true, items: rows });
  }
  if (p === "/sync/ack-payments" && req.method === "POST") {
    if (!tokenOk(req)) return send(res, 401, { ok: false, error: "unauthorized" });
    const raw = await readBody(req);
    let b; try { b = JSON.parse(raw || "{}"); } catch { return send(res, 400, { ok: false, error: "bad data" }); }
    const ids = Array.isArray(b.ids) ? b.ids.filter(n => Number.isInteger(n)) : [];
    if (ids.length) { const qs = ids.map(() => "?").join(","); run(`UPDATE payments SET pulled=1 WHERE id IN (${qs})`, ...ids); }
    return send(res, 200, { ok: true, acked: ids.length });
  }

  // --- customer self-service lookup: account code + last name (view-only) ---
  if (p === "/api/myaccount" && req.method === "POST") {
    const raw = await readBody(req);
    let b; try { b = JSON.parse(raw || "{}"); } catch { return send(res, 400, { ok: false, error: "Bad data." }); }
    const code = String(b.code || "").trim();
    const last = String(b.last || "").trim().toLowerCase();
    if (!code || !last) return send(res, 400, { ok: false, error: "Enter your account code (or username) and last name." });
    const row = all("SELECT code,name,plan,speed,status,due,balance,rate,username,conn_type,updated_at FROM customer_summary WHERE (code=? OR username=?) AND last=?", code, code.toLowerCase(), last)[0];
    if (!row) return send(res, 404, { ok: false, error: "No match. Check your account code or username and last name, or contact us." });
    return send(res, 200, { ok: true, account: row });
  }

  // health check
  if (p === "/health") return send(res, 200, { ok: true, pending: all("SELECT COUNT(*) n FROM submissions WHERE pulled=0")[0].n });

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log("============================================================");
  console.log("  " + BIZ + " — Client Portal (public)");
  console.log("============================================================");
  console.log("  Listening on port " + PORT);
  console.log("  Pages:  /apply   /pay   /help");
  console.log("  Sync:   GET /sync/pull   POST /sync/ack   (Bearer token)");
  console.log("  This server NEVER talks to your router. It only collects data.");
  console.log("============================================================");
});
