// lib/sms.js — minimal SMS sender via Semaphore (popular in the Philippines).
// Zero deps (node:https). Configurable base URL for testing.
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

// cfg: { apiKey, sender, baseUrl }   to: phone number(s)   message: text
export function sendSms(cfg, to, message) {
  return new Promise((resolve, reject) => {
    if (!cfg.apiKey) return reject(new Error("SMS API key not set"));
    const baseUrl = (cfg.baseUrl || "https://api.semaphore.co/api/v4").replace(/\/$/, "");
    let u; try { u = new URL(baseUrl + "/messages"); } catch { return reject(new Error("bad URL")); }
    const lib = u.protocol === "http:" ? http : https;
    const form = new URLSearchParams({ apikey: cfg.apiKey, number: String(to), message: String(message) });
    if (cfg.sender) form.set("sendername", cfg.sender);
    const data = Buffer.from(form.toString());
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname,
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": data.length }, timeout: 15000 }, (res) => {
      let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c));
      res.on("end", () => {
        let j = null; try { j = JSON.parse(d); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, json: j });
        else reject(new Error("SMS HTTP " + res.statusCode + ": " + d.slice(0, 200)));
      });
    });
    req.on("timeout", () => req.destroy(new Error("SMS timeout")));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

export function looksLikePhone(s) {
  const t = String(s || "").trim();
  return !t.includes("@") && /^[+0-9][0-9\-\s]{6,}$/.test(t);
}
