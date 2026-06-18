// server.js — zero-dependency HTTP server (Node 18+ built-ins only).
// No express, no dotenv, no SDK — so it bundles cleanly into a single .exe.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { MikroTik } from "./lib/mikrotik.js";
import { RouterOSAPI } from "./lib/routeros-api.js";
import { parseCommand, draftReply, dailyDigest, aiEnabled, setAiConfigProvider } from "./lib/ai.js";
import { screenProof } from "./lib/proofcheck.js";
import { parsePaymentSms } from "./lib/smsparse.js";
import { loadEnv } from "./lib/env.js";
import { Plans, Customers, Invoices, Payments, summary } from "./lib/db.js";
import { Settings } from "./lib/db.js";
import { Tickets, Proofs } from "./lib/db.js";
import { makeClient as tgMakeClient } from "./lib/telegram.js";
import { sendSms, looksLikePhone } from "./lib/sms.js";
import { GsmModem } from "./lib/gsm.js";
import { sendMail } from "./lib/smtp.js";
import { createLink as pmCreateLink, verifyWebhook as pmVerify, parseEvent as pmParse } from "./lib/paymongo.js";
import { Collections, Audit, Sales } from "./lib/db.js";
import { HotspotEvents, Coins, HotspotSales } from "./lib/db.js";
import { VendoSales, NewUsers, SalesAdmin } from "./lib/db.js";
import { Vendos } from "./lib/db.js";
import { CoinLog } from "./lib/db.js";
import { fetchVendo } from "./lib/juanfi.js";
import { parseCoinLog, coinSig } from "./lib/coinlog.js";
import { dbFile } from "./lib/db.js";
import { Accounts } from "./lib/db.js";
import { Inventory } from "./lib/db.js";
import { JobOrders } from "./lib/db.js";
import { Maintenance } from "./lib/db.js";
import { Techs } from "./lib/db.js";
import { Hardware } from "./lib/db.js";
import { Expenses } from "./lib/db.js";
import { exportAll, importAll } from "./lib/db.js";
import { kpis, Naps, Outages, Reports, CSessions, ClientStatus, Sms } from "./lib/db.js";
import { evalRouter, evalMassDrop, diffClientStates } from "./lib/watchdog.js";
import { coinAnomalies, totalDropTamper, triageMassDrop } from "./lib/anomaly.js";
import { Usage } from "./lib/db.js";
import { parseQueues } from "./lib/usage.js";
import * as Auth from "./lib/auth.js";
import * as License from "./lib/license.js";

loadEnv(); // read .env next to the executable, if present

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// When compiled with pkg/SEA, assets live in a virtual FS but we must read/write the license
// next to the actual executable on the real disk. process.execPath points at the .exe.
const APP_DIR = (process.pkg || process.env.PKG_EXECPATH) ? path.dirname(process.execPath) : __dirname;

// ---- License state (checked at startup + after activation) ----
let LICENSE_OK = false;
let LICENSE_STATE = { ok: false, reason: "unchecked" };
function refreshLicense() {
  LICENSE_STATE = License.checkLicense(APP_DIR);
  LICENSE_OK = !!LICENSE_STATE.ok;
  return LICENSE_STATE;
}
function licenseReasonText(reason) {
  return {
    "no-license": "No license found. Paste your license key below.",
    "bad-signature": "This license key is invalid or was modified.",
    "wrong-machine": "This license is for a different computer. Each license is locked to one machine.",
    "expired": "This license has expired. Contact your vendor to renew.",
    "malformed": "That license key is not in the right format.",
  }[reason] || ("License problem: " + (reason || "unknown"));
}
function licensePageHtml() {
  const mid = License.machineId();
  const fp = License.machineFingerprint();
  const reason = licenseReasonText(LICENSE_STATE.reason);
  return `<!doctype html><html><head><meta charset="utf-8"><title>License required</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:Arial,Helvetica,sans-serif;background:#0c1322;color:#e9eef8;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
  .card{background:#131c30;border:1px solid #243250;border-radius:16px;max-width:560px;width:100%;padding:26px}
  h1{margin:0 0 4px;font-size:20px}.sub{color:#8fa0bd;font-size:13px;margin-bottom:18px}
  .warn{background:rgba(255,93,109,.12);border:1px solid #ff5d6d;border-radius:10px;padding:11px 13px;font-size:13px;margin-bottom:16px}
  label{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#8fa0bd;display:block;margin:14px 0 5px}
  .mid{font-family:monospace;font-size:16px;background:#0c1322;border:1px solid #243250;border-radius:8px;padding:11px;display:flex;justify-content:space-between;align-items:center;gap:8px}
  textarea{width:100%;box-sizing:border-box;background:#0c1322;border:1px solid #243250;border-radius:8px;color:#e9eef8;padding:11px;font-family:monospace;font-size:12px;min-height:90px}
  button{background:#2f6bff;color:#fff;border:none;border-radius:8px;padding:11px 18px;font-weight:700;cursor:pointer;font-size:14px;margin-top:12px}
  .ghost{background:#1a2540;border:1px solid #243250}
  .ok{color:#2dd482}.muted{color:#8fa0bd;font-size:12px;margin-top:14px;line-height:1.5}</style></head>
  <body><div class="card">
    <h1>🔒 Activate your license</h1>
    <div class="sub">This copy needs a valid license to run on this computer.</div>
    <div class="warn">${reason}</div>
    <label>Your Machine ID (send this to your vendor)</label>
    <div class="mid"><span id="mid" style="font-size:12px;word-break:break-all">${fp}</span><button class="ghost" style="margin:0;padding:7px 12px;white-space:nowrap" onclick="copyFull()">Copy</button></div>
    <label>Activate with your license file</label>
    <div id="drop" style="border:2px dashed #2f6bff;border-radius:12px;padding:22px;text-align:center;cursor:pointer;background:#0f1830;transition:.15s">
      <div style="font-size:30px;margin-bottom:6px">📄</div>
      <div style="font-size:14px;font-weight:700">Drag your <b>license.key</b> file here</div>
      <div class="muted" style="margin-top:4px">or click to choose the file your vendor sent you</div>
      <input type="file" id="file" accept=".key,.txt,text/plain" style="display:none">
    </div>
    <div class="muted" style="margin:12px 0 4px">— or paste the license key text —</div>
    <textarea id="key" placeholder="Paste the license key your vendor sent you…"></textarea>
    <button onclick="activate()">Activate</button>
    <div id="msg" class="muted"></div>
    <div class="muted">How it works: send your Machine ID to your vendor, they send back a license file locked to this computer. Drag it in (or paste it) and it activates. Each license runs on one machine only.</div>
  </div>
  <script>
  const FULL = ${JSON.stringify(fp)};
  function copyFull(){ navigator.clipboard.writeText(FULL).then(()=>{msg('<span class=ok>Full Machine ID copied — send it to your vendor.</span>');}); }
  function msg(h){ document.getElementById('msg').innerHTML = h; }
  const drop = document.getElementById('drop'), file = document.getElementById('file');
  drop.onclick = () => file.click();
  file.onchange = () => { if (file.files[0]) readAndActivate(file.files[0]); };
  ['dragenter','dragover'].forEach(e=>drop.addEventListener(e,(ev)=>{ev.preventDefault();drop.style.background='#15224a';}));
  ['dragleave','drop'].forEach(e=>drop.addEventListener(e,(ev)=>{ev.preventDefault();drop.style.background='#0f1830';}));
  drop.addEventListener('drop',(ev)=>{ ev.preventDefault(); const f=ev.dataTransfer.files[0]; if(f) readAndActivate(f); });
  function readAndActivate(f){
    const r=new FileReader();
    r.onload=()=>{ document.getElementById('key').value=String(r.result||'').trim(); msg('Read '+f.name+' — activating…'); activate(); };
    r.onerror=()=>msg('Could not read that file.');
    r.readAsText(f);
  }
  async function activate(){
    const key=document.getElementById('key').value.trim();
    if(!key){msg('Drag your license file in, or paste the key first.');return;}
    const r=await fetch('/api/license/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const d=await r.json();
    if(d.ok){msg('<span class=ok>'+(d.message||'Activated!')+' Reloading…</span>');setTimeout(()=>location.reload(),1200);}
    else{msg(d.error||'Activation failed.');}
  }
  </script></body></html>`;
}

// Connection mode:
//   "api"  -> binary API, TCP port 8728 (or 8729 with SSL). Works on v6 and v7.
//   "rest" -> REST API over HTTPS (RouterOS v7 only).
const MODE = (process.env.MIKROTIK_MODE || "api").toLowerCase();

let mt;
function mtConfig() {
  // Settings (UI) take priority; fall back to environment variables.
  let s = {}; try { s = Settings.all(); } catch {}
  const host = (s.mikrotik_host || process.env.MIKROTIK_HOST || "").split(":")[0];
  const port = Number(s.mikrotik_port || process.env.MIKROTIK_PORT) || 8728;
  const user = s.mikrotik_user || process.env.MIKROTIK_USER || "";
  const password = (s.mikrotik_password && s.mikrotik_password !== "***") ? s.mikrotik_password : (process.env.MIKROTIK_PASSWORD || "");
  const ssl = (s.mikrotik_ssl === "1") || process.env.MIKROTIK_API_SSL === "true";
  return { host, port, user, password, ssl };
}
function rebuildMt() {
  if (MODE === "rest") {
    const rh = (() => { try { return Settings.get("mikrotik_host", "") || process.env.MIKROTIK_HOST || ""; } catch { return process.env.MIKROTIK_HOST || ""; } })();
    mt = new MikroTik({ host: rh, user: process.env.MIKROTIK_USER, password: process.env.MIKROTIK_PASSWORD, verifyTls: process.env.MIKROTIK_TLS_VERIFY === "true" });
    return;
  }
  const c = mtConfig();
  mt = new RouterOSAPI({ host: c.host, user: c.user, password: c.password, port: c.port || (c.ssl ? 8729 : 8728), ssl: c.ssl });
}
rebuildMt();

// ---- Dry-run safety mode ----
// When ON, router WRITE commands are logged (not sent). Lets you preview changes safely.
const dryRunLog = []; // recent dry-run commands (in-memory ring)
function syncDryRun() {
  const on = Settings.get("dry_run", "0") === "1";
  RouterOSAPI.dryRun = on;
  RouterOSAPI.onDryRun = (cmd) => {
    dryRunLog.unshift({ at: new Date().toISOString(), cmd });
    if (dryRunLog.length > 200) dryRunLog.pop();
    Audit.add({ type: "dryrun", action: "would-send", detail: cmd, ok: true });
  };
}
syncDryRun();

// Where archived (cleared) log data is saved before deletion.
const ARCHIVE_DIR = path.join(process.cwd(), "data", "archives");

// Actions that disrupt service require an explicit confirm from the operator.
const DESTRUCTIVE = new Set([
  "delete_pppoe", "disconnect_pppoe", "disable_pppoe",
  "delete_hotspot_user", "disconnect_hotspot", "disable_hotspot_user",
]);

// Maps a validated action to a MikroTik client call. Keep in sync with ai.js.
function execute(action, p) {
  switch (action) {
    case "list_pppoe": return mt.listPppoe();
    case "list_pppoe_active": return mt.listPppoeActive();
    case "create_pppoe": return mt.createPppoe(p);
    case "enable_pppoe": return mt.setPppoeDisabled(p.name, false);
    case "disable_pppoe": return mt.setPppoeDisabled(p.name, true);
    case "delete_pppoe": return mt.deletePppoe(p.name);
    case "disconnect_pppoe": return mt.disconnectPppoe(p.name);
    case "list_hotspot_users": return mt.listHotspotUsers();
    case "list_hotspot_active": return mt.listHotspotActive();
    case "create_hotspot_user": return mt.createHotspotUser(p);
    case "enable_hotspot_user": return mt.setHotspotUserDisabled(p.name, false);
    case "disable_hotspot_user": return mt.setHotspotUserDisabled(p.name, true);
    case "delete_hotspot_user": return mt.deleteHotspotUser(p.name);
    case "disconnect_hotspot": return mt.disconnectHotspot(p.user);
    case "list_hotspot_profiles": return mt.hotspotUserProfiles();
    case "create_hotspot_profile": return mt.createHotspotProfile(p);
    case "list_pppoe_profiles": return mt.pppProfiles();
    case "sync_config": return mt.snapshot();
    case "system_resource": return mt.systemResource();
    case "interface_traffic": return mt.interfaces();
    default: throw new Error(`Unhandled action: ${action}`);
  }
}

// GET routes -> data producers
const GET_ROUTES = {
  "/api/status": async () => ({ resource: await mt.systemResource(), identity: await mt.identity() }),
  "/api/interfaces": () => mt.interfaces(),
  "/api/pppoe": () => mt.listPppoe(),
  "/api/pppoe/active": () => mt.listPppoeActive(),
  "/api/pppoe/profiles": () => mt.pppProfiles(),
  "/api/hotspot/users": () => mt.listHotspotUsers(),
  "/api/hotspot/active": () => mt.listHotspotActive(),
  "/api/hotspot/profiles": () => mt.hotspotUserProfiles(),
  "/api/hotspot/servers": () => mt.hotspotServers(),
  "/api/hotspot/bindings": () => mt.hotspotIpBindings(),
  "/api/hotspot/coins/today": () => Coins.today(),
  "/api/hotspot/events/recent": () => HotspotEvents.recent(40),
  "/api/hotspot/vendo": () => VendoSales.summary(),
  "/api/hotspot/vendo/recent": () => VendoSales.recent(80),
  "/api/hotspot/new-users": () => NewUsers.recent(20),
  "/api/users/status": () => usersStatus(),
  "/api/router/logs": async () => (await mt.systemLogs() || []).slice(-150).reverse(),
  "/api/router/scripts": () => mt.scripts(),
  "/api/router/schedulers": () => mt.schedulers(),
  "/api/router/vendo-sales": () => vendoScriptSales(),
  "/api/router/netsetup": async () => {
    const safe = async (fn) => { try { return (await fn()) || []; } catch { return []; } };
    const [ifaces, vlans, addrs, pools, dhcp, hs, hsprof] = await Promise.all([
      safe(() => mt.interfaces()), safe(() => mt.vlans()), safe(() => mt.ipAddresses()),
      safe(() => mt.pools()), safe(() => mt.dhcpServers()), safe(() => mt.hotspotServers()), safe(() => mt.hotspotServerProfiles()),
    ]);
    return {
      interfaces: ifaces.map((i) => ({ id: i[".id"], name: i.name, type: i.type || "", running: i.running === "true" })),
      vlans: vlans.map((v) => ({ id: v[".id"], name: v.name, vlanId: v["vlan-id"], interface: v.interface, comment: v.comment || "" })),
      addresses: addrs.map((a) => ({ id: a[".id"], address: a.address, interface: a.interface, network: a.network || "" })),
      pools: pools.map((p) => ({ id: p[".id"], name: p.name, ranges: p.ranges })),
      dhcp: dhcp.map((d) => ({ id: d[".id"], name: d.name, interface: d.interface, pool: d["address-pool"], disabled: d.disabled === "true" })),
      hotspots: hs.map((h) => ({ id: h[".id"], name: h.name, interface: h.interface, pool: h["address-pool"] || "", profile: h.profile || "", addressesPerMac: h["addresses-per-mac"] || "", disabled: h.disabled === "true" })),
      profiles: hsprof.map((p) => ({ id: p[".id"], name: p.name, hotspotAddress: p["hotspot-address"] || "", dnsName: p["dns-name"] || "", loginBy: p["login-by"] || "" })),
    };
  },
  "/api/router/address-lists": async () => {
    let lists = [];
    try { lists = (await mt.firewallAddressLists()) || []; } catch {}
    const names = [...new Set(lists.map((x) => x.list).filter(Boolean))].sort();
    return names;
  },
  "/api/router/leases": async () => {
    const leases = (await mt.dhcpLeases()) || [];
    let bound = [];
    try { bound = (await mt.hotspotIpBindings()) || []; } catch {}
    const boundMacs = new Set(bound.map((x) => String(x["mac-address"] || "").toUpperCase()));
    return leases.map((l) => ({
      id: l[".id"], address: l.address || l["active-address"] || "", mac: l["mac-address"] || l["active-mac-address"] || "",
      server: l.server || "", host: l["host-name"] || l["active-host-name"] || "", status: l.status || "",
      dynamic: String(l.dynamic) !== "false", lists: l["address-lists"] || "", comment: l.comment || "",
      nodemcu: /^(esp|wiznet|nodemcu)/i.test(String(l["host-name"] || l["active-host-name"] || "")),
      bound: boundMacs.has(String(l["mac-address"] || l["active-mac-address"] || "").toUpperCase()),
    }));
  },
  "/api/router/watchdog": async () => {
    const offline = ClientStatus.all().filter((c) => !c.online && c.last_seen).sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen))).slice(0, 30);
    return { up: WD.up, online: WD.online, baseline: WD.baseline, massAlert: WD.massAlert, lastCheck: WD.lastCheck, downSince: WD.downSince, events: WD.events.slice(0, 12), offline };
  },
  "/api/router/usage": async () => {
    const q = await mt.queues().catch(() => []);
    const customers = Customers.list();
    const capByUser = new Map(customers.map((c) => [String(c.username || "").toLowerCase(), Number(c.plan_cap) || 0]));
    const parsed = parseQueues(q, customers);
    const period = new Date().toISOString().slice(0, 7);
    parsed.rows = parsed.rows.map((r) => {
      const key = String(r.name || "").toLowerCase();
      const u = Usage.forKey(key, period);
      const mtdUp = u ? Number(u.up) : 0, mtdDown = u ? Number(u.down) : 0;
      const capGb = capByUser.get(key) || 0;
      const mtd = mtdUp + mtdDown;
      return { ...r, mtdUp, mtdDown, mtd, capGb, overCap: capGb > 0 && mtd / 1073741824 >= capGb };
    });
    return parsed;
  },
  "/api/router/clock": async () => { const c = await mt.clock().catch(() => null); return { router: c, today: await routerToday(), server: new Date().toISOString() }; },
  "/api/router/test": async () => {
    const c = mtConfig();
    if (!c.host) return { connected: false, error: "No MikroTik IP set. Enter it in Settings → MikroTik access." };
    try {
      // One probe. If identity() succeeds the connection + login + API all work.
      const id = await mt.identity();
      const clk = await mt.clock().catch(() => null); // clock is optional; identity already proved the link
      return { connected: true, host: c.host, port: c.port, identity: id, clock: clk };
    } catch (e) {
      return { connected: false, host: c.host, port: c.port, error: e.message };
    }
  },
  "/api/router/coin-logs": () => scanCoinLogs(true),
  "/api/router/coin-logs/preview": () => scanCoinLogs(false),
  "/api/router/ipoe-redirect-diag": async () => {
    // Diagnose the IPoE captive-redirect path. Reads router state + checks each piece.
    const out = { steps: [] };
    const add = (name, ok, detail) => out.steps.push({ name, ok, detail });
    try { const id = await mt.identity(); add("connection", true, "connected to " + (id || "router")); }
    catch (e) { add("connection", false, e.message); return out; }
    // web proxy enabled?
    try { const p = await mt.print("/ip/proxy"); const row = (p || [])[0] || {}; add("web-proxy", String(row.enabled) === "true", "enabled=" + row.enabled + (row.port ? " port=" + row.port : "")); }
    catch (e) { add("web-proxy", false, "can't read /ip/proxy: " + e.message); }
    // existing proxy access rules
    try { const a = await mt.print("/ip/proxy/access"); add("proxy-access-rules", true, (a || []).length + " rule(s)"); }
    catch (e) { add("proxy-access-rules", false, e.message); }
    // dstnat rules count
    try { const n = await mt.print("/ip/firewall/nat", { "?chain": "dstnat" }); add("dstnat-rules", true, (n || []).length + " dstnat rule(s)"); }
    catch (e) { add("dstnat-rules", false, e.message); }
    // suspended address-list members
    try { const l = await mt.print("/ip/firewall/address-list", { "?list": IPOE_SUSPEND_LIST }); add("suspended-list", true, (l || []).length + " IP(s) on '" + IPOE_SUSPEND_LIST + "'"); }
    catch (e) { add("suspended-list", false, e.message); }
    // can we WRITE? add a harmless test address-list entry then remove it
    try {
      await mt.addrListAdd(IPOE_SUSPEND_LIST + "-test", "1.2.3.4", "diag test");
      await mt.addrListRemove(IPOE_SUSPEND_LIST + "-test", "1.2.3.4");
      add("write-permission", true, "API user can add/remove firewall entries");
    } catch (e) { add("write-permission", false, "API user CANNOT write: " + e.message); }
    // public url set?
    const pu = (Settings.get("public_url") || "").trim();
    add("public-url", !!pu, pu || "NOT SET — redirects are skipped without this");
    return out;
  },
};

// Parse per-vendo sales from the JuanFi/Arts system scripts.
// Scripts are named "<vendo> Daily" / "<vendo> Weekly" / "<vendo> Monthly"
// and their source holds the peso total for that period.
async function vendoScriptSales() {
  const scripts = (await mt.scripts()) || [];
  const periodRe = /^(.*\S)\s+(daily|weekly|monthly)$/i;
  const map = {};
  for (const s of scripts) {
    const name = (s.name || "").trim();
    const m = name.match(periodRe);
    if (!m) continue;
    const vendo = m[1].trim();
    const period = m[2].toLowerCase();
    const raw = (s.source == null ? "" : String(s.source)).trim();
    if (!/^\d+(\.\d+)?$/.test(raw)) continue;           // source must be a plain number
    const amt = Number(raw);
    (map[vendo] = map[vendo] || { vendo, daily: 0, weekly: 0, monthly: 0 })[period] = amt;
  }
  return Object.values(map).sort((a, b) => b.monthly - a.monthly || b.daily - a.daily);
}

// Read the router log, parse coin drops, and (optionally) record new ones.
async function scanCoinLogs(record) {
  const logs = (await mt.systemLogs()) || [];
  const vendoNames = Vendos.list().map((v) => v.name);

  // Best-effort MAC -> device name map (DHCP lease host-name, then hotspot host).
  const macMap = {};
  try {
    const leases = (mt.dhcpLeases ? await mt.dhcpLeases() : []) || [];
    for (const l of leases) {
      const m = (l["mac-address"] || "").toUpperCase();
      const nm = l["host-name"] || l.comment || "";
      if (m && nm) macMap[m] = nm;
    }
  } catch {}
  try {
    const hosts = (mt.hotspotHosts ? await mt.hotspotHosts() : []) || [];
    for (const h of hosts) {
      const m = (h["mac-address"] || "").toUpperCase();
      const nm = h["host-name"] || h.comment || "";
      if (m && nm && !macMap[m]) macMap[m] = nm;
    }
  } catch {}

  const found = [];
  let recorded = 0;
  for (const entry of logs) {
    const c = parseCoinLog(entry, vendoNames);
    if (!c) continue;
    if (!c.device && c.mac && macMap[c.mac]) c.device = macMap[c.mac];
    let isNew = false;
    if (record) {
      isNew = CoinLog.markNew(coinSig(entry));
      if (isNew) {
        HotspotEvents.add({ type: "coin", user: c.user, amount: c.amount, mac: c.mac, ip: c.ip || "", vendo: c.vendo, device: c.device, detail: c.message });
        recorded++;
      }
    }
    found.push({ ...c, recorded: isNew });
  }
  found.reverse(); // newest first for display
  return { recorded, count: found.length, events: found.slice(0, 100) };
}

// Combined active/inactive view for PPPoE and hotspot (+ hotspot remaining time).
async function usersStatus() {
  const [pppSec, pppAct, hsUsers, hsAct] = await Promise.all([
    mt.listPppoe(), mt.listPppoeActive(), mt.listHotspotUsers(), mt.listHotspotActive(),
  ]);
  const onPpp = new Set((pppAct || []).map((a) => a.name));
  const onHs = new Set((hsAct || []).map((a) => a.user));
  const pppoe = (pppSec || []).map((s) => ({
    name: s.name, profile: s.profile || "default",
    disabled: s.disabled === "true" || s.disabled === true,
    online: onPpp.has(s.name),
  }));
  const hotspot = (hsUsers || []).map((u) => ({
    name: u.name, profile: u.profile || "default",
    disabled: u.disabled === "true" || u.disabled === true,
    online: onHs.has(u.name),
    limitUptime: u["limit-uptime"] || "",
    uptime: u.uptime || "",
  }));
  return { pppoe, hotspot, pppoeOnline: onPpp.size, hotspotOnline: onHs.size };
}

