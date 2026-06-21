// lib/license.js — offline, machine-locked licensing.
// The panel ships with the VENDOR PUBLIC KEY only. Licenses are signed by the vendor's
// PRIVATE KEY (kept secret, never shipped). A license is valid only if:
//   1. its signature verifies against the public key (can't be forged), AND
//   2. its bound machine fingerprint matches THIS machine, AND
//   3. it hasn't expired (for subscription/trial licenses).
//
// Zero external deps: node:crypto (ed25519), node:os.
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// ---- VENDOR PUBLIC KEY ----
// Replace this with YOUR public key from tools/license-keygen.mjs (run it once).
// The matching PRIVATE key stays with you and is NEVER shipped to customers.
export const VENDOR_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARA2NMMi8GVDDRZFVsi1Pv4CjtSFbCav1Wfh8Iivsv9Y=
-----END PUBLIC KEY-----`;
// NOTE: the key above is a PLACEHOLDER. Generate a real pair with the keygen tool and paste
// the public key here (or set LICENSE_PUBKEY in the build) before compiling for sale.

// Accept the public key in ANY of these forms and rebuild proper PEM, so a copy/paste that
// loses newlines (very common) still works:
//   - full PEM with BEGIN/END and newlines
//   - single-line PEM (headers + body all on one line)
//   - just the base64 body (no headers at all)
export function normalizePublicKey(input) {
  let s = String(input || "").trim();
  if (!s) return s;
  // strip headers/footers and all whitespace to get the pure base64 body
  let body = s
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!body) return s;
  // re-wrap base64 at 64 chars and add proper PEM headers
  const wrapped = body.match(/.{1,64}/g).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

const VENDOR_PUBLIC_KEY_PEM = normalizePublicKey(VENDOR_PUBLIC_KEY);
// Combine stable hardware identifiers into one hash. We use several so swapping one part
// (e.g. a NIC) still leaves enough to match within tolerance — but by default we require an
// exact match of the composite. Tweak `fingerprint()` if you want fuzzy matching.
export function machineFingerprint() {
  const parts = [];
  // primary network MAC(s) — stable per machine
  const nets = os.networkInterfaces();
  const macs = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.mac && ni.mac !== "00:00:00:00:00:00" && !ni.internal) macs.push(ni.mac.toUpperCase());
    }
  }
  macs.sort();
  parts.push("mac:" + (macs[0] || "none"));        // first stable MAC
  parts.push("host:" + (os.hostname() || ""));      // machine name
  parts.push("cpu:" + (os.cpus()[0]?.model || "")); // CPU model
  parts.push("arch:" + os.arch());
  parts.push("plat:" + os.platform());
  // total RAM bucketed (so minor reporting differences don't break it)
  parts.push("mem:" + Math.round(os.totalmem() / (1024 * 1024 * 1024)) + "GB");
  const raw = parts.join("|");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Short, human-readable machine ID the customer sends you to get a license.
export function machineId() {
  const fp = machineFingerprint();
  // format as 4 groups of 5 for readability, e.g. A1B2C-D3E4F-...
  const short = fp.slice(0, 20).toUpperCase();
  return short.match(/.{1,5}/g).join("-");
}

// ---- License verification ----
// A license file is JSON: { data: {...}, sig: "base64" }
// data = { fp, customer, model, issued, expires|null, features }
//   fp      = machine fingerprint this license is bound to
//   model   = "perpetual" | "subscription" | "trial"
//   expires = ISO date string or null (perpetual)
export function verifyLicense(licenseObj, opts = {}) {
  try {
    if (!licenseObj || !licenseObj.data || !licenseObj.sig) return { ok: false, reason: "malformed" };
    const dataStr = canonical(licenseObj.data);
    const ok = crypto.verify(null, Buffer.from(dataStr), VENDOR_PUBLIC_KEY_PEM, Buffer.from(licenseObj.sig, "base64"));
    if (!ok) return { ok: false, reason: "bad-signature" };
    const d = licenseObj.data;
    // machine binding
    const here = opts.fingerprint || machineFingerprint();
    if (d.fp !== here) return { ok: false, reason: "wrong-machine", boundTo: d.fp };
    // expiry (perpetual = no expires)
    if (d.expires) {
      const now = opts.now ? new Date(opts.now) : new Date();
      if (now > new Date(d.expires)) return { ok: false, reason: "expired", expires: d.expires };
    }
    return { ok: true, license: d };
  } catch (e) {
    return { ok: false, reason: "error:" + e.message };
  }
}

// Canonical JSON (stable key order) so signing/verifying always hash the same bytes.
export function canonical(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonical).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

// Load a license file from disk (license.key next to the app, or LICENSE_FILE env).
export function loadLicenseFile(baseDir) {
  const candidates = [
    process.env.LICENSE_FILE,
    baseDir && path.join(baseDir, "license.key"),
    path.join(process.cwd(), "license.key"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const txt = fs.readFileSync(p, "utf8").trim();
        return { obj: JSON.parse(decodeKey(txt)), path: p };
      }
    } catch {}
  }
  return { obj: null, path: candidates[candidates.length - 1] };
}

// Licenses are distributed as base64 of the JSON, so they're one clean blob to copy/paste.
export function encodeKey(licenseObj) { return Buffer.from(JSON.stringify(licenseObj)).toString("base64"); }
export function decodeKey(txt) {
  const t = String(txt).trim();
  if (t.startsWith("{")) return t; // already JSON
  return Buffer.from(t, "base64").toString("utf8");
}

// Full gate used at startup. Returns { ok, reason, license, machineId }.
export function checkLicense(baseDir) {
  // Allow a dev/escape hatch ONLY when explicitly enabled (never in shipped builds).
  if (process.env.LICENSE_DISABLED === "1") return { ok: true, license: { model: "dev", customer: "DEV MODE" }, machineId: machineId() };
  const { obj } = loadLicenseFile(baseDir);
  if (!obj) return { ok: false, reason: "no-license", machineId: machineId() };
  const r = verifyLicense(obj);
  return { ...r, machineId: machineId() };
}
