// lib/juanfi.js
// Pulls data from a JuanFi (WiFi ni Juan) NodeMCU over the LAN.
//
// Reverse-engineered from JuanFi v4.4 firmware:
//   - Admin API lives under /admin/api/* and is guarded by an "X-TOKEN" header.
//   - A token is obtained by POSTing to /validateLogin (username + password);
//     the firmware generates a "randomToken".
//   - The "API Key (use for remote api)" from System Configuration can be sent
//     directly as the X-TOKEN, so remote tools skip the login step.
//   - Dashboard JSON keys: sales, dailySales, monthlySales, customerCount.
//   - Active users: /admin/api/getActiveUsers.
// We try the API key first, then a login, then legacy methods, and report which
// worked. The raw response is always kept so fields can be verified.
import http from "node:http";
import crypto from "node:crypto";

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

function httpReq(urlStr, { method = "GET", headers = {}, body = null, timeout = 7000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error("bad URL: " + urlStr)); }
    const data = body == null ? null : Buffer.from(body);
    const h = { ...headers };
    if (data) {
      h["Content-Type"] = h["Content-Type"] || "application/x-www-form-urlencoded";
      h["Content-Length"] = data.length;
    }
    const req = http.request(
      { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, timeout, headers: h },
      (res) => {
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(d); } catch {}
          resolve({ status: res.statusCode, text: d, json, headers: res.headers });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) => reject(e));
    if (data) req.write(data);
    req.end();
  });
}

function isAuthSuccess(r) {
  if (!r || r.status < 200 || r.status >= 300) return false;
  const t = r.text || "";
  if (/need to login|not login|unauthorized/i.test(t)) return false;
  if (/<html/i.test(t) && !r.json) return false;
  return true;
}

function parseDashboard(j) {
  if (!j || typeof j !== "object") return null;
  const lower = {};
  for (const k of Object.keys(j)) lower[k.toLowerCase()] = j[k];
  const has = (n) => Object.keys(lower).find((k) => k.includes(n));
  const val = (n) => { const k = has(n); return k ? lower[k] : undefined; };
  return {
    sales: lower["sales"] ?? val("total") ?? val("current"),
    dailySales: val("daily"),
    monthlySales: val("monthly"),
    customerServed: val("customer") ?? val("served") ?? val("count"),
    activeUsers: val("active"),
  };
}

// Extract a token from a /validateLogin response (JSON, plain body, or cookie).
function extractToken(r) {
  if (!r) return null;
  if (r.json && typeof r.json === "object") {
    return r.json.token || r.json.randomToken || r.json.value || r.json.data || null;
  }
  const t = (r.text || "").trim();
  if (t && t.length <= 80 && !/\s|<|>|need to login/i.test(t)) return t;
  const sc = r.headers && r.headers["set-cookie"];
  if (sc && sc.length) {
    const m = String(sc[0]).match(/(?:token|TOKEN)=([^;]+)/);
    if (m) return m[1];
  }
  return null;
}

async function login(base, username, password) {
  const forms = [
    `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    `username=${encodeURIComponent(username)}&password=${encodeURIComponent(md5(password))}`,
  ];
  for (const form of forms) {
    try {
      let r = await httpReq(base + "/validateLogin", { method: "POST", body: form });
      let tok = extractToken(r);
      if (tok) return tok;
      // some builds use GET query
      r = await httpReq(base + "/validateLogin?" + form, { method: "GET" });
      tok = extractToken(r);
      if (tok) return tok;
    } catch {}
  }
  return null;
}

async function pullWithToken(base, token) {
  const headers = { "X-TOKEN": token };
  const dash = await httpReq(base + "/admin/api/dashboard", { headers });
  if (!isAuthSuccess(dash)) return null;
  const out = { dash, active: null, rates: null };
  try { out.active = await httpReq(base + "/admin/api/getActiveUsers", { headers }); } catch {}
  try { out.rates = await httpReq(base + "/admin/api/getRates", { headers }); } catch {}
  return out;
}

function activeCount(activeResp) {
  if (!activeResp || !activeResp.json) return undefined;
  const j = activeResp.json;
  if (Array.isArray(j)) return j.length;
  if (Array.isArray(j.data)) return j.data.length;
  if (Array.isArray(j.users)) return j.users.length;
  return undefined;
}

export async function fetchVendo(v) {
  const port = Number(v.port) || 80;
  const base = `http://${v.ip}:${port}`;
  const out = { id: v.id, name: v.name, online: false, status: 0, method: null,
    parsed: null, dashboard: null, rates: null, raw: "", error: null, at: new Date().toISOString() };

  const finish = (method, pull) => {
    out.online = true;
    out.method = method;
    out.status = pull.dash.status;
    out.raw = (pull.dash.text || "").slice(0, 2000);
    out.dashboard = pull.dash.json;
    out.parsed = parseDashboard(pull.dash.json) || {};
    const ac = activeCount(pull.active);
    if (ac !== undefined) out.parsed.activeUsers = ac;
    out.rates = pull.rates ? (pull.rates.json || (pull.rates.text || "").slice(0, 1200)) : null;
    return out;
  };

  try {
    // 1) API key used directly as X-TOKEN (JuanFi "remote api")
    if (v.apikey) {
      const pull = await pullWithToken(base, v.apikey);
      if (pull) return finish("apikey (X-TOKEN)", pull);
    }
    // 2) Login with admin username/password to obtain a token
    if (v.username) {
      const tok = await login(base, v.username, v.password || "");
      if (tok) {
        const pull = await pullWithToken(base, tok);
        if (pull) return finish("login token (X-TOKEN)", pull);
      }
    }
    // 3) Legacy fallbacks (older firmware): HTTP Basic / ?apikey query
    const basic = "Basic " + Buffer.from(`${v.username || ""}:${v.password || ""}`).toString("base64");
    let r = await httpReq(base + "/admin/api/dashboard", { headers: { Authorization: basic } });
    if (isAuthSuccess(r)) return finish("basic-auth (legacy)", { dash: r });
    if (v.apikey) {
      r = await httpReq(base + "/admin/api/dashboard?apikey=" + encodeURIComponent(v.apikey));
      if (isAuthSuccess(r)) return finish("apikey-query (legacy)", { dash: r });
    }

    // Nothing worked — report the most useful failure.
    out.status = r ? r.status : 0;
    out.raw = r ? (r.text || "").slice(0, 2000) : "";
    if (v.apikey && !v.username) {
      out.error = "API key was rejected as X-TOKEN. Open System Configuration on the vendo, click Generate Key + SAVE, and paste the exact key — or instead fill the admin username & password.";
    } else {
      out.error = "Login failed. Use the SAME admin username & password you type at http://" + v.ip + "/login. If the password uses special characters, double-check it. You can also paste the vendo's API key.";
    }
  } catch (e) {
    out.error = e.message + " (is the panel PC able to reach " + base + "?)";
  }
  return out;
}
