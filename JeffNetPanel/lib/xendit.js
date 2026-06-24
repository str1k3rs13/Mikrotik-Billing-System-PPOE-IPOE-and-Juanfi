// lib/xendit.js — create GCash/card/e-wallet payment Invoices and verify webhooks via Xendit.
// Uses node:https only. Mirrors the shape of lib/paymongo.js so the server can call either.
// Xendit API docs: https://developer.xendit.co/api-reference/#create-invoice
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
    req.on("timeout", () => req.destroy(new Error("Xendit timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// cfg: { secret, baseUrl }   amountPhp in pesos (e.g. 500.00)
// Returns the same shape as paymongo.createLink: { id, checkout_url, reference_number, status }
export async function createLink(cfg, { amountPhp, description, remarks }) {
  if (!cfg.secret) throw new Error("Xendit secret key not set");
  const baseUrl = (cfg.baseUrl || "https://api.xendit.co").replace(/\/$/, "");
  // Xendit uses HTTP Basic auth: the secret API key as username, blank password.
  const auth = "Basic " + Buffer.from(cfg.secret + ":").toString("base64");
  // external_id ties the invoice back to our record (e.g. "INV-123"); must be unique per invoice.
  const externalId = (remarks || "INV") + "-" + Date.now().toString(36);
  const r = await request(baseUrl + "/v2/invoices", {
    method: "POST",
    headers: { Authorization: auth },
    body: {
      external_id: externalId,
      amount: Math.round(Number(amountPhp)),      // Xendit takes whole-peso amounts (PHP), not centavos
      description: description || "Invoice",
      currency: "PHP",
      // Let the customer pick GCash / card / e-wallet inside Xendit's hosted checkout.
      // (Omitting payment_methods lets Xendit show all the merchant's enabled channels.)
    },
  });
  if (r.status < 200 || r.status >= 300 || !r.json) {
    const msg = r.json && (r.json.message || r.json.error_code) ? (r.json.message || r.json.error_code) : `HTTP ${r.status}`;
    throw new Error(msg);
  }
  const a = r.json;
  return {
    id: a.id,                          // Xendit invoice id, e.g. "5f9a..."
    checkout_url: a.invoice_url,       // hosted checkout page
    reference_number: a.external_id,   // our external id
    status: a.status,                  // "PENDING" | "PAID" | "EXPIRED" | "SETTLED"
  };
}

// Verify a Xendit webhook. Xendit uses a static callback token in the "x-callback-token" header
// (set in the Xendit dashboard), compared against the token you saved in settings.
export function verifyWebhook(rawBody, callbackTokenHeader, expectedToken) {
  if (!expectedToken || !callbackTokenHeader) return false;
  try {
    const a = Buffer.from(String(callbackTokenHeader));
    const b = Buffer.from(String(expectedToken));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// Pull the useful bits out of a Xendit invoice webhook body.
// Xendit posts the invoice object directly: { id, external_id, status, amount, ... }
export function parseEvent(json) {
  if (!json) return null;
  const status = String(json.status || "").toUpperCase();
  // Treat PAID and SETTLED as success (SETTLED = funds settled to your balance).
  const paid = status === "PAID" || status === "SETTLED";
  return {
    type: paid ? "invoice.paid" : ("invoice." + (status.toLowerCase() || "event")),
    resourceId: json.id || null,
    status,
    remarks: json.external_id || "",
    amount: json.amount != null ? Math.round(Number(json.amount) * 100) : null, // normalize to centavos like PayMongo
    paid,
  };
}