function send(res, code, payload) {
  const isHtml = typeof payload === "string";
  res.writeHead(code, {
    "Content-Type": isHtml ? "text/html; charset=utf-8" : "application/json",
    // Security headers
    "X-Content-Type-Options": "nosniff",         // stop MIME-sniffing
    "X-Frame-Options": "SAMEORIGIN",             // block clickjacking (no embedding in iframes)
    "Referrer-Policy": "same-origin",            // don't leak URLs to third parties
    "X-XSS-Protection": "0",                     // rely on CSP-era browser defaults
  });
  res.end(isHtml ? payload : JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

// Reads the dashboard HTML. Works both unpackaged and inside a pkg snapshot
// (public/** is bundled as an asset — see package.json "pkg.assets").
// ---- PWA helpers: service worker + generated icon ----
function serviceWorkerJs() {
  // Minimal, network-first service worker. Its only real job is to make the app
  // "installable" (and not break offline). We don't aggressively cache the app shell
  // because the panel must always reflect live data; we just pass through to network.
  return `const CACHE = "ops-shell-v1";
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (e) => {
  // network-first; if offline, try cache (only static icons/manifest get cached)
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (/\\/(icon-\\d+\\.png|manifest|pay-manifest|apply-manifest)\\b/.test(url.pathname) || url.pathname.endsWith(".webmanifest")) {
    e.respondWith(
      caches.open(CACHE).then((c) => c.match(e.request).then((hit) =>
        hit || fetch(e.request).then((res) => { c.put(e.request, res.clone()); return res; })
      ))
    );
  }
});`;
}

// CRC + PNG chunk helpers (zero-dependency PNG writer)
function pwaIconPng(size) {
  // Build an RGBA bitmap: brand-blue rounded square with white signal bars.
  const S = size, bg = [12, 19, 34], panel = [47, 107, 255], white = [233, 238, 248];
  const buf = Buffer.alloc(S * S * 4);
  const set = (x, y, c, a = 255) => { if (x < 0 || y < 0 || x >= S || y >= S) return; const i = (y * S + x) * 4; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = a; };
  const r = Math.round(S * 0.20); // corner radius
  const inCard = (x, y) => {
    // rounded-rect mask covering most of the icon
    const m = Math.round(S * 0.06);
    const x0 = m, y0 = m, x1 = S - m, y1 = S - m;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const corners = [[x0 + r, y0 + r], [x1 - r, y0 + r], [x0 + r, y1 - r], [x1 - r, y1 - r]];
    if ((x < x0 + r || x > x1 - r) && (y < y0 + r || y > y1 - r)) {
      for (const [cx, cy] of corners) { if (Math.hypot(x - cx, y - cy) <= r) return true; }
      return false;
    }
    return true;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (inCard(x, y)) set(x, y, panel); else set(x, y, bg);
  }
  // draw 3 ascending "signal" bars in white, centered
  const baseY = Math.round(S * 0.70), bw = Math.round(S * 0.11), gap = Math.round(S * 0.07);
  const heights = [0.16, 0.27, 0.40];
  let bx = Math.round(S / 2 - (bw * 1.5 + gap));
  for (let b = 0; b < 3; b++) {
    const h = Math.round(S * heights[b]);
    for (let y = baseY - h; y <= baseY; y++) for (let x = bx; x < bx + bw; x++) set(x, y, white);
    bx += bw + gap;
  }
  return encodePng(S, S, buf);
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, y * w * 4 + w * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
let _crcTable;
function crc32(buf) {
  if (!_crcTable) { _crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _crcTable[n] = c >>> 0; } }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = _crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function indexHtml() {
  return fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
}

const requestHandler = async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    // ---- LICENSE GATE (hard lock) ----
    // If the license is invalid, every route serves the license page (so the operator can
    // see their Machine ID and paste a key) and a tiny API to submit a key. Nothing else runs.
    if (!LICENSE_OK) {
      if (pathname === "/api/license/info" && req.method === "GET") {
        return send(res, 200, { ok: true, machineId: License.machineId(), fingerprint: License.machineFingerprint(), reason: LICENSE_STATE.reason || "no-license" });
      }
      if (pathname === "/api/license/activate" && req.method === "POST") {
        const b = JSON.parse((await readBody(req)) || "{}");
        try {
          const obj = JSON.parse(License.decodeKey(b.key || ""));
          const r = License.verifyLicense(obj);
          if (!r.ok) return send(res, 400, { ok: false, error: licenseReasonText(r.reason) });
          fs.writeFileSync(path.join(APP_DIR, "license.key"), String(b.key).trim());
          refreshLicense();
          return send(res, 200, { ok: true, message: "License accepted. Restarting checks…", license: r.license });
        } catch (e) { return send(res, 400, { ok: false, error: "That doesn't look like a valid license key." }); }
      }
      // everything else → the activation page
      return send(res, 200, licensePageHtml());
    }

    if (req.method === "GET" && pathname === "/") {
      return send(res, 200, indexHtml());
    }

    // ---- PWA: manifest, service worker, icons (installable web app) ----
    if (req.method === "GET" && pathname === "/manifest.webmanifest") {
      const biz = Settings.get("biz_name", "Network Ops");
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      return res.end(JSON.stringify({
        name: biz + " — Ops Panel", short_name: biz.slice(0, 12) || "Ops",
        start_url: "/", scope: "/", display: "standalone",
        background_color: "#0c1322", theme_color: "#0c1322",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      }));
    }
    // Customer-facing manifest (scoped to /pay so the installed app opens the pay page)
    if (req.method === "GET" && pathname === "/pay-manifest.webmanifest") {
      const biz = Settings.get("biz_name", "Internet");
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      return res.end(JSON.stringify({
        name: biz + " — Pay", short_name: "Pay", start_url: "/pay", scope: "/pay", display: "standalone",
        background_color: "#0c1322", theme_color: "#0c1322",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
                { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }],
      }));
    }
    if (req.method === "GET" && pathname === "/apply-manifest.webmanifest") {
      const biz = Settings.get("biz_name", "Internet");
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      return res.end(JSON.stringify({
        name: biz + " — Apply", short_name: "Apply", start_url: "/apply", scope: "/apply", display: "standalone",
        background_color: "#0c1322", theme_color: "#0c1322",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
                { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }],
      }));
    }
    if (req.method === "GET" && pathname === "/sw.js") {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-cache" });
      return res.end(serviceWorkerJs());
    }
    if (req.method === "GET" && (pathname === "/icon-192.png" || pathname === "/icon-512.png")) {
      const size = pathname.includes("512") ? 512 : 192;
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      return res.end(pwaIconPng(size));
    }

    if (req.method === "GET" && pathname === "/api/hotspot/event") {
      // Webhook called by MikroTik /tool fetch. e.g. ...?type=login&user=bob
      const p = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
      HotspotEvents.add({ type: p.type, user: p.user, amount: p.amount, mac: p.mac, ip: p.ip, detail: p.detail, vendo: p.vendo });
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }

    // PayMongo webhook (public; PayMongo posts here — verified by signature, not session)
    if (pathname === "/api/billing/paymongo/webhook" && req.method === "POST") {
      const raw = (await readBody(req)) || "";
      const secret = Settings.get("paymongo_webhook_secret");
      if (!secret) { res.writeHead(503); return res.end("webhook secret not configured"); }
      if (!pmVerify(raw, req.headers["paymongo-signature"], secret)) { res.writeHead(401); return res.end("bad signature"); }
      let json = null; try { json = JSON.parse(raw); } catch {}
      const ev = pmParse(json);
      if (ev && /paid$/.test(ev.type || "")) {
        let inv = ev.resourceId ? Invoices.byLink(ev.resourceId) : null;
        if (!inv && ev.remarks) { const mm2 = String(ev.remarks).match(/INV-(\d+)/); if (mm2) inv = Invoices.get(Number(mm2[1])); }
        if (inv && inv.status !== "paid") {
          Invoices.pay(inv.id, { method: "gcash", reference: ev.resourceId || "paymongo", note: "PayMongo online payment" });
          Audit.add({ type: "auto", customer_id: inv.customer_id, customer_name: inv.customer_name, action: "invoice-paid-online", detail: ev.resourceId || "", ok: true });
          // auto-reconnect: if the customer was suspended, re-enable them on the router
          try {
            const cust = Customers.get(inv.customer_id);
            if (cust && cust.status === "suspended") {
              await customerAction(cust.id, "enable");
              Audit.add({ type: "auto", customer_id: cust.id, customer_name: cust.name, action: "auto-reconnect", detail: "after online payment", ok: true });
            }
          } catch (e) {
            Audit.add({ type: "auto", customer_id: inv.customer_id, action: "auto-reconnect-failed", detail: e.message, ok: false });
          }
        }
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }

    // ---- Public client hub (big buttons: Apply / Pay / Helpdesk) ----
    if ((pathname === "/welcome" || pathname === "/home") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(welcomePageHtml());
    }

    // ---- Public customer "pay your bill" page + API (no login) ----
    if (pathname === "/portal" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(portalPageHtml());
    }
    if (pathname === "/api/portal/login" && req.method === "POST") {
      let b2 = {}; try { b2 = JSON.parse((await readBody(req)) || "{}"); } catch {}
      const u = String(b2.username || "").trim(), pw = String(b2.password || "");
      const cust = Customers.byUsername(u);
      if (!cust || !u) return send(res, 401, { ok: false, error: "Account not found. Check your username." });
      if (!cust.password) return send(res, 401, { ok: false, error: "This account has no portal password yet. Please contact us to set one." });
      if (cust.password !== pw) return send(res, 401, { ok: false, error: "Wrong password." });
      const token = CSessions.create(cust.id);
      res.setHeader("Set-Cookie", `csid=${token}; HttpOnly; Path=/; Max-Age=${7 * 86400}; SameSite=Lax`);
      Audit.add({ type: "auto", customer_id: cust.id, customer_name: cust.name, action: "portal-login", detail: u, ok: true });
      return send(res, 200, { ok: true });
    }
    if (pathname === "/api/portal/logout" && req.method === "POST") {
      const tok = (req.headers.cookie || "").split(/;\s*/).find((x) => x.startsWith("csid="));
      if (tok) CSessions.destroy(tok.slice(5));
      res.setHeader("Set-Cookie", "csid=; HttpOnly; Path=/; Max-Age=0");
      return send(res, 200, { ok: true });
    }
    if (pathname === "/api/portal/me" && req.method === "GET") {
      const tok = (req.headers.cookie || "").split(/;\s*/).find((x) => x.startsWith("csid="));
      const sess = CSessions.get(tok ? tok.slice(5) : "");
      if (!sess) return send(res, 401, { ok: false, error: "not logged in" });
      const c = Customers.get(sess.customer_id);
      if (!c) return send(res, 401, { ok: false, error: "account missing" });
      const s = Settings.all();
      const pay = { gcash_name: s.gcash_name || "", gcash_number: s.gcash_number || "", gcash_qr: s.gcash_qr || "", maya_name: s.maya_name || "", maya_number: s.maya_number || "", bank_details: s.bank_details || "" };
      const invoices = Invoices.byCustomer(c.id).filter((i) => i.status !== "paid");
      const payments = Payments.byCustomer(c.id).slice(0, 12);
      let usage = null;
      try { const uk = Usage.forKey(String(c.username || "").toLowerCase()); if (uk) usage = { up: uk.up, down: uk.down, capGb: Number(c.plan_cap) || 0 }; } catch {}
      const lastProof = Proofs.latestForUser(c.username);
      return send(res, 200, { ok: true, biz: s.biz_name || "Internet Service", logo: s.brand_logo || "",
        customer: { name: c.name, username: c.username, status: c.status, expiry: c.expiry || "", plan_name: c.plan_name || "", area: c.area || "" },
        invoices, payments, usage, pay, lastProof: lastProof ? { status: lastProof.status, reason: lastProof.reject_reason || "" } : null });
    }
    if (pathname === "/pay" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(payPageHtml());
    }
    if (pathname === "/apply" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(applyPageHtml());
    }
    if (pathname === "/api/apply/info" && req.method === "GET") {
      const biz = Settings.get("biz_name", "Internet Service");
      const logo = Settings.get("brand_logo", "");
      const s = Settings.all();
      const pay = { gcash_name: s.gcash_name || "", gcash_number: s.gcash_number || "", gcash_qr: s.gcash_qr || "",
        maya_name: s.maya_name || "", maya_number: s.maya_number || "", maya_qr: s.maya_qr || "" };
      const fee = Number(s.install_fee || 0), router = Number(s.router_cost || 0);
      // public can see active plans (name/price/speed/type)
      const plans = Plans.list().map((p) => ({ id: p.id, name: p.name, price: p.price, speed: p.speed || "", type: p.type || "pppoe", days: p.validity_days }));
      const agreement = s.apply_agreement || "I confirm the information above is correct. I understand the installation fee and equipment cost, and agree to the service terms. A technician will contact me to schedule the installation.";
      return send(res, 200, { ok: true, biz, logo, pay, install_fee: fee, router_cost: router, plans, agreement });
    }
    if (pathname === "/api/apply" && req.method === "POST") {
      const raw = (await readBody(req)) || "";
      if (raw.length > 8_000_000) return send(res, 413, { ok: false, error: "Image too large (max ~6MB)." });
      const b = JSON.parse(raw || "{}");
      if (!b.name || !String(b.name).trim()) return send(res, 400, { ok: false, error: "Please enter your name." });
      if (!b.contact || !String(b.contact).trim()) return send(res, 400, { ok: false, error: "Please enter a contact number." });
      if (!b.agreed) return send(res, 400, { ok: false, error: "Please read and tick the agreement to continue." });
      const s = Settings.all();
      const jo = JobOrders.apply({
        name: b.name, contact: b.contact, email: b.email, address: b.address, area: b.area,
        lat: b.lat, lng: b.lng, plan_id: b.plan_id || null, conn_type: b.conn_type || "pppoe", notes: b.notes,
        install_fee: Number(s.install_fee || 0), router_cost: Number(s.router_cost || 0),
        pay_choice: b.pay_choice === "now" ? "now" : "on_install",
        pay_reference: b.pay_reference || "", pay_proof: b.pay_proof || "", agreed: 1,
      });
      Audit.add({ type: "auto", action: "job-application", detail: `${b.name} (${b.contact}) — ${b.pay_choice === "now" ? "pay now" : "pay on install"}`, ok: true });
      // notify operator via Telegram
      const c = tg(), chat = tgChat();
      if (c && chat) { try { await c.sendMessage(chat, `📋 <b>NEW INSTALL APPLICATION</b>\n${escapeHtml(b.name)} · ${escapeHtml(b.contact)}\n${escapeHtml(b.address || "")}\nPayment: ${b.pay_choice === "now" ? "paying now (verify proof)" : "on install day"}\nOpen Job Orders to review.`); } catch {} }
      return send(res, 200, { ok: true, id: jo.id, message: "Thank you! Your application was received. We'll contact you shortly to schedule your installation." });
    }
    if (pathname === "/api/branding" && req.method === "GET") {
      const s = Settings.all();
      return send(res, 200, { ok: true, data: { biz_name: s.biz_name || "", brand_logo: s.brand_logo || "" } });
    }
    if (pathname === "/api/pay/lookup" && req.method === "GET") {
      const u = (new URL(req.url, "http://localhost").searchParams.get("u") || "").trim().toLowerCase();
      const biz = Settings.get("biz_name", "Internet Service");
      const logo = Settings.get("brand_logo", "");
      const s = Settings.all();
      const pay = { gcash_name: s.gcash_name || "", gcash_number: s.gcash_number || "", gcash_qr: s.gcash_qr || "",
        maya_name: s.maya_name || "", maya_number: s.maya_number || "", maya_qr: s.maya_qr || "", bank_details: s.bank_details || "" };
      // Match by username (PPPoE) OR by account id / MAC / static IP (IPoE) OR by contact number.
      const norm = (x) => String(x || "").toLowerCase().replace(/[\s:-]/g, "");
      const all = Customers.list();
      const cust = u ? all.find((c) =>
        (c.username || "").toLowerCase() === u ||
        (c.account_code || "").toLowerCase() === u ||
        ("ipoe-" + (c.username || "")).toLowerCase() === u ||
        ("ipoe-" + String(c.id).padStart(4, "0")).toLowerCase() === u ||
        norm(c.mac) === norm(u) ||
        (c.static_ip || "") === u ||
        norm(c.contact) === norm(u)
      ) : null;
      if (!cust) return send(res, 200, { ok: true, biz, logo, pay, customer: null, invoices: [] });
      const invoices = Invoices.list({ customer_id: cust.id, status: "unpaid" })
        .map((i) => ({ id: i.id, period: i.period, amount: i.amount, due_date: i.due_date }));
      const lp = Proofs.latestForUser(cust.username);
      const lastPay = Payments.lastForCustomer ? Payments.lastForCustomer(cust.id) : null;
      const acct = cust.account_code || ("IPOE-" + String(cust.id).padStart(4, "0"));
      return send(res, 200, { ok: true, biz, logo, pay,
        customer: {
          id: cust.id, name: cust.name, status: cust.status, expiry: cust.expiry || "",
          conn_type: cust.conn_type || "pppoe", account: cust.account_code || ((cust.conn_type === "ipoe") ? acct : (cust.username || acct)),
          plan_name: cust.plan_name || "", plan_price: cust.plan_price || 0, plan_speed: cust.plan_speed || "",
          plan_days: cust.plan_days || 0, billing_day: cust.billing_day || 1,
          wallet: Number(cust.credit) || 0,
          last_payment: lastPay ? String(lastPay.paid_at || "").slice(0, 10) : "",
        },
        invoices,
        lastProof: lp ? { status: lp.status, reason: lp.reject_reason || "" } : null });
    }
    if (pathname === "/api/pay/plans" && req.method === "GET") {
      // plans the customer can renew/switch to (optionally filter by their conn type)
      const ct = (new URL(req.url, "http://localhost").searchParams.get("type") || "").trim();
      let plans = Plans.list();
      if (ct) plans = plans.filter((p) => (p.type || "pppoe") === ct || (p.type || "") === "");
      return send(res, 200, { ok: true, plans: plans.map((p) => ({ id: p.id, name: p.name, price: p.price, speed: p.speed || "", days: p.validity_days, type: p.type || "pppoe" })) });
    }
    if (pathname === "/api/pay/link" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const inv = Invoices.get(Number(b.invoice_id));
      if (!inv || inv.status === "paid") return send(res, 400, { ok: false, error: "invoice not payable" });
      if (inv.payment_url) return send(res, 200, { ok: true, url: inv.payment_url }); // reuse existing link
      const s = Settings.all();
      if (!s.paymongo_secret) return send(res, 400, { ok: false, error: "Online payment isn't set up — please pay at the counter." });
      try {
        const link = await pmCreateLink({ secret: s.paymongo_secret, baseUrl: s.paymongo_base || undefined },
          { amountPhp: inv.amount, description: `${s.biz_name || "Internet"} ${inv.period} — ${inv.customer_name}`, remarks: `INV-${inv.id}` });
        Invoices.setLink(inv.id, link.id, link.checkout_url || "");
        return send(res, 200, { ok: true, url: link.checkout_url });
      } catch (e) {
        return send(res, 500, { ok: false, error: "Could not create payment link: " + e.message });
      }
    }

    // Customer uploads proof of payment -> store + notify operator's Telegram (approve there)
    if (pathname === "/api/pay/proof" && req.method === "POST") {
      const raw = (await readBody(req)) || "";
      if (raw.length > 8_000_000) return send(res, 413, { ok: false, error: "Image too large (max ~6MB)." });
      const b = JSON.parse(raw || "{}");
      const u = (b.username || "").trim().toLowerCase();
      const cust = u ? Customers.list().find((c) => (c.username || "").toLowerCase() === u) : (b.customer_id ? Customers.get(b.customer_id) : null);
      let inv = b.invoice_id ? Invoices.get(Number(b.invoice_id)) : null;
      if (!inv && cust) inv = (Invoices.list({ customer_id: cust.id, status: "unpaid" })[0]) || null;
      if (!b.image) return send(res, 400, { ok: false, error: "Please attach a photo of your receipt." });
      // ---- anti-fraud screening (flags only; reused references are blocked) ----
      const screen = screenProof({ reference: b.reference || "", image: b.image, priorRefs: Proofs.allRefs(), customerId: cust ? cust.id : null });
      if (screen.severity === "block") {
        const blockMsg = screen.flags.find((f) => f.level === "block");
        return send(res, 409, { ok: false, error: (blockMsg ? blockMsg.msg : "This receipt cannot be accepted.") + " If you think this is a mistake, please contact us." });
      }
      // ---- SMS auto-match: did a matching GCash/Maya text already arrive on our SIM? ----
      let smsMatch = null;
      try {
        const hit = Sms.findPayment(b.reference || "", inv ? inv.amount : 0);
        if (hit) {
          const amtOk = !inv || Math.abs(Number(hit.amount) - Number(inv.amount)) < 0.01 || !hit.amount;
          smsMatch = { ok: true, amount: hit.amount, reference: hit.reference, by: hit.reference && String(hit.reference).replace(/\s+/g, "") === String(b.reference || "").replace(/\s+/g, "") ? "reference" : "amount", amountOk: amtOk };
          screen.flags.push(amtOk
            ? { code: "sms-confirmed", level: "ok", msg: `✓ Confirmed by ${String(hit.name || "GCash")} SMS on your SIM (₱${Number(hit.amount || 0).toLocaleString()}${hit.reference ? ", ref " + hit.reference : ""}).` }
            : { code: "sms-amount-mismatch", level: "warn", msg: `A GCash SMS with this reference arrived but for ₱${Number(hit.amount).toLocaleString()}, not ₱${Number(inv.amount).toLocaleString()} — verify.` });
        }
      } catch {}
      const proof = Proofs.add({ invoice_id: inv ? inv.id : null, customer_id: cust ? cust.id : null, username: b.username || (cust && cust.username) || "", image: b.image, note: b.note || "", reference: b.reference || "", amount: inv ? inv.amount : 0, flags: JSON.stringify(screen.flags || []) });
      // Auto-approve when an SMS confirmed the exact payment and the operator opted in.
      if (smsMatch && smsMatch.ok && smsMatch.amountOk && Settings.get("sms_autoapprove", "0") === "1" && inv && cust) {
        try {
          await applyApprovedProof(Proofs.get(proof.id), "sms-auto");
          Audit.add({ type: "auto", customer_id: cust.id, customer_name: cust.name, action: "proof-auto-approve", detail: `SMS-confirmed ₱${Number(smsMatch.amount || inv.amount).toLocaleString()}${smsMatch.reference ? " ref " + smsMatch.reference : ""}`, ok: true });
          const c2 = tg(), chat2 = tgChat();
          if (c2 && chat2) { try { await c2.sendMessage(chat2, `✅ <b>AUTO-APPROVED</b>\n${escapeHtml(cust.name)} — payment confirmed by SMS on your SIM (₱${Number(smsMatch.amount || inv.amount).toLocaleString()}${smsMatch.reference ? ", ref " + smsMatch.reference : ""}). Reconnected.`); } catch {} }
          return send(res, 200, { ok: true, message: "Confirmed! We matched your payment automatically and your connection is restored. Thank you!" });
        } catch (e) { Audit.add({ type: "auto", action: "proof-auto-approve", detail: "failed: " + e.message, ok: false }); }
      }
      const c = tg(), chat = tgChat();
      if (c && chat) {
        try {
          const { buffer } = dataUrlToBuffer(b.image);
          const caption = `🧾 <b>PAYMENT SUBMITTED</b>\nUser: <b>${proof.username || (cust && cust.name) || "unknown"}</b>\n` +
            (inv ? `Plan: ${inv.plan_name || "—"}\nAmount: ₱${Number(inv.amount).toLocaleString()}\nInvoice: INV-${inv.id} · ${inv.period}\n` : "") +
            (b.reference ? `Reference: <b>${b.reference}</b>\n` : "") +
            (b.note ? `Note: ${b.note}\n` : "") +
            (smsMatch && smsMatch.ok && smsMatch.amountOk ? `\n✅ <b>SMS-CONFIRMED</b> — matching ${escapeHtml(String(smsMatch.by))} found on your SIM.\n` : "") +
            (screen.flags && screen.flags.filter((f) => f.level !== "ok").length ? `\n⚠️ <b>Review flags:</b> ${screen.flags.filter((f) => f.level !== "ok").map((f) => escapeHtml(f.msg)).join("; ")}\n` : "") +
            `Approve to reconnect & extend.`;
          const kb = { inline_keyboard: [[{ text: "✅ APPROVE", callback_data: "approve:" + proof.id }, { text: "❌ REJECT", callback_data: "reject:" + proof.id }]] };
          const r = await c.sendPhoto(chat, buffer, caption, kb);
          if (r && r.json && r.json.ok) Proofs.setMsgId(proof.id, r.json.result.message_id);
        } catch (e) { Audit.add({ type: "auto", action: "telegram-error", detail: e.message, ok: false }); }
      }
      return send(res, 200, { ok: true, message: "Thank you! Your proof was sent for verification. Your connection will be restored once approved." });
    }

    // ---- Wallet top-up: customer adds credit. Instant if a matching GCash/Maya SMS is
    // already on our SIM; otherwise it becomes a proof the operator approves. ----
    if (pathname === "/api/pay/topup" && req.method === "POST") {
      const raw = (await readBody(req)) || "";
      if (raw.length > 8_000_000) return send(res, 413, { ok: false, error: "Image too large (max ~6MB)." });
      const b = JSON.parse(raw || "{}");
      const u = (b.account || b.username || "").trim().toLowerCase();
      const norm = (x) => String(x || "").toLowerCase().replace(/[\s:-]/g, "");
      const cust = u ? Customers.list().find((c) => (c.username || "").toLowerCase() === u || (c.account_code || "").toLowerCase() === u || ("ipoe-" + (c.username || "")).toLowerCase() === u || norm(c.mac) === norm(u) || ("ipoe-" + String(c.id).padStart(4, "0")).toLowerCase() === u) : (b.customer_id ? Customers.get(b.customer_id) : null);
      if (!cust) return send(res, 404, { ok: false, error: "Account not found." });
      const amt = Math.round(Number(b.amount) || 0);
      if (amt <= 0) return send(res, 400, { ok: false, error: "Enter the amount you topped up." });
      if (!b.image && !b.reference) return send(res, 400, { ok: false, error: "Attach a receipt photo or enter the reference number." });
      // duplicate-reference guard
      if (b.reference && Proofs.allRefs && Proofs.allRefs().includes(String(b.reference).replace(/\s+/g, ""))) {
        return send(res, 409, { ok: false, error: "This reference number was already used." });
      }
      // SMS auto-match?
      let matched = false, matchInfo = null;
      try {
        const hit = Sms.findPayment(b.reference || "", amt);
        if (hit) { const amtOk = !hit.amount || Math.abs(Number(hit.amount) - amt) < 0.01; if (amtOk) { matched = true; matchInfo = hit; } }
      } catch {}
      const autoOk = matched && Settings.get("sms_autoapprove", "0") === "1";
      // record a proof row either way (for audit + dup-ref tracking)
      const proof = Proofs.add({ invoice_id: null, customer_id: cust.id, username: cust.username || "", image: b.image || "", note: "WALLET TOPUP ₱" + amt + (b.note ? " — " + b.note : ""), reference: b.reference || "", amount: amt, flags: JSON.stringify(matched ? [{ code: "sms-confirmed", level: "ok", msg: "✓ Top-up matched a GCash/Maya SMS on your SIM." }] : []) });
      if (autoOk) {
        const bal = Customers.addCredit(cust.id, amt, "wallet top-up (SMS-confirmed" + (matchInfo && matchInfo.reference ? " ref " + matchInfo.reference : "") + ")");
        try { Proofs.setStatus(proof.id, "approved", "wallet top-up auto"); } catch {}
        Audit.add({ type: "auto", customer_id: cust.id, customer_name: cust.name, action: "wallet-topup", detail: `₱${amt} auto (SMS)`, ok: true });
        const c2 = tg(), chat2 = tgChat(); if (c2 && chat2) { try { await c2.sendMessage(chat2, `💰 <b>WALLET TOP-UP</b>\n${escapeHtml(cust.name)} +₱${amt} (SMS-confirmed). New balance: ₱${Number(bal).toLocaleString()}.`); } catch {} }
        return send(res, 200, { ok: true, instant: true, wallet: bal, message: `Confirmed! ₱${amt} added to your wallet. New balance: ₱${Number(bal).toLocaleString()}.` });
      }
      // else notify operator to approve
      const c = tg(), chat = tgChat();
      if (c && chat) { try {
        const cap = `💰 <b>WALLET TOP-UP</b> (verify)\n${escapeHtml(cust.name)} wants to add <b>₱${amt}</b>.${b.reference ? "\nRef: " + escapeHtml(b.reference) : ""}\nApprove to credit the wallet.`;
        const kb = { inline_keyboard: [[{ text: "✅ CREDIT ₱" + amt, callback_data: "topup:" + proof.id + ":" + amt }, { text: "❌ REJECT", callback_data: "reject:" + proof.id }]] };
        if (b.image) { const { buffer } = dataUrlToBuffer(b.image); const r = await c.sendPhoto(chat, buffer, cap, kb); if (r && r.json && r.json.ok) Proofs.setMsgId(proof.id, r.json.result.message_id); }
        else { await c.sendMessage(chat, cap, kb); }
      } catch (e) { Audit.add({ type: "auto", action: "telegram-error", detail: e.message, ok: false }); } }
      return send(res, 200, { ok: true, instant: false, message: "Thanks! Your top-up is pending verification. Your wallet will update once approved." });
    }

    // ---- Renew using wallet balance (customer-initiated) ----
    if (pathname === "/api/pay/renew-wallet" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const u = (b.account || b.username || "").trim().toLowerCase();
      const norm = (x) => String(x || "").toLowerCase().replace(/[\s:-]/g, "");
      const cust = u ? Customers.list().find((c) => (c.username || "").toLowerCase() === u || (c.account_code || "").toLowerCase() === u || ("ipoe-" + (c.username || "")).toLowerCase() === u || norm(c.mac) === norm(u) || ("ipoe-" + String(c.id).padStart(4, "0")).toLowerCase() === u) : null;
      if (!cust) return send(res, 404, { ok: false, error: "Account not found." });
      const fresh = Customers.get(cust.id);
      const price = Number(fresh.plan_price) || 0;
      const bal = Number(fresh.credit) || 0;
      if (price <= 0) return send(res, 400, { ok: false, error: "No plan price set on your account — please contact us." });
      if (bal < price) return send(res, 400, { ok: false, error: `Not enough wallet balance. Plan is ₱${price.toLocaleString()}, you have ₱${bal.toLocaleString()}. Please top up first.` });
      try {
        Customers.addCredit(cust.id, -price, "wallet renewal");
        const exp = await renewCustomer(fresh, fresh.plan_mins || 43200);
        Payments.record({ customer_id: cust.id, amount: price, method: "wallet", note: "self-renew from wallet" });
        Audit.add({ type: "auto", customer_id: cust.id, customer_name: cust.name, action: "wallet-renew", detail: `₱${price}, expiry ${exp}`, ok: true });
        return send(res, 200, { ok: true, message: `Renewed! ₱${price.toLocaleString()} used from your wallet. Active until ${String(exp).slice(0, 10)}.`, wallet: bal - price, expiry: exp });
      } catch (e) {
        Customers.addCredit(cust.id, price, "no-income: refund — wallet renewal failed"); // refund on failure (reverses the -price spend, not new cash)
        return send(res, 500, { ok: false, error: "Renewal failed on the router; your wallet was not charged. " + e.message });
      }
    }

    // Public helpdesk ticket submission (from the portal or /help)
    if (pathname === "/api/helpdesk" && req.method === "POST") {
      const raw = (await readBody(req)) || "";
      if (raw.length > 8_000_000) return send(res, 413, { ok: false, error: "Attachment too large (max ~6MB)." });
      const b = JSON.parse(raw || "{}");
      if (!b.message) return send(res, 400, { ok: false, error: "Please describe your issue." });
      const t = Tickets.add({ name: b.name, contact: b.contact, message: b.message, image: b.image || "", category: b.category || "" });
      const c = tg(), chat = tgChat();
      if (c && chat) {
        try {
          const cap = `🆘 <b>HELPDESK #${t.id}</b>${b.category ? " · " + b.category : ""}\nFrom: <b>${b.name || "—"}</b> ${b.contact ? "(" + b.contact + ")" : ""}\n${b.message}`;
          if (b.image) { const { buffer } = dataUrlToBuffer(b.image); await c.sendPhoto(chat, buffer, cap, null, "report.jpg"); }
          else await c.sendMessage(chat, cap);
        } catch (e) { Audit.add({ type: "auto", action: "telegram-error", detail: e.message, ok: false }); }
      }
      return send(res, 200, { ok: true, id: t.id, message: `Thanks! Your ticket number is #${t.id}. Save it to check the status later.` });
    }

    // Public: customer checks their ticket status / staff reply
    if (pathname === "/api/help/status" && req.method === "GET") {
      const sp = new URL(req.url, "http://localhost").searchParams;
      const id = Number(sp.get("id"));
      const q = (sp.get("q") || "").trim().toLowerCase();
      const t = id ? Tickets.statusView(id) : null;
      if (!t) return send(res, 200, { ok: true, ticket: null });
      // light privacy: if the ticket has a contact/name on file, require it to match
      const onfile = ((t.contact || "") + " " + (t.name || "")).toLowerCase();
      if ((t.contact || t.name) && q && !onfile.includes(q)) return send(res, 200, { ok: true, ticket: null });
      if ((t.contact || t.name) && !q) return send(res, 200, { ok: false, error: "Enter the name or contact you used, to view this ticket." });
      return send(res, 200, { ok: true, ticket: { id: t.id, category: t.category, message: t.message, status: t.status, reply: t.reply, reply_image: t.reply_image || "", created_at: t.created_at } });
    }

    // Public standalone helpdesk portal
    if (pathname === "/help" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(helpPageHtml());
    }

    const cookies = Auth.parseCookies(req);
    const user = Auth.sessionUser(cookies.sid);

    if (pathname === "/api/auth/login" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      // client IP — trust Cloudflare's header when behind the tunnel, else socket address
      const ip = (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "?";
      const r = Auth.login((b.username || "").trim(), b.password || "", ip);
      if (r && r.error === "locked") {
        const mins = Math.ceil((r.remainingMs || 0) / 60000);
        return send(res, 429, { ok: false, error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` });
      }
      if (!r) return send(res, 401, { ok: false, error: "Invalid username or password" });
      res.setHeader("Set-Cookie", `sid=${r.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200`);
      return send(res, 200, { ok: true, user: r.user });
    }
    if (pathname === "/api/license/status" && req.method === "GET") {
      // visible inside the unlocked app (Settings → License)
      const lic = LICENSE_STATE.license || {};
      let daysLeft = null;
      if (lic.expires) daysLeft = Math.ceil((new Date(lic.expires) - new Date()) / 86400000);
      return send(res, 200, { ok: true, data: {
        valid: LICENSE_OK, customer: lic.customer || "", model: lic.model || "",
        issued: lic.issued || "", expires: lic.expires || null, daysLeft,
        machineId: License.machineId(), reason: LICENSE_STATE.reason || "",
      } });
    }
    if (pathname === "/api/auth/me" && req.method === "GET") {
      const warn = (user && user.role === "admin") ? Auth.isDefaultAdminPassword() : false;
      return send(res, 200, { ok: true, user: user || null, defaultPassword: warn });
    }
    if (pathname === "/api/auth/logout" && req.method === "POST") {
      Auth.logout(cookies.sid);
      res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; Max-Age=0");
      return send(res, 200, { ok: true });
    }

    // ---- Gate: every other /api route requires a valid session ----
    if (pathname.startsWith("/api/") && !user) {
      return send(res, 401, { ok: false, needLogin: true, error: "login required" });
    }

    // Role helper: admin can do anything; others must be in the allowed list.
    const need = (...roles) => {
      if (!user) return false;
      if (user.role === "admin") return true;
      return roles.includes(user.role);
    };
    const denied = () => send(res, 403, { ok: false, error: "your role isn't allowed to do that" });

    // ---- Account management (admin only, except change-own-password) ----
    if (pathname === "/api/auth/users" && req.method === "GET") {
      if (!need()) return denied();
      return send(res, 200, { ok: true, data: Accounts.list() });
    }
    if (pathname === "/api/auth/users" && req.method === "POST") {
      if (!need()) return denied();
      const b = JSON.parse((await readBody(req)) || "{}");
      const username = (b.username || "").trim();
      if (!username || !b.password) return send(res, 400, { ok: false, error: "username and password required" });
      if (!Auth.ROLES.includes(b.role)) return send(res, 400, { ok: false, error: "invalid role" });
      if (Accounts.getByName(username)) return send(res, 400, { ok: false, error: "username already exists" });
      const { salt, hash } = Auth.hashPassword(b.password);
      const u = Accounts.create({ username, salt, hash, role: b.role });
      Audit.add({ type: "auth", action: "user-create", detail: `${username} (${b.role})`, ok: true });
      return send(res, 200, { ok: true, data: u });
    }
    let um;
    if ((um = pathname.match(/^\/api\/auth\/users\/(\d+)$/)) && req.method === "DELETE") {
      if (!need()) return denied();
      const id = Number(um[1]);
      if (user.id === id) return send(res, 400, { ok: false, error: "you can't delete your own account" });
      const delTarget = Accounts.getById(id);
      if (delTarget && delTarget.username === "admin") return send(res, 400, { ok: false, error: "The admin account can't be deleted." });
      Accounts.remove(id); Auth.dropSessionsForUser(id);
      Audit.add({ type: "auth", action: "user-delete", detail: String(id), ok: true });
      return send(res, 200, { ok: true });
    }
    if ((um = pathname.match(/^\/api\/auth\/users\/(\d+)\/role$/)) && req.method === "POST") {
      if (!need()) return denied();
      const b = JSON.parse((await readBody(req)) || "{}");
      if (!Auth.ROLES.includes(b.role)) return send(res, 400, { ok: false, error: "invalid role" });
      const id = Number(um[1]);
      // The built-in 'admin' account must always stay admin — never let it be demoted
      // (otherwise no one could configure the router/billing and you'd be locked out).
      const target = Accounts.getById(id);
      if (target && target.username === "admin" && b.role !== "admin") {
        return send(res, 400, { ok: false, error: "The admin account must stay admin." });
      }
      Accounts.setRole(id, b.role); Auth.refreshSessionsForUser(id, b.role);
      return send(res, 200, { ok: true });
    }
    if ((um = pathname.match(/^\/api\/auth\/users\/(\d+)\/edit$/)) && req.method === "POST") {
      if (!need()) return denied();
      const id = Number(um[1]);
      const target = Accounts.getById(id);
      if (!target) return send(res, 404, { ok: false, error: "user not found" });
      const b = JSON.parse((await readBody(req)) || "{}");
      const newName = (b.username || "").trim();
      if (newName && newName.toLowerCase() !== (target.username || "").toLowerCase()) {
        const clash = Accounts.getByName(newName);
        if (clash) return send(res, 400, { ok: false, error: "username already exists" });
        Accounts.setUsername(id, newName);
      }
      if (b.password) { if (String(b.password).length < 4) return send(res, 400, { ok: false, error: "password too short" }); const { salt, hash } = Auth.hashPassword(b.password); Accounts.setPassword(id, salt, hash); }
      Audit.add({ type: "auth", action: "user-edit", detail: newName || target.username, ok: true });
      return send(res, 200, { ok: true, data: Accounts.getById(id) });
    }
    if (pathname === "/api/auth/change-password" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const full = Accounts.getByName(user.username);
      if (!full || !Auth.verifyPassword(b.old || "", full.salt, full.hash))
        return send(res, 400, { ok: false, error: "current password is incorrect" });
      if (!b.new || String(b.new).length < 4) return send(res, 400, { ok: false, error: "new password too short" });
      const { salt, hash } = Auth.hashPassword(b.new);
      Accounts.setPassword(full.id, salt, hash);
      Audit.add({ type: "auth", action: "password-change", detail: user.username, ok: true });
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/hotspot/sales") {
      const range = new URL(req.url, "http://localhost").searchParams.get("range") || "monthly";
      return send(res, 200, { ok: true, data: HotspotSales.series(range) });
    }

    // ---- Helpdesk (staff) ----
    if (pathname === "/api/helpdesk" && req.method === "GET") {
      return send(res, 200, { ok: true, data: Tickets.list().map(({ image, ...t }) => ({ ...t, hasImage: !!image })) });
    }
    let hm;
    if ((hm = pathname.match(/^\/api\/helpdesk\/(\d+)$/)) && req.method === "GET") {
      const t = Tickets.get(Number(hm[1]));
      return t ? send(res, 200, { ok: true, data: t }) : send(res, 404, { ok: false, error: "not found" });
    }
    if ((hm = pathname.match(/^\/api\/helpdesk\/(\d+)\/ai-draft$/)) && req.method === "POST") {
      if (!aiEnabled()) return send(res, 400, { ok: false, error: "AI is off. Turn it on and add your API key in Settings." });
      const t = Tickets.statusView(Number(hm[1]));
      if (!t) return send(res, 404, { ok: false, error: "ticket not found" });
      try {
        const draft = await draftReply({ bizName: Settings.get("biz_name"), customerName: t.name, category: t.category, message: t.message });
        return send(res, 200, { ok: true, draft });
      } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
    }
    if ((hm = pathname.match(/^\/api\/helpdesk\/(\d+)\/reply$/)) && req.method === "POST") {
      const raw = (await readBody(req)) || "";
      if (raw.length > 8_000_000) return send(res, 413, { ok: false, error: "Attachment too large (max ~6MB)." });
      const b = JSON.parse(raw || "{}");
      Tickets.reply(Number(hm[1]), b.reply || "", b.image || "");
      const t = Tickets.statusView(Number(hm[1]));
      let notified = { via: "none" };
      try { notified = await notifyCustomerReply(t); } catch {}
      return send(res, 200, { ok: true, notified: notified.via });
    }
    if ((hm = pathname.match(/^\/api\/helpdesk\/(\d+)\/(resolve|reopen)$/)) && req.method === "POST") {
      Tickets.setStatus(Number(hm[1]), hm[2] === "resolve" ? "resolved" : "open");
      return send(res, 200, { ok: true });
    }

    // ---- Payment proofs (staff) ----
    if (pathname === "/api/proofs" && req.method === "GET") {
      return send(res, 200, { ok: true, data: Proofs.list().map(({ image, ...p }) => ({ ...p, hasImage: !!image })) });
    }
    let pm;
    if ((pm = pathname.match(/^\/api\/proofs\/(\d+)$/)) && req.method === "GET") {
      const p = Proofs.get(Number(pm[1]));
      return p ? send(res, 200, { ok: true, data: p }) : send(res, 404, { ok: false, error: "not found" });
    }
    if ((pm = pathname.match(/^\/api\/proofs\/(\d+)\/approve$/)) && req.method === "POST") {
      if (!need("cashier")) return denied();
      const p = Proofs.get(Number(pm[1]));
      if (!p) return send(res, 404, { ok: false, error: "not found" });
      if (p.status === "pending") await applyApprovedProof(p, "panel");
      return send(res, 200, { ok: true });
    }
    if ((pm = pathname.match(/^\/api\/proofs\/(\d+)\/reject$/)) && req.method === "POST") {
      if (!need("cashier")) return denied();
      Proofs.setStatus(Number(pm[1]), "rejected");
      return send(res, 200, { ok: true });
    }

    // ---- Backup / restore / audit (admin) ----
    if (pathname === "/api/billing/backup" && req.method === "GET") {
      if (!need()) return denied();
      const json = JSON.stringify(exportAll(), null, 2);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="billing-backup-${new Date().toISOString().slice(0,10)}.json"` });
      return res.end(json);
    }
    if (pathname === "/api/billing/restore" && req.method === "POST") {
      if (!need()) return denied();
      const raw = (await readBody(req)) || "";
      if (raw.length > 40_000_000) return send(res, 413, { ok: false, error: "Backup file too large." });
      let data; try { data = JSON.parse(raw); } catch { return send(res, 400, { ok: false, error: "not a valid backup file" }); }
      try {
        const counts = importAll(data);
        Auth.seedDefaultAdmin(); // make sure an admin still exists
        Audit.add({ type: "manual", action: "restore", detail: Object.entries(counts).map(([k,v]) => `${k}:${v}`).join(" "), ok: true });
        return send(res, 200, { ok: true, counts });
      } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
    }
    if (pathname === "/api/router/dryrun-log" && req.method === "GET") {
      if (!need()) return denied();
      return send(res, 200, { ok: true, data: { enabled: RouterOSAPI.dryRun, commands: dryRunLog.slice(0, 100) } });
    }
    if (pathname === "/api/router/dryrun-log/clear" && req.method === "POST") {
      if (!need()) return denied();
      dryRunLog.length = 0;
      return send(res, 200, { ok: true });
    }
    if (pathname === "/api/maintenance/stats" && req.method === "GET") {
      if (!need()) return denied();
      return send(res, 200, { ok: true, data: Maintenance.stats() });
    }
    if (pathname === "/api/maintenance/cleanup" && req.method === "POST") {
      if (!need()) return denied();
      const b = JSON.parse((await readBody(req)) || "{}");
      // cutoff = keep last N months (default 12). Rows older than cutoff are archived then cleared.
      const months = Math.max(1, Number(b.keepMonths) || 12);
      const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - months);
      const cutoffYmd = cutoff.toISOString().slice(0, 10);
      const tables = Array.isArray(b.tables) && b.tables.length ? b.tables : Maintenance.PRUNABLE.map((p) => p.table);
      // 1) ARCHIVE first — gather old rows into one dated file
      const archive = { archivedAt: new Date().toISOString(), keepMonths: months, cutoff: cutoffYmd, data: {} };
      let totalRows = 0;
      for (const t of tables) { const rows = Maintenance.oldRows(t, cutoffYmd); archive.data[t] = rows; totalRows += rows.length; }
      if (totalRows === 0) return send(res, 200, { ok: true, archived: 0, cleared: 0, message: "Nothing older than " + cutoffYmd + " to archive." });
      let archiveFile = "";
      try {
        if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
        archiveFile = path.join(ARCHIVE_DIR, `archive-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
        fs.writeFileSync(archiveFile, JSON.stringify(archive, null, 2));
      } catch (e) {
        return send(res, 500, { ok: false, error: "Could not write archive file (nothing was cleared): " + e.message });
      }
      // 2) Only after the archive is safely on disk, CLEAR the old rows
      const cleared = {};
      for (const t of tables) cleared[t] = Maintenance.clearOld(t, cutoffYmd);
      Maintenance.vacuum();
      Audit.add({ type: "manual", action: "data-cleanup", detail: `kept ${months}mo, archived ${totalRows} rows -> ${path.basename(archiveFile)}`, ok: true });
      return send(res, 200, { ok: true, archived: totalRows, archiveFile: path.basename(archiveFile), cleared });
    }
    if (pathname === "/api/maintenance/archives" && req.method === "GET") {
      if (!need()) return denied();
      let files = [];
      try { files = fs.readdirSync(ARCHIVE_DIR).filter((f) => f.startsWith("archive-")).sort().reverse().map((f) => { const st = fs.statSync(path.join(ARCHIVE_DIR, f)); return { name: f, bytes: st.size, at: st.mtime.toISOString() }; }); } catch {}
      return send(res, 200, { ok: true, data: files });
    }
    if (pathname === "/api/maintenance/archive" && req.method === "GET") {
      if (!need()) return denied();
      const name = new URL(req.url, "http://localhost").searchParams.get("name") || "";
      if (!/^archive-[\w-]+\.json$/.test(name)) return send(res, 400, { ok: false, error: "bad name" });
      const fp = path.join(ARCHIVE_DIR, name);
      if (!fs.existsSync(fp)) return send(res, 404, { ok: false, error: "not found" });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${name}"` });
      return res.end(fs.readFileSync(fp));
    }
    if (pathname === "/api/audit" && req.method === "GET") {
      if (!need()) return denied();
      const n = Number(new URL(req.url, "http://localhost").searchParams.get("n")) || 100;
      return send(res, 200, { ok: true, data: Audit.list(n) });
    }
    // Printable payment receipt (HTML)
    let rcpt;
    if ((rcpt = pathname.match(/^\/api\/billing\/payments\/(\d+)\/receipt$/)) && req.method === "GET") {
      const p = Payments.get(Number(rcpt[1]));
      if (!p) return send(res, 404, { ok: false, error: "payment not found" });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(receiptHtml(p));
    }

    // Printable financial report (HTML)
    if (pathname === "/api/billing/report/financial/print" && req.method === "GET") {
      if (!need()) return denied();
      const q2 = new URL(req.url, "http://localhost").searchParams;
      const period = q2.get("period") || new Date().toISOString().slice(0, 7);
      const st = Reports.monthlyStatement(period);
      const snap = Reports.snapshot();
      const s2 = Settings.all();
      const P = (n) => "\u20B1" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2 });
      const monthName = new Date(period + "-01").toLocaleDateString("en-PH", { month: "long", year: "numeric" });
      const incomeRows = [
        ["Client subscriptions (monthly plans)", st.income.subscriptions],
        ["Installation fees", st.income.installation],
        ["Hardware / equipment margin", st.income.hardware],
        ["Hotspot / vendo (piso-WiFi) income", st.income.vendo],
      ].map(([l, v]) => `<tr><td>${l}</td><td class="r">${P(v)}</td></tr>`).join("");
      const vendoRows = (st.vendoByDevice || []).map((d) => `<tr><td>${escapeHtml(d.vendo)}</td><td class="r">${d.c}</td><td class="r">${P(d.s)}</td></tr>`).join("") || '<tr><td colspan=3>No vendo income this month.</td></tr>';
      const methodRows = (st.methods || []).map((x) => `<tr><td>${escapeHtml((x.method || "cash").toUpperCase())}</td><td class="r">${x.n}</td><td class="r">${P(x.total)}</td></tr>`).join("") || '<tr><td colspan=3>—</td></tr>';
      const expRows = (st.expenses || []).map((e) => `<tr><td>${escapeHtml(e.category || "misc")}</td><td class="r">${e.n}</td><td class="r">${P(e.total)}</td></tr>`).join("") || '<tr><td colspan=3>No expenses this month.</td></tr>';
      const netColor = st.net >= 0 ? "#1a7f37" : "#c0392b";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Monthly financial report — ${escapeHtml(monthName)}</title>
      <style>*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#111;max-width:780px;margin:24px auto;padding:0 20px}
      .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #111;padding-bottom:12px;margin-bottom:8px}
      h1{font-size:20px;margin:0}.sub{color:#666;font-size:12px}
      .period{font-size:15px;font-weight:700;margin:10px 0 4px}
      table{width:100%;border-collapse:collapse;margin:6px 0 20px;font-size:13px}
      th{font-size:11px;text-transform:uppercase;color:#666;text-align:left;border-bottom:2px solid #111;padding:6px 8px}
      td{padding:6px 8px;border-bottom:1px solid #eee}.r{text-align:right}
      h2{font-size:14px;margin:18px 0 4px;border-left:4px solid #2f6bff;padding-left:8px}
      tr.tot td{border-top:2px solid #111;border-bottom:none;font-weight:800;font-size:14px}
      .summary{border:2px solid #111;border-radius:10px;padding:14px;margin:8px 0 20px}
      .summary .line{display:flex;justify-content:space-between;padding:5px 0;font-size:14px}
      .summary .net{display:flex;justify-content:space-between;padding:10px 0 0;margin-top:6px;border-top:2px solid #111;font-size:18px;font-weight:800}
      .ft{color:#888;font-size:11px;text-align:center;margin-top:18px;border-top:1px solid #ddd;padding-top:10px}
      button{padding:8px 16px;border:none;border-radius:8px;background:#111;color:#fff;font-weight:700;cursor:pointer;margin-bottom:14px}
      @media print{button{display:none}body{margin:0}}</style></head><body>
      <button onclick="print()">🖨 Print / Save as PDF</button>
      <div class="head"><div><h1>${escapeHtml(s2.biz_name || "Internet Service")}</h1><div class="sub">${escapeHtml(s2.biz_address || "")}</div></div><div class="sub">Generated ${new Date().toISOString().slice(0, 10)}</div></div>
      <div class="period">Monthly Financial Report — ${escapeHtml(monthName)}</div>

      <h2>Income summary</h2>
      <table><thead><tr><th>Income stream</th><th class="r">Amount</th></tr></thead><tbody>
        ${incomeRows}
        <tr class="tot"><td>TOTAL INCOME</td><td class="r">${P(st.incomeTotal)}</td></tr>
      </tbody></table>

      <h2>Net result</h2>
      <div class="summary">
        <div class="line"><span>Total income</span><b>${P(st.incomeTotal)}</b></div>
        <div class="line"><span>Total expenses</span><b style="color:#c0392b">− ${P(st.expenseTotal)}</b></div>
        <div class="net"><span>NET (${st.net >= 0 ? "profit" : "loss"})</span><span style="color:${netColor}">${P(st.net)}</span></div>
      </div>

      <h2>Client subscriptions &amp; one-off income — by payment method</h2>
      <table><thead><tr><th>Method</th><th class="r">Count</th><th class="r">Total</th></tr></thead><tbody>${methodRows}</tbody></table>

      <h2>Hardware / equipment sales</h2>
      <table><thead><tr><th>Item</th><th class="r">Amount</th></tr></thead><tbody>
        <tr><td>Sold to clients (revenue)</td><td class="r">${P(st.hardwareDetail.revenue)}</td></tr>
        <tr><td>Cost of equipment</td><td class="r">− ${P(st.hardwareDetail.cost)}</td></tr>
        <tr class="tot"><td>Hardware margin</td><td class="r">${P(st.hardwareDetail.margin)}</td></tr>
      </tbody></table>

      <h2>Hotspot / vendo (piso-WiFi) income — by device</h2>
      <table><thead><tr><th>Vendo</th><th class="r">Coins</th><th class="r">Income</th></tr></thead><tbody>${vendoRows}
        <tr class="tot"><td>Total vendo income</td><td class="r"></td><td class="r">${P(st.income.vendo)}</td></tr></tbody></table>

      <h2>Expenses — by category</h2>
      <table><thead><tr><th>Category</th><th class="r">Items</th><th class="r">Total</th></tr></thead><tbody>${expRows}
        <tr class="tot"><td>Total expenses</td><td class="r"></td><td class="r">${P(st.expenseTotal)}</td></tr></tbody></table>

      <div class="ft">System-generated report for ${escapeHtml(monthName)}. Hardware is shown as margin (sell − cost) so equipment cost isn't double-counted. Active clients: ${snap.active} · Suspended: ${snap.suspended}.</div>
      </body></html>`);
    }
    if (pathname === "/api/billing/kpis" && req.method === "GET") {
      return send(res, 200, { ok: true, data: kpis() });
    }
    // CSV exports for accounting (admin)
    let csvm;
    if ((csvm = pathname.match(/^\/api\/billing\/export\/(customers|payments)\.csv$/)) && req.method === "GET") {
      if (!need()) return denied();
      const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      let head, rows;
      if (csvm[1] === "customers") {
        head = ["id", "name", "username", "contact", "address", "plan", "status", "expiry"];
        rows = Customers.list().map((c) => [c.id, c.name, c.username, c.contact, c.address, c.plan_name, c.status, c.expiry]);
      } else {
        head = ["id", "date", "customer", "amount", "method", "reference", "invoice_id"];
        rows = Payments.list().map((p) => [p.id, p.paid_at, p.customer_name, p.amount, p.method, p.reference, p.invoice_id]);
      }
      const csv = [head.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\r\n");
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${csvm[1]}-${new Date().toISOString().slice(0,10)}.csv"` });
      return res.end(csv);
    }

    if (req.method === "GET" && GET_ROUTES[pathname]) {
      try {
        return send(res, 200, { ok: true, data: await GET_ROUTES[pathname]() });
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message });
      }
    }

    if (req.method === "POST" && pathname === "/api/ai") {
      if (!need("technician")) return denied();
      const body = JSON.parse((await readBody(req)) || "{}");
      const { instruction, confirm } = body;
      if (!instruction || !instruction.trim()) {
        return send(res, 400, { ok: false, error: "instruction is required" });
      }
      const parsed = await parseCommand(instruction.trim());
      if (!parsed.ok) return send(res, 200, { ok: false, error: parsed.reason });

      if (DESTRUCTIVE.has(parsed.action) && !confirm) {
        return send(res, 200, {
          ok: true, needsConfirm: true,
          action: parsed.action, params: parsed.params, explanation: parsed.explanation,
        });
      }
      const data = await execute(parsed.action, parsed.params);
      return send(res, 200, {
        ok: true, action: parsed.action, params: parsed.params,
        explanation: parsed.explanation, data,
      });
    }

    if (pathname.startsWith("/api/billing")) {
      const isJobOrders = pathname.startsWith("/api/billing/joborders");
      const isInventory = pathname.startsWith("/api/billing/inventory") || pathname.startsWith("/api/billing/installs");
      const isTechs = pathname.startsWith("/api/billing/techs");
      const isAdminOnly = pathname === "/api/billing/settings" || pathname === "/api/billing/automation" || pathname === "/api/billing/sales/reset" || pathname === "/api/billing/import-users";
      if (req.method === "GET") { /* any logged-in role may read */ }
      else if (isAdminOnly) { if (!need()) return denied(); }            // admin only
      else if (isJobOrders || isInventory || isTechs) { if (!need("technician", "cashier")) return denied(); } // tech+cashier+admin
      else { if (!need("cashier")) return denied(); }                    // cashier+admin (payments, customers, expenses…)
      return handleBilling(req, res, pathname);
    }

    if (pathname === "/api/router/coin-test" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const vendoNames = Vendos.list().map((v) => v.name);
      const parsed = parseCoinLog({ message: body.message || "", time: body.time || "" }, vendoNames);
      return send(res, 200, { ok: true, data: { parsed, matched: !!parsed } });
    }

    if (pathname.startsWith("/api/router") && req.method === "POST") {
      // Router control is admin-only. Technicians and cashiers cannot push router changes.
      if (user.role !== "admin") return denied();
      return handleRouter(req, res, pathname);
    }

    if (pathname.startsWith("/api/vendos")) {
      if (req.method !== "GET" && !need("technician")) return denied();
      return handleVendos(req, res, pathname);
    }

    send(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
};

// ---- Vendos (JuanFi NodeMCU registry + live pull) ------------------------
async function handleVendos(req, res, pathname) {
  const sub = pathname.replace("/api/vendos", "") || "/";
  const method = req.method;
  const body = method === "GET" ? {} : JSON.parse((await readBody(req)) || "{}");
  const ok = (data) => send(res, 200, { ok: true, data });
  let mm;
  try {
    if (sub === "/" || sub === "") {
      if (method === "GET") return ok(Vendos.list());
      if (method === "POST") return ok(Vendos.create(body));
    }
    if (sub === "/poll" && method === "GET") {
      const list = Vendos.list().filter((v) => v.enabled);
      const results = await Promise.all(list.map(async (v) => {
        const r = await fetchVendo(v);
        Vendos.saveSnapshot(v.id, r.online, r);
        return r;
      }));
      return ok(results);
    }
    if ((mm = sub.match(/^\/(\d+)$/))) {
      const id = Number(mm[1]);
      if (method === "PUT") return ok(Vendos.update(id, body));
      if (method === "DELETE") return ok(Vendos.remove(id));
    }
    if ((mm = sub.match(/^\/(\d+)\/fetch$/)) && method === "POST") {
      const v = Vendos.get(Number(mm[1]));
      if (!v) throw new Error("Vendo not found");
      const r = await fetchVendo(v);
      Vendos.saveSnapshot(v.id, r.online, r);
      return ok(r);
    }
    return send(res, 404, { ok: false, error: "vendos route not found: " + method + " " + sub });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
}

// ---- Import router users into billing ------------------------------------
async function importUsers(source) {
  const existing = new Set(Customers.list().map((c) => (c.username || "").toLowerCase()).filter(Boolean));
  const plans = Plans.list();
  const planByProfile = {};
  for (const p of plans) if (p.router_profile) planByProfile[p.router_profile.toLowerCase()] = p.id;
  let rows = [];
  if (source === "hotspot") rows = (await mt.listHotspotUsers()) || [];
  else rows = (await mt.listPppoe()) || [];
  let created = 0, skipped = 0;
  for (const r of rows) {
    const name = (r.name || "").trim();
    if (!name) { skipped++; continue; }
    if (existing.has(name.toLowerCase())) { skipped++; continue; }
    const profile = (r.profile || "").toLowerCase();
    Customers.create({
      name, username: name, password: r.password || "",
      plan_id: planByProfile[profile] || null,
      status: String(r.disabled) === "true" ? "suspended" : "active",
      notes: `imported from ${source}${r.profile ? " · profile " + r.profile : ""}`,
    });
    existing.add(name.toLowerCase());
    created++;
  }
  Audit.add({ type: "manual", action: "import-users", detail: `${source}: ${created} created, ${skipped} skipped`, ok: true });
  return { source, created, skipped, total: rows.length };
}

// ---- Public standalone helpdesk portal -----------------------------------
function welcomePageHtml() {
  const biz = Settings.get("biz_name", "Internet Service");
  const logo = Settings.get("brand_logo", "");
  const tagline = Settings.get("welcome_tagline", "Welcome! What would you like to do?");
  const E = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>${E(biz)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0c1322">
  <style>
    /* Dark is the default (CDATA-style deep navy). Light is opt-in via the toggle. */
    :root, [data-theme="dark"]{
      --brand1:#2f6bff;--brand2:#1f8fe0;
      --bg:#0a0f1c;--card:#121b2e;--ink:#e9eef8;--muted:#8fa0bd;--line:#22304c;
      --herograd:linear-gradient(135deg,#16233f,#0e1830);
      --radius:20px;--shadow:0 6px 22px rgba(0,0,0,.35);
      --ic-apply:#16294a;--ic-pay:#10402f;--ic-help:#3d3414;--ic-portal:#221f4a;
      --ic-apply-t:#7fb0ff;--ic-pay-t:#4fd49a;--ic-help-t:#f0c869;--ic-portal-t:#b3aaff;
    }
    [data-theme="light"]{
      --brand1:#2746d8;--brand2:#1aa3e0;
      --bg:#eef2f8;--card:#ffffff;--ink:#0e1726;--muted:#5b6b86;--line:#e6ebf3;
      --herograd:linear-gradient(135deg,#2746d8,#1aa3e0);
      --shadow:0 6px 22px rgba(20,40,90,.08);
      --ic-apply:#e7f0fb;--ic-pay:#e7f7ee;--ic-help:#fdf3dd;--ic-portal:#eef0fb;
      --ic-apply-t:#185fa5;--ic-pay-t:#0f6e56;--ic-help-t:#854f0b;--ic-portal-t:#534ab7;
    }
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);margin:0;min-height:100vh;padding:0 16px calc(40px + env(safe-area-inset-bottom)) 16px;line-height:1.45;transition:background .2s,color .2s}
    .wrap{width:100%;max-width:480px;margin:0 auto}
    .hero{background:var(--herograd);color:#fff;border-radius:0 0 28px 28px;margin:0 -16px 22px;padding:calc(34px + env(safe-area-inset-top)) 24px 30px;box-shadow:var(--shadow);text-align:center;position:relative}
    .themebtn{position:absolute;top:calc(14px + env(safe-area-inset-top));right:16px;background:rgba(255,255,255,.16);border:none;color:#fff;width:40px;height:40px;border-radius:50%;font-size:18px;line-height:1;padding:0;cursor:pointer;display:flex;align-items:center;justify-content:center}
    .logo{width:62px;height:62px;border-radius:16px;background:rgba(255,255,255,.16);display:flex;align-items:center;justify-content:center;font-size:30px;margin:0 auto 12px;overflow:hidden}
    .logo img{width:100%;height:100%;object-fit:cover}
    .hero h1{font-size:23px;font-weight:800;margin:0 0 4px;letter-spacing:-.01em}
    .hero p{font-size:14px;opacity:.92;margin:0}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .tile{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:26px 18px;text-align:center;cursor:pointer;text-decoration:none;color:var(--ink);box-shadow:var(--shadow);transition:transform .12s,box-shadow .12s;display:flex;flex-direction:column;align-items:center;gap:10px}
    .tile:active{transform:scale(.97)}
    .tile .ic{width:64px;height:64px;border-radius:18px;display:flex;align-items:center;justify-content:center;font-size:32px}
    .tile h2{font-size:17px;font-weight:800;margin:0}
    .tile p{font-size:12.5px;color:var(--muted);margin:0}
    .apply .ic{background:var(--ic-apply);color:var(--ic-apply-t)}
    .pay .ic{background:var(--ic-pay);color:var(--ic-pay-t)}
    .help .ic{background:var(--ic-help);color:var(--ic-help-t)}
    .portal .ic{background:var(--ic-portal);color:var(--ic-portal-t)}
    .full{grid-column:1 / -1}
    .foot{text-align:center;color:var(--muted);font-size:12px;margin-top:24px}
    @media(max-width:340px){.grid{grid-template-columns:1fr}}
  </style></head><body>
  <div class="wrap">
    <div class="hero">
      <button class="themebtn" id="themebtn" onclick="toggleTheme()" aria-label="Toggle light/dark">🌙</button>
      <div class="logo">${logo ? `<img src="${E(logo)}" alt="">` : "📶"}</div>
      <h1>${E(biz)}</h1>
      <p>${E(tagline)}</p>
    </div>
    <div class="grid">
      <a class="tile apply full" href="/apply">
        <div class="ic">📝</div>
        <h2>Apply for Internet</h2>
        <p>New customer? Send us your application to get connected.</p>
      </a>
      <a class="tile pay" href="/pay">
        <div class="ic">💳</div>
        <h2>Pay Bill</h2>
        <p>Send your payment &amp; proof.</p>
      </a>
      <a class="tile help" href="/help">
        <div class="ic">🛠️</div>
        <h2>Help &amp; Support</h2>
        <p>Need assistance? Reach us.</p>
      </a>
      <a class="tile portal full" href="/portal">
        <div class="ic">👤</div>
        <h2>My Account</h2>
        <p>Log in to see your due date, usage, and payment history.</p>
      </a>
    </div>
    <div class="foot">© <span id="yr"></span> ${E(biz)}</div>
  </div>
  <script>
    document.getElementById("yr").textContent=new Date().getFullYear();
    // theme: default dark; remember the customer's choice in this browser
    var saved=null; try{saved=localStorage.getItem("jns_theme");}catch(e){}
    var theme = saved || "dark";
    applyTheme(theme);
    function applyTheme(t){
      document.documentElement.setAttribute("data-theme",t);
      var b=document.getElementById("themebtn"); if(b) b.textContent = (t==="dark") ? "🌙" : "☀️";
      var m=document.querySelector('meta[name=theme-color]'); if(m) m.setAttribute("content", t==="dark"?"#0c1322":"#2746d8");
    }
    function toggleTheme(){
      theme = (document.documentElement.getAttribute("data-theme")==="dark") ? "light" : "dark";
      try{localStorage.setItem("jns_theme",theme);}catch(e){}
      applyTheme(theme);
    }
  </script>
  </body></html>`;
}

function helpPageHtml() {
  const biz = Settings.get("biz_name", "Internet Service");
  const logo = Settings.get("brand_logo", "");
  const E = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Help &amp; Support</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#2746d8">
  <style>
    :root{--brand1:#2746d8;--brand2:#1aa3e0;--ink:#0e1726;--muted:#5b6b86;--line:#e6ebf3;--bg:#eef2f8;--card:#ffffff;--inbg:#fbfcfe;--dropln:#c4d0e4;--ok:#0f9d58;--okbg:#e7f7ee;--okln:#bce6cd;--warn:#b9770a;--warnbg:#fdf3dd;--warnln:#f0dca6;--info:#1564c0;--infobg:#e7f0fb;--infoln:#bcd6f3;--radius:18px;--shadow:0 6px 22px rgba(20,40,90,.08)}
    [data-theme="dark"]{--brand1:#16233f;--brand2:#0e1830;--ink:#e9eef8;--muted:#8fa0bd;--line:#22304c;--bg:#0a0f1c;--card:#121b2e;--inbg:#0c1322;--dropln:#2c3c5c;--ok:#2dd482;--okbg:#10402f;--okln:#1d6b4d;--warn:#f0c869;--warnbg:#3d3414;--warnln:#5c5020;--info:#7fb0ff;--infobg:#16294a;--infoln:#2a4a7a;--shadow:0 6px 22px rgba(0,0,0,.35)}
    .pubbar{position:sticky;top:0;z-index:60;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bg)}
    .pubmenu{display:inline-flex;align-items:center;gap:4px;background:var(--card);border:1px solid var(--line);color:var(--ink);text-decoration:none;font-size:13px;font-weight:700;padding:8px 14px;border-radius:20px}
    .pubtheme{background:var(--card);border:1px solid var(--line);color:var(--ink);width:40px;height:40px;border-radius:50%;font-size:18px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:0 16px calc(40px + env(safe-area-inset-bottom)) 16px;line-height:1.45;-webkit-font-smoothing:antialiased}
    .wrap{width:100%;max-width:460px;margin:0 auto}
    .hero{background:linear-gradient(135deg,var(--brand1),var(--brand2));color:#fff;border-radius:0 0 26px 26px;margin:0 -16px 18px;padding:calc(22px + env(safe-area-inset-top)) 24px 26px;box-shadow:var(--shadow)}
    .eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;opacity:.85;font-weight:700}
    .hero h1{font-size:22px;font-weight:800;margin:9px 0 2px;letter-spacing:-.01em}
    .hero p{margin:0;font-size:13px;opacity:.85}
    .hero img.lg{height:40px;max-width:180px;object-fit:contain;background:#fff;border-radius:9px;padding:4px;display:${logo ? "block" : "none"};margin-bottom:8px}
    .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;margin-bottom:14px;box-shadow:var(--shadow)}
    .tabs{display:flex;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:5px;margin-bottom:14px;box-shadow:var(--shadow)}
    .tabs button{flex:1;padding:11px;border:none;border-radius:10px;background:transparent;color:var(--muted);font-weight:700;font-size:14px;font-family:inherit;cursor:pointer}
    .tabs button.on{background:linear-gradient(135deg,var(--brand1),var(--brand2));color:#fff}
    label.lbl{display:block;font-size:13px;font-weight:600;margin:0 0 6px}
    input,textarea,select{width:100%;padding:14px;border-radius:12px;border:1.5px solid var(--line);background:var(--inbg);color:var(--ink);font-size:16px;font-family:inherit;margin-bottom:11px}
    input:focus,textarea:focus,select:focus{outline:none;border-color:var(--brand1);box-shadow:0 0 0 4px rgba(39,70,216,.12)}
    textarea{min-height:96px;resize:vertical}
    button{width:100%;padding:15px;border:none;border-radius:12px;font-size:16px;font-weight:700;font-family:inherit;cursor:pointer}
    button:active{transform:translateY(1px)}
    .btn{background:linear-gradient(135deg,var(--brand1),var(--brand2));color:#fff;box-shadow:0 6px 16px rgba(39,70,216,.28)}
    .sec{background:#eef2fa;color:var(--brand1);box-shadow:none}
    .drop{display:flex;flex-direction:column;align-items:center;gap:6px;border:2px dashed var(--dropln);border-radius:14px;padding:20px;text-align:center;color:var(--muted);cursor:pointer;background:var(--inbg);margin-bottom:11px}
    .drop .big{font-weight:700;color:var(--ink);font-size:14px}
    .thumb{width:100%;border-radius:12px;margin-bottom:11px;display:none}
    .msg{margin-top:10px;font-size:13.5px;text-align:center;color:var(--muted)}
    .pill{display:inline-block;padding:7px 13px;border-radius:20px;font-size:13px;font-weight:700}
    .pill.ok{background:var(--okbg);color:#0c5a36;border:1px solid var(--okln)}
    .pill.open{background:var(--warnbg);color:#7a4e06;border:1px solid var(--warnln)}
    .pill.ans{background:var(--infobg);color:#0c477f;border:1px solid var(--infoln)}
    .tk{border:1.5px solid var(--line);border-radius:14px;padding:16px;margin-top:12px;background:var(--inbg)}
    .tk .topic{font-size:12px;color:var(--muted);margin:6px 0}
    .reply{margin-top:12px;padding:12px;border-radius:10px;background:var(--infobg);border:1px solid var(--infoln);color:#0c477f;font-size:14px}
    .foot{text-align:center;color:var(--muted);font-size:12px;margin:18px 0 6px}
    a{color:var(--brand1)}
    [data-theme="dark"] a{color:#7fb0ff}
    .links{text-align:center;font-size:13.5px;margin-top:6px}
    @media (min-width:700px){.wrap{max-width:520px}.hero{border-radius:26px;margin:18px 0}}
  </style></head><body>
  <div class="pubbar"><a class="pubmenu" href="/welcome">← Menu</a><button class="pubtheme" id="pubtheme" onclick="togglePubTheme()" aria-label="Toggle theme">🌙</button></div>
  <script>
    (function(){var s=null;try{s=localStorage.getItem("jns_theme");}catch(e){}var t=s||"dark";document.documentElement.setAttribute("data-theme",t);window.addEventListener("DOMContentLoaded",function(){var b=document.getElementById("pubtheme");if(b)b.textContent=t==="dark"?"🌙":"☀️";});window.togglePubTheme=function(){var c=document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark";document.documentElement.setAttribute("data-theme",c);try{localStorage.setItem("jns_theme",c);}catch(e){}var b=document.getElementById("pubtheme");if(b)b.textContent=c==="dark"?"🌙":"☀️";};})();
  </script>
  <div class="wrap">
    <div class="hero">
      <div class="eyebrow">Help &amp; Support</div>
      <img class="lg" src="${logo}" alt="">
      <h1>${E(biz)}</h1>
      <p>Report a problem or check an existing ticket.</p>
    </div>
    <div class="tabs">
      <button id="tab-new" class="on" onclick="tab('new')">New report</button>
      <button id="tab-chk" onclick="tab('chk')">Check status</button>
    </div>
    <div class="card" id="pane-new">
      <label class="lbl" for="hname">Your name</label>
      <input id="hname" placeholder="Juan Dela Cruz">
      <label class="lbl" for="hcontact">Contact (phone or email)</label>
      <input id="hcontact" placeholder="09xx… or you@email.com">
      <label class="lbl" for="hcat">What is the issue?</label>
      <select id="hcat"><option value="">Choose a topic</option><option>No internet</option><option>Slow connection</option><option>Billing / payment</option><option>Relocation / new line</option><option>Other</option></select>
      <label class="lbl" for="hmsg">Describe the problem</label>
      <textarea id="hmsg" placeholder="Tell us what is happening…"></textarea>
      <label class="drop" for="hf"><span style="font-size:24px">&#128206;</span><span class="big">Attach a photo (optional)</span><span>screenshot, signal lights, etc.</span></label>
      <input id="hf" type="file" accept="image/*" style="display:none" onchange="prevH(this)">
      <img id="hthumb" class="thumb">
      <button class="btn" onclick="sendHelp(this)">Send report</button>
      <div class="msg" id="hout"></div>
    </div>
    <div class="card" id="pane-chk" style="display:none">
      <label class="lbl" for="cid">Ticket number</label>
      <input id="cid" placeholder="e.g. 12" inputmode="numeric">
      <label class="lbl" for="cq">Name or contact you used</label>
      <input id="cq" placeholder="so we can verify it is yours">
      <button class="sec" onclick="checkStatus(this)">Check status</button>
      <div id="cout"></div>
    </div>
    <div class="links"><a href="/pay">Pay your bill / view your account &#8594;</a></div>
    <div class="foot">${E(biz)} &middot; we are here to help</div>
  </div>
  <script>
    var $=function(id){return document.getElementById(id)};
    function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
    function fileToDataUrl(file){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(r.result)};r.onerror=rej;r.readAsDataURL(file)})}
    function tab(t){var n=t==='new';$("pane-new").style.display=n?'block':'none';$("pane-chk").style.display=n?'none':'block';$("tab-new").className=n?'on':'';$("tab-chk").className=n?'':'on';}
    function prevH(inp){ if(inp.files[0]){ var t=$("hthumb"); t.src=URL.createObjectURL(inp.files[0]); t.style.display="block"; } }
    var pre=new URLSearchParams(location.search); if(pre.get('u')) $("hname").value=pre.get('u');
    async function sendHelp(btn){
      if(!$("hmsg").value.trim()) return alert("Please describe the problem.");
      btn.disabled=true; $("hout").textContent="Sending\\u2026";
      var img=""; if($("hf").files[0]) img=await fileToDataUrl($("hf").files[0]);
      var r=await fetch("/api/helpdesk",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:$("hname").value,contact:$("hcontact").value,category:$("hcat").value,message:$("hmsg").value,image:img})}).then(x=>x.json());
      btn.disabled=false;
      $("hout").innerHTML = r.ok ? '<span class="pill ok">'+esc(r.message)+'</span>' : (r.error||"Failed");
      if(r.ok){ $("hmsg").value=""; $("hf").value=""; $("hthumb").style.display="none"; }
    }
    async function checkStatus(btn){
      if(!$("cid").value.trim()) return alert("Enter your ticket number.");
      btn.disabled=true; $("cout").innerHTML="";
      var r=await fetch("/api/help/status?id="+encodeURIComponent($("cid").value.trim())+"&q="+encodeURIComponent($("cq").value.trim())).then(x=>x.json());
      btn.disabled=false;
      if(!r.ok){ $("cout").innerHTML='<div class="msg">'+esc(r.error||"Not found")+'</div>'; return; }
      if(!r.ticket){ $("cout").innerHTML='<div class="msg">No matching ticket found.</div>'; return; }
      var t=r.ticket, cls=t.status==='open'?'open':(t.status==='resolved'?'ok':'ans');
      $("cout").innerHTML='<div class="tk"><div>Ticket #'+t.id+' &nbsp;<span class="pill '+cls+'">'+esc(t.status)+'</span></div>'+
        (t.category?'<div class="topic">'+esc(t.category)+'</div>':'')+
        '<div style="margin-top:6px">'+esc(t.message)+'</div>'+
        (t.reply?'<div class="reply"><b>Staff reply:</b><br>'+esc(t.reply)+'</div>'+(t.reply_image?'<img src="'+t.reply_image+'" style="max-width:100%;border-radius:10px;margin-top:8px">':''):'<div class="msg" style="margin-top:10px">No reply yet \\u2014 we will get back to you.</div>')+'</div>';
    }
    if(pre.get('ticket')){ tab('chk'); $("cid").value=pre.get('ticket'); }
  </script></body></html>`;
}


// ---- Public "pay your bill" page (captive-portal friendly) ---------------
function portalPageHtml() {
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>My Account</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0c1322">
  <style>
    :root{--brand1:#2746d8;--brand2:#1aa3e0;--ink:#0e1726;--muted:#5b6b86;--line:#e6ebf3;--bg:#eef2f8;--card:#ffffff;--inbg:#fbfcfe;--ok:#0f9d58;--okbg:#e7f7ee;--okln:#bce6cd;--bad:#e23a3a;--badbg:#fdecec;--badln:#f6c9c9;--warn:#b9770a;--warnbg:#fdf3dd;--warnln:#f0dca6;--radius:18px;--shadow:0 6px 22px rgba(20,40,90,.08)}
    [data-theme="dark"]{--brand1:#16233f;--brand2:#0e1830;--ink:#e9eef8;--muted:#8fa0bd;--line:#22304c;--bg:#0a0f1c;--card:#121b2e;--inbg:#0c1322;--ok:#2dd482;--okbg:#10402f;--okln:#1d6b4d;--bad:#ff5d6d;--badbg:#3a1620;--badln:#5c2230;--warn:#f0c869;--warnbg:#3d3414;--warnln:#5c5020;--shadow:0 6px 22px rgba(0,0,0,.35)}
    .pubbar{position:sticky;top:0;z-index:60;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bg)}
    .pubmenu{display:inline-flex;align-items:center;gap:4px;background:var(--card);border:1px solid var(--line);color:var(--ink);text-decoration:none;font-size:13px;font-weight:700;padding:8px 14px;border-radius:20px}
    .pubtheme{background:var(--card);border:1px solid var(--line);color:var(--ink);width:40px;height:40px;border-radius:50%;font-size:18px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:0 16px calc(40px + env(safe-area-inset-bottom)) 16px;line-height:1.45;-webkit-font-smoothing:antialiased}
    .wrap{width:100%;max-width:460px;margin:0 auto}
    .hero{background:linear-gradient(135deg,var(--brand1),var(--brand2));color:#fff;border-radius:18px;margin:0 0 18px;padding:22px 24px;box-shadow:var(--shadow);display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
    .hero h1{font-size:21px;font-weight:800;margin:8px 0 2px}.hero p{margin:0;font-size:13px;opacity:.85}
    .eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;opacity:.85;font-weight:700}
    .hero img.lg{height:38px;max-width:160px;object-fit:contain;background:#fff;border-radius:9px;padding:3px;display:none;margin-bottom:6px}
    .lo{width:auto;padding:8px 14px;border-radius:10px;background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.3);font-size:12.5px;font-weight:700;display:none}
    .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;margin-bottom:14px;box-shadow:var(--shadow)}
    .card h2{font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
    label.lbl{display:block;font-size:13px;font-weight:600;margin:0 0 6px}
    input,textarea{width:100%;padding:14px;border-radius:12px;border:1.5px solid var(--line);background:var(--inbg);color:var(--ink);font-size:16px;font-family:inherit;margin-bottom:11px}
    input:focus,textarea:focus{outline:none;border-color:var(--brand1);box-shadow:0 0 0 4px rgba(39,70,216,.12)}
    button{width:100%;padding:15px;border:none;border-radius:12px;font-size:16px;font-weight:700;font-family:inherit;cursor:pointer}
    .btn{background:linear-gradient(135deg,var(--brand1),var(--brand2));color:#fff;box-shadow:0 6px 16px rgba(39,70,216,.28)}
    .gc{background:#0a7bd6;color:#fff}
    .status{display:flex;gap:14px;align-items:flex-start;border-radius:var(--radius);padding:18px;margin-bottom:14px;border:1.5px solid}
    .status .ic{flex:0 0 44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:#fff}
    .status .t{font-size:17px;font-weight:800;margin:0 0 2px}.status .s{font-size:13.5px;margin:0}
    .status.ok{background:var(--okbg);border-color:var(--okln);color:#0c5a36}.status.ok .ic{background:var(--ok)}
    .status.bad{background:var(--badbg);border-color:var(--badln);color:#8f1f1f}.status.bad .ic{background:var(--bad)}
    .notice{border-radius:12px;padding:12px 14px;margin-bottom:14px;font-size:13.5px;border:1.5px solid}
    .notice.warn{background:var(--warnbg);border-color:var(--warnln);color:#7a4e06}
    .notice.bad{background:var(--badbg);border-color:var(--badln);color:#8f1f1f}
    .row{display:flex;justify-content:space-between;gap:10px;font-size:14px;padding:8px 0;border-top:1px dashed var(--line)}
    .row:first-of-type{border-top:none}.row .k{color:var(--muted)}.row .v{font-weight:700;text-align:right}
    .amount{font-size:34px;font-weight:800;line-height:1.1}.due{color:var(--muted);font-size:13px;margin:2px 0 14px}
    .ubar{height:10px;border-radius:6px;background:#e8edf6;overflow:hidden;margin:8px 0 4px}
    .ubar span{display:block;height:100%;border-radius:6px;background:linear-gradient(90deg,var(--brand1),var(--brand2))}
    .ubar.full span{background:linear-gradient(90deg,#d8324a,#e4596d)}
    .uhint{font-size:12px;color:var(--muted)}
    .pm{border:1.5px solid var(--line);border-radius:14px;padding:14px;margin-top:12px;background:var(--inbg)}
    .pm-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
    .pm-logo{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff}
    .pm.gcash .pm-logo{background:#0a7bd6}.pm.maya .pm-logo{background:#0fb86e}.pm.bank .pm-logo{background:#3a4658}
    .pm-name{font-weight:700;font-size:15px}.pm-tag{font-size:11.5px;color:var(--muted)}
    .copy{width:auto;padding:6px 12px;border-radius:8px;background:#eef2fa;color:var(--brand1);font-size:12px;font-weight:700;border:1px solid var(--line)}
    .qrwrap{text-align:center;margin-top:10px}.qr{width:172px;max-width:70%;background:#fff;border:1px solid var(--line);border-radius:12px;padding:8px}
    .drop{display:flex;flex-direction:column;align-items:center;gap:6px;border:2px dashed #c4d0e4;border-radius:14px;padding:20px;text-align:center;color:var(--muted);cursor:pointer;background:var(--inbg);margin-bottom:11px}
    .drop .big{font-weight:700;color:var(--ink);font-size:14px}
    .thumb{width:100%;border-radius:12px;margin-bottom:11px;display:none}
    .pill{display:inline-block;padding:7px 13px;border-radius:20px;font-size:13px;font-weight:700;background:var(--okbg);color:#0c5a36;border:1px solid var(--okln)}
    .msg{margin-top:10px;font-size:13.5px;text-align:center;color:var(--muted)}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{text-align:left;font-size:10.5px;text-transform:uppercase;color:var(--muted);padding:6px 4px;border-bottom:2px solid var(--line)}
    td{padding:8px 4px;border-bottom:1px solid var(--line)}
    .foot{text-align:center;color:var(--muted);font-size:12px;margin:18px 0 6px}
    a{color:var(--brand1)}
    [data-theme="dark"] a{color:#7fb0ff}
    @media (min-width:700px){.wrap{max-width:520px}.hero{border-radius:26px;margin:18px 0}}
  </style></head><body>
  <div class="pubbar"><a class="pubmenu" href="/welcome">← Menu</a><button class="pubtheme" id="pubtheme" onclick="togglePubTheme()" aria-label="Toggle theme">🌙</button></div>
  <script>
    (function(){var s=null;try{s=localStorage.getItem("jns_theme");}catch(e){}var t=s||"dark";document.documentElement.setAttribute("data-theme",t);window.addEventListener("DOMContentLoaded",function(){var b=document.getElementById("pubtheme");if(b)b.textContent=t==="dark"?"\u{1F319}":"\u2600\uFE0F";});window.togglePubTheme=function(){var c=document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark";document.documentElement.setAttribute("data-theme",c);try{localStorage.setItem("jns_theme",c);}catch(e){}var b=document.getElementById("pubtheme");if(b)b.textContent=c==="dark"?"\u{1F319}":"\u2600\uFE0F";};})();
  </script>
  <div class="wrap">
    <div class="hero">
      <div><div class="eyebrow">My Account</div><img id="logo" class="lg" alt=""><h1 id="biz">Customer Portal</h1><p id="hello">Sign in to manage your internet account.</p></div>
      <button class="lo" id="lobtn" onclick="doLogout()">Log out</button>
    </div>
    <div class="card" id="login-card">
      <h2>Sign in</h2>
      <label class="lbl" for="lu">Account username</label>
      <input id="lu" autocapitalize="off" autocomplete="username" autocorrect="off" spellcheck="false" placeholder="Your PPPoE / account username">
      <label class="lbl" for="lp">Password</label>
      <input id="lp" type="password" autocomplete="current-password" placeholder="Your account password">
      <button class="btn" onclick="doLogin(this)">Sign in</button>
      <div class="msg" id="lmsg">Same username and password as your internet connection.</div>
      <div style="text-align:center;margin-top:8px;font-size:13px"><a href="/pay">Just paying a bill? Quick pay without signing in &#8594;</a></div>
    </div>
    <div id="acct"></div>
    <div class="foot" id="foot"></div>
  </div>
  <script>
    var $=function(id){return document.getElementById(id)};
    function peso(n){return "\\u20B1"+Number(n).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2})}
    function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
    function gb(b){return (Number(b||0)/1073741824)}
    var ME=null;
    function fileToDataUrl(f){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(r.result)};r.onerror=rej;r.readAsDataURL(f)})}
    $("lp").addEventListener("keydown",function(e){if(e.key==="Enter")doLogin()});
    async function doLogin(btn){
      if(btn)btn.disabled=true; $("lmsg").textContent="Signing in\\u2026";
      var r=await fetch("/api/portal/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("lu").value.trim(),password:$("lp").value})}).then(x=>x.json()).catch(function(){return{}});
      if(btn)btn.disabled=false;
      if(!r.ok){$("lmsg").textContent=r.error||"Sign-in failed.";return;}
      $("lmsg").textContent=""; loadMe();
    }
    async function doLogout(){ await fetch("/api/portal/logout",{method:"POST"}); location.reload(); }
    async function loadMe(){
      var r=await fetch("/api/portal/me").then(x=>x.json()).catch(function(){return{}});
      if(!r.ok){ $("login-card").style.display="block"; $("lobtn").style.display="none"; return; }
      ME=r; render();
    }
    function render(){
      var r=ME, c=r.customer;
      $("login-card").style.display="none"; $("lobtn").style.display="block";
      if(r.biz)$("biz").textContent=r.biz;
      if(r.logo){$("logo").src=r.logo;$("logo").style.display="block";}
      $("hello").textContent="Hi, "+c.name+"!";
      $("foot").textContent="Secured customer portal \\u00b7 "+r.biz;
      var suspended=c.status==="suspended", html="";
      if(suspended){
        html+='<div class="status bad"><div class="ic">!</div><div><p class="t">Disconnected</p><p class="s">Your account is past due. Settle below to be reconnected automatically.</p></div></div>';
      } else {
        html+='<div class="status ok"><div class="ic">&#10003;</div><div><p class="t">Connected</p><p class="s">'+(c.expiry?('Active until <b>'+esc(String(c.expiry).slice(0,16))+'</b>.'):'Your account is in good standing.')+'</p></div></div>';
      }
      if(r.lastProof&&r.lastProof.status==="pending") html+='<div class="notice warn">&#9203; Your payment is <b>under review</b>. You will be reconnected once approved.</div>';
      if(r.lastProof&&r.lastProof.status==="rejected") html+='<div class="notice bad">&#10007; Your last receipt was <b>not accepted</b>'+(r.lastProof.reason?(': '+esc(r.lastProof.reason)):'')+'. Please send a clearer photo below.</div>';
      // plan card
      html+='<div class="card"><h2>My plan</h2>'+
        '<div class="row"><span class="k">Plan</span><span class="v">'+esc(c.plan_name||"\\u2014")+'</span></div>'+
        '<div class="row"><span class="k">Account</span><span class="v">'+esc(c.username)+'</span></div>'+
        (c.area?'<div class="row"><span class="k">Area</span><span class="v">'+esc(c.area)+'</span></div>':'')+
        (c.expiry?'<div class="row"><span class="k">Valid until</span><span class="v">'+esc(String(c.expiry).slice(0,16))+'</span></div>':'')+
        usageHtml(r.usage)+'</div>';
      // bill
      if(r.invoices.length){
        html+='<div class="card"><h2>Amount due</h2>'+r.invoices.map(function(i){return '<div><div class="amount">'+peso(Math.max(0,i.amount-(i.paid_amount||0)))+'</div><div class="due">'+((i.paid_amount||0)>0?('Partial: '+peso(i.paid_amount)+' of '+peso(i.amount)+' paid \u00b7 '):'')+'Billing period '+esc(i.period)+(i.due_date?' \\u00b7 due '+esc(i.due_date):'')+'</div><button class="btn gc" onclick="pay('+i.id+',this)">Pay online \\u00b7 GCash or card</button></div>'}).join('<hr style="border:none;border-top:1px solid #e6ebf3;margin:14px 0">')+'</div>';
      } else if(!suspended){
        html+='<div class="card"><span class="pill">&#10003; You are all set \\u00b7 nothing due</span></div>';
      }
      if(suspended||r.invoices.length){
        html+=payMethodsHtml(r.pay);
        html+='<div class="card"><h2>Already paid? Send your receipt</h2>'+
          '<label class="drop" for="pf"><span style="font-size:26px">&#128247;</span><span class="big">Add payment screenshot</span><span>Tap to take a photo or choose from gallery</span></label>'+
          '<input id="pf" type="file" accept="image/*" style="display:none" onchange="prev(this)">'+
          '<img id="pthumb" class="thumb">'+
          '<label class="lbl" for="pref">Reference number</label>'+
          '<input id="pref" placeholder="GCash / Maya reference no.">'+
          '<button class="btn" onclick="sendProof(this)">Submit payment</button>'+
          '<div class="msg" id="pmsg"></div></div>';
      }
      // history
      html+='<div class="card"><h2>Payment history</h2>'+
        (r.payments.length?'<table><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Ref</th></tr></thead><tbody>'+
          r.payments.map(function(p){return '<tr><td>'+esc(String(p.paid_at||"").replace("T"," ").slice(0,16))+'</td><td><b>'+peso(p.amount)+'</b></td><td>'+esc((p.method||"cash").toUpperCase())+'</td><td>'+esc(p.reference||"\\u2014")+'</td></tr>'}).join("")+'</tbody></table>'
        :'<div class="msg" style="margin:0">No payments recorded yet.</div>')+'</div>';
      html+='<div class="card" style="text-align:center;font-size:13.5px">Need help? <a href="/help">Open the help center &#8594;</a></div>';
      $("acct").innerHTML=html;
    }
    function usageHtml(u){
      if(!u||(!u.up&&!u.down)) return "";
      var used=gb(Number(u.up)+Number(u.down)), cap=Number(u.capGb)||0;
      var pct=cap>0?Math.min(100,Math.round(used/cap*100)):null;
      return '<div style="margin-top:12px"><div style="display:flex;justify-content:space-between;font-size:13px"><span class="k" style="color:var(--muted)">Data used this month</span><span style="font-weight:700">'+used.toFixed(used<10?2:1)+' GB'+(cap>0?(' / '+cap+' GB'):'')+'</span></div>'+
        (pct!=null?('<div class="ubar'+(pct>=100?' full':'')+'"><span style="width:'+pct+'%"></span></div><div class="uhint">'+pct+'% of your monthly data</div>'):'')+'</div>';
    }
    function payMethodsHtml(p){
      var cards="";
      function card(title,tag,cls,logo,name,number,qr){
        if(!name&&!number&&!qr) return "";
        return '<div class="pm '+cls+'"><div class="pm-head"><div class="pm-logo">'+logo+'</div><div><div class="pm-name">'+title+'</div><div class="pm-tag">'+tag+'</div></div></div>'+
          (name?'<div class="row"><span class="k">Account name</span><span class="v">'+esc(name)+'</span></div>':'')+
          (number?'<div class="row"><span class="k">Number</span><span class="v">'+esc(number)+' <button class="copy" data-c="'+esc(number)+'" onclick="copyTxt(this.dataset.c,this)">Copy</button></span></div>':'')+
          (qr?'<div class="qrwrap"><img class="qr" src="'+qr+'" alt="QR"><div class="uhint">Scan with your '+title+' app</div></div>':'')+'</div>';
      }
      cards+=card("GCash","Send to this GCash number","gcash","G",p.gcash_name,p.gcash_number,p.gcash_qr);
      cards+=card("Maya","Send to this Maya number","maya","M",p.maya_name,p.maya_number,p.maya_qr);
      if(p.bank_details) cards+='<div class="pm bank"><div class="pm-head"><div class="pm-logo">&#127974;</div><div><div class="pm-name">Bank transfer</div></div></div><div class="row" style="border:none"><span class="v" style="white-space:pre-wrap;text-align:left;font-weight:500">'+esc(p.bank_details)+'</span></div></div>';
      if(!cards) return "";
      return '<div class="card"><h2>Pay via GCash / Maya / Bank</h2>'+cards+'</div>';
    }
    function copyTxt(t,btn){ navigator.clipboard.writeText(t).then(function(){ if(btn){var o=btn.textContent;btn.textContent="Copied";setTimeout(function(){btn.textContent=o},1200);} },function(){}); }
    function prev(inp){ if(inp.files[0]){ var t=$("pthumb"); t.src=URL.createObjectURL(inp.files[0]); t.style.display="block"; } }
    async function pay(id,btn){
      btn.disabled=true; btn.textContent="Opening payment\\u2026";
      var r=await fetch("/api/pay/link",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({invoice_id:id})}).then(x=>x.json());
      if(r.ok&&r.url){location.href=r.url;} else {btn.disabled=false;btn.textContent="Pay online \\u00b7 GCash or card";alert(r.error||"Could not start payment.");}
    }
    async function sendProof(btn){
      var f=$("pf").files[0]; if(!f) return alert("Please attach your receipt photo first.");
      btn.disabled=true; $("pmsg").textContent="Uploading\\u2026";
      var img=await fileToDataUrl(f);
      var r=await fetch("/api/pay/proof",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:ME.customer.username,reference:$("pref").value,note:"via portal",image:img})}).then(x=>x.json());
      btn.disabled=false;
      $("pmsg").innerHTML = r.ok ? '<span class="pill">'+esc(r.message)+'</span>' : (r.error||"Upload failed");
    }
    loadMe();
  </script></body></html>`;
}

function payPageHtml() {
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Account &amp; Payment</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0c1322">
  <link rel="manifest" href="/pay-manifest.webmanifest">
  <meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <script>if("serviceWorker" in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});}</script>
  <style>
    :root{--bg:#0c1322;--card:#131c30;--card2:#1a2540;--line:#243250;--text:#e9eef8;--muted:#8fa0bd;--accent:#3b82f6;--accent2:#5b9dff;--grad:#2f6bff;--warn:#ff5d6d;--bad:#ff5d6d;--ok:#2dd482;--radius:16px}
    [data-theme="light"]{--bg:#eef2f8;--card:#ffffff;--card2:#f3f6fb;--line:#e6ebf3;--text:#0e1726;--muted:#5b6b86;--accent:#2746d8;--accent2:#1564c0;--grad:#2746d8;--warn:#b9770a;--bad:#c0392b;--ok:#0f9d58}
    .pubbar{position:sticky;top:0;z-index:60;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bg)}
    .pubmenu{display:inline-flex;align-items:center;gap:4px;background:var(--card2);border:1px solid var(--line);color:var(--text);text-decoration:none;font-size:13px;font-weight:700;padding:8px 14px;border-radius:20px}
    .pubtheme{background:var(--card2);border:1px solid var(--line);color:var(--text);width:40px;height:40px;border-radius:50%;font-size:18px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
    *{box-sizing:border-box}
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:
      radial-gradient(1200px 500px at 50% -8%,#16264a 0%,transparent 60%),var(--bg);color:var(--text);min-height:100vh}
    .topbar{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line);background:#0a1120}
    .topbar .logo{width:30px;height:30px;border-radius:8px;background:var(--grad);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px}
    .topbar b{font-size:15px}
    .wrap{max-width:460px;margin:0 auto;padding:18px 14px 60px}
    .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin-bottom:14px;box-shadow:0 14px 40px rgba(0,0,0,.35)}
    .pad{padding:18px}
    h1{font-size:19px;margin:6px 2px 2px}
    .sub{color:var(--muted);font-size:13px;margin:0 2px 14px}
    label{display:block;font-size:12px;color:var(--muted);margin:12px 2px 5px;text-transform:uppercase;letter-spacing:.5px}
    input,select{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:11px;padding:13px 13px;color:var(--text);font-size:15px}
    input:focus,select:focus{outline:none;border-color:var(--accent)}
    button{width:100%;border:none;border-radius:13px;padding:15px;font-size:15px;font-weight:700;cursor:pointer;background:var(--grad);color:#fff;box-shadow:0 8px 22px rgba(47,107,255,.30)}
    button.ghost{background:var(--bg);color:var(--text);border:1px solid var(--line);box-shadow:none}
    button:disabled{opacity:.6}
    .hero{background:var(--grad);color:#fff;padding:18px;position:relative}
    .hero .acct{font-family:ui-monospace,Menlo,monospace;font-size:12px;opacity:.85;margin-top:2px}
    .hero .nm{font-size:24px;font-weight:800;line-height:1.1;margin-top:2px}
    .badge{position:absolute;top:14px;right:14px;background:#ffffff22;border:1px solid #ffffff55;color:#fff;font-weight:700;font-size:12px;padding:5px 10px;border-radius:20px}
    .badge.bad{background:#ef5a6f;color:#fff;border-color:transparent}
    .chips{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
    .chip{background:#ffffff1f;border:1px solid #ffffff33;color:#fff;font-size:12px;font-weight:600;padding:5px 10px;border-radius:9px}
    .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:var(--line);border-top:1px solid var(--line)}
    .grid3>div{background:var(--card);padding:12px 10px}
    .grid3 .k{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
    .grid3 .v{font-size:14px;font-weight:700;margin-top:3px}
    .wallet{display:flex;align-items:center;justify-content:space-between;background:var(--card2);border:1px dashed var(--line);border-radius:13px;padding:13px 14px;margin:14px 0}
    .wallet .bal{font-size:22px;font-weight:800;color:var(--accent2)}
    .acts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px}
    .acts button{font-size:14px;padding:14px 10px}
    .due{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin:14px 2px 6px}
    .bar{height:8px;border-radius:6px;background:var(--bg);overflow:hidden}.bar>i{display:block;height:100%;background:linear-gradient(90deg,#ef5a6f,#f0a23b)}
    .plan{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--line);border-radius:13px;padding:14px;margin-bottom:10px;cursor:pointer;background:var(--bg)}
    .plan:hover{border-color:var(--accent)}
    .plan.cur{border-color:var(--accent);box-shadow:0 0 0 2px rgba(47,107,255,.30) inset}
    .plan .nm{font-weight:700}.plan .sp{font-size:12px;color:var(--muted);margin-top:2px}
    .plan .pr{font-size:17px;font-weight:800;white-space:nowrap}.plan .va{font-size:11px;color:var(--muted);text-align:right}
    .tag{display:inline-block;background:var(--accent);color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;margin-left:6px}
    .seg{display:flex;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:4px;margin-bottom:14px}
    .seg button{background:transparent;color:var(--muted);box-shadow:none;padding:9px;border-radius:9px}
    .seg button.on{background:var(--grad);color:#fff}
    .qrwrap{background:#fff;border-radius:14px;padding:14px;text-align:center;margin:8px 0}
    .qrwrap img{max-width:220px;width:100%}
    .amt{display:flex;justify-content:space-between;align-items:center;background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:13px 14px;margin:6px 0 14px}
    .amt .big{font-size:24px;font-weight:800}
    .how{font-size:12.5px;color:var(--muted);line-height:1.7;padding-left:18px;margin:6px 0}
    .center{text-align:center}
    .ok-ring{width:78px;height:78px;border-radius:50%;background:var(--grad);display:flex;align-items:center;justify-content:center;font-size:38px;color:#fff;margin:8px auto 14px}
    .refbox{display:flex;align-items:center;gap:10px;background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:13px;margin:14px 0;font-family:ui-monospace,monospace}
    .hide{display:none}
    .note{font-size:12px;color:var(--muted);margin-top:10px;text-align:center}
    .err{color:var(--bad);font-size:13px;margin-top:8px}
    .drop{border:2px dashed var(--line);border-radius:13px;padding:22px;text-align:center;color:var(--muted);font-size:13px;cursor:pointer}
    .back{background:none;color:var(--muted);box-shadow:none;width:auto;padding:8px;font-weight:600}
    a.link{color:var(--accent2);text-decoration:none;font-size:13px}
  </style></head><body>
  <div class="pubbar"><a class="pubmenu" href="/welcome">← Menu</a><button class="pubtheme" id="pubtheme" onclick="togglePubTheme()" aria-label="Toggle theme">🌙</button></div>
  <div class="topbar"><div class="logo" id="lg">≈</div><div><b id="biz">Internet</b><div style="font-size:11px;color:var(--muted)" id="acctTag"></div></div></div>
  <script>
    (function(){var s=null;try{s=localStorage.getItem("jns_theme");}catch(e){}var t=s||"dark";document.documentElement.setAttribute("data-theme",t);window.addEventListener("DOMContentLoaded",function(){var b=document.getElementById("pubtheme");if(b)b.textContent=t==="dark"?"🌙":"☀️";});window.togglePubTheme=function(){var c=document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark";document.documentElement.setAttribute("data-theme",c);try{localStorage.setItem("jns_theme",c);}catch(e){}var b=document.getElementById("pubtheme");if(b)b.textContent=c==="dark"?"🌙":"☀️";};})();
  </script>
  <div class="wrap">

    <!-- LOGIN / LOOKUP -->
    <div class="card" id="screen-login"><div class="pad">
      <h1>Sign in to your account</h1>
      <p class="sub">Enter your account username, IPoE account no., or registered mobile number.</p>
      <label>Account</label>
      <input id="u" placeholder="e.g. juan.delacruz / IPOE-0001 / 0917…" autocapitalize="off">
      <div style="height:12px"></div>
      <button onclick="lookup()">Check my account</button>
      <div class="err hide" id="loginErr"></div>
    </div></div>

    <!-- ACCOUNT STATUS -->
    <div class="card hide" id="screen-acct">
      <div class="hero">
        <div style="font-size:11px;letter-spacing:1px;opacity:.8;text-transform:uppercase">Subscriber</div>
        <div class="nm" id="a-name">—</div>
        <div class="acct" id="a-acct">—</div>
        <div class="badge" id="a-badge">ACTIVE</div>
        <div class="chips"><span class="chip" id="a-conn">PPPoE</span><span class="chip" id="a-plan">—</span></div>
      </div>
      <div class="grid3">
        <div><div class="k">Plan rate</div><div class="v" id="a-rate">—</div></div>
        <div><div class="k">Due date</div><div class="v" id="a-due">—</div></div>
        <div><div class="k">Last payment</div><div class="v" id="a-last">—</div></div>
      </div>
      <div class="pad">
        <div class="wallet"><div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Wallet balance</div><div class="bal" id="a-wallet">₱0</div></div><button style="width:auto;padding:11px 16px" onclick="go('topup')">Top up</button></div>
        <div class="due"><span id="a-duelabel">Status</span><span id="a-dueval"></span></div>
        <div class="bar"><i id="a-bar" style="width:30%"></i></div>
        <label>Actions</label>
        <button onclick="go('plans')">⟳ Renew / Change plan</button>
        <div class="acts">
          <button class="ghost" onclick="go('pay')">Pay bill</button>
          <button class="ghost" onclick="renewWallet(this)">Renew from wallet</button>
        </div>
        <div class="acts">
          <button class="ghost" onclick="go('help')">Support ticket</button>
          <button class="ghost" onclick="resetPortal()">Check another account</button>
        </div>
        <div class="err hide" id="acctErr"></div>
        <div class="note" id="acctMsg"></div>
      </div>
    </div>

    <!-- CHOOSE PLAN -->
    <div class="card hide" id="screen-plans"><div class="pad">
      <button class="back" onclick="go('acct')">← Back</button>
      <h1>Choose your plan</h1>
      <p class="sub">Select a plan to renew or change your connection.</p>
      <div id="planList"></div>
      <div class="note">Your plan activates immediately after payment is confirmed.</div>
    </div></div>

    <!-- PAY (QR + submit reference) -->
    <div class="card hide" id="screen-pay"><div class="pad">
      <button class="back" onclick="go('acct')">← Back</button>
      <h1>Pay your bill</h1>
      <div class="seg"><button id="seg-gcash" class="on" onclick="payTab('gcash')">GCash</button><button id="seg-maya" onclick="payTab('maya')">Maya</button></div>
      <div class="amt"><div><div style="font-size:11px;color:var(--muted);text-transform:uppercase">Amount due</div><div class="big" id="p-amt">₱0</div></div><span class="chip" style="background:var(--card2);border:1px solid var(--line);color:var(--muted)" id="p-tag">Internet bill</span></div>
      <div class="qrwrap" id="p-qrwrap"><img id="p-qr" alt="QR"><div id="p-noqr" style="color:#333;font-size:13px;display:none">Send to the number below</div></div>
      <div class="center" style="font-size:13px;color:var(--muted)" id="p-num"></div>
      <label>How to pay</label>
      <ol class="how"><li>Open your e-wallet app</li><li>Scan the QR or send to the number above</li><li>Enter the exact amount</li><li>Note your <b>Reference Number</b></li><li>Tap below and submit it</li></ol>
      <button onclick="go('submit')">I've paid · Submit reference</button>
    </div></div>

    <!-- SUBMIT REFERENCE + RECEIPT -->
    <div class="card hide" id="screen-submit"><div class="pad">
      <button class="back" onclick="go('pay')">← Back</button>
      <h1>Submit your payment</h1>
      <div class="amt"><div><div style="font-size:11px;color:var(--muted);text-transform:uppercase">Amount paid</div><div class="big" id="s-amt">₱0</div></div><span class="chip" id="s-step" style="background:var(--card2);border:1px solid var(--line);color:var(--muted)">Step 2 of 2</span></div>
      <label>Upload receipt photo (recommended)</label>
      <div class="drop" id="s-drop" onclick="document.getElementById('s-file').click()">⬆<br>Tap to choose photo<br><span style="font-size:11px">JPG, PNG · max 10MB</span></div>
      <input type="file" id="s-file" accept="image/*" class="hide" onchange="pickFile()">
      <div id="s-fname" class="note"></div>
      <label>Reference number *</label>
      <input id="s-ref" placeholder="e.g. 1234 5678 901" inputmode="numeric">
      <div style="height:12px"></div>
      <button onclick="submitPay(this)">→ Submit payment</button>
      <div class="err hide" id="s-err"></div>
    </div></div>

    <!-- TOP-UP WALLET -->
    <div class="card hide" id="screen-topup"><div class="pad">
      <button class="back" onclick="go('acct')">← Back</button>
      <h1>Top up wallet</h1>
      <p class="sub">Add credit to your wallet. Pay via GCash/Maya, then submit the amount + reference. It's instant if we auto-match your payment, otherwise it's credited once verified.</p>
      <div class="seg"><button id="tseg-gcash" class="on" onclick="payTab('gcash')">GCash</button><button id="tseg-maya" onclick="payTab('maya')">Maya</button></div>
      <div class="qrwrap" id="t-qrwrap"><img id="t-qr" alt="QR"><div id="t-noqr" style="color:#333;font-size:13px;display:none">Send to the number below</div></div>
      <div class="center" style="font-size:13px;color:var(--muted)" id="t-num"></div>
      <label>Amount topped up (₱) *</label>
      <input id="t-amt" type="number" inputmode="numeric" placeholder="e.g. 500">
      <label>Reference number *</label>
      <input id="t-ref" placeholder="e.g. 1234 5678 901" inputmode="numeric">
      <label>Receipt photo (recommended)</label>
      <div class="drop" id="t-drop" onclick="document.getElementById('t-file').click()">⬆ Tap to choose photo</div>
      <input type="file" id="t-file" accept="image/*" class="hide" onchange="pickFileT()">
      <div id="t-fname" class="note"></div>
      <div style="height:12px"></div>
      <button onclick="submitTopup(this)">Add to wallet</button>
      <div class="err hide" id="t-err"></div>
    </div></div>

    <!-- SUCCESS -->
    <div class="card hide" id="screen-done"><div class="pad center">
      <div class="ok-ring">✓</div>
      <h1 style="text-align:center" id="d-title">Payment Submitted!</h1>
      <p class="sub" style="text-align:center" id="d-msg">Your proof of payment has been sent to the admin.</p>
      <div class="refbox hide" id="d-refbox"><span style="color:var(--accent2)">✓</span><div><div style="font-size:10px;color:var(--muted);text-transform:uppercase">Reference no.</div><div id="d-ref">—</div></div></div>
      <button class="ghost" onclick="afterDone()">Done</button>
    </div></div>

    <!-- HELP (ticket) -->
    <div class="card hide" id="screen-help"><div class="pad">
      <button class="back" onclick="go('acct')">← Back</button>
      <h1>Support ticket</h1>
      <label>Your concern</label>
      <input id="h-msg" placeholder="Describe the problem…">
      <div style="height:12px"></div>
      <button onclick="submitHelp(this)">Send ticket</button>
      <div class="note" id="h-out"></div>
    </div></div>

  </div>
  <script>
    var $=function(id){return document.getElementById(id)};
    function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
    var ME=null, PAY=null, TAB="gcash", IMG="", TIMG="", PEN=0;
    var pre=new URLSearchParams(location.search).get("u")||"";
    function pesos(n){return "\\u20B1"+(Number(n)||0).toLocaleString()}
    function show(id){["login","acct","plans","pay","submit","topup","done","help"].forEach(function(s){$("screen-"+s).classList.toggle("hide",s!==id)});window.scrollTo(0,0)}
    function go(id){ if(id==="pay"||id==="submit"){$("p-amt").textContent=pesos(PEN);$("s-amt").textContent=pesos(PEN);} if(id==="plans")renderPlans(); if(id==="topup"||id==="pay")paintQR(); show(id)}
    function resetPortal(){ME=null;$("u").value="";show("login")}
    function fileToDataUrl(f){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(r.result)};r.onerror=rej;r.readAsDataURL(f)})}

    async function lookup(){
      var u=$("u").value.trim(); if(!u)return;
      $("loginErr").classList.add("hide");
      var r=await fetch("/api/pay/lookup?u="+encodeURIComponent(u)).then(function(x){return x.json()});
      PAY=r.pay||{}; $("biz").textContent=r.biz||"Internet"; if(r.logo){$("lg").innerHTML='<img src="'+r.logo+'" style="width:100%;height:100%;border-radius:8px;object-fit:cover">'}
      if(!r.customer){$("loginErr").textContent="Account not found. Check your username / account no. / mobile.";$("loginErr").classList.remove("hide");return}
      ME=r.customer; PEN=(r.invoices&&r.invoices[0]?r.invoices[0].amount:ME.plan_price)||0;
      paintAcct(); show("acct");
    }
    function paintAcct(){
      $("a-name").textContent=ME.name; $("a-acct").textContent=ME.account; $("acctTag").textContent=ME.account;
      $("a-conn").textContent=(ME.conn_type==="ipoe"?"IPoE":(ME.conn_type==="hotspot"?"Hotspot":"PPPoE"));
      $("a-plan").textContent=ME.plan_name||"—";
      $("a-rate").textContent=ME.plan_speed||"—";
      $("a-due").textContent=ME.expiry?ME.expiry.slice(0,10):"—";
      $("a-last").textContent=ME.last_payment||"—";
      $("a-wallet").textContent=pesos(ME.wallet);
      var exp=(ME.status||"active").toLowerCase()!=="active";
      var b=$("a-badge"); b.textContent=exp?"ACCOUNT EXPIRED":"ACTIVE"; b.classList.toggle("bad",exp);
      $("a-duelabel").textContent=exp?"Expired":"Active until"; $("a-dueval").textContent=ME.expiry?ME.expiry.slice(0,10):"—";
      $("a-bar").style.width=exp?"100%":"30%";
    }
    function payTab(t){TAB=t;["seg-gcash","seg-maya","tseg-gcash","tseg-maya"].forEach(function(id){var e=$(id);if(e)e.classList.toggle("on",id.indexOf(t)>=0)});paintQR()}
    function paintQR(){
      var qr=TAB==="maya"?PAY.maya_qr:PAY.gcash_qr;
      var num=TAB==="maya"?(PAY.maya_number||PAY.maya_name):(PAY.gcash_number||PAY.gcash_name);
      [["p-qr","p-noqr","p-num"],["t-qr","t-noqr","t-num"]].forEach(function(ids){
        var img=$(ids[0]),no=$(ids[1]),nm=$(ids[2]); if(!img)return;
        if(qr){img.src=qr;img.style.display="";no.style.display="none"}else{img.style.display="none";no.style.display=""}
        nm.textContent=num?("Send to: "+num):"";
      });
    }
    function renderPlans(){
      fetch("/api/pay/plans?type="+(ME&&ME.conn_type?ME.conn_type:"")).then(function(x){return x.json()}).then(function(r){
        var list=$("planList"); var ps=(r.plans||[]);
        if(!ps.length){list.innerHTML='<div class="note">No plans available right now.</div>';return}
        list.innerHTML=ps.map(function(p){
          var cur=ME&&p.name===ME.plan_name;
          return '<div class="plan'+(cur?' cur':'')+'" onclick="pickPlan('+p.id+','+p.price+")\\">"+
            '<div><div class="nm">'+esc(p.name)+(cur?'<span class="tag">CURRENT PLAN</span>':'')+'</div><div class="sp">'+esc(p.speed||"")+'</div></div>'+
            '<div><div class="pr">'+pesos(p.price)+'</div><div class="va">'+(p.days||0)+' days</div></div></div>';
        }).join("");
      });
    }
    function pickPlan(id,price){ PEN=price; go("pay"); }
    function pickFile(){ var f=$("s-file").files[0]; if(f){$("s-fname").textContent="📎 "+f.name; fileToDataUrl(f).then(function(d){IMG=d})} }
    function pickFileT(){ var f=$("t-file").files[0]; if(f){$("t-fname").textContent="📎 "+f.name; fileToDataUrl(f).then(function(d){TIMG=d})} }

    async function submitPay(btn){
      var ref=$("s-ref").value.trim();
      if(!ref && !IMG){$("s-err").textContent="Enter your reference number or attach a receipt.";$("s-err").classList.remove("hide");return}
      $("s-err").classList.add("hide"); btn.disabled=true; btn.textContent="Submitting…";
      var body={username:ME.account,account:ME.account,customer_id:ME.id,reference:ref,note:"via portal",image:IMG};
      var r=await fetch("/api/pay/proof",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(x){return x.json()});
      btn.disabled=false; btn.textContent="→ Submit payment";
      if(!r.ok){$("s-err").textContent=r.error||"Failed";$("s-err").classList.remove("hide");return}
      $("d-title").textContent=r.message&&r.message.indexOf("Confirmed")>=0?"Payment Confirmed!":"Payment Submitted!";
      $("d-msg").textContent=r.message||"Your proof was sent. Your account updates once verified.";
      if(ref){$("d-ref").textContent="Ref: "+ref;$("d-refbox").classList.remove("hide")}else{$("d-refbox").classList.add("hide")}
      show("done");
    }
    async function submitTopup(btn){
      var amt=Number($("t-amt").value||0), ref=$("t-ref").value.trim();
      if(!amt){$("t-err").textContent="Enter the amount you topped up.";$("t-err").classList.remove("hide");return}
      if(!ref && !TIMG){$("t-err").textContent="Enter the reference number or attach a receipt.";$("t-err").classList.remove("hide");return}
      $("t-err").classList.add("hide"); btn.disabled=true; btn.textContent="Submitting…";
      var r=await fetch("/api/pay/topup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account:ME.account,customer_id:ME.id,amount:amt,reference:ref,image:TIMG})}).then(function(x){return x.json()});
      btn.disabled=false; btn.textContent="Add to wallet";
      if(!r.ok){$("t-err").textContent=r.error||"Failed";$("t-err").classList.remove("hide");return}
      if(r.instant && r.wallet!=null){ME.wallet=r.wallet}
      $("d-title").textContent=r.instant?"Wallet Topped Up!":"Top-up Submitted!";
      $("d-msg").textContent=r.message||"Your wallet updates once verified.";
      if(ref){$("d-ref").textContent="Ref: "+ref;$("d-refbox").classList.remove("hide")}else{$("d-refbox").classList.add("hide")}
      show("done");
    }
    async function renewWallet(btn){
      $("acctErr").classList.add("hide"); $("acctMsg").textContent="";
      if(!confirm("Use your wallet balance ("+pesos(ME.wallet)+") to renew "+(ME.plan_name||"your plan")+"?"))return;
      btn.disabled=true;
      var r=await fetch("/api/pay/renew-wallet",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account:ME.account})}).then(function(x){return x.json()});
      btn.disabled=false;
      if(!r.ok){$("acctErr").textContent=r.error;$("acctErr").classList.remove("hide");return}
      ME.wallet=r.wallet; if(r.expiry){ME.expiry=r.expiry;ME.status="active"}
      paintAcct(); $("acctMsg").textContent=r.message;
    }
    function afterDone(){ if(ME){ // refresh account view
        fetch("/api/pay/lookup?u="+encodeURIComponent(ME.account)).then(function(x){return x.json()}).then(function(r){if(r.customer){ME=r.customer;PEN=(r.invoices&&r.invoices[0]?r.invoices[0].amount:ME.plan_price)||0;paintAcct()}go("acct")});
      } else show("login") }
    async function submitHelp(btn){
      var m=$("h-msg").value.trim(); if(!m){$("h-out").textContent="Please describe your concern.";return}
      btn.disabled=true; $("h-out").textContent="Sending…";
      var r=await fetch("/api/helpdesk",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:ME?ME.name:"",contact:"",message:m})}).then(function(x){return x.json()});
      btn.disabled=false; $("h-out").textContent=r.ok?(r.message||"Sent! We'll get back to you."):(r.error||"Failed");
    }
    if(pre){$("u").value=pre;lookup()}
  </script></body></html>`;
}

function applyPageHtml() {
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Apply for Internet Installation</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0c1322">
  <link rel="manifest" href="/apply-manifest.webmanifest">
  <meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <script>if("serviceWorker" in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});}</script>
  <style>
    :root{--bg:#0c1322;--card:#131c30;--card2:#1a2540;--line:#243250;--text:#e9eef8;--muted:#8fa0bd;--accent:#3b82f6;--accent2:#5b9dff;--grad:#2f6bff;--ok:#2dd482;--warn:#ff5d6d;--radius:16px}
    [data-theme="light"]{--bg:#eef2f8;--card:#ffffff;--card2:#f3f6fb;--line:#e6ebf3;--text:#0e1726;--muted:#5b6b86;--accent:#2746d8;--accent2:#1564c0;--grad:#2746d8;--ok:#0f9d58;--warn:#b9770a}
    .pubbar{position:sticky;top:0;z-index:60;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bg)}
    .pubmenu{display:inline-flex;align-items:center;gap:4px;background:var(--card2);border:1px solid var(--line);color:var(--text);text-decoration:none;font-size:13px;font-weight:700;padding:8px 14px;border-radius:20px}
    .pubtheme{background:var(--card2);border:1px solid var(--line);color:var(--text);width:40px;height:40px;border-radius:50%;font-size:18px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
    *{box-sizing:border-box}
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:radial-gradient(1200px 500px at 50% -8%,#16264a 0%,transparent 60%),var(--bg);color:var(--text);min-height:100vh}
    .topbar{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line);background:#0a1120}
    .topbar .logo{width:30px;height:30px;border-radius:8px;background:var(--grad);display:flex;align-items:center;justify-content:center;font-weight:800}
    .wrap{max-width:480px;margin:0 auto;padding:18px 14px 60px}
    .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin-bottom:14px;box-shadow:0 14px 40px rgba(0,0,0,.35)}
    .pad{padding:18px}
    h1{font-size:20px;margin:4px 2px 2px}
    .sub{color:var(--muted);font-size:13px;margin:0 2px 14px}
    label{display:block;font-size:12px;color:var(--muted);margin:12px 2px 5px;text-transform:uppercase;letter-spacing:.5px}
    input,select,textarea{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:11px;padding:13px;color:var(--text);font-size:15px;font-family:inherit}
    input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
    button{width:100%;border:none;border-radius:13px;padding:15px;font-size:15px;font-weight:700;cursor:pointer;background:var(--grad);color:#fff;box-shadow:0 8px 22px rgba(47,107,255,.30)}
    button.ghost{background:var(--bg);color:var(--text);border:1px solid var(--line);box-shadow:none}
    button:disabled{opacity:.6}
    .row{display:flex;gap:10px}.row>*{flex:1}
    .pin{background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:13px;margin-top:6px;font-size:13px;color:var(--muted)}
    .pin.set{color:var(--ok);border-color:var(--ok)}
    .charges{background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:14px;margin:8px 0}
    .charges .ln{display:flex;justify-content:space-between;font-size:14px;padding:3px 0}
    .charges .tot{display:flex;justify-content:space-between;font-weight:800;font-size:17px;border-top:1px solid var(--line);margin-top:6px;padding-top:8px}
    .seg{display:flex;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:4px;margin:6px 0}
    .seg button{background:transparent;color:var(--muted);box-shadow:none;padding:11px;border-radius:9px;font-size:13px}
    .seg button.on{background:var(--grad);color:#fff}
    .qrwrap{background:#fff;border-radius:12px;padding:12px;text-align:center;margin:8px 0}.qrwrap img{max-width:180px;width:100%}
    .agree{display:flex;gap:10px;align-items:flex-start;background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:13px;margin:14px 0;font-size:12.5px;color:var(--muted);line-height:1.5}
    .agree input{width:20px;height:20px;flex:none;margin-top:1px}
    .drop{border:2px dashed var(--line);border-radius:12px;padding:18px;text-align:center;color:var(--muted);font-size:13px;cursor:pointer}
    .err{color:var(--warn);font-size:13px;margin-top:8px}
    .hide{display:none}
    .ok-ring{width:78px;height:78px;border-radius:50%;background:var(--grad);display:flex;align-items:center;justify-content:center;font-size:38px;color:#fff;margin:8px auto 14px}
    .center{text-align:center}
    .muted{color:var(--muted);font-size:12px}
  </style></head><body>
  <div class="pubbar"><a class="pubmenu" href="/welcome">← Menu</a><button class="pubtheme" id="pubtheme" onclick="togglePubTheme()" aria-label="Toggle theme">🌙</button></div>
  <div class="topbar"><div class="logo" id="lg">≈</div><div><b id="biz">Internet Service</b><div class="muted">New connection application</div></div></div>
  <script>
    (function(){var s=null;try{s=localStorage.getItem("jns_theme");}catch(e){}var t=s||"dark";document.documentElement.setAttribute("data-theme",t);window.addEventListener("DOMContentLoaded",function(){var b=document.getElementById("pubtheme");if(b)b.textContent=t==="dark"?"🌙":"☀️";});window.togglePubTheme=function(){var c=document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark";document.documentElement.setAttribute("data-theme",c);try{localStorage.setItem("jns_theme",c);}catch(e){}var b=document.getElementById("pubtheme");if(b)b.textContent=c==="dark"?"🌙":"☀️";};})();
  </script>
  <div class="wrap">

    <div class="card" id="form-card"><div class="pad">
      <h1>Apply for Internet</h1>
      <p class="sub">Fill in your details and pin your location. We'll contact you to schedule the installation.</p>

      <label>Full name *</label><input id="f-name" placeholder="Juan Dela Cruz">
      <div class="row"><div><label>Mobile number *</label><input id="f-contact" placeholder="0917…" inputmode="tel"></div><div><label>Email (optional)</label><input id="f-email" placeholder="you@email.com"></div></div>
      <label>Installation address *</label><textarea id="f-address" rows="2" placeholder="Purok, Barangay, Town"></textarea>
      <label>Area / Sitio (optional)</label><input id="f-area" placeholder="e.g. Poblacion">

      <label>Plan you want</label><select id="f-plan"><option value="">— choose a plan —</option></select>

      <label>Pin your location</label>
      <button class="ghost" type="button" onclick="getLoc()">📍 Use my current location</button>
      <div class="pin" id="f-pin">No location pinned yet. Tap the button above (allow location access), or enter coordinates below.</div>
      <div class="row" style="margin-top:8px"><div><input id="f-lat" placeholder="latitude" inputmode="decimal"></div><div><input id="f-lng" placeholder="longitude" inputmode="decimal"></div></div>

      <label>Notes (optional)</label><textarea id="f-notes" rows="2" placeholder="Landmark, preferred schedule, etc."></textarea>

      <label>Charges</label>
      <div class="charges">
        <div class="ln"><span>Installation fee</span><span id="c-fee">\u20B10</span></div>
        <div class="ln"><span>Router / equipment</span><span id="c-router">\u20B10</span></div>
        <div class="tot"><span>Total</span><span id="c-total">\u20B10</span></div>
      </div>

      <label>Payment</label>
      <div class="seg"><button type="button" id="seg-later" class="on" onclick="payChoice('on_install')">Pay on install day</button><button type="button" id="seg-now" onclick="payChoice('now')">Pay now</button></div>

      <div id="pay-now-box" class="hide">
        <div class="seg"><button type="button" id="m-gcash" class="on" onclick="payTab('gcash')">GCash</button><button type="button" id="m-maya" onclick="payTab('maya')">Maya</button></div>
        <div class="qrwrap" id="qrwrap"><img id="qr" alt="QR"><div id="noqr" style="color:#333;font-size:13px;display:none">Send to the number below</div></div>
        <div class="center muted" id="paynum"></div>
        <label>Reference number</label><input id="f-ref" placeholder="e.g. 1234 5678 901" inputmode="numeric">
        <label>Receipt photo</label>
        <div class="drop" onclick="document.getElementById('f-proof').click()">⬆ Tap to attach your receipt</div>
        <input type="file" id="f-proof" accept="image/*" class="hide" onchange="pickProof()"><div id="proofname" class="muted" style="margin-top:6px"></div>
      </div>

      <div class="agree"><input type="checkbox" id="f-agree"><label for="f-agree" style="margin:0;text-transform:none;letter-spacing:0;color:var(--muted);font-size:12.5px" id="agree-text">I confirm the information is correct and agree to the terms.</label></div>

      <button onclick="submitApply(this)">Submit application</button>
      <div class="err hide" id="err"></div>
    </div></div>

    <div class="card hide" id="done-card"><div class="pad center">
      <div class="ok-ring">✓</div>
      <h1 style="text-align:center">Application Received!</h1>
      <p class="sub" style="text-align:center" id="done-msg">We'll contact you shortly to schedule your installation.</p>
    </div></div>

  </div>
  <script>
    var $=function(id){return document.getElementById(id)};
    function esc(s){return String(s==null?"":s)}
    var INFO=null, PC="on_install", TAB="gcash", PROOF="";
    function pesos(n){return "\\u20B1"+(Number(n)||0).toLocaleString()}
    fetch("/api/apply/info").then(function(r){return r.json()}).then(function(d){
      INFO=d; $("biz").textContent=d.biz||"Internet Service";
      if(d.logo){$("lg").innerHTML='<img src="'+d.logo+'" style="width:100%;height:100%;border-radius:8px;object-fit:cover">'}
      $("c-fee").textContent=pesos(d.install_fee); $("c-router").textContent=pesos(d.router_cost);
      $("c-total").textContent=pesos((d.install_fee||0)+(d.router_cost||0));
      $("f-plan").innerHTML='<option value="">— choose a plan —</option>'+(d.plans||[]).map(function(p){return '<option value="'+p.id+'">'+esc(p.name)+(p.speed?' · '+esc(p.speed):'')+' · '+pesos(p.price)+'</option>'}).join("");
      if(d.agreement)$("agree-text").textContent=d.agreement;
      paintQR();
    });
    function getLoc(){
      if(!navigator.geolocation){$("f-pin").textContent="Location not supported on this device — enter coordinates manually.";return}
      $("f-pin").textContent="Getting your location…";
      navigator.geolocation.getCurrentPosition(function(pos){
        var la=pos.coords.latitude.toFixed(6), ln=pos.coords.longitude.toFixed(6);
        $("f-lat").value=la; $("f-lng").value=ln;
        $("f-pin").textContent="📍 Location pinned: "+la+", "+ln; $("f-pin").classList.add("set");
      },function(e){$("f-pin").textContent="Couldn't get location ("+e.message+"). Please enter coordinates manually or describe in notes.";});
    }
    function payChoice(c){PC=c;$("seg-now").classList.toggle("on",c==="now");$("seg-later").classList.toggle("on",c==="on_install");$("pay-now-box").classList.toggle("hide",c!=="now")}
    function payTab(t){TAB=t;$("m-gcash").classList.toggle("on",t==="gcash");$("m-maya").classList.toggle("on",t==="maya");paintQR()}
    function paintQR(){
      if(!INFO)return; var p=INFO.pay||{};
      var qr=TAB==="maya"?p.maya_qr:p.gcash_qr, num=TAB==="maya"?(p.maya_number||p.maya_name):(p.gcash_number||p.gcash_name);
      if(qr){$("qr").src=qr;$("qr").style.display="";$("noqr").style.display="none"}else{$("qr").style.display="none";$("noqr").style.display=""}
      $("paynum").textContent=num?("Send to: "+num):"";
    }
    function pickProof(){var f=$("f-proof").files[0];if(f){$("proofname").textContent="📎 "+f.name;var r=new FileReader();r.onload=function(){PROOF=r.result};r.readAsDataURL(f)}}
    async function submitApply(btn){
      var name=$("f-name").value.trim(), contact=$("f-contact").value.trim();
      if(!name){return showErr("Please enter your name.")}
      if(!contact){return showErr("Please enter your mobile number.")}
      if(!$("f-address").value.trim()){return showErr("Please enter your installation address.")}
      if(!$("f-agree").checked){return showErr("Please tick the agreement box to continue.")}
      $("err").classList.add("hide"); btn.disabled=true; btn.textContent="Submitting…";
      var body={name:name,contact:contact,email:$("f-email").value.trim(),address:$("f-address").value.trim(),area:$("f-area").value.trim(),
        lat:$("f-lat").value.trim(),lng:$("f-lng").value.trim(),plan_id:$("f-plan").value||null,notes:$("f-notes").value.trim(),
        pay_choice:PC,pay_reference:PC==="now"?$("f-ref").value.trim():"",pay_proof:PC==="now"?PROOF:"",agreed:true};
      var r=await fetch("/api/apply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(x){return x.json()});
      btn.disabled=false; btn.textContent="Submit application";
      if(!r.ok){return showErr(r.error||"Submission failed.")}
      $("done-msg").textContent=r.message||"We'll contact you shortly."; $("form-card").classList.add("hide"); $("done-card").classList.remove("hide"); window.scrollTo(0,0);
    }
    function showErr(m){$("err").textContent=m;$("err").classList.remove("hide");window.scrollTo(0,document.body.scrollHeight)}
  </script></body></html>`;
}

// ---- Invoice rendering (printable HTML + plain text for email) -----------
function pesos(n) { return "\u20B1" + (Number(n) || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function receiptHtml(p) {
  const s = Settings.all();
  const biz = s.biz_name || "Internet Service";
  const E = (x) => escapeHtml(x == null ? "" : x);
  const no = "OR-" + String(p.id).padStart(5, "0");
  const when = String(p.paid_at || "").replace("T", " ").slice(0, 16);
  const peso = (n) => "₱" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${E(no)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;padding:18px;background:#f3f4f6}
    .r{max-width:420px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:10px;padding:22px}
    .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:12px}
    .biz{font-size:18px;font-weight:800} .sub{font-size:11px;color:#666;margin-top:2px;white-space:pre-line}
    .tag{font-size:12px;font-weight:700;color:#111;text-align:right} .tag b{font-size:14px}
    .row{display:flex;justify-content:space-between;font-size:13px;margin:5px 0}
    .k{color:#666} .amt{font-size:22px;font-weight:800;text-align:center;margin:14px 0;padding:10px;background:#f6f7f9;border-radius:8px}
    .ft{font-size:11px;color:#777;text-align:center;margin-top:14px;border-top:1px dashed #ccc;padding-top:10px}
    .btns{max-width:420px;margin:12px auto 0;text-align:center} button{padding:9px 16px;border:none;border-radius:8px;background:#111;color:#fff;font-weight:700;cursor:pointer}
    @media print{body{background:#fff;padding:0}.r{border:none}.btns{display:none}}
  </style></head><body>
  <div class="r">
    <div class="top">
      <div><div class="biz">${E(biz)}</div><div class="sub">${E(s.biz_address || "")}${s.biz_contact ? "\n" + E(s.biz_contact) : ""}</div></div>
      <div class="tag">OFFICIAL RECEIPT<br><b>${E(no)}</b><br><span style="color:#666;font-weight:400">${E(when)}</span></div>
    </div>
    <div class="row"><span class="k">Received from</span><span><b>${E(p.customer_name || "Walk-in")}</b></span></div>
    ${p.customer_username ? `<div class="row"><span class="k">Account</span><span>${E(p.customer_username)}</span></div>` : ""}
    <div class="row"><span class="k">For</span><span>${p.invoice_id ? "Invoice #" + p.invoice_id : "Internet service"}</span></div>
    <div class="row"><span class="k">Method</span><span>${E((p.method || "cash").toUpperCase())}</span></div>
    ${p.reference ? `<div class="row"><span class="k">Reference</span><span>${E(p.reference)}</span></div>` : ""}
    <div class="amt">${peso(p.amount)}</div>
    <div class="ft">Received with thanks. This is a system-generated receipt.</div>
  </div>
  <div class="btns"><button onclick="print()">Print</button></div>
  </body></html>`;
}

function invoiceText(inv) {
  const s = Settings.all();
  return [
    `${s.biz_name || "Internet Service"} — Invoice`,
    `Billing period: ${inv.period}`,
    `Customer: ${inv.customer_name} (${inv.username || ""})`,
    `Amount due: ${pesos(inv.amount)}`,
    `Due date: ${inv.due_date || ""}`,
    `Status: ${inv.status}`,
    s.gcash_number ? `\nPay via GCash: ${s.gcash_name || ""} ${s.gcash_number} — reference INV-${inv.id}` : "",
  ].join("\n");
}
function invoiceHtml(inv) {
  const s = Settings.all();
  const E = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const paid = inv.status === "paid";
  const gcash = s.gcash_number
    ? `<div class="pay"><h3>Pay via GCash</h3>
         <div><b>${E(s.gcash_name || s.biz_name || "")}</b></div>
         <div class="big">${E(s.gcash_number)}</div>
         <div>Reference: <b>INV-${inv.id}</b> — please include this in your payment note.</div></div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${E(inv.period)} — ${E(inv.customer_name)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;max-width:720px;margin:24px auto;padding:0 20px;}
    .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #111;padding-bottom:16px;}
    .biz{font-size:20px;font-weight:800;} .muted{color:#666;font-size:13px;}
    .tag{padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700;}
    .paid{background:#e6f6ec;color:#1a7f3c;} .unpaid{background:#fdeaea;color:#c0392b;}
    table{width:100%;border-collapse:collapse;margin:22px 0;} td,th{padding:10px;border-bottom:1px solid #eee;text-align:left;}
    .total{font-size:22px;font-weight:800;} .pay{margin-top:18px;padding:16px;border:2px dashed #888;border-radius:10px;background:#fafafa;}
    .pay .big{font-size:24px;font-weight:800;letter-spacing:1px;margin:4px 0;} h3{margin:0 0 8px;}
    .btn{display:inline-block;margin:18px 0;padding:10px 18px;background:#111;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;}
    @media print{.btn{display:none;}}
  </style></head><body>
  <div class="head">
    <div><div class="biz">${E(s.biz_name || "Internet Service")}</div>
      <div class="muted">${E(s.biz_address || "")}</div>
      <div class="muted">${E(s.biz_contact || "")}</div></div>
    <div style="text-align:right"><div style="font-size:18px;font-weight:700">INVOICE</div>
      <div class="muted">No. INV-${inv.id}</div>
      <div class="tag ${paid ? "paid" : "unpaid"}">${paid ? "PAID" : "UNPAID"}</div></div>
  </div>
  <table>
    <tr><th>Billed to</th><td>${E(inv.customer_name)}${inv.username ? " (" + E(inv.username) + ")" : ""}<br><span class="muted">${E(inv.address || "")}</span></td></tr>
    <tr><th>Plan</th><td>${E(inv.plan_name || "—")}</td></tr>
    <tr><th>Billing period</th><td>${E(inv.period)}</td></tr>
    <tr><th>Due date</th><td>${E(inv.due_date || "—")}</td></tr>
    <tr><th>Amount due</th><td class="total">${pesos(inv.amount)}</td></tr>
  </table>
  ${gcash}
  <button class="btn" onclick="window.print()">Print / Save as PDF</button>
  </body></html>`;
}

// ---- Router user & profile management ------------------------------------
function genVoucherCode(len, prefix) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
  let s = prefix || "";
  const n = Math.min(Math.max(Number(len) || 6, 4), 16);
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function handleRouter(req, res, pathname) {
  const sub = pathname.replace("/api/router", "");
  const b = JSON.parse((await readBody(req)) || "{}");
  const ok = (data) => send(res, 200, { ok: true, data });
  try {
    switch (sub) {
      case "/pppoe/add": return ok(await mt.createPppoe(b));
      case "/pppoe/delete": return ok(await mt.deletePppoe(b.name));
      case "/pppoe/edit": return ok(await mt.updatePppoe(b.oldName || b.name, b));
      case "/pppoe/disable": return ok(await mt.setPppoeDisabled(b.name, true));
      case "/pppoe/enable": return ok(await mt.setPppoeDisabled(b.name, false));
      case "/hotspot/add": return ok(await mt.createHotspotUser(b));
      case "/usage/snapshot": return ok(await runUsageSnapshot());
      case "/watchdog/run": return ok(await runWatchdog());
      case "/vendo-check": return ok(await runVendoCheck() || { ran: true });
      case "/net/vlan-add": {
        if (!b.name || !b.vlanId || !b.interface) return send(res, 400, { ok: false, error: "Need VLAN name, VLAN ID, and interface." });
        await mt.vlanAdd({ name: b.name, vlanId: b.vlanId, interface: b.interface });
        Audit.add({ type: "manual", action: "vlan-add", detail: `${b.name} id=${b.vlanId} on ${b.interface}`, ok: true });
        return ok({ added: true });
      }
      case "/net/vlan-remove": { if (!b.id) return send(res, 400, { ok: false, error: "id required" }); await mt.vlanRemove(b.id); return ok({ removed: true }); }
      case "/net/ip-add": {
        if (!b.address || !b.interface) return send(res, 400, { ok: false, error: "Need address (e.g. 10.0.15.1/24) and interface." });
        await mt.ipAddressAdd({ address: b.address, interface: b.interface });
        Audit.add({ type: "manual", action: "ip-add", detail: `${b.address} on ${b.interface}`, ok: true });
        return ok({ added: true });
      }
      case "/net/ip-remove": { if (!b.id) return send(res, 400, { ok: false, error: "id required" }); await mt.ipAddressRemove(b.id); return ok({ removed: true }); }
      case "/net/dhcp-add": {
        // auto-create pool + network + server for an interface/subnet
        if (!b.interface || !b.network) return send(res, 400, { ok: false, error: "Need interface and network (e.g. 10.0.15.0/24)." });
        const r = await provisionDhcp(b);
        Audit.add({ type: "manual", action: "dhcp-add", detail: `${b.interface} ${b.network} pool=${r.pool}`, ok: true });
        return ok(r);
      }
      case "/net/dhcp-set": {
        if (!b.id || !b.name) return send(res, 400, { ok: false, error: "id and new name required" });
        await mt.dhcpServerSet(b.id, { name: b.name });
        Audit.add({ type: "manual", action: "dhcp-rename", detail: `${b.id} → ${b.name}`, ok: true });
        return ok({ done: true });
      }
      case "/net/dhcp-remove": { if (!b.id) return send(res, 400, { ok: false, error: "id required" }); await mt.dhcpServerRemove(b.id); return ok({ removed: true }); }
      case "/net/hotspot-add": {
        if (!b.interface) return send(res, 400, { ok: false, error: "Choose an interface/VLAN." });
        await mt.hotspotServerAdd({ name: b.name || ("hs-" + b.interface), interface: b.interface, pool: b.pool, profile: b.profile, addressesPerMac: b.addressesPerMac });
        Audit.add({ type: "manual", action: "hotspot-add", detail: `${b.name || b.interface} on ${b.interface}`, ok: true });
        return ok({ added: true });
      }
      case "/net/hotspot-set": {
        if (!b.id) return send(res, 400, { ok: false, error: "id required" });
        await mt.hotspotServerSet(b.id, b);
        Audit.add({ type: "manual", action: "hotspot-edit", detail: `${b.id}`, ok: true });
        return ok({ done: true });
      }
      case "/net/hotspot-remove": { if (!b.id) return send(res, 400, { ok: false, error: "id required" }); await mt.hotspotServerRemove(b.id); return ok({ removed: true }); }
      case "/net/hotspot-profile-set": {
        if (!b.id) return send(res, 400, { ok: false, error: "id required" });
        await mt.hotspotProfileSet(b.id, b);
        Audit.add({ type: "manual", action: "hotspot-profile-edit", detail: `${b.id}`, ok: true });
        return ok({ done: true });
      }
      case "/net/expand": {
        // ONE-CLICK vendo expansion: VLAN → IP → pool → DHCP network+server → hotspot
        const r = await expandVlanHotspot(b);
        Audit.add({ type: "manual", action: "net-expand", detail: `VLAN ${b.vlanId} ${b.network}: ${r.steps.join(", ")}`, ok: true });
        return ok(r);
      }
      case "/net/ipoe-fw-rules": {
        // Generate the one-time RouterOS firewall rules that make the "suspended"
        // address-list actually redirect/block IPoE subscribers. No router write here —
        // we return the script text for the operator to paste in once.
        const list = IPOE_SUSPEND_LIST;
        const portal = (b.portal || (Settings.get("public_url") || "").replace(/^https?:\/\//, "").replace(/\/$/, "") || "10.0.0.1").trim();
        const portalIp = (b.portalIp || portal.split(":")[0] || "10.0.0.1").trim();
        const port = Number(b.port) || 80;
        const wan = (b.wan || "ether1").trim();
        const script = [
          "# === IPoE / PPPoE suspend rules (paste once into the MikroTik terminal) ===",
          "# Same rules as Settings -> Hotspot setup helper — all suspend types share the \"" + list + "\" address-list.",
          "# Subscribers on the \"" + list + "\" list get redirected to your pay page and blocked from the internet.",
          "",
          "# 1) Redirect their web traffic (port 80) to the captive pay page",
          "/ip firewall nat add chain=dstnat protocol=tcp dst-port=80 \\",
          "    src-address-list=" + list + " action=dst-nat to-addresses=" + portalIp + " to-ports=" + port + " \\",
          "    comment=\"IPoE/PPPoE suspended -> pay portal\"",
          "",
          "# 2) Allow them to REACH the portal + DNS (so the page and lookups load)",
          "/ip firewall filter add chain=forward src-address-list=" + list + " dst-address=" + portalIp + " action=accept comment=\"IPoE/PPPoE suspended: allow portal\"",
          "/ip firewall filter add chain=forward src-address-list=" + list + " protocol=udp dst-port=53 action=accept comment=\"IPoE/PPPoE suspended: allow DNS\"",
          "/ip firewall filter add chain=forward src-address-list=" + list + " protocol=tcp dst-port=53 action=accept comment=\"IPoE/PPPoE suspended: allow DNS-tcp\"",
          "",
          "# 3) Block everything else going OUT to the internet for suspended subscribers",
          "/ip firewall filter add chain=forward src-address-list=" + list + " out-interface=" + wan + " action=reject reject-with=icmp-network-unreachable comment=\"IPoE/PPPoE suspended: block internet\"",
          "",
          "# Tip: make sure these filter rules sit ABOVE your general 'accept established/related' allow rules,",
          "# or place the block rule early in the forward chain so it takes effect.",
        ].join("\n");
        return ok({ script, portalIp, port, wan, list });
      }
      case "/leases/static": {
        if (!b.id) return send(res, 400, { ok: false, error: "lease id required" });
        await mt.leaseMakeStatic(b.id);
        Audit.add({ type: "manual", action: "lease-static", detail: b.id, ok: true });
        return ok({ done: true });
      }
      case "/leases/set": {
        if (!b.id) return send(res, 400, { ok: false, error: "lease id required" });
        await mt.leaseSet(b.id, b);
        Audit.add({ type: "manual", action: "lease-edit", detail: `${b.id} → ${b.address || ""} ${b.mac || ""}`, ok: true });
        return ok({ done: true });
      }
      case "/bindings/add": {
        if (!b.mac && !b.address) return send(res, 400, { ok: false, error: "Give at least a MAC or an address." });
        const r2 = await mt.ipBindingAdd(b);
        Audit.add({ type: "manual", action: "ip-bind", detail: `${b.mac || b.address} type=${b.type || "bypassed"}`, ok: true });
        return ok({ added: true, ret: r2 });
      }
      case "/bindings/remove": {
        if (!b.id) return send(res, 400, { ok: false, error: "binding id required" });
        await mt.ipBindingRemove(b.id);
        return ok({ removed: true });
      }
      case "/bindings/set": {
        if (!b.id) return send(res, 400, { ok: false, error: "binding id required" });
        await mt.ipBindingSet(b.id, b);
        Audit.add({ type: "manual", action: "ip-bind-edit", detail: `${b.id} → ${b.mac || ""} ${b.address || ""} ${b.server || ""}`, ok: true });
        return ok({ done: true });
      }
      case "/nodemcu/setup": {
        // one-click: make lease static + hotspot ip-binding (bypassed)
        if (!b.id) return send(res, 400, { ok: false, error: "lease id required" });
        const leases = (await mt.dhcpLeases()) || [];
        const lease = leases.find((l) => l[".id"] === b.id);
        if (!lease) return send(res, 404, { ok: false, error: "lease not found (refresh the list)" });
        const steps = [];
        if (String(lease.dynamic) !== "false") { await mt.leaseMakeStatic(b.id); steps.push("lease made static"); }
        else steps.push("lease already static");
        const mac = lease["mac-address"], addr = lease.address;
        const bindings = (await mt.hotspotIpBindings().catch(() => [])) || [];
        const existing = bindings.find((x) => String(x["mac-address"] || "").toUpperCase() === String(mac || "").toUpperCase());
        if (existing) steps.push("already bound (" + (existing.type || "bypassed") + ")");
        else { await mt.ipBindingAdd({ mac, address: addr, server: b.server || "", type: "bypassed", comment: "vendo " + (lease["host-name"] || "") }); steps.push("ip-binding added (bypassed)"); }
        Audit.add({ type: "manual", action: "nodemcu-setup", detail: `${lease["host-name"] || mac} @ ${addr}: ${steps.join(", ")}`, ok: true });
        return ok({ steps, address: addr, mac });
      }
      case "/hotspot/vouchers": {
        const count = Math.min(Math.max(Number(b.count) || 10, 1), 500);
        const profile = b.profile || "default";
        const userOnly = b.userOnly !== false;
        const made = [], errors = [];
        for (let i = 0; i < count; i++) {
          const code = genVoucherCode(b.length, b.prefix);
          const password = userOnly ? "" : code;
          try { await mt.createHotspotUser({ name: code, password, profile, limitUptime: b.uptime || "" }); made.push(code); }
          catch (e) { errors.push(e.message); }
        }
        Audit.add({ type: "manual", action: "vouchers", detail: `${made.length}x ${profile}${userOnly ? " (user-only)" : ""}`, ok: true });
        return ok({ created: made, count: made.length, profile, uptime: b.uptime || "", price: b.price || "", exp: b.exp || "", userOnly, errors });
      }
      case "/hotspot/delete": return ok(await mt.deleteHotspotUser(b.name));
      case "/hotspot/edit": return ok(await mt.updateHotspotUser(b.oldName || b.name, b));
      case "/hotspot/disable": return ok(await mt.setHotspotUserDisabled(b.name, true));
      case "/hotspot/enable": return ok(await mt.setHotspotUserDisabled(b.name, false));
      case "/ppp-profile/add": return ok(await mt.createPppProfile(b));
      case "/ppp-profile/edit": return ok(await mt.updatePppProfile(b.name, b));
      case "/hotspot-profile/add": return ok(await mt.createHotspotProfile(b));
      case "/hotspot-profile/edit": return ok(await mt.updateHotspotProfile(b.name, b));
      default: return send(res, 404, { ok: false, error: "router route not found: " + sub });
    }
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
}

// ---- Billing API ---------------------------------------------------------
// Routes under /api/billing/* backed by lib/db.js (SQLite). Customer
// suspend/enable/provision also act on the router via the active client.
async function handleBilling(req, res, pathname) {
  const sub = pathname.replace("/api/billing", "") || "/";
  const method = req.method;
  const body = method === "GET" ? {} : JSON.parse((await readBody(req)) || "{}");
  const url = new URL(req.url, "http://localhost");
  const q = Object.fromEntries(url.searchParams);
  const m = (re) => sub.match(re);
  const ok = (data) => send(res, 200, { ok: true, data });

  try {
    if (sub === "/summary" && method === "GET") return ok(summary());

    // Plans
    if (sub === "/plans" && method === "GET") return ok(Plans.list());
    if (sub === "/plans" && method === "POST") return ok(Plans.create(body));
    let mm;
    if ((mm = m(/^\/plans\/(\d+)$/))) {
      if (method === "PUT") return ok(Plans.update(Number(mm[1]), body));
      if (method === "DELETE") return ok(Plans.remove(Number(mm[1])));
    }

    // Customers
    if (sub === "/customers" && method === "GET") return ok(Customers.list());
    if (sub === "/map" && method === "GET") {
      return ok({
        clients: Customers.located().map((c) => ({ id: c.id, name: c.name, username: c.username, plan_name: c.plan_name, status: c.status, area: c.area, lat: c.lat, lng: c.lng, nap_id: c.nap_id })),
        naps: Naps.list(),
      });
    }
    if (sub === "/naps" && method === "GET") return ok(Naps.list());
    if (sub === "/outages" && method === "GET") return ok(Outages.list());
    if (sub === "/ai/digest" && method === "GET") {
      if (!aiEnabled()) return send(res, 400, { ok: false, error: "AI is off. Turn it on and add your API key in Settings." });
      const k = kpis();
      const overdue = Invoices.list({ status: "unpaid" }).filter((i) => i.due_date && i.due_date < new Date().toISOString().slice(0, 10));
      const openOutages = Outages.list().filter((o) => o.status === "open");
      const offlineVendos = Vendos.list().filter((v) => v.enabled && !v.online).map((v) => v.name);
      const recentAnomalies = Audit.list ? (Audit.list(40) || []).filter((a) => ["coin-tamper", "coin-spike", "coin-burst", "coin-stall"].includes(a.action)).slice(0, 6).map((a) => a.detail) : [];
      const facts = {
        date: new Date().toISOString().slice(0, 10),
        activeClients: k.active, suspended: k.suspended,
        collectedToday: k.collectedToday, paymentsToday: k.collectedTodayCount,
        expiringIn7Days: k.expiring7, pendingProofs: k.pendingProofs, openTickets: k.openTickets,
        overdueInvoices: overdue.length, overdueAmount: overdue.reduce((s, i) => s + (Number(i.amount) - (Number(i.paid_amount) || 0)), 0),
        openOutages: openOutages.map((o) => o.title), offlineVendos, recentAnomalies,
      };
      try { const text = await dailyDigest(facts); return ok({ digest: text, facts }); }
      catch (e) { return send(res, 500, { ok: false, error: e.message }); }
    }
    if (sub === "/report/financial" && method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      const months = Number(q.get("months")) || 12;
      return ok({ months: Reports.monthly(months), byMethod: Reports.byMethod(q.get("period") || ""), byConnType: Reports.byConnType(q.get("period") || ""), snapshot: Reports.snapshot() });
    }
    if (sub === "/report/cashflow" && method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      const period = q.get("period") || new Date().toISOString().slice(0, 7);
      return ok(Reports.cashflow(period));
    }
    if (sub === "/outages" && method === "POST") {
      if (!body.title) return send(res, 400, { ok: false, error: "Describe the outage (title) first." });
      const o = Outages.create(body);
      const affected = Outages.affected(o.scope_type, o.scope_value);
      let sent = 0;
      if (body.notify) {
        const text = `Service advisory: ${o.title}. We are working on it and will message you once restored. Sorry for the inconvenience. — ${Settings.get("biz_name") || "Your internet provider"}`;
        for (const c of affected.filter((x) => x.contact)) {
          try { const r = await notifyCustomerMsg(c.contact, c.name, "Service interruption", text); if (r.via && r.via !== "none" && !String(r.via).endsWith("-failed")) sent++; } catch {}
        }
        Outages.setNotified(o.id, sent);
      }
      tgNotify(`🛠 <b>OUTAGE DECLARED</b>\n${escapeHtml(o.title)}\nScope: ${o.scope_type === "all" ? "all customers" : escapeHtml(String(body.scope_label || o.scope_value))}\nAffected: ${affected.length} client(s)` + (body.notify ? `\nNotified: ${sent}` : ""));
      Audit.add({ type: "manual", action: "outage-open", detail: o.title, ok: true });
      return ok({ outage: Outages.get(o.id), affected: affected.length, notified: sent });
    }
    if ((mm = m(/^\/outages\/(\d+)\/resolve$/)) && method === "POST") {
      const o = Outages.get(Number(mm[1]));
      if (!o) return send(res, 404, { ok: false, error: "outage not found" });
      const r2 = Outages.resolve(o.id);
      let sent = 0;
      if (body.notify) {
        const text = `Good news — service is restored (${o.title}). Thank you for your patience! — ${Settings.get("biz_name") || "Your internet provider"}`;
        for (const c of Outages.affected(o.scope_type, o.scope_value).filter((x) => x.contact)) {
          try { const r = await notifyCustomerMsg(c.contact, c.name, "Service restored", text); if (r.via && r.via !== "none" && !String(r.via).endsWith("-failed")) sent++; } catch {}
        }
      }
      tgNotify(`✅ <b>OUTAGE RESOLVED</b>\n${escapeHtml(o.title)}` + (body.notify ? `\nRestored notice sent to ${sent}` : ""));
      Audit.add({ type: "manual", action: "outage-resolve", detail: o.title, ok: true });
      return ok({ outage: r2, notified: sent });
    }
    if ((mm = m(/^\/outages\/(\d+)$/)) && method === "DELETE") { Outages.remove(Number(mm[1])); return ok({ deleted: true }); }
    if (sub === "/naps" && method === "POST") {
      if (!body.name) return send(res, 400, { ok: false, error: "Tower/NAP name is required." });
      Audit.add({ type: "manual", action: "nap-add", detail: body.name, ok: true });
      return ok(Naps.create(body));
    }
    if ((mm = m(/^\/naps\/(\d+)$/)) && (method === "PATCH" || method === "PUT")) {
      try {
        const updated = Naps.update(Number(mm[1]), body);
        Audit.add({ type: "manual", action: "nap-edit", detail: "#" + mm[1] + " → " + (updated.name || ""), ok: true });
        return ok(updated);
      } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    }
    if ((mm = m(/^\/naps\/(\d+)$/)) && method === "DELETE") {
      Naps.remove(Number(mm[1]));
      Audit.add({ type: "manual", action: "nap-delete", detail: "#" + mm[1], ok: true });
      return ok({ deleted: true });
    }
    if ((mm = m(/^\/customers\/(\d+)\/location$/)) && method === "POST") {
      return ok(Customers.setLocation(Number(mm[1]), body.lat, body.lng, body.nap_id));
    }
    if (sub === "/areas" && method === "GET") return ok(Customers.areas());
    if (sub === "/sms/messages" && method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      const filter = q.get("filter") || "all";
      const data = filter === "gcash" ? Sms.gcashList(50) : Sms.list(120);
      // Resolve each number to a PPPoE/billing customer (by mobile) so the box shows the real name + username.
      const cache = new Map();
      const enriched = data.map((m) => {
        if (m.gcash) return m; // GCash sender names aren't customers
        let c = cache.get(m.number);
        if (c === undefined) { c = Customers.byContact(m.number); cache.set(m.number, c); }
        return c ? { ...m, name: c.name || m.name, username: c.username || "", customer_id: c.id } : m;
      });
      return ok({ messages: enriched, unread: Sms.unread() });
    }
    if (sub === "/sms/send" && method === "POST") {
      const to = String(body.to || "").trim(), text = String(body.body || "").trim();
      if (!to || !text) return send(res, 400, { ok: false, error: "Enter a number and a message." });
      const s2 = Settings.all();
      const cust = Customers.byContact(to);
      try {
        const r2 = await sendSmsAny(s2, to, text);
        Sms.add({ direction: "out", number: to, name: cust ? cust.name : "", body: text, status: "sent", read: 1 });
        return ok({ sent: true, ref: r2 && r2.ref });
      } catch (e) {
        Sms.add({ direction: "out", number: to, name: cust ? cust.name : "", body: text, status: "failed", read: 1 });
        return send(res, 500, { ok: false, error: e.message });
      }
    }
    if (sub === "/sms/read" && method === "POST") { Sms.markRead(body.number); return ok({ done: true }); }
    if (sub === "/sms/test" && method === "POST") {
      const to = String(body.to || "").trim();
      if (!to) return send(res, 400, { ok: false, error: "Enter a phone number to send the test to." });
      const s2 = Settings.all();
      try {
        const r2 = await sendSmsAny(s2, to, `${s2.biz_name || "Panel"}: test message — your SMS setup works!`);
        return ok({ sent: true, provider: s2.sms_provider || "semaphore", ref: r2 && r2.ref });
      } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
    }
    if (sub === "/sms/check" && method === "POST") {
      const r2 = await pollGsmInbox();
      return ok(r2);
    }
    if (sub === "/broadcast" && method === "POST") {
      const area = (body.area || "").trim();
      const msg = (body.message || "").trim();
      if (!msg) return send(res, 400, { ok: false, error: "Message is required." });
      const list = (area && area !== "__all__") ? Customers.byArea(area) : Customers.list().filter((c) => c.contact);
      let sent = 0, failed = 0; const vias = {};
      for (const c of list) {
        try {
          const r = await notifyCustomerMsg(c.contact, c.name, (Settings.get("biz_name") || "Notice"), msg);
          if (r.via && r.via !== "none" && !String(r.via).endsWith("-failed")) { sent++; vias[r.via] = (vias[r.via] || 0) + 1; } else failed++;
        } catch { failed++; }
      }
      tgNotify(`📢 <b>Broadcast sent</b>${(area && area !== "__all__") ? " — " + escapeHtml(area) : ""}\nDelivered: ${sent}${failed ? ` · failed/no-contact: ${failed}` : ""}\n"${escapeHtml(msg).slice(0, 150)}"`);
      Audit.add({ type: "manual", action: "broadcast", detail: `${area || "all"}: ${sent} sent`, ok: true });
      return ok({ sent, failed, vias, total: list.length });
    }
    if (sub === "/customers" && method === "POST") {
      const created = Customers.create(body);
      if (Settings.get("auto_provision", "0") === "1" && created.username && created.plan_id) {
        try { await customerAction(created.id, "provision"); Audit.add({ type: "auto", customer_id: created.id, customer_name: created.name, action: "auto-provision", detail: created.username, ok: true }); }
        catch (e) { Audit.add({ type: "auto", customer_id: created.id, customer_name: created.name, action: "auto-provision", detail: e.message, ok: false }); }
      }
      return ok(Customers.get(created.id));
    }
    if ((mm = m(/^\/customers\/(\d+)$/))) {
      if (method === "PUT" || method === "POST") return ok(Customers.update(Number(mm[1]), body));
      if (method === "DELETE") return ok(Customers.remove(Number(mm[1])));
    }
    if ((mm = m(/^\/customers\/(\d+)\/(suspend|enable|provision|renew)$/)) && method === "POST") {
      return ok(await customerAction(Number(mm[1]), mm[2]));
    }

    // Invoices
    if (sub === "/invoices" && method === "GET") return ok(Invoices.list(q));
    if (sub === "/invoices/generate" && method === "POST") return ok(Invoices.generate(body.period));
    if (sub === "/invoices/auto-run" && method === "POST") return ok(await runAutoInvoice(true));
    if ((mm = m(/^\/invoices\/(\d+)\/pay$/)) && method === "POST") {
      const r2 = Invoices.pay(Number(mm[1]), body);
      maybeAutoReceipt(r2.invoice && r2.invoice.customer_id).catch(() => {});
      return ok(r2);
    }
    if ((mm = m(/^\/customers\/(\d+)\/credit$/)) && method === "POST") {
      const c = Customers.get(Number(mm[1]));
      if (!c) return send(res, 404, { ok: false, error: "customer not found" });
      const amt = Number(body.amount);
      if (!amt) return send(res, 400, { ok: false, error: "Enter an amount (negative to deduct)." });
      const bal = Customers.addCredit(c.id, amt, body.note || "manual adjustment");
      Audit.add({ type: "manual", customer_id: c.id, customer_name: c.name, action: "credit", detail: (amt > 0 ? "+" : "") + amt + " → ₱" + bal, ok: true });
      return ok({ credit: bal });
    }
    if ((mm = m(/^\/customers\/(\d+)\/paycredit$/)) && method === "POST") {
      const c = Customers.get(Number(mm[1]));
      if (!c) return send(res, 404, { ok: false, error: "customer not found" });
      const credit = Number(c.credit) || 0;
      if (credit <= 0) return send(res, 400, { ok: false, error: "No wallet credit available." });
      const inv = Invoices.byCustomer(c.id).find((i) => i.status !== "paid");
      if (!inv) return send(res, 400, { ok: false, error: "No unpaid invoice to apply credit to." });
      const balance = Math.max(0, Number(inv.amount) - (Number(inv.paid_amount) || 0));
      const use = Math.min(credit, balance);
      const r2 = Invoices.pay(inv.id, { amount: use, method: "credit", note: "paid from wallet credit" });
      Customers.addCredit(c.id, -use, "applied to invoice #" + inv.id);
      Audit.add({ type: "manual", customer_id: c.id, customer_name: c.name, action: "credit-pay", detail: `₱${use} → invoice #${inv.id}${r2.fully ? " (fully paid)" : ""}`, ok: true });
      return ok({ used: use, invoice: r2.invoice, remainingCredit: (Number(c.credit) || 0) - use });
    }

    // Payments
    if (sub === "/payments" && method === "GET") return ok(Payments.list());
    if (sub === "/payments" && method === "POST") return ok(Payments.record(body));

    // Automation / collections
    if (sub === "/golive" && method === "GET") {
      // Live status snapshot for the wizard + saved checklist progress.
      const s = Settings.all();
      let progress = {};
      try { progress = JSON.parse(s.golive_progress || "{}"); } catch {}
      return ok({
        progress,
        status: {
          dryRun: RouterOSAPI.dryRun,
          publicUrl: s.public_url || "",
          mikrotikHost: s.mikrotik_host || "",
          autoSuspend: (s.auto_suspend === "1"),
          smsConfigured: smsConfigured(s),
          telegram: !!(s.telegram_bot_token && s.telegram_chat_id),
          customers: Customers.list().length,
          plans: Plans.list().length,
        },
      });
    }
    if (sub === "/golive" && method === "POST") {
      const cur = (() => { try { return JSON.parse(Settings.get("golive_progress", "{}")); } catch { return {}; } })();
      const next = { ...cur, ...(body.progress || {}) };
      Settings.set("golive_progress", JSON.stringify(next));
      return ok({ progress: next });
    }
    if (sub === "/automation" && method === "GET") {
      return ok({ ...{ enabled: AUTOMATION.enabled, time: AUTOMATION.time, graceDays: AUTOMATION.graceDays }, audit: Audit.list(40) });
    }
    if (sub === "/automation" && method === "POST") {
      const patch = {};
      if ("enabled" in body) patch.auto_suspend = body.enabled ? "1" : "0";
      if (body.time) patch.auto_suspend_time = String(body.time);
      if (body.graceDays != null) patch.auto_suspend_grace = String(Number(body.graceDays) || 0);
      Settings.setMany(patch);
      Audit.add({ type: "manual", action: "automation-config", detail: `auto-suspend ${AUTOMATION.enabled ? "ON" : "OFF"} @ ${AUTOMATION.time}, grace ${AUTOMATION.graceDays}d`, ok: true });
      return ok({ enabled: AUTOMATION.enabled, time: AUTOMATION.time, graceDays: AUTOMATION.graceDays });
    }
    if (sub === "/collections/run" && method === "POST") {
      return ok(await runCollections({ dryRun: !!body.dryRun, graceDays: AUTOMATION.graceDays }));
    }
    if (sub === "/reminders/run" && method === "POST") {
      return ok(await runReminders());
    }
    if (sub === "/reminders/preview" && method === "GET") {
      // Who would get a reminder, grouped by how many days until expiry.
      const today = await routerToday();
      const days = (Settings.get("reminder_days", "3,1").split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => n >= 0));
      const groups = [];
      for (const d of days) {
        const list = Customers.expiringOn(addDays(today, d)).map((c) => ({
          id: c.id, name: c.name, contact: c.contact, plan: c.plan_name, expiry: c.expiry,
          remindedToday: c.last_reminded === today,
        }));
        groups.push({ days: d, label: d === 0 ? "expires today" : `in ${d} day(s)`, customers: list });
      }
      return ok({ today, reminder_days: days.join(","), smsConfigured: smsConfigured(Settings.all()), groups });
    }
    if (sub === "/portal/sync-now" && method === "POST") {
      const r = await runPortalSync();
      const p = await pushCustomerSummary();
      reschedulePortalSync(); // re-arm in case settings changed
      return ok({ ...r, push: p });
    }
    if (sub === "/report/run" && method === "POST") {
      return ok(await dailyReport());
    }
    if (sub === "/backup/telegram" && method === "POST") {
      return ok(await runAutoBackup(true));
    }
    if ((mm = m(/^\/customers\/(\d+)\/history$/)) && method === "GET") {
      const c = Customers.get(Number(mm[1]));
      if (!c) return send(res, 404, { ok: false, error: "customer not found" });
      return ok({ customer: { id: c.id, name: c.name, username: c.username, plan_name: c.plan_name, expiry: c.expiry, status: c.status },
        invoices: Invoices.byCustomer(c.id), payments: Payments.byCustomer(c.id),
        units: Inventory.unitsForCustomer(c.id), materials: Inventory.movesForCustomer(c.id), installs: Inventory.installsForCustomer(c.id) });
    }
    if ((mm = m(/^\/payments\/(\d+)\/receipt\/email$/)) && method === "POST") {
      const p = Payments.get(Number(mm[1]));
      if (!p) return send(res, 404, { ok: false, error: "payment not found" });
      const to = (body.to || p.customer_contact || "").trim();
      if (!/@/.test(to)) return send(res, 400, { ok: false, error: "No email address on file for this customer." });
      const s = Settings.all();
      if (!s.smtp_host) return send(res, 400, { ok: false, error: "Email isn't set up (SMTP)." });
      try {
        await sendMail({ host: s.smtp_host, port: s.smtp_port, secure: s.smtp_secure === "1" || String(s.smtp_port) === "465", user: s.smtp_user, pass: s.smtp_pass, from: s.smtp_from || s.smtp_user },
          { to, subject: `Receipt OR-${String(p.id).padStart(5, "0")} — ${s.biz_name || "Internet Service"}`,
            text: `Official receipt OR-${String(p.id).padStart(5, "0")} for ₱${Number(p.amount || 0).toLocaleString()} (${p.method || "cash"}). Thank you.`,
            html: receiptHtml(p) });
        return ok({ sent: true, to });
      } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
    }
    if (sub === "/sales" && method === "GET") {
      return ok(Sales.series(q.range || "monthly"));
    }
    if (sub === "/sales/reset" && method === "POST") {
      const r = SalesAdmin.reset(body.scope || "all");
      Audit.add({ type: "manual", action: "reset-sales", detail: r.scope, ok: true });
      return ok(r);
    }

    // ---- Business / SMTP settings (admin only) ----
    if (sub === "/settings" && method === "GET") {
      const s = Settings.all();
      for (const k of ["smtp_pass", "paymongo_secret", "paymongo_webhook_secret", "telegram_bot_token", "semaphore_api_key", "mikrotik_password", "ai_api_key", "portal_token"]) if (s[k]) s[k] = "***";
      return ok(s);
    }
    if (sub === "/settings" && method === "POST") {
      const patch = { ...body };
      for (const k of ["smtp_pass", "paymongo_secret", "paymongo_webhook_secret", "telegram_bot_token", "semaphore_api_key", "mikrotik_password", "ai_api_key", "portal_token"])
        if (patch[k] === "***" || patch[k] === undefined) delete patch[k]; // keep existing
      Settings.setMany(patch);
      if (Object.keys(patch).some((k) => k.startsWith("mikrotik_"))) { try { mt.close && mt.close(); } catch {} rebuildMt(); }
      if ("dry_run" in patch) syncDryRun();
      if ("expiry_check_mins" in patch) rescheduleSweep();
      if ("usage_snapshot_mins" in patch) rescheduleUsage();
      if (Object.keys(patch).some((k) => k.startsWith("gsm_") || k === "sms_provider")) rescheduleGsm();
      if ("watchdog_mins" in patch) rescheduleWatchdog();
      if ("vendo_alerts" in patch || "vendo_check_mins" in patch) rescheduleVendoCheck();
      if ("portal_url" in patch || "portal_token" in patch || "portal_sync_enabled" in patch || "portal_sync_mins" in patch) reschedulePortalSync();
      Audit.add({ type: "manual", action: "settings-update", detail: Object.keys(patch).join(","), ok: true });
      const s = Settings.all();
      for (const k of ["smtp_pass", "paymongo_secret", "paymongo_webhook_secret", "telegram_bot_token", "semaphore_api_key", "mikrotik_password", "ai_api_key", "portal_token"]) if (s[k]) s[k] = "***";
      return ok(s);
    }

    // ---- PayMongo: create a GCash/card payment link for an invoice ----
    if ((mm = m(/^\/invoices\/(\d+)\/payment-link$/)) && method === "POST") {
      const inv = Invoices.get(Number(mm[1]));
      if (!inv) return send(res, 404, { ok: false, error: "invoice not found" });
      const s = Settings.all();
      if (!s.paymongo_secret) return send(res, 400, { ok: false, error: "PayMongo secret key not set — open Settings" });
      try {
        const link = await pmCreateLink(
          { secret: s.paymongo_secret, baseUrl: s.paymongo_base || undefined },
          { amountPhp: inv.amount, description: `${s.biz_name || "Internet"} ${inv.period} — ${inv.customer_name}`, remarks: `INV-${inv.id}` }
        );
        Invoices.setLink(inv.id, link.id, link.checkout_url || "");
        Audit.add({ type: "manual", customer_id: inv.customer_id, customer_name: inv.customer_name, action: "payment-link", detail: link.id, ok: true });
        return ok({ url: link.checkout_url, id: link.id });
      } catch (e) {
        return send(res, 500, { ok: false, error: "PayMongo: " + e.message });
      }
    }

    // ---- Import users from the router into billing ----
    // ---- Expenses + profit ----
    if (sub === "/expenses" && method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      const period = q.get("period") || "";
      return ok({
        categories: Expenses.CATEGORIES,
        list: Expenses.list(period ? { period } : {}),
        byCategory: Expenses.byCategory(period),
        total: Expenses.totalForPeriod(period),
      });
    }
    if (sub === "/expenses" && method === "POST") {
      if (!(Number(body.amount) > 0)) return send(res, 400, { ok: false, error: "Enter an amount greater than zero." });
      const e = Expenses.add(body);
      Audit.add({ type: "manual", action: "expense-add", detail: `${e.category} \u20B1${e.amount} ${e.description || ""}`.trim(), ok: true });
      return ok(e);
    }
    if ((mm = m(/^\/expenses\/(\d+)$/)) && (method === "POST" || method === "PUT")) {
      return ok(Expenses.update(Number(mm[1]), body));
    }
    if ((mm = m(/^\/expenses\/(\d+)$/)) && method === "DELETE") {
      Expenses.remove(Number(mm[1])); return ok({ removed: true });
    }
    if (sub === "/cashflow" && method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      const period = q.get("period") || new Date().toISOString().slice(0, 7);
      const inPeriod = (dt) => String(dt || "").slice(0, 7) === period;
      // INFLOW: payments, split into install charges vs subscription/other
      let installIn = 0, subIn = 0, payCount = 0;
      for (const p of Payments.list()) {
        if (!inPeriod(p.paid_at)) continue;
        const amt = Number(p.amount) || 0;
        if (String(p.note || "").startsWith("Install:")) installIn += amt; else subIn += amt;
        payCount++;
      }
      // OUTFLOW: business expenses + stock purchases (inventory "in" moves valued at item cost)
      const expenses = Expenses.totalForPeriod(period);
      let stockBuy = 0;
      try {
        const moves = Inventory.moves(1000).filter((mv) => mv.type === "in" && inPeriod(mv.at));
        for (const mv of moves) { const it = Inventory.item(mv.item_id); stockBuy += (Number(mv.qty) || 0) * (it ? Number(it.cost) || 0 : 0); }
      } catch {}
      const inflow = installIn + subIn;
      const outflow = expenses + stockBuy;
      return ok({
        period,
        inflow: { total: inflow, subscription: subIn, install: installIn, count: payCount },
        outflow: { total: outflow, expenses, stockPurchases: stockBuy },
        net: inflow - outflow,
        expenseByCategory: Expenses.byCategory(period),
      });
    }
    if (sub === "/profit" && method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      const period = q.get("period") || new Date().toISOString().slice(0, 7);
      // revenue from payments in the period
      const rev = (Reports.byMethod(period) || []).reduce((s, r) => s + Number(r.total || 0), 0);
      const exp = Expenses.totalForPeriod(period);
      return ok({
        period, revenue: rev, expenses: exp, profit: rev - exp,
        revenueByConnType: Reports.byConnType ? Reports.byConnType(period) : [],
        expenseByCategory: Expenses.byCategory(period),
      });
    }

    // ---- Job Orders (install applications pipeline) ----
    if (sub === "/joborders" && method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      return ok({ list: JobOrders.list(q.get("status") ? { status: q.get("status") } : {}), summary: JobOrders.summary(), alerts: JobOrders.alerts() });
    }
    if ((mm = m(/^\/joborders\/(\d+)$/)) && method === "GET") {
      const jo = JobOrders.get(Number(mm[1])); if (!jo) return send(res, 404, { ok: false, error: "Not found" });
      return ok(jo);
    }
    if ((mm = m(/^\/joborders\/(\d+)\/assign$/)) && method === "POST") {
      return ok(JobOrders.setTech(Number(mm[1]), body.tech || ""));
    }
    if ((mm = m(/^\/joborders\/(\d+)\/status$/)) && method === "POST") {
      const st = body.status || "applied";
      if (st === "rejected") {
        const jo = JobOrders.reject(Number(mm[1]), body.reason || "");
        Audit.add({ type: "manual", action: "jo-reject", detail: `JO #${mm[1]}: ${body.reason || "(no reason)"}`, ok: true });
        return ok(jo);
      }
      return ok(JobOrders.setStatus(Number(mm[1]), st));
    }
    if ((mm = m(/^\/joborders\/(\d+)\/paid$/)) && method === "POST") {
      return ok(JobOrders.setPaid(Number(mm[1])));
    }
    // Helper: ensure this job order has an install record (create + link lazily)
    if ((mm = m(/^\/joborders\/(\d+)\/release-unit$/)) && method === "POST") {
      const jo = JobOrders.get(Number(mm[1]));
      if (!jo) return send(res, 404, { ok: false, error: "Job order not found" });
      const unitId = Number(body.unit_id);
      if (!unitId) return send(res, 400, { ok: false, error: "Choose a unit to release." });
      // make sure there's an install record for this JO
      let installId = jo.install_id;
      if (!installId) { const ins = Inventory.createInstall({ customer_id: jo.customer_id || null, tech: jo.tech || "", notes: "Job Order #" + jo.id }); installId = ins.id; JobOrders.setInstall(jo.id, installId); }
      try {
        // assign the unit to this tech + (if account exists) customer, tagged to the install
        const unitRow = Inventory.unit(unitId);
        Inventory.setUnit(unitId, { status: "assigned", tech: jo.tech || "", customer_id: jo.customer_id || null, install_id: installId });
        // record a stock movement so it shows in "Recent stock movements" and on-hand reflects it
        if (unitRow && unitRow.item_id) {
          Inventory.logMove({ item_id: unitRow.item_id, type: "unit_out", qty: 1, customer_id: jo.customer_id || null, install_id: installId, tech: jo.tech || "", note: `released to JO #${jo.id} (${jo.name || ""})`.trim() });
        }
        if (jo.status === "applied" || jo.status === "assigned") JobOrders.setStatus(jo.id, "released");
        Audit.add({ type: "manual", action: "jo-release-unit", detail: `unit #${unitId} -> JO #${jo.id} (${jo.tech || "tech"})`, ok: true });
        return ok(JobOrders.get(jo.id));
      } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    }
    if ((mm = m(/^\/joborders\/(\d+)\/signoff$/)) && method === "POST") {
      const jo = JobOrders.get(Number(mm[1]));
      if (!jo) return send(res, 404, { ok: false, error: "Job order not found" });
      if (!body.approved_by) return send(res, 400, { ok: false, error: "Enter the client's name." });
      let installId = jo.install_id;
      if (!installId) { const ins = Inventory.createInstall({ customer_id: jo.customer_id || null, tech: jo.tech || "", notes: "Job Order #" + jo.id }); installId = ins.id; JobOrders.setInstall(jo.id, installId); }
      // mark any released units for this install as installed
      try { for (const u of Inventory.installUnits(installId)) { if (u.status === "assigned") Inventory.setUnit(u.id, { status: "installed", tech: jo.tech || u.tech || "", customer_id: jo.customer_id || u.customer_id || null, install_id: installId }); } } catch {}
      Inventory.approveInstall(installId, { approval_type: body.approval_type || "typed", approved_by: body.approved_by, approval_data: body.approval_data || "" });
      // Sign-off is the final step: mark the job completed.
      JobOrders.setStatus(jo.id, "completed");
      Audit.add({ type: "manual", customer_id: jo.customer_id, action: "jo-signoff", detail: `JO #${jo.id} signed by ${body.approved_by} (${body.approval_type})`, ok: true });
      // Build the completed-install summary to return to the UI.
      const fresh = JobOrders.get(jo.id);
      const units = Inventory.installUnits(installId);
      const ins2 = Inventory.install(installId);
      return ok({ ...fresh, summary: {
        client: body.approved_by, customer_name: fresh.name,
        install_date: (ins2 && ins2.approved_at) ? ins2.approved_at : "",
        tech: fresh.tech || "",
        units: units.map((u) => ({ item: u.item_name, serial: u.serial, mac: u.mac })),
        approval_type: body.approval_type || "typed",
      } });
    }
    if ((mm = m(/^\/joborders\/(\d+)\/install$/)) && method === "GET") {
      const jo = JobOrders.get(Number(mm[1]));
      if (!jo || !jo.install_id) return ok({ install: null, units: [], moves: [] });
      return ok({ install: Inventory.install(jo.install_id), units: Inventory.installUnits(jo.install_id), moves: Inventory.installMoves(jo.install_id) });
    }
    if ((mm = m(/^\/joborders\/(\d+)\/approve-account$/)) && method === "POST") {
      const jo = JobOrders.get(Number(mm[1]));
      if (!jo) return send(res, 404, { ok: false, error: "Job order not found" });
      if (jo.customer_id) return send(res, 400, { ok: false, error: "An account was already created for this application (#" + jo.customer_id + ")." });
      // Payment gate: an account can only be created once payment has been received.
      if (jo.pay_status !== "paid") return send(res, 400, { ok: false, error: "Process payment first — mark the payment received before creating the account." });
      // Connection type comes from the chosen PLAN (ipoe vs pppoe/hotspot), not a guess.
      const connType = (jo.plan_type === "ipoe") ? "ipoe" : (jo.plan_type === "hotspot") ? "hotspot" : "pppoe";
      const fields = {
        name: jo.name, contact: jo.contact || "", address: jo.address || "", area: jo.area || "",
        plan_id: jo.plan_id || null, conn_type: connType, lat: jo.lat, lng: jo.lng,
        notes: "From application #" + jo.id + (jo.notes ? " — " + jo.notes : ""),
      };
      if (connType === "ipoe") {
        // IPoE: no username/password. Auto-suggest the next free IP from existing IPoE
        // subscribers; the MAC is filled when the tech releases the ONU/router unit to the job.
        fields.static_ip = body.static_ip || suggestNextIpoeIp();
        fields.mac = ""; // captured at unit release / provision
      } else {
        // PPPoE/hotspot: username = clientname@businessname (no spaces), password = CAPS auto.
        fields.username = body.username || makeUsername(jo.name);
        fields.password = body.password || makePassword();
      }
      const cust = Customers.create(fields);
      JobOrders.link(jo.id, cust.id);
      // Back-link anything that was created BEFORE the account existed (equipment was released
      // during the "released" step, when customer_id was still null). Without this, the new
      // customer's History shows no equipment / materials / install.
      try {
        if (jo.install_id) {
          // tie the install record to this customer
          if (Inventory.setInstallCustomer) Inventory.setInstallCustomer(jo.install_id, cust.id);
          // tie every unit on that install to this customer
          for (const u of Inventory.installUnits(jo.install_id)) {
            Inventory.setUnit(u.id, { customer_id: cust.id });
          }
          // tie any material movements on that install to this customer
          if (Inventory.setMovesCustomerByInstall) Inventory.setMovesCustomerByInstall(jo.install_id, cust.id);
        }
      } catch (e) { /* non-fatal: account is created regardless */ }
      Audit.add({ type: "manual", customer_id: cust.id, customer_name: cust.name, action: "jo-approve-account", detail: `${connType} account from application #${jo.id}`, ok: true });
      const idLine = connType === "ipoe"
        ? `IPoE subscriber created for ${cust.name}. Suggested IP: ${cust.static_ip || "—"}. Assign the ONU/router (MAC) when releasing equipment, then provision.`
        : `Account created for ${cust.name}\nUsername: ${cust.username}\nPassword: ${cust.password}\nReview, then provision.`;
      return ok({ customer_id: cust.id, conn_type: connType, username: cust.username || "", static_ip: cust.static_ip || "", message: idLine });
    }
    if ((mm = m(/^\/joborders\/(\d+)$/)) && method === "DELETE") {
      JobOrders.remove(Number(mm[1])); return ok({ removed: true });
    }

    // ---- Tech team ----
    if (sub === "/techs" && method === "GET") {
      return ok({ techs: Techs.list(), summary: Techs.summary(), ranks: Techs.RANKS, statuses: Techs.STATUSES });
    }
    if (sub === "/techs" && method === "POST") {
      if (!body.name || !String(body.name).trim()) return send(res, 400, { ok: false, error: "Name is required." });
      return ok(Techs.create(body));
    }
    if ((mm = m(/^\/techs\/(\d+)$/)) && method === "POST") {
      return ok(Techs.update(Number(mm[1]), body));
    }
    if ((mm = m(/^\/techs\/(\d+)\/status$/)) && method === "POST") {
      return ok(Techs.setStatus(Number(mm[1]), body.status));
    }
    if ((mm = m(/^\/techs\/(\d+)$/)) && method === "DELETE") {
      Techs.remove(Number(mm[1])); return ok({ removed: true });
    }

    // ---- Inventory ----
    if (sub === "/inventory" && method === "GET") {
      // install revenue collected (payments tagged "Install:") — this month + all-time
      const period = new Date().toISOString().slice(0, 7);
      let instMonth = 0, instTotal = 0, instCount = 0;
      try {
        const rows = Payments.list().filter((p) => String(p.note || "").startsWith("Install:"));
        for (const p of rows) { instTotal += Number(p.amount) || 0; instCount++; if (String(p.paid_at || "").slice(0, 7) === period) instMonth += Number(p.amount) || 0; }
      } catch {}
      return ok({ items: Inventory.items(), low: Inventory.lowStock(), summary: Inventory.summary(),
        installRevenue: { month: instMonth, total: instTotal, count: instCount },
        hardware: { month: Hardware.summary(period), all: Hardware.summary() },
        costAsExpense: Settings.get("inv_cost_as_expense", "0") === "1" });
    }
    if (sub === "/inventory/items" && method === "POST") {
      if (!body.name) return send(res, 400, { ok: false, error: "Item name is required." });
      return ok(Inventory.addItem(body));
    }
    if ((mm = m(/^\/inventory\/items\/(\d+)$/)) && (method === "POST" || method === "PUT")) {
      return ok(Inventory.updateItem(Number(mm[1]), body));
    }
    if ((mm = m(/^\/inventory\/items\/(\d+)$/)) && method === "DELETE") {
      Inventory.removeItem(Number(mm[1])); return ok({ removed: true });
    }
    if (sub === "/inventory/move" && method === "POST") {
      try {
        const item = Inventory.move(body);
        Audit.add({ type: "manual", customer_id: body.customer_id || null, action: "stock-" + (body.type || "move"), detail: `${body.type} ${Math.abs(Number(body.qty) || 0)} ${item.unit} of ${item.name}${body.tech ? " by " + body.tech : ""}`, ok: true });
        return ok(item);
      } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    }
    if (sub === "/inventory/moves" && method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      const cid = q.get("customer_id");
      return ok(cid ? Inventory.movesForCustomer(Number(cid)) : Inventory.moves(200));
    }
    // serialized units
    if (sub === "/inventory/custody" && method === "GET") {
      return ok(Inventory.techCustody());
    }
    // Charge a customer for an installation: fee + router cost.
    // mode "collect" -> record a payment now (cash/gcash/maya). mode "invoice" -> add to their bill.
    if (sub === "/inventory/sell" && method === "POST") {
      // Sell a hardware item to a client at sell_price; record revenue + cost + margin.
      const cid = Number(body.customer_id) || null;
      const cust = cid ? Customers.get(cid) : null;
      const item = body.item_id ? Inventory.item(Number(body.item_id)) : null;
      if (!item) return send(res, 400, { ok: false, error: "Choose an item to sell." });
      const cost = Math.round(Number(body.cost != null ? body.cost : item.cost) || 0);
      const sell = Math.round(Number(body.sell_price != null ? body.sell_price : item.sell_price) || 0);
      if (sell <= 0) return send(res, 400, { ok: false, error: "Set a sell price for this item first (cost ₱" + cost + ")." });
      const method2 = ["cash", "gcash", "maya"].includes(body.method) ? body.method : "cash";
      const unitId = body.unit_id ? Number(body.unit_id) : null;
      const who = cust ? cust.name : (body.customer_name || "walk-in");
      // 1) revenue: record the sale price as a payment tagged "Hardware:"
      let payId = null;
      if (cid) { const pay = Payments.record({ customer_id: cid, amount: sell, method: method2, reference: body.reference || "", note: "Hardware: " + item.name }); payId = pay.id; }
      // 2) optional: log the cost as a purchase expense (user decides per sale)
      // Costing mode is the source of truth. In stock-value mode (recommended) we NEVER log
      // the cost as an expense (the stock value already represents that money) — this prevents
      // double-counting regardless of what the client sends.
      const costAsExpense = Settings.get("inv_cost_as_expense", "0") === "1";
      let expId = null;
      if (costAsExpense && cost > 0) {
        const ex = Expenses.add({ category: "equipment", description: "Cost of " + item.name + " sold to " + who, amount: cost, spent_at: new Date().toISOString().slice(0, 10), note: "Auto from hardware sale" });
        expId = ex.id;
      }
      // 3) record the sale (margin) + mark the unit installed if given
      if (unitId) Inventory.setUnit(unitId, { status: "installed", customer_id: cid });
      const sale = Hardware.record({ customer_id: cid, item_id: item.id, unit_id: unitId, item_name: item.name, cost, sell_price: sell, method: method2, payment_id: payId, expense_id: expId, note: body.note || "" });
      Audit.add({ type: "manual", customer_id: cid, customer_name: who, action: "hardware-sale", detail: `${item.name}: sold ₱${sell} (cost ₱${cost}, margin ₱${sell - cost})${expId ? " + logged cost expense" : ""}`, ok: true });
      return ok({ sale, revenue: sell, cost, margin: sell - cost, loggedExpense: !!expId,
        message: `Sold ${item.name} for ₱${sell.toLocaleString()} (cost ₱${cost.toLocaleString()}, margin ₱${(sell - cost).toLocaleString()})${cid ? " — recorded to " + who : ""}.` });
    }
    if (sub === "/inventory/sales" && method === "GET") {
      const ym = new URL(req.url, "http://localhost").searchParams.get("month") || "";
      return ok({ list: Hardware.list(), summary: Hardware.summary(ym), summaryAll: Hardware.summary() });
    }
    if (sub === "/install-charge" && method === "POST") {
      const cid = Number(body.customer_id);
      const cust = cid ? Customers.get(cid) : null;
      if (!cust) return send(res, 400, { ok: false, error: "Choose a customer." });
      const fee = Math.round(Number(body.install_fee) || 0);
      const router = Math.round(Number(body.router_cost) || 0);
      const total = fee + router;
      if (total <= 0) return send(res, 400, { ok: false, error: "Enter an installation fee and/or router cost." });
      const parts = [];
      if (fee > 0) parts.push("Installation fee \u20B1" + fee.toLocaleString());
      if (router > 0) parts.push("Router/equipment \u20B1" + router.toLocaleString());
      const desc = parts.join(" + ");
      const mode = body.mode === "invoice" ? "invoice" : "collect";
      if (mode === "invoice") {
        const inv = Invoices.addOne({ customer_id: cid, amount: total, note: desc, period: "INSTALL-" + cid + "-" + Date.now() });
        Audit.add({ type: "manual", customer_id: cid, customer_name: cust.name, action: "install-charge-invoice", detail: desc + " (added to bill)", ok: true });
        return ok({ mode, invoice_id: inv.id, total, desc, message: `Added \u20B1${total.toLocaleString()} to ${cust.name}'s bill (${desc}).` });
      } else {
        const pmethod = ["cash", "gcash", "maya"].includes(body.method) ? body.method : "cash";
        const pay = Payments.record({ customer_id: cid, amount: total, method: pmethod, reference: body.reference || "", note: "Install: " + desc });
        Audit.add({ type: "manual", customer_id: cid, customer_name: cust.name, action: "install-charge-paid", detail: desc + " via " + pmethod, ok: true });
        return ok({ mode, payment_id: pay.id, total, desc, method: pmethod, message: `Collected \u20B1${total.toLocaleString()} from ${cust.name} via ${pmethod.toUpperCase()} (${desc}).` });
      }
    }
    if (sub === "/inventory/units/trace" && method === "GET") {
      // Search a router by MAC or serial → full unit + lifecycle history
      const q = new URL(req.url, "http://localhost").searchParams.get("q") || "";
      const u = Inventory.findByMacOrSerial(q);
      if (!u) return ok({ found: false });
      return ok({ found: true, unit: u });
    }
    if ((mm = m(/^\/inventory\/units\/(\d+)\/pullout$/)) && method === "POST") {
      try {
        const r = Inventory.pullOut(Number(mm[1]), { defective: !!body.defective, reason: body.reason || "", tech: body.tech || "" });
        Audit.add({ type: "manual", customer_id: r.customer_id || null, action: "unit-pullout", detail: `${r.item_name||"unit"} ${r.serial||r.mac} → ${r.status}`, ok: true });
        return ok(r);
      } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    }
    if ((mm = m(/^\/inventory\/units\/(\d+)\/replace$/)) && method === "POST") {
      try {
        const r = Inventory.replaceUnit(Number(mm[1]), Number(body.new_unit_id), { customer_id: body.customer_id || null, defective: body.defective !== false, tech: body.tech || "" });
        Audit.add({ type: "manual", customer_id: r.new.customer_id || null, action: "unit-replace", detail: `${r.old.serial||r.old.mac} → ${r.new.serial||r.new.mac}`, ok: true });
        return ok(r);
      } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    }
    if (sub === "/inventory/units" && method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      const cid = q.get("customer_id");
      if (cid) return ok(Inventory.unitsForCustomer(Number(cid)));
      return ok(Inventory.units(q.get("status") ? { status: q.get("status") } : null));
    }
    if (sub === "/inventory/units" && method === "POST") {
      try { return ok(Inventory.addUnit(body)); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    }
    if ((mm = m(/^\/inventory\/units\/(\d+)$/)) && (method === "POST" || method === "PUT")) {
      try { return ok(Inventory.setUnit(Number(mm[1]), body)); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    }
    if ((mm = m(/^\/inventory\/units\/(\d+)$/)) && method === "DELETE") {
      Inventory.removeUnit(Number(mm[1])); return ok({ removed: true });
    }
    // install jobs
    if (sub === "/installs" && method === "POST") {
      const ins = Inventory.createInstall(body);
      Audit.add({ type: "manual", customer_id: body.customer_id || null, action: "install-open", detail: `install #${ins.id} by ${body.tech || "?"}`, ok: true });
      return ok(ins);
    }
    if ((mm = m(/^\/installs\/(\d+)$/)) && method === "GET") {
      const id = Number(mm[1]);
      const ins = Inventory.install(id);
      if (!ins) return send(res, 404, { ok: false, error: "install not found" });
      return ok({ install: ins, units: Inventory.installUnits(id), moves: Inventory.installMoves(id) });
    }
    if ((mm = m(/^\/installs\/(\d+)\/approve$/)) && method === "POST") {
      const ins = Inventory.approveInstall(Number(mm[1]), body);
      Audit.add({ type: "manual", customer_id: ins.customer_id, customer_name: ins.customer_name, action: "install-approved", detail: `by ${body.approved_by || "client"} (${body.approval_type})`, ok: true });
      return ok(ins);
    }
    if ((mm = m(/^\/installs$/)) && method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      const cid = q.get("customer_id");
      return ok(cid ? Inventory.installsForCustomer(Number(cid)) : []);
    }

    if (sub === "/import-users" && method === "POST") {
      return ok(await importUsers(body.source || "pppoe"));
    }

    // ---- Printable invoice (returns HTML, opened in a new tab) ----
    if ((mm = m(/^\/invoices\/(\d+)\/print$/)) && method === "GET") {
      const inv = Invoices.get(Number(mm[1]));
      if (!inv) return send(res, 404, { ok: false, error: "invoice not found" });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(invoiceHtml(inv));
    }

    // ---- Email an invoice via SMTP ----
    if ((mm = m(/^\/invoices\/(\d+)\/email$/)) && method === "POST") {
      const inv = Invoices.get(Number(mm[1]));
      if (!inv) return send(res, 404, { ok: false, error: "invoice not found" });
      const to = (body.to || inv.contact || "").trim();
      if (!to || !/@/.test(to)) return send(res, 400, { ok: false, error: "no valid email for this customer (set the customer's contact to an email, or pass 'to')" });
      const s = Settings.all();
      if (!s.smtp_host) return send(res, 400, { ok: false, error: "SMTP is not configured — open Settings and fill in your mail server details first" });
      try {
        await sendMail(
          { host: s.smtp_host, port: s.smtp_port, secure: s.smtp_secure === "1" || String(s.smtp_port) === "465", user: s.smtp_user, pass: s.smtp_pass, from: s.smtp_from || s.smtp_user },
          { to, subject: `Invoice ${inv.period} — ${s.biz_name || "Internet Service"}`, html: invoiceHtml(inv), text: invoiceText(inv) }
        );
        Audit.add({ type: "manual", customer_id: inv.customer_id, customer_name: inv.customer_name, action: "invoice-emailed", detail: to, ok: true });
        return ok({ sent: true, to });
      } catch (e) {
        Audit.add({ type: "manual", customer_id: inv.customer_id, action: "invoice-email-failed", detail: e.message, ok: false });
        return send(res, 500, { ok: false, error: "SMTP error: " + e.message });
      }
    }

    return send(res, 404, { ok: false, error: "billing route not found: " + method + " " + sub });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
}

// ---- Telegram: proof-of-payment approvals + alerts -----------------------
function dataUrlToBuffer(s) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(s || "");
  if (m) return { buffer: Buffer.from(m[2], "base64"), contentType: m[1] };
  return { buffer: Buffer.from(String(s || ""), "base64"), contentType: "image/jpeg" };
}
function tg() {
  const token = Settings.get("telegram_bot_token");
  if (!token) return null;
  return tgMakeClient(token, Settings.get("telegram_base") || undefined);
}
function tgChat() { return Settings.get("telegram_chat_id"); }
function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// Notify a customer that their ticket was answered (email or SMS, per their contact).
async function notifyCustomerReply(t) {
  const contact = (t.contact || "").trim();
  if (!contact) return { via: "none" };
  const s = Settings.all();
  const biz = s.biz_name || "Support";
  if (/@/.test(contact) && s.smtp_host) {
    try {
      const atts = [];
      if (t.reply_image) { const { buffer, contentType } = dataUrlToBuffer(t.reply_image); atts.push({ filename: "reply.jpg", contentType, buffer }); }
      await sendMail(
        { host: s.smtp_host, port: s.smtp_port, secure: s.smtp_secure === "1" || String(s.smtp_port) === "465", user: s.smtp_user, pass: s.smtp_pass, from: s.smtp_from || s.smtp_user },
        { to: contact, subject: `Re: your support ticket #${t.id} — ${biz}`,
          text: `Hi ${t.name || ""},\n\nYour report: ${t.message}\n\nOur reply:\n${t.reply}\n\n— ${biz}`,
          html: `<p>Hi ${escapeHtml(t.name || "")},</p><p><b>Your report:</b> ${escapeHtml(t.message)}</p><p><b>Our reply:</b><br>${escapeHtml(t.reply)}</p>${t.reply_image ? "<p>(photo attached)</p>" : ""}<p>— ${escapeHtml(biz)}</p>`,
          attachments: atts });
      Audit.add({ type: "auto", action: "reply-emailed", detail: contact, ok: true });
      return { via: "email" };
    } catch (e) { Audit.add({ type: "auto", action: "reply-email-failed", detail: e.message, ok: false }); return { via: "email-failed", error: e.message }; }
  }
  if (looksLikePhone(contact) && smsConfigured(s)) {
    try {
      await sendSmsAny(s, contact, `${biz}: Re ticket #${t.id} - ${t.reply}`.slice(0, 300));
      Audit.add({ type: "auto", action: "reply-sms", detail: contact, ok: true });
      return { via: "sms" };
    } catch (e) { Audit.add({ type: "auto", action: "reply-sms-failed", detail: e.message, ok: false }); return { via: "sms-failed", error: e.message }; }
  }
  return { via: "none" };
}

async function tgNotify(text) {
  const c = tg(), chat = tgChat();
  if (!c || !chat) return;
  try { await c.sendMessage(chat, text); } catch (e) { Audit.add({ type: "auto", action: "telegram-error", detail: e.message, ok: false }); }
}

// Generic one-off notification to a customer (email or SMS, per their contact).
async function notifyCustomerMsg(contact, name, subject, text) {
  contact = (contact || "").trim();
  if (!contact) return { via: "none" };
  const s = Settings.all();
  const biz = s.biz_name || "Support";
  if (/@/.test(contact) && s.smtp_host) {
    try {
      await sendMail({ host: s.smtp_host, port: s.smtp_port, secure: s.smtp_secure === "1" || String(s.smtp_port) === "465", user: s.smtp_user, pass: s.smtp_pass, from: s.smtp_from || s.smtp_user },
        { to: contact, subject, text, html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>` });
      return { via: "email" };
    } catch { return { via: "email-failed" }; }
  }
  if (looksLikePhone(contact) && smsConfigured(s)) {
    try { await sendSmsAny(s, contact, (`${biz}: ${text}`).slice(0, 300)); return { via: "sms" }; }
    catch { return { via: "sms-failed" }; }
  }
  return { via: "none" };
}

// ---- SMS provider routing: Semaphore (cloud) or a USB GSM dongle (own SIM) ----
let _gsm = null;
function gsmModem() {
  const s = Settings.all();
  const port = s.gsm_port || "";
  if (!port) throw new Error("GSM port not set (Settings → SMS → dongle port, e.g. COM3)");
  if (!_gsm || _gsm.port !== port || _gsm.baud !== (Number(s.gsm_baud) || 115200)) {
    try { _gsm && _gsm.close(); } catch {}
    _gsm = new GsmModem({ port, baud: s.gsm_baud });
  }
  return _gsm;
}
async function sendSmsAny(s, to, message) {
  if ((s.sms_provider || "semaphore") === "gsm") {
    return gsmModem().sendSms(to, message);
  }
  return sendSms({ apiKey: s.semaphore_api_key, sender: s.sms_sender, baseUrl: s.sms_base || undefined }, to, message);
}
function smsConfigured(s) {
  return (s.sms_provider || "semaphore") === "gsm" ? !!s.gsm_port : !!s.semaphore_api_key;
}

// Poll the dongle for received texts -> helpdesk tickets + Telegram, then delete from SIM.
let _gsmPolling = false;
async function pollGsmInbox() {
  const s = Settings.all();
  if (_gsmPolling || (s.sms_provider || "semaphore") !== "gsm" || !s.gsm_port || s.gsm_receive !== "1") return { skipped: true };
  _gsmPolling = true;
  try {
    const msgs = await gsmModem().readSms("REC UNREAD");
    for (const m of msgs) {
      const cust = Customers.byContact(m.from);
      const pay = parsePaymentSms(m.from, m.text);
      if (pay.isPayment) {
        Sms.add({ direction: "in", number: m.from, name: pay.provider.toUpperCase(), body: m.text, gcash: 1, amount: pay.amount, reference: pay.reference, read: 0 });
        tgNotify(`💰 <b>PAYMENT NOTIFICATION (${escapeHtml(pay.provider.toUpperCase())})</b>\nAmount: ₱${Number(pay.amount).toLocaleString()}\n${pay.reference ? "Ref: " + escapeHtml(pay.reference) + "\n" : ""}Match this against a customer's submitted receipt.`);
      } else {
        Sms.add({ direction: "in", number: m.from, name: cust ? cust.name : "", body: m.text, read: 0 });
        const t = Tickets.add({ name: cust ? cust.name : m.from, contact: m.from, category: "SMS", message: m.text });
        tgNotify(`💬 <b>SMS received</b> from ${escapeHtml(cust ? cust.name + " (" + m.from + ")" : m.from)}\n"${escapeHtml(m.text).slice(0, 300)}"\nLogged as ticket #${t.id}`);
      }
      try { await gsmModem().deleteSms(m.index); } catch {}
    }
    return { received: msgs.length };
  } catch (e) { return { error: e.message }; }
  finally { _gsmPolling = false; }
}
let _gsmTimer = null;
function rescheduleGsm() {
  if (_gsmTimer) { clearInterval(_gsmTimer); _gsmTimer = null; }
  const s = Settings.all();
  if ((s.sms_provider || "semaphore") === "gsm" && s.gsm_port && s.gsm_receive === "1") {
    _gsmTimer = setInterval(() => { pollGsmInbox().catch(() => {}); }, 60 * 1000);
    return true;
  }
  return false;
}

// Auto-email the latest receipt to the customer if enabled and they have an email.
async function maybeAutoReceipt(customerId) {
  if (!customerId || Settings.get("auto_receipt", "0") !== "1") return;
  const c = Customers.get(customerId);
  if (!c || !/@/.test(String(c.contact || ""))) return;
  const p = Payments.byCustomer(customerId)[0];
  if (!p) return;
  const s = Settings.all();
  if (!s.smtp_host) return;
  const full = Payments.get(p.id);
  await sendMail({ host: s.smtp_host, port: s.smtp_port, secure: s.smtp_secure === "1" || String(s.smtp_port) === "465", user: s.smtp_user, pass: s.smtp_pass, from: s.smtp_from || s.smtp_user },
    { to: c.contact, subject: `Receipt OR-${String(p.id).padStart(5, "0")} — ${s.biz_name || "Internet Service"}`,
      text: `Official receipt OR-${String(p.id).padStart(5, "0")} for ₱${Number(p.amount || 0).toLocaleString()}. Thank you.`, html: receiptHtml(full) });
  Audit.add({ type: "auto", customer_id: customerId, action: "auto-receipt", detail: "OR-" + p.id + " → " + c.contact, ok: true });
}

// Send expiry reminders N days before expiry (configurable, e.g. "3,1"). Once per customer per day.
async function runReminders() {
  const today = await routerToday();
  const url = (Settings.get("public_url") || "").replace(/\/$/, "");
  const days = (Settings.get("reminder_days", "3,1").split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => n >= 0));
  const notified = [];
  for (const d of days) {
    const target = addDays(today, d);
    for (const c of Customers.expiringOn(target)) {
      if (c.last_reminded === today) continue;
      const when = d === 0 ? "today" : `in ${d} day(s)`;
      const pay = url ? ` Pay/here: ${url}/pay?u=${encodeURIComponent(c.username || "")}` : "";
      const text = `Hi ${c.name}, your ${c.plan_name || "internet"} plan expires ${when} (${c.expiry}). Please settle before then to avoid disconnection.${pay}`;
      const r = await notifyCustomerMsg(c.contact, c.name, "Service expiry reminder", text);
      Customers.setReminded(c.id, today);
      notified.push({ name: c.name, expiry: c.expiry, via: r.via });
    }
  }
  if (notified.length) tgNotify(`🔔 <b>Expiry reminders sent</b> (${notified.length})\n` + notified.map((n) => `• ${n.name} — ${n.expiry} (${n.via})`).join("\n"));
  return { count: notified.length, notified };
}

// Once-a-day operations summary to the operator's Telegram.
async function dailyReport() {
  const today = await routerToday();
  const col = Collections.collectedOn(today);
  const s = summary();
  const soon = Customers.expiringBy(addDays(today, 3));
  const pending = Proofs.pendingCount();
  const openTk = Tickets.openCount();
  const expiredNow = Customers.expiredAsOf(await routerNow()).length;
  const msg = `📊 <b>DAILY REPORT</b> — ${today}\n` +
    `Collected today: <b>₱${Number(col.s).toLocaleString()}</b> (${col.n} payment${col.n === 1 ? "" : "s"})\n` +
    `Active: ${s.active} · Suspended: ${s.suspended}\n` +
    `Outstanding: ₱${Number(s.outstanding).toLocaleString()} · Overdue invoices: ${s.overdue}\n` +
    `Pending proofs: ${pending} · Open tickets: ${openTk}\n` +
    (expiredNow ? `⚠️ Expired & due to suspend: ${expiredNow}\n` : "") +
    `Expiring within 3 days: ${soon.length}` + (soon.length ? "\n" + soon.slice(0, 15).map((c) => `• ${c.name} — ${c.expiry}`).join("\n") : "");
  await tgNotify(msg);
  return { sent: true, collectedToday: col.s };
}

// ---- Auto-backup (to disk, optionally to Telegram) -----------------------
const BACKUP_DIR = path.join(process.cwd(), "data", "backups");
function writeBackupFile() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const json = JSON.stringify(exportAll(), null, 2);
  const name = `billing-backup-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), json);
  return { name, buffer: Buffer.from(json) };
}
function pruneBackups(keep) {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("billing-backup-")).sort();
    while (files.length > (Number(keep) || 14)) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch {}
}
async function runAutoBackup(force) {
  const s = Settings.all();
  const toFile = force || s.auto_backup === "1";
  const toTg = force || s.backup_telegram === "1";
  if (!toFile && !toTg) return { skipped: true };
  const b = writeBackupFile();
  pruneBackups(s.keep_backups);
  if (toTg) {
    const c = tg(), chat = tgChat();
    if (c && chat) { try { await c.sendDocument(chat, b.buffer, b.name, `🗄️ Billing backup — ${new Date().toLocaleString()}`); } catch (e) { Audit.add({ type: "auto", action: "backup-tg-failed", detail: e.message, ok: false }); } }
  }
  Audit.add({ type: "auto", action: "backup", detail: b.name, ok: true });
  return { file: b.name, toTelegram: toTg };
}

// Apply an approved proof: mark its invoice paid, renew expiry, reconnect, confirm.
async function applyApprovedProof(proof, via) {
  Proofs.setStatus(proof.id, "approved");
  let inv = proof.invoice_id ? Invoices.get(proof.invoice_id) : null;
  if (inv && inv.status !== "paid") {
    Invoices.pay(inv.id, { method: "gcash", reference: proof.reference || ("proof#" + proof.id), note: "Proof approved (" + via + ")" });
    Audit.add({ type: "auto", customer_id: inv.customer_id, customer_name: inv.customer_name, action: "invoice-paid-proof", detail: via, ok: true });
  }
  let newExpiry = null, cust = null;
  if (proof.customer_id) {
    cust = Customers.get(proof.customer_id);
    if (cust) {
      try {
        newExpiry = await renewCustomer(cust, cust.plan_mins || 43200);
        Audit.add({ type: "auto", customer_id: cust.id, customer_name: cust.name, action: "renew-reconnect", detail: "expiry " + newExpiry, ok: true });
      } catch (e) {
        Audit.add({ type: "auto", customer_id: cust.id, action: "reconnect-failed", detail: e.message, ok: false });
      }
    }
  }
  // Telegram confirmation (PDF: "✅ PAYMENT APPROVED … Internet Restored")
  if (cust) tgNotify(`✅ <b>PAYMENT APPROVED</b>\nUser: <b>${cust.username || cust.name}</b>\nPlan: ${cust.plan_name || "—"}\nProfile: ACTIVE\nNew expiry: <b>${newExpiry || "—"}</b>\nInternet restored.`);
  if (cust && Settings.get("notify_customers", "1") === "1" && cust.contact) {
    notifyCustomerMsg(cust.contact, cust.name, "Payment received — reconnected", `Hi ${cust.name}, we received your payment and your internet is reconnected. New expiry: ${newExpiry || "—"}. Thank you!`).catch(() => {});
  }
  if (cust) maybeAutoReceipt(cust.id).catch(() => {});
  return { newExpiry };
}

let tgOffset = 0, tgPolling = false;
async function tgPollOnce() {
  const c = tg();
  if (!c) return -1;
  const r = await c.getUpdates(tgOffset, 50);
  if (!r || !r.json || !r.json.ok) return 0;
  let n = 0;
  for (const up of r.json.result) {
    n++;
    tgOffset = up.update_id + 1;
    // Text commands (operator control from Telegram)
    const msg = up.message;
    if (msg && typeof msg.text === "string" && msg.text.trim().startsWith("/")) {
      const chat = tgChat();
      if (chat && String(msg.chat.id) !== String(chat)) continue; // only the configured operator chat
      const cmd = msg.text.trim().split(/\s+/)[0].toLowerCase();
      try {
        if (cmd === "/today" || cmd === "/report") await dailyReport();
        else if (cmd === "/pending") {
          const ps = Proofs.list("pending");
          await c.sendMessage(msg.chat.id, ps.length ? "Pending proofs:\n" + ps.map((p) => `#${p.id} ${p.username} ₱${Number(p.amount || 0).toLocaleString()} ref ${p.reference || "-"}`).join("\n") : "No pending proofs.");
        } else if (cmd === "/expiring") {
          const today = await routerToday(); const soon = Customers.expiringBy(addDays(today, 3));
          await c.sendMessage(msg.chat.id, soon.length ? "Expiring within 3 days:\n" + soon.map((x) => `• ${x.name} — ${x.expiry}`).join("\n") : "No accounts expiring within 3 days.");
        } else if (cmd === "/remind") {
          const rr = await runReminders(); await c.sendMessage(msg.chat.id, `Sent ${rr.count} reminder(s).`);
        } else {
          await c.sendMessage(msg.chat.id, "Commands:\n/today — daily report\n/pending — payment proofs awaiting approval\n/expiring — accounts expiring in ≤3 days\n/remind — send expiry reminders now\nApprove/Reject payments using the buttons on each proof photo.");
        }
      } catch (e) { Audit.add({ type: "auto", action: "telegram-cmd-error", detail: e.message, ok: false }); }
      continue;
    }
    const cb = up.callback_query;
    if (!cb || !cb.data) continue;
    const [action, idStr, extra] = String(cb.data).split(":");
    const proof = Proofs.get(Number(idStr));
    if (!proof) { try { await c.answerCallback(cb.id, "Not found / already handled"); } catch {} continue; }
    if (proof.status !== "pending") { try { await c.answerCallback(cb.id, "Already " + proof.status); } catch {} continue; }
    if (action === "topup") {
      const amt = Math.round(Number(extra) || Number(proof.amount) || 0);
      const bal = Customers.addCredit(proof.customer_id, amt, "wallet top-up (approved via Telegram)");
      try { Proofs.setStatus(proof.id, "approved", "wallet top-up"); } catch {}
      const cu = Customers.get(proof.customer_id);
      Audit.add({ type: "manual", customer_id: proof.customer_id, customer_name: cu ? cu.name : "", action: "wallet-topup", detail: `₱${amt} approved`, ok: true });
      try { await c.answerCallback(cb.id, "Credited ₱" + amt); } catch {}
      try { if (cb.message) await c.editMessageText(cb.message.chat.id, cb.message.message_id, `💰 Credited ₱${amt} to ${cu ? cu.name : proof.username}. Balance: ₱${Number(bal).toLocaleString()}.`); } catch {}
      if (cu && Settings.get("notify_customers", "1") === "1" && cu.contact) notifyCustomerMsg(cu.contact, cu.name, "Wallet top-up", `Hi ${cu.name}, ₱${amt} was added to your wallet. New balance: ₱${Number(bal).toLocaleString()}.`).catch(() => {});
      continue;
    }
    if (action === "approve") {
      await applyApprovedProof(proof, "telegram");
      try { await c.answerCallback(cb.id, "Approved ✅ — customer reconnected"); } catch {}
      try { if (cb.message) await c.editMessageText(cb.message.chat.id, cb.message.message_id, `✅ Approved — ${proof.username} reconnected.`); } catch {}
    } else if (action === "reject") {
      Proofs.reject(proof.id, "Rejected via Telegram");
      Audit.add({ type: "manual", action: "proof-rejected", detail: proof.username, ok: true });
      try { await c.answerCallback(cb.id, "Rejected"); } catch {}
      try { if (cb.message) await c.editMessageText(cb.message.chat.id, cb.message.message_id, `❌ Rejected — ${proof.username}.`); } catch {}
      tgNotify(`❌ <b>PAYMENT REJECTED</b>\nUser: <b>${proof.username}</b>\nReason: proof not valid. Ask the customer to upload a clearer receipt.`);
    }
  }
  return n;
}
async function tgPollLoop() {
  if (tgPolling) return;
  tgPolling = true;
  for (;;) {
    let n = 0;
    try { n = await tgPollOnce(); } catch { n = 0; await new Promise((r) => setTimeout(r, 5000)); }
    if (n < 0) await new Promise((r) => setTimeout(r, 4000));        // not configured yet; re-check soon
    else if (n === 0) await new Promise((r) => setTimeout(r, 1000)); // idle (real Telegram already long-polls)
  }
}

// ---- Automation: auto-suspend overdue / auto-reconnect on payment --------
// Backed by Settings so it can be toggled live from the dashboard; falls back to
// the .env values the first time (before the operator sets it in the UI).
const AUTOMATION = {
  get enabled() { return Settings.get("auto_suspend", process.env.AUTO_SUSPEND === "true" ? "1" : "0") === "1"; },
  get time() { return Settings.get("auto_suspend_time", process.env.AUTO_SUSPEND_TIME || "09:00"); },
  get graceDays() { return Number(Settings.get("auto_suspend_grace", process.env.GRACE_DAYS || "0")) || 0; },
};

// Runs the collection pass. dryRun=true previews without touching the router or DB.
// Periodic usage snapshot: read /queue counters, accumulate month-to-date deltas
// (handles resets), and optionally enforce per-plan data caps.
let _usageSnapping = false;
async function runUsageSnapshot() {
  if (_usageSnapping || !mtConfig().host) return { skipped: true };
  _usageSnapping = true;
  try {
    const q = await mt.queues().catch(() => []);
    const parsed = parseQueues(q, []).rows.map((r) => ({ name: r.name, up: r.up, down: r.down }));
    const res = Usage.accumulate(parsed);
    if (Settings.get("enforce_caps", "0") === "1") await enforceDataCaps();
    return res;
  } finally { _usageSnapping = false; }
}

// Suspend active customers whose month-to-date usage exceeds their plan's data cap.
async function enforceDataCaps() {
  for (const c of Customers.list()) {
    if (c.status !== "active") continue;
    const capGb = Number(c.plan_cap) || 0; if (capGb <= 0 || !c.username) continue;
    const u = Usage.forKey(c.username);
    const usedGb = u ? (Number(u.up) + Number(u.down)) / 1073741824 : 0;
    if (usedGb >= capGb) {
      try {
        await applyProfileSwitch(c, "suspend");
        Customers.setStatusAndAuto(c.id, "suspended", true);
        Audit.add({ type: "auto", customer_id: c.id, customer_name: c.name, action: "suspend", detail: `data cap ${capGb}GB reached (${usedGb.toFixed(1)}GB)`, ok: true });
        tgNotify(`🚫 <b>DATA CAP REACHED</b>\n<b>${c.name}</b> (${c.username})\nUsed ${usedGb.toFixed(1)}GB of ${capGb}GB — suspended.`);
        if (Settings.get("notify_customers", "1") === "1" && c.contact) {
          const url = (Settings.get("public_url") || "").replace(/\/$/, "");
          notifyCustomerMsg(c.contact, c.name, "Data limit reached", `Hi ${c.name}, you've reached your ${capGb}GB data limit and service is paused until renewal.` + (url ? ` ${url}/pay?u=${encodeURIComponent(c.username)}` : "")).catch(() => {});
        }
      } catch (e) { Audit.add({ type: "auto", customer_id: c.id, action: "suspend", detail: e.message, ok: false }); }
    }
  }
}

let _usageTimer = null;
function rescheduleUsage() {
  if (_usageTimer) { clearInterval(_usageTimer); _usageTimer = null; }
  const mins = Math.max(0, Number(Settings.get("usage_snapshot_mins", "10")) || 0);
  if (mins > 0) _usageTimer = setInterval(() => { runUsageSnapshot().catch(() => {}); }, mins * 60 * 1000);
  return mins;
}

// Monthly auto-invoicing: on the configured day each month, create invoices for
// monthly subscribers (idempotent). force=true bypasses the day check (manual button).
async function runAutoInvoice(force) {
  if (!force && Settings.get("auto_invoice", "0") !== "1") return { skipped: true };
  const day = Math.min(Math.max(Number(Settings.get("invoice_day", "1")) || 1, 1), 28);
  if (!force) {
    const today = await routerToday();
    if (Number(today.slice(8, 10)) !== day) return { skipped: true, reason: "not invoice day" };
  }
  const res = Invoices.generateMonthly();
  if (res.created) {
    Audit.add({ type: force ? "manual" : "auto", action: "auto-invoice", detail: `${res.period}: ${res.created}`, ok: true });
    tgNotify(`🧾 <b>Invoices generated</b> for ${res.period}: ${res.created} new.`);
  }
  return res;
}

// Suspend one expired customer on the router + DB, with a one-time Telegram alert.
// If enabled and the wallet covers the plan price, renew from credit instead of suspending.
async function tryAutoRenewFromCredit(c) {
  if (Settings.get("auto_renew_credit", "0") !== "1") return false;
  const price = Number(c.plan_price) || 0;
  const credit = Number(c.credit) || 0;
  if (price <= 0 || credit < price) return false;
  // Router + expiry FIRST — if this fails, no money moves.
  let newExpiry;
  try { newExpiry = await renewCustomer(c, c.plan_mins || 43200); }
  catch (e) { Audit.add({ type: "auto", customer_id: c.id, customer_name: c.name, action: "auto-renew", detail: "router error: " + e.message, ok: false }); return false; }
  Customers.addCredit(c.id, -price, "auto-renew on expiry");
  const inv = Invoices.byCustomer(c.id).find((i) => i.status !== "paid");
  if (inv) Invoices.pay(inv.id, { amount: price, method: "credit", note: "auto-renew from wallet" });
  else Payments.record({ customer_id: c.id, amount: price, method: "credit", reference: "", note: "auto-renew from wallet" });
  Audit.add({ type: "auto", customer_id: c.id, customer_name: c.name, action: "auto-renew", detail: `₱${price} from wallet → ${newExpiry}`, ok: true });
  tgNotify(`🔄 <b>AUTO-RENEWED FROM WALLET</b>\nUser: <b>${c.name}</b> (${c.username})\n₱${price.toLocaleString()} deducted · balance ₱${(credit - price).toLocaleString()}\nNew expiry: ${newExpiry}`);
  if (Settings.get("notify_customers", "1") === "1" && c.contact) {
    notifyCustomerMsg(c.contact, c.name, "Plan renewed", `Hi ${c.name}, your plan was automatically renewed using your wallet balance. New expiry: ${newExpiry}. Remaining balance: ₱${(credit - price).toLocaleString()}.`).catch(() => {});
  }
  return true;
}

async function suspendForExpiry(c) {
  if (await tryAutoRenewFromCredit(c)) return { renewed: true };
  await applyProfileSwitch(c, "suspend");
  Customers.setStatusAndAuto(c.id, "suspended", true);
  Audit.add({ type: "auto", customer_id: c.id, customer_name: c.name, action: "suspend", detail: "expired " + c.expiry, ok: true });
  const due = (Invoices.list({ customer_id: c.id, status: "unpaid" })[0] || {}).amount;
  const ident = c.username || c.account_code || c.static_ip || c.mac || "";
  tgNotify(`🔴 <b>ACCOUNT EXPIRED</b>\nUser: <b>${c.name}</b>${ident ? ` (${ident})` : ""}\nPlan: ${c.plan_name || "—"}\nExpired: ${c.expiry}\nStatus: moved to SUSPENDED` + (due ? `\nRemaining due: ₱${Number(due).toLocaleString()}` : ""));
  if (Settings.get("notify_customers", "1") === "1" && c.contact) {
    const url = (Settings.get("public_url") || "").replace(/\/$/, "");
    const pay = url ? ` Settle here: ${url}/pay?u=${encodeURIComponent(c.username || "")}` : "";
    notifyCustomerMsg(c.contact, c.name, "Internet disconnected", `Hi ${c.name}, your internet is disconnected because your account expired (${c.expiry}). Please settle to reconnect.${pay}`).catch(() => {});
  }
}

// Lightweight recurring sweep: suspend anyone whose expiry just passed. Safe to run often.
let _sweeping = false;
async function runExpirySweep() {
  if (_sweeping) return { skipped: true };
  if (!mtConfig().host) return { skipped: true };
  _sweeping = true;
  try {
    const now = await routerNow();
    const grace = Math.max(0, Number(Settings.get("expiry_grace_mins", "0")) || 0);
    const due = Customers.expiredAsOf(grace ? addMinutes(now, -grace) : now);
    let n = 0;
    for (const c of due) {
      try { await suspendForExpiry(c); n++; }
      catch (e) { Audit.add({ type: "auto", customer_id: c.id, action: "suspend", detail: e.message, ok: false }); }
    }
    if (n) console.log(`[auto] expiry sweep suspended ${n}`);
    return { suspended: n };
  } finally { _sweeping = false; }
}

// ---- Vendo offline alerts ----
const VENDO_STATE = new Map(); // id -> { online, fails, since }
let _vendoPolling = false;
// ---- Network provisioning helpers ----
// Username for PPPoE/hotspot: clientname@businessname, lowercase, no spaces, unique.
function makeUsername(name) {
  const biz = (Settings.get("biz_name", "isp") || "isp").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const base = String(name || "client").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "client";
  let u = base + "@" + (biz || "isp"), n = 1;
  const exists = (x) => Customers.list().find((c) => (c.username || "").toLowerCase() === x.toLowerCase());
  while (exists(u)) u = base + (++n) + "@" + (biz || "isp");
  return u;
}
// Password: all-caps, auto-generated, no ambiguous chars.
function makePassword(len = 8) {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = ""; for (let i = 0; i < len; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
// Suggest the next free IPoE IP based on existing IPoE subscribers' IPs (same /24).
// This is a best-effort suggestion; provisioning validates against the real router/subnet.
function suggestNextIpoeIp() {
  const ips = Customers.list().filter((c) => (c.conn_type === "ipoe") && c.static_ip).map((c) => c.static_ip);
  if (!ips.length) return ""; // no basis to guess; admin sets it
  // use the most common /24 prefix among existing IPoE IPs
  const counts = {};
  for (const ip of ips) { const p = ip.split(".").slice(0, 3).join("."); counts[p] = (counts[p] || 0) + 1; }
  const prefix = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const used = new Set(ips.filter((ip) => ip.startsWith(prefix + ".")).map((ip) => Number(ip.split(".")[3])));
  for (let host = 3; host <= 253; host++) { if (!used.has(host)) return prefix + "." + host; }
  return "";
}

function subnetParts(network) {
  const [net, mask] = String(network).split("/");
  const o = net.split(".");
  if (o.length !== 4) throw new Error("network must look like 10.0.11.0/24");
  const base = o.slice(0, 3).join(".");
  return { base, mask: mask || "24", gateway: base + ".1", gwCidr: base + ".1/" + (mask || "24"), poolRange: base + ".3-" + base + ".253", network: base + ".0/" + (mask || "24") };
}
async function provisionDhcp(b) {
  const sp = subnetParts(b.network);
  const tag = b.tag || b.interface;
  const poolName = b.pool || ("pool-" + tag);
  const steps = [];
  const pools = (await mt.pools().catch(() => [])) || [];
  if (!pools.find((p) => p.name === poolName)) { await mt.poolAdd({ name: poolName, ranges: b.poolRange || sp.poolRange }); steps.push("pool " + poolName); } else steps.push("pool exists");
  const nets = (await mt.dhcpNetworks().catch(() => [])) || [];
  if (!nets.find((n) => n.address === sp.network)) { await mt.dhcpNetworkAdd({ address: sp.network, gateway: b.gateway || sp.gateway, dns: b.dns || "8.8.8.8" }); steps.push("network " + sp.network); } else steps.push("network exists");
  const servers = (await mt.dhcpServers().catch(() => [])) || [];
  const srvName = b.name || tag; // default DHCP server name = the VLAN/interface name
  if (!servers.find((s) => s.name === srvName)) { await mt.dhcpServerAdd({ name: srvName, interface: b.interface, pool: poolName, leaseTime: b.leaseTime || "00:30:00" }); steps.push("dhcp " + srvName); } else steps.push("dhcp exists");
  return { pool: poolName, gateway: b.gateway || sp.gateway, network: sp.network, server: srvName, steps };
}
async function expandVlanHotspot(b) {
  if (!b.vlanId || !b.interface || !b.network) throw new Error("Need VLAN ID, parent interface, and network (e.g. 10.0.15.0/24).");
  const sp = subnetParts(b.network);
  const vlanName = b.vlanName || ("vlan" + b.vlanId);
  const gateway = b.gateway || sp.gateway;        // 10.0.15.1
  const gwCidr = gateway + "/" + sp.mask;          // 10.0.15.1/24
  const poolRange = b.poolRange || sp.poolRange;   // 10.0.15.3-10.0.15.253
  const dns = b.dns || "8.8.8.8";
  const leaseTime = b.leaseTime || "00:30:00";
  const steps = [];
  // 1) VLAN — name + id only, NO comment
  const vlans = (await mt.vlans().catch(() => [])) || [];
  if (!vlans.find((v) => v.name === vlanName || String(v["vlan-id"]) === String(b.vlanId))) { await mt.vlanAdd({ name: vlanName, vlanId: b.vlanId, interface: b.interface }); steps.push("vlan " + vlanName); } else steps.push("vlan exists");
  // 2) gateway IP on the VLAN — NO comment
  const addrs = (await mt.ipAddresses().catch(() => [])) || [];
  if (!addrs.find((a) => String(a.address) === gwCidr)) { await mt.ipAddressAdd({ address: gwCidr, interface: vlanName }); steps.push("ip " + gwCidr); } else steps.push("ip exists");
  // 3) DHCP (pool + network + server), server name = vlan name, lease 30m
  const dhcp = await provisionDhcp({ interface: vlanName, network: b.network, gateway, dns, tag: vlanName, poolRange, leaseTime, name: vlanName });
  steps.push(...dhcp.steps);
  // 4) hotspot server on the VLAN, reusing the same pool + addresses-per-mac
  const hs = (await mt.hotspotServers().catch(() => [])) || [];
  const hsName = b.hotspotName || ("hs-" + vlanName);
  if (!hs.find((h) => h.name === hsName || h.interface === vlanName)) { await mt.hotspotServerAdd({ name: hsName, interface: vlanName, pool: dhcp.pool, profile: b.profile, addressesPerMac: b.addressesPerMac }); steps.push("hotspot " + hsName); } else steps.push("hotspot exists");
  return { vlan: vlanName, gateway, pool: dhcp.pool, hotspot: hsName, steps };
}

async function runVendoCheck() {
  if (_vendoPolling) return;
  if (Settings.get("vendo_alerts", "0") !== "1") return;
  _vendoPolling = true;
  try {
    const list = Vendos.list().filter((v) => v.enabled);
    for (const v of list) {
      let online = false, fresh = null;
      try { const r = await fetchVendo(v); online = !!r.online; fresh = r; Vendos.saveSnapshot(v.id, online, r); }
      catch { online = false; }
      const st = VENDO_STATE.get(v.id) || { online: true, fails: 0, since: null, lastTotal: null, alerted: {} };
      st.alerted = st.alerted || {};
      // ---- coin tamper: total counter dropped without a collection ----
      if (online && Settings.get("coin_alerts", "0") === "1") {
        try {
          let cur = null;
          if (fresh) {
            const d = fresh.dashboard || fresh.parsed || {};
            const v2 = Number(d.coinTotal ?? d.sales ?? d.salesTotal ?? d.total ?? fresh.sales);
            if (!isNaN(v2)) cur = v2;
          }
          if (cur != null && !isNaN(cur)) {
            const tamper = totalDropTamper(st.lastTotal, cur, { collectedSince: false });
            if (tamper) {
              tgNotify(`🚨 <b>VENDO TAMPER?</b>\n${escapeHtml(v.name)} (${escapeHtml(v.ip)})\n${escapeHtml(tamper.msg)}`);
              Audit.add({ type: "auto", action: "coin-tamper", detail: `${v.name}: ${tamper.from}->${tamper.to}`, ok: false });
            }
            st.lastTotal = cur;
          }
          // ---- coin-drop anomalies (spike / burst / stall) ----
          const events = VendoSales.eventsForVendo(v.name, 200);
          for (const a of coinAnomalies(events)) {
            const lastAt = st.alerted[a.type] || 0;
            if (Date.now() - lastAt > 30 * 60000) { // de-dupe: at most once / 30 min per type
              const icon = a.severity === "info" ? "\u2139\uFE0F" : "\u26A0\uFE0F";
              tgNotify(`${icon} <b>COIN ALERT \u2014 ${escapeHtml(v.name)}</b>\n${escapeHtml(a.msg)}`);
              Audit.add({ type: "auto", action: a.type, detail: `${v.name}: ${a.msg}`.slice(0, 120), ok: false });
              st.alerted[a.type] = Date.now();
            }
          }
        } catch {}
      }
      if (online) {
        if (st.online === false) {
          const downMin = st.since ? Math.round((Date.now() - st.since) / 60000) : null;
          tgNotify(`🟢 <b>VENDO BACK ONLINE</b>\n${escapeHtml(v.name)} (${escapeHtml(v.ip)})` + (downMin != null ? `\nwas offline ~${downMin} min` : ""));
          Audit.add({ type: "auto", action: "vendo-online", detail: v.name, ok: true });
        }
        st.online = true; st.fails = 0; st.since = null;
      } else {
        const fails = (st.fails || 0) + 1;
        if (fails >= 2 && st.online !== false) {
          tgNotify(`🔴 <b>VENDO OFFLINE</b>\n${escapeHtml(v.name)} (${escapeHtml(v.ip)})\nNot responding — check power/network at that vendo.`);
          Audit.add({ type: "auto", action: "vendo-offline", detail: v.name, ok: false });
          st.online = false; st.fails = fails; st.since = Date.now();
        } else {
          st.fails = fails;
        }
      }
      VENDO_STATE.set(v.id, st);
    }
    return { checked: list.length };
  } finally { _vendoPolling = false; }
}
let _vendoTimer = null;
function rescheduleVendoCheck() {
  if (_vendoTimer) { clearInterval(_vendoTimer); _vendoTimer = null; }
  const mins = Math.max(0, Number(Settings.get("vendo_check_mins", "3")) || 0);
  if (Settings.get("vendo_alerts", "0") === "1" && mins > 0) _vendoTimer = setInterval(() => { runVendoCheck().catch(() => {}); }, mins * 60 * 1000);
  return Settings.get("vendo_alerts", "0") === "1" ? mins : 0;
}

// ---- Network watchdog: router reachability, mass-offline detection, last-seen ----
const WD = { up: null, fails: 0, downSince: null, lastCheck: null, baseline: null, massAlert: false, online: null, events: [] };
function wdEvent(ev) {
  WD.events.unshift(ev); WD.events.length = Math.min(WD.events.length, 50);
  if (ev.type === "mass-drop" && Settings.get("auto_outage", "0") === "1") {
    try {
      // Smart triage: do the offline clients share one tower?
      const offline = ClientStatus.all().filter((c) => !c.online).map((c) => {
        const cust = Customers.byUsername(c.username);
        return { username: c.username, nap_id: cust ? cust.nap_id : null };
      });
      const naps = Naps.list();
      const t = triageMassDrop(offline, naps);
      let o;
      if (t) {
        o = Outages.create({ title: `Auto: ${t.name} likely down (${t.count} of ${t.of} offline clients on it)`, scope_type: "nap", scope_value: String(t.nap_id), notes: "auto-detected + triaged by the network watchdog" });
        tgNotify(`🛰 <b>SMART TRIAGE</b>\n${t.count} of ${t.of} offline clients are on <b>${escapeHtml(t.name)}</b>.\nLikely that tower is down — outage opened on it.`);
      } else {
        o = Outages.create({ title: `Auto-detected: clients dropped ${ev.from} → ${ev.to}`, scope_type: "all", notes: "opened automatically by the network watchdog" });
      }
      Audit.add({ type: "auto", action: "outage-open", detail: o.title, ok: true });
    } catch {}
  }
  Audit.add({ type: "auto", action: "watchdog", detail: ev.msg, ok: ev.type === "router-up" || ev.type === "mass-recover" });
  const head = ev.type === "router-down" ? "🔴 <b>ROUTER DOWN</b>" : ev.type === "router-up" ? "🟢 <b>ROUTER RESTORED</b>" : ev.type === "mass-drop" ? "⚠️ <b>MASS OFFLINE</b>" : "🟢 <b>CLIENTS RESTORED</b>";
  tgNotify(`${head}\n${escapeHtml(ev.msg)}`);
}
let _wdRunning = false;
async function runWatchdog() {
  if (_wdRunning || !mtConfig().host) return { skipped: true };
  _wdRunning = true;
  try {
    const now = localNowStr();
    let reachable = false, secrets = [], active = [];
    try { secrets = await mt.listPppoe(); active = await mt.listPppoeActive(); reachable = true; }
    catch { reachable = false; }
    for (const ev of evalRouter(WD, reachable, now)) wdEvent(ev);
    if (reachable) {
      const onlineSet = new Set(active.map((a) => a.name));
      WD.online = onlineSet.size;
      for (const ev of evalMassDrop(WD, onlineSet.size, now, { pct: Number(Settings.get("watchdog_drop_pct", "50")) || 50 })) wdEvent(ev);
      const prev = ClientStatus.map();
      const changes = diffClientStates(secrets.map((s) => s.name), onlineSet, prev);
      if (changes.length || onlineSet.size) ClientStatus.apply(changes, onlineSet, now);
    }
    return { up: WD.up, online: WD.online };
  } finally { _wdRunning = false; }
}
let _wdTimer = null;
function rescheduleWatchdog() {
  if (_wdTimer) { clearInterval(_wdTimer); _wdTimer = null; }
  const mins = Math.max(0, Number(Settings.get("watchdog_mins", "2")) || 0);
  if (mins > 0) _wdTimer = setInterval(() => { runWatchdog().catch(() => {}); }, mins * 60 * 1000);
  return mins;
}

// Recurring sweep timer (re-armed when the interval setting changes).
let _sweepTimer = null;
function rescheduleSweep() {
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
  const mins = Math.max(0, Number(Settings.get("expiry_check_mins", "2")) || 0);
  if (mins > 0) _sweepTimer = setInterval(() => { runExpirySweep().catch(() => {}); }, mins * 60 * 1000);
  return mins;
}

// ---- Client Portal sync (PULL model) -------------------------------------
// Your public portal (on a VPS) only COLLECTS applications/payments/help tickets.
// This panel, on your PRIVATE network, periodically PULLS new ones using a secret token,
// imports them (applications -> job orders), then ACKs so they aren't pulled again.
// The portal never reaches in to us; we reach out to it. No inbound ports needed here.
function _portalCfg() {
  return {
    url: (Settings.get("portal_url", "") || "").replace(/\/+$/, ""),   // e.g. https://portal.example.com
    token: Settings.get("portal_token", "") || "",
    enabled: Settings.get("portal_sync_enabled", "0") === "1",
  };
}
function _portalGet(base, pathName, token) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(base + pathName); } catch (e) { return reject(e); }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: "GET", headers: { Authorization: "Bearer " + token }, timeout: 12000 }, (res) => {
      let d = ""; res.on("data", (c) => d += c); res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(d || "{}") }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on("timeout", () => req.destroy(new Error("portal timeout")));
    req.on("error", reject); req.end();
  });
}
function _portalPost(base, pathName, token, bodyObj) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(base + pathName); } catch (e) { return reject(e); }
    const lib = u.protocol === "https:" ? https : http;
    const payload = JSON.stringify(bodyObj || {});
    const req = lib.request(u, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 12000 }, (res) => {
      let d = ""; res.on("data", (c) => d += c); res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(d || "{}") }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on("timeout", () => req.destroy(new Error("portal timeout")));
    req.on("error", reject); req.end(payload);
  });
}
async function runPortalSync() {
  const cfg = _portalCfg();
  if (!cfg.enabled || !cfg.url || !cfg.token) return { ok: false, skipped: true };
  let pulled = 0, imported = 0; const acked = [];
  try {
    const r = await _portalGet(cfg.url, "/sync/pull", cfg.token);
    if (r.status === 401) { Audit.add({ type: "auto", action: "portal-sync", detail: "unauthorized — check portal token", ok: false }); return { ok: false, error: "unauthorized" }; }
    if (!r.json || !r.json.ok || !Array.isArray(r.json.items)) return { ok: false, error: "bad response" };
    pulled = r.json.items.length;
    const s = Settings.all();
    for (const item of r.json.items) {
      try {
        const d = item.data || {};
        if (item.kind === "apply") {
          // applications become job orders (same as the built-in apply form)
          JobOrders.apply({
            name: d.name, contact: d.contact, email: d.email, address: d.address, area: d.area,
            plan_id: null, conn_type: d.conn_type || "pppoe", notes: (d.message || "") + " [via portal]",
            install_fee: Number(s.install_fee || 0), router_cost: Number(s.router_cost || 0),
            pay_choice: d.pay_choice === "now" ? "now" : "on_install",
            pay_reference: d.pay_reference || "", pay_proof: "", agreed: 1,
          });
          imported++;
        } else if (item.kind === "help") {
          // help tickets -> activity log (you can act on them from the dashboard)
          Audit.add({ type: "auto", action: "portal-help-ticket", detail: `${d.name} (${d.contact}) [${d.topic || "support"}]: ${d.message || ""}`, ok: true });
          imported++;
        } else if (item.kind === "pay") {
          // payment NOTICES are informational — log them; you confirm & record the actual payment.
          Audit.add({ type: "auto", action: "portal-payment-notice", detail: `${d.name} (${d.contact}) ${d.message || ""} ref:${d.pay_reference || "-"}`, ok: true });
          imported++;
        }
        acked.push(item.id);
      } catch (e) { /* skip a bad item, keep going */ }
    }
    if (acked.length) await _portalPost(cfg.url, "/sync/ack", cfg.token, { ids: acked });
    if (imported) Audit.add({ type: "auto", action: "portal-sync", detail: `imported ${imported} of ${pulled} from portal`, ok: true });
    return { ok: true, pulled, imported };
  } catch (e) {
    Audit.add({ type: "auto", action: "portal-sync", detail: "error: " + e.message, ok: false });
    return { ok: false, error: e.message };
  }
}
let _portalTimer = null;
function reschedulePortalSync() {
  if (_portalTimer) { clearInterval(_portalTimer); _portalTimer = null; }
  const cfg = _portalCfg();
  if (cfg.enabled && cfg.url && cfg.token) {
    const mins = Math.max(1, Number(Settings.get("portal_sync_mins", "1")) || 1);
    _portalTimer = setInterval(() => { runPortalSync().catch(() => {}); pushCustomerSummary().catch(() => {}); }, mins * 60 * 1000);
    if (_portalTimer.unref) _portalTimer.unref();
    return mins;
  }
  return 0;
}

// Push a MINIMAL, read-only customer summary up to the portal so customers can look up their
// balance/due date/plan. We send ONLY what's needed to display — never passwords, never router
// credentials, never the full DB. The portal stores this snapshot; customers query it by
// account code + last name. This is outbound only (no inbound ports; router stays private).
async function pushCustomerSummary() {
  const cfg = _portalCfg();
  if (!cfg.enabled || !cfg.url || !cfg.token) return { ok: false, skipped: true };
  // only push if the operator opted in (it's a privacy choice to put balances in the cloud)
  if (Settings.get("portal_show_balance", "0") !== "1") return { ok: false, skipped: true };
  try {
    const rows = Customers.list ? Customers.list() : [];
    const summary = rows.map((c) => {
      const lastName = String(c.name || "").trim().split(/\s+/).slice(-1)[0] || "";
      return {
        code: c.account_code || "",
        last: lastName.toLowerCase(),            // for matching (case-insensitive)
        name: c.name || "",
        plan: c.plan_name || "",
        speed: c.plan_speed || "",
        status: c.auto_suspended ? "suspended" : (c.status || "active"),
        due: c.expiry || "",
        balance: Number(c.credit || 0),          // wallet credit (positive = they have credit)
      };
    }).filter((x) => x.code && x.last);           // only customers with an account code
    const r = await _portalPost(cfg.url, "/sync/push-summary", cfg.token, { customers: summary });
    if (r.status === 401) { Audit.add({ type: "auto", action: "portal-push", detail: "unauthorized — check token", ok: false }); return { ok: false, error: "unauthorized" }; }
    return { ok: true, pushed: summary.length };
  } catch (e) {
    Audit.add({ type: "auto", action: "portal-push", detail: "error: " + e.message, ok: false });
    return { ok: false, error: e.message };
  }
}

async function runCollections({ dryRun = false, graceDays = 0 } = {}) {
  const suspended = [], reconnected = [], errors = [];
  const isHotspot = (c) => (c.plan_type || "pppoe") === "hotspot";

  // Expiry-based pass (PDF model): suspend accounts whose expiry has passed (minus grace).
  const today = await routerNow();
  const grace0 = Math.max(0, Number(Settings.get("expiry_grace_mins", "0")) || 0);
  for (const c of Customers.expiredAsOf(grace0 ? addMinutes(today, -grace0) : today)) {
    if (dryRun) { suspended.push({ id: c.id, name: c.name, username: c.username, expiry: c.expiry, preview: true }); continue; }
    try {
      await suspendForExpiry(c);
      suspended.push({ id: c.id, name: c.name, username: c.username, expiry: c.expiry });
    } catch (e) {
      Audit.add({ type: "auto", customer_id: c.id, customer_name: c.name, action: "suspend", detail: e.message, ok: false });
      errors.push({ id: c.id, name: c.name, action: "suspend", error: e.message });
    }
  }

  for (const c of Collections.toSuspend(graceDays)) {
    if (c.expiry) continue; // already covered by the expiry pass above
    if (dryRun) { suspended.push({ id: c.id, name: c.name, username: c.username, preview: true }); continue; }
    try {
      if (isHotspot(c)) await mt.setHotspotUserDisabled(c.username, true);
      else await mt.setPppoeDisabled(c.username, true);
      Customers.setStatusAndAuto(c.id, "suspended", true);
      Audit.add({ type: "auto", customer_id: c.id, customer_name: c.name, action: "suspend", detail: "overdue", ok: true });
      suspended.push({ id: c.id, name: c.name, username: c.username });
      tgNotify(`⚠️ <b>Disconnected (unpaid)</b>\nClient: <b>${c.name}</b> (${c.username || "—"})\nDate: ${new Date().toLocaleString()}\nReason: past due`);
    } catch (e) {
      Audit.add({ type: "auto", customer_id: c.id, customer_name: c.name, action: "suspend", detail: e.message, ok: false });
      errors.push({ id: c.id, name: c.name, action: "suspend", error: e.message });
    }
  }

  for (const c of Collections.toReconnect()) {
    if (dryRun) { reconnected.push({ id: c.id, name: c.name, username: c.username, preview: true }); continue; }
    try {
      if (isHotspot(c)) await mt.setHotspotUserDisabled(c.username, false);
      else await mt.setPppoeDisabled(c.username, false);
      Customers.setStatusAndAuto(c.id, "active", false);
      Audit.add({ type: "auto", customer_id: c.id, customer_name: c.name, action: "reconnect", detail: "paid", ok: true });
      reconnected.push({ id: c.id, name: c.name, username: c.username });
    } catch (e) {
      Audit.add({ type: "auto", customer_id: c.id, customer_name: c.name, action: "reconnect", detail: e.message, ok: false });
      errors.push({ id: c.id, name: c.name, action: "reconnect", error: e.message });
    }
  }
  return { ranAt: new Date().toISOString(), dryRun, graceDays, suspended, reconnected, errors };
}

// Simple zero-dependency daily scheduler: run fn() every day at HH:MM.
function scheduleDailyJob(hhmm, fn, label) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const msUntilNext = () => {
    const now = new Date(); const next = new Date(now);
    next.setHours(h || 0, m || 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  };
  const arm = () => setTimeout(async () => {
    try { await fn(); console.log(`[auto] ${label || "job"} ran`); }
    catch (e) { console.error(`[auto] ${label || "job"} error:`, e.message); }
    arm();
  }, msUntilNext());
  arm();
}

function scheduleDaily(hhmm, fn) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const msUntilNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(h || 0, m || 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  };
  const arm = () => setTimeout(async () => {
    try { const r = await fn(); console.log(`[auto] collections run: ${r.suspended.length} suspended, ${r.reconnected.length} reconnected, ${r.errors.length} errors`); }
    catch (e) { console.error("[auto] scheduled job error:", e.message); }
    arm();
  }, msUntilNext());
  arm();
}


// status in sync. Works for pppoe (default) and hotspot plans.
// ---- Time sync with MikroTik + expiry-based suspend/reconnect ------------
function parseRosDate(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);             // ROS v7: 2026-06-11
  const m = /^([a-z]{3})\/(\d{1,2})\/(\d{4})$/i.exec(s);              // ROS v6: jun/11/2026
  if (m) { const mo = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" }[m[1].toLowerCase()]; return `${m[3]}-${mo}-${String(m[2]).padStart(2,"0")}`; }
  return null;
}
async function routerToday() {
  try { const c = await mt.clock(); const d = parseRosDate(c && c.date); if (d) return d; } catch {}
  return new Date().toISOString().slice(0, 10);
}
function pad2(n) { return String(n).padStart(2, "0"); }
function localNowStr() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
// Full datetime "YYYY-MM-DD HH:MM:SS" from the router clock (fallback: server local time).
async function routerNow() {
  try { const c = await mt.clock(); const d = parseRosDate(c && c.date); const t = (c && c.time && /^\d{2}:\d{2}/.test(c.time)) ? c.time.slice(0, 8) : null; if (d) return `${d} ${t || "00:00:00"}`; } catch {}
  return localNowStr();
}
function addDays(ymd, days) { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + (Number(days) || 0)); return d.toISOString().slice(0, 10); }
function addMinutes(dt, mins) {
  const s = String(dt || "").replace(" ", "T"); const base = new Date(s.length <= 10 ? s + "T00:00:00Z" : s + "Z");
  if (isNaN(base)) return localNowStr();
  base.setUTCMinutes(base.getUTCMinutes() + (Number(mins) || 0));
  const i = base.toISOString(); return i.slice(0, 10) + " " + i.slice(11, 19);
}

// ---- IPoE lifecycle (static lease by MAC + queue; address-list suspend) ----
const IPOE_SUSPEND_LIST = "suspended"; // matches the panel's firewall redirect rules
function normalizeMac(raw) {
  // Accept AABBCCDDEEFF, aa-bb-cc.., aa:bb:.., with spaces; return canonical AA:BB:CC:DD:EE:FF or "".
  const hex = String(raw || "").toUpperCase().replace(/[^0-9A-F]/g, "");
  if (hex.length !== 12) return "";
  return hex.match(/.{2}/g).join(":");
}
function rateLimitFor(c) {
  // plan speed → RouterOS rate-limit "UP/DOWN". Accepts "10M/10M" or a single "10M".
  let rl = c.plan_speed || c.plan_rate || c.rate_limit || "";
  if (rl && !rl.includes("/")) rl = rl + "/" + rl;
  return rl;
}
async function ipoeProvision(c) {
  if (!c.mac) throw new Error("IPoE customer needs a MAC address.");
  if (!c.static_ip) throw new Error("IPoE customer needs a static IP.");
  if (!c.vlan_iface) throw new Error("IPoE customer needs a VLAN / DHCP-server name.");
  const mac = normalizeMac(c.mac);
  if (!mac) throw new Error(`The MAC address "${c.mac}" isn't valid. It must be 6 pairs like A8:A5:EF:26:2B:55.`);
  const server = c.vlan_iface; // the VLAN's DHCP server name (e.g. vlan15)
  // Verify the DHCP server actually exists on the router, with a clear message if not.
  let servers = [];
  try { servers = (await mt.dhcpServers()) || []; } catch (e) { throw new Error("Can't reach the router to provision (" + e.message + ")."); }
  if (servers.length && !servers.find((s) => s.name === server)) {
    const names = servers.map((s) => s.name).join(", ") || "(none)";
    throw new Error(`No DHCP server named "${server}" on the router. Create it first (Vendos → Network setup → Easy expand), or pick one of: ${names}.`);
  }
  // Sanity-check the static IP belongs to that server's subnet (via the gateway address on its interface).
  try {
    const srv = servers.find((s) => s.name === server);
    if (srv) {
      const addrs = (await mt.ipAddresses().catch(() => [])) || [];
      const ga = addrs.find((a) => a.interface === srv.interface && a.address);
      if (ga && ga.address.includes("/")) {
        const [gwip, mask] = ga.address.split("/");
        const net3 = gwip.split(".").slice(0, 3).join(".");
        const ip3 = String(c.static_ip).split(".").slice(0, 3).join(".");
        if (mask === "24" && net3 !== ip3) {
          throw new Error(`The IP ${c.static_ip} isn't in ${server}'s subnet (${net3}.0/24, gateway ${gwip}). Use an address like ${net3}.x.`);
        }
      }
    }
  } catch (e) { if (/isn't in/.test(e.message)) throw e; }
  const rl = rateLimitFor(c);
  const qname = "ipoe-" + (c.username || c.id);
  // remove any stale lease/queue for this MAC first (idempotent)
  try { await mt.leaseRemoveByMac(mac); } catch {}
  try {
    await mt.leaseAddStatic({ address: c.static_ip, mac, server, rateLimit: rl, comment: "ipoe " + c.name });
  } catch (e) {
    throw new Error(`Could not add the DHCP lease (${c.static_ip} → ${mac} on "${server}"): ${e.message}. Check the IP is inside that server\'s subnet and not already used.`);
  }
  if (rl) {
    // The DHCP lease's rate-limit auto-creates the dynamic simple queue on RouterOS,
    // so we do NOT add a separate simple queue (it would duplicate it). Just clean up any
    // standalone queue left by earlier versions.
    try { await mt.queueSimpleRemoveByName(qname); } catch {}
  }
  // make sure they're not left on the suspended list
  try { await mt.addrListRemove(IPOE_SUSPEND_LIST, c.static_ip); } catch {}
}
async function ipoeSuspend(c) {
  if (!c.static_ip) throw new Error("IPoE customer has no static IP to suspend.");
  // The panel ONLY manages the 'suspended' address-list. The router's own rules
  // (NAT dstnat by src-address-list=suspended, and the web-proxy redirect) do the
  // redirect. The panel never touches /ip proxy access or /ip firewall nat, so your
  // working router rules are left exactly as they are.
  await mt.addrListAdd(IPOE_SUSPEND_LIST, c.static_ip, "suspended " + c.name);
  Audit.add({ type: "auto", customer_id: c.id, action: "ipoe-suspend", detail: c.static_ip + " added to '" + IPOE_SUSPEND_LIST + "'", ok: true });
}
async function ipoeEnable(c) {
  if (!c.static_ip) throw new Error("IPoE customer has no static IP.");
  await mt.addrListRemove(IPOE_SUSPEND_LIST, c.static_ip);
  Audit.add({ type: "auto", customer_id: c.id, action: "ipoe-enable", detail: c.static_ip + " removed from '" + IPOE_SUSPEND_LIST + "'", ok: true });
}
// Public URL (Settings) -> { host, port } for redirect rules.
function proxyRedirectParts() {
  let u = (Settings.get("public_url") || "").trim();
  if (!u) return { host: "", port: 80 };
  u = u.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const [host, port] = u.split(":");
  return { host: host || "", port: Number(port) || 80 };
}

// Switch a customer's router profile (ACTIVE plan profile <-> SUSPENDED profile)
// or fall back to disable/enable, then kick the live session so it applies now.
async function applyProfileSwitch(c, target) {
  if ((c.conn_type || "pppoe") === "ipoe") {
    if (target === "suspend") return ipoeSuspend(c);
    return ipoeEnable(c);
  }
  const isHotspot = (c.plan_type || "pppoe") === "hotspot";
  const suspProfile = Settings.get("suspended_profile");
  const activeProfile = c.plan_profile || "default";
  if (target === "suspend") {
    if (suspProfile) { if (isHotspot) await mt.updateHotspotUser(c.username, { profile: suspProfile }); else await mt.updatePppoe(c.username, { profile: suspProfile }); }
    else { if (isHotspot) await mt.setHotspotUserDisabled(c.username, true); else await mt.setPppoeDisabled(c.username, true); }
  } else {
    if (suspProfile) { if (isHotspot) await mt.updateHotspotUser(c.username, { profile: activeProfile }); else await mt.updatePppoe(c.username, { profile: activeProfile }); }
    else { if (isHotspot) await mt.setHotspotUserDisabled(c.username, false); else await mt.setPppoeDisabled(c.username, false); }
  }
  try { if (isHotspot) await mt.disconnectHotspot(c.username); else await mt.disconnectPppoe(c.username); } catch {}
}

// Reconnect + extend expiry by N minutes (from the later of current expiry / now).
async function renewCustomer(c, mins) {
  await applyProfileSwitch(c, "active");
  const now = await routerNow();
  const base = (c.expiry && c.expiry >= now) ? c.expiry : now;
  const newExpiry = addMinutes(base, Number(mins) || (Number(c.plan_mins) || 43200));
  Customers.setExpiry(c.id, newExpiry);
  Customers.setStatusAndAuto(c.id, "active", false);
  return newExpiry;
}

async function customerAction(id, action) {
  const c = Customers.get(id);
  if (!c) throw new Error("Customer not found");
  const isIpoe = (c.conn_type || "pppoe") === "ipoe";
  if (!isIpoe && !c.username) throw new Error("Customer has no router username set");
  if (isIpoe && !c.mac) throw new Error("IPoE customer has no MAC address set");
  const isHotspot = (c.plan_type || "pppoe") === "hotspot";

  if (action === "suspend") { await applyProfileSwitch(c, "suspend"); return Customers.setStatus(id, "suspended"); }
  if (action === "enable") { await applyProfileSwitch(c, "active"); return Customers.setStatus(id, "active"); }
  if (action === "renew") {
    const exp = await renewCustomer(c, c.plan_mins || 43200);
    if (Settings.get("notify_customers", "1") === "1" && c.contact) notifyCustomerMsg(c.contact, c.name, "Service renewed", `Hi ${c.name}, your internet service has been renewed. New expiry: ${exp}. Thank you!`).catch(() => {});
    return Customers.get(id);
  }
  if (action === "provision") {
    if (isIpoe) { await ipoeProvision(c); }
    else {
      const profile = c.plan_profile || "default";
      if (isHotspot) await mt.createHotspotUser({ name: c.username, password: c.password, profile });
      else await mt.createPppoe({ name: c.username, password: c.password, profile, comment: c.name });
    }
    if (!c.expiry) Customers.setExpiry(id, addMinutes(await routerNow(), c.plan_mins || 43200));
    return Customers.setStatus(id, "active");
  }
  throw new Error("Unknown action");
}

const PORT = process.env.PORT || 3000;

// AI config comes from Settings (operator pastes the key in the UI), with .env as fallback.
// Toggle: ai_enabled. Key: ai_api_key. Model: ai_model.
setAiConfigProvider(() => {
  const enabled = Settings.get("ai_enabled", process.env.ANTHROPIC_API_KEY ? "1" : "0") === "1";
  const apiKey = Settings.get("ai_api_key", "") || process.env.ANTHROPIC_API_KEY || "";
  const model = Settings.get("ai_model", "") || process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  return { enabled, apiKey, model, base: process.env.AI_BASE || "https://api.anthropic.com" };
});

// Check the license before we start serving. The handler hard-locks if it's not valid.
refreshLicense();
// Re-verify the license periodically (catches a swapped/deleted key file mid-session, or an
// expiry that happens while the app is running). Cheap: re-reads the file + re-checks signature.
const _licTimer = setInterval(() => { try { refreshLicense(); } catch {} }, 10 * 60 * 1000);
if (_licTimer.unref) _licTimer.unref();
if (LICENSE_OK) console.log("  >> license: OK (" + (LICENSE_STATE.license?.customer || "") + ", " + (LICENSE_STATE.license?.model || "") + ")");
else console.log("  !! license: " + LICENSE_STATE.reason + " — panel will show the activation page until a valid key is added. Machine ID: " + License.machineId());

// ---- HTTP / HTTPS startup ----
// If TLS_CERT + TLS_KEY point to valid PEM files (e.g. from Let's Encrypt / certbot),
// the panel serves HTTPS on PORT and (optionally) redirects plain HTTP on TLS_HTTP_PORT.
// Otherwise it serves plain HTTP as before.
let server, httpsOn = false;
const certPath = process.env.TLS_CERT || "";
const keyPath = process.env.TLS_KEY || "";
if (certPath && keyPath) {
  try {
    const opts = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
    if (process.env.TLS_CA) { try { opts.ca = fs.readFileSync(process.env.TLS_CA); } catch {} }
    server = https.createServer(opts, requestHandler);
    httpsOn = true;
    // Optional: redirect plain HTTP -> HTTPS so old links + Let's Encrypt renewals work.
    const httpPort = Number(process.env.TLS_HTTP_PORT || 0);
    if (httpPort > 0) {
      http.createServer((req, res) => {
        const host = (req.headers.host || "").replace(/:\d+$/, "");
        const to = (Number(PORT) === 443) ? `https://${host}${req.url}` : `https://${host}:${PORT}${req.url}`;
        res.writeHead(301, { Location: to }); res.end();
      }).listen(httpPort, () => console.log(`  >> HTTP→HTTPS redirect listening on :${httpPort}`));
    }
  } catch (e) {
    console.log("  !! TLS_CERT/TLS_KEY set but could not be read (" + e.message + "). Falling back to HTTP.");
    server = http.createServer(requestHandler);
  }
} else {
  server = http.createServer(requestHandler);
}

server.listen(PORT, () => {
  const url = `${httpsOn ? "https" : "http"}://localhost:${PORT}`;
  const seeded = Auth.seedDefaultAdmin();
  if (process.env.RESET_ADMIN === "1" || process.env.RESET_ADMIN === "true") {
    Auth.ensureAdminReset();
    console.log('  >> RESET_ADMIN: the "admin" account was reset to password "admin" (role admin). Log in and change it, then remove RESET_ADMIN.');
  }
  console.log("============================================");
  console.log(" JEFF NETWORK SERVICE Panel");
  console.log(" Open in your browser: " + url);
  console.log(" Router target: " + (mtConfig().host || "(set MikroTik IP in Settings or .env)") + "  [mode: " + MODE + (MODE === "rest" ? "" : " port " + mt.port) + "]");
  console.log(" AI command box: " + (aiEnabled() ? "enabled" : "off (enable it in Settings → AI Assistant)"));
  console.log(" Billing database: " + dbFile);
  console.log(" Login: ENABLED (roles: admin / cashier / technician)");
  console.log(" Telegram approvals: " + (Settings.get("telegram_bot_token") ? "configured" : "set bot token + chat id in Settings to enable"));
  if (seeded) console.log(`  >> First run: default admin created — username "admin", password "admin". CHANGE IT after logging in.`);
  console.log(" Auto-suspend: " + (AUTOMATION.enabled
    ? `ON (daily ${AUTOMATION.time}, grace ${AUTOMATION.graceDays} day(s))`
    : "OFF (manual collections only)"));
  console.log(" Press Ctrl+C to stop.");
  console.log("============================================");
  // auto-open the browser (best-effort, per-OS; ignored if it fails, e.g. headless server)
  try {
    if (process.platform === "win32") exec(`start "" "${url}"`);
    else if (process.platform === "darwin") exec(`open "${url}"`);
    else exec(`xdg-open "${url}" >/dev/null 2>&1 || true`);
  } catch {}
  // Daily collection pass — scheduled always; it checks the live setting at fire-time,
  // so toggling auto-suspend in the dashboard takes effect without a restart.
  scheduleDaily(AUTOMATION.time, () => { if (AUTOMATION.enabled) runCollections({ graceDays: AUTOMATION.graceDays }); });
  // Daily reminders + operator report (default 08:00; override with report_time in Settings)
  scheduleDailyJob(Settings.get("report_time", "08:00"), async () => { await runAutoInvoice(); await runReminders(); await dailyReport(); await runAutoBackup(); }, "invoice+reminders+report+backup");
  // Short-interval expiry sweep so time-based (minute/hour) plans disconnect on time.
  const sweepMins = rescheduleSweep();
  if (sweepMins > 0) console.log(`  >> expiry sweep every ${sweepMins} min (Settings → "Check expiries every")`);
  const usageMins = rescheduleUsage();
  if (usageMins > 0) console.log(`  >> usage snapshot every ${usageMins} min`);
  if (rescheduleGsm()) console.log("  >> GSM dongle inbox check every 1 min");
  const wdMins = rescheduleWatchdog();
  if (wdMins > 0) { console.log(`  >> network watchdog every ${wdMins} min`); setTimeout(() => runWatchdog().catch(() => {}), 4000); }
  const vcMins = rescheduleVendoCheck();
  if (vcMins > 0) console.log(`  >> vendo offline check every ${vcMins} min`);
  const portalMins = reschedulePortalSync();
  if (portalMins > 0) { console.log(`  >> client portal sync every ${portalMins} min`); setTimeout(() => { runPortalSync().catch(() => {}); pushCustomerSummary().catch(() => {}); }, 5000); }
  tgPollLoop(); // listens for Telegram approve/reject (no-op until a bot token is set)
});
