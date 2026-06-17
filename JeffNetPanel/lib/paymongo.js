// lib/paymongo.js — create GCash/card payment Links and verify webhooks.
// Uses node:https only. Base URL is configurable for testing.
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";

function request(urlStr, { method = "GET", headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error("bad URL")); }
    const lib = u.protocol === "http:" ? http : https;
    const data = body == null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const h = { "Content-Type": "application/json", Accept: "application/json", ...headers };
    if (data) h["Content-Length"] = data.length;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + u.search, method, headers: h, timeout }, (res) => {
      let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, text: d, json: j }); });
    });
    req.on("timeout", () => req.destroy(new Error("PayMongo timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// cfg: { secret, baseUrl }   amountPhp in pesos (e.g. 500.00)
export async function createLink(cfg, { amountPhp, description, remarks }) {
  if (!cfg.secret) throw new Error("PayMongo secret key not set");
  const baseUrl = (cfg.baseUrl || "https://api.paymongo.com/v1").replace(/\/$/, "");
  const auth = "Basic " + Buffer.from(cfg.secret + ":").toString("base64");
  const r = await request(baseUrl + "/links", {
    method: "POST",
    headers: { Authorization: auth },
    body: { data: { attributes: { amount: Math.round(Number(amountPhp) * 100), description: description || "Invoice", remarks: remarks || "" } } },
  });
  if (r.status < 200 || r.status >= 300 || !r.json || !r.json.data) {
    const msg = r.json && r.json.errors ? r.json.errors.map((e) => e.detail).join("; ") : `HTTP ${r.status}`;
    throw new Error(msg);
  }
  const a = r.json.data.attributes || {};
  return { id: r.json.data.id, checkout_url: a.checkout_url, reference_number: a.reference_number, status: a.status };
}

// Verify a PayMongo webhook signature.
// Header format: "t=<unix>,te=<test sig>,li=<live sig>"
export function verifyWebhook(rawBody, signatureHeader, webhookSecret) {
  if (!webhookSecret || !signatureHeader) return false;
  const parts = {};
  for (const seg of String(signatureHeader).split(",")) {
    const i = seg.indexOf("=");
    if (i > 0) parts[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
  }
  if (!parts.t) return false;
  const expected = crypto.createHmac("sha256", webhookSecret).update(parts.t + "." + rawBody).digest("hex");
  for (const sig of [parts.te, parts.li]) {
    if (!sig) continue;
    try {
      const a = Buffer.from(expected, "hex"), b = Buffer.from(sig, "hex");
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch {}
  }
  return false;
}

// Pull the useful bits out of a webhook event body.
export function parseEvent(json) {
  const ev = json && json.data && json.data.attributes;
  if (!ev) return null;
  const resource = ev.data && ev.data.attributes ? ev.data.attributes : {};
  return {
    type: ev.type,                                  // e.g. "link.payment.paid"
    resourceId: ev.data ? ev.data.id : null,        // e.g. "link_xxx"
    status: resource.status,
    remarks: resource.remarks,
    amount: resource.amount,
  };
}
