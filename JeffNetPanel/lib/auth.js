// lib/auth.js — login, password hashing, sessions, role checks.
// Zero external deps: scrypt for hashing, in-memory session map.
import crypto from "node:crypto";
import { Accounts, Audit } from "./db.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map(); // token -> { id, username, role, expires }

// --- Brute-force protection ---
// Track failed login attempts per key (username|ip). After a threshold, lock out for a
// growing window. Successful login clears the counter. In-memory (resets on restart).
const failTracker = new Map(); // key -> { count, lockUntil, first }
const MAX_FAILS = 5;            // allowed fails before lockout kicks in
const LOCK_BASE_MS = 60 * 1000; // 1 min, doubles each further lockout (1,2,4,8… capped)
const LOCK_MAX_MS = 30 * 60 * 1000; // cap at 30 min
const WINDOW_MS = 15 * 60 * 1000;   // failures older than this are forgotten

function throttleKey(username, ip) { return String(username || "").toLowerCase() + "|" + (ip || "?"); }

export function loginThrottleStatus(username, ip) {
  const k = throttleKey(username, ip);
  const t = failTracker.get(k);
  if (!t) return { locked: false, remainingMs: 0, fails: 0 };
  if (t.lockUntil && t.lockUntil > Date.now()) return { locked: true, remainingMs: t.lockUntil - Date.now(), fails: t.count };
  return { locked: false, remainingMs: 0, fails: t.count || 0 };
}

function recordFail(username, ip) {
  const k = throttleKey(username, ip);
  const now = Date.now();
  let t = failTracker.get(k);
  if (!t || (now - (t.first || now)) > WINDOW_MS) t = { count: 0, lockUntil: 0, first: now, locks: 0 };
  t.count++;
  if (t.count >= MAX_FAILS) {
    t.locks = (t.locks || 0) + 1;
    const dur = Math.min(LOCK_BASE_MS * Math.pow(2, t.locks - 1), LOCK_MAX_MS);
    t.lockUntil = now + dur;
    t.count = 0; // reset the counter; the lock now gates them
  }
  failTracker.set(k, t);
}
function clearFails(username, ip) { failTracker.delete(throttleKey(username, ip)); }

// periodic cleanup so the map can't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of failTracker) {
    if ((!t.lockUntil || t.lockUntil < now) && (now - (t.first || 0)) > WINDOW_MS) failTracker.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

export const ROLES = ["admin", "cashier", "technician"];

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}
export function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const a = Buffer.from(h, "hex"), b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Create the first admin if there are no users yet. Returns the default creds (or null).
export function seedDefaultAdmin() {
  if (Accounts.count() > 0) return null;
  const { salt, hash } = hashPassword("admin");
  Accounts.create({ username: "admin", salt, hash, role: "admin" });
  return { username: "admin", password: "admin" };
}

// Recovery: force an 'admin' account (password 'admin', role admin) to exist.
// Triggered by RESET_ADMIN=1 at startup so an operator can never be locked out.
export function ensureAdminReset() {
  const { salt, hash } = hashPassword("admin");
  const existing = Accounts.getByName("admin");
  if (existing) { Accounts.setPassword(existing.id, salt, hash); Accounts.setRole(existing.id, "admin"); }
  else Accounts.create({ username: "admin", salt, hash, role: "admin" });
  return { username: "admin", password: "admin" };
}

export function login(username, password, ip) {
  // brute-force gate
  const st = loginThrottleStatus(username, ip);
  if (st.locked) {
    Audit.add({ type: "auth", action: "login-blocked", detail: `${username || ""} (locked ${Math.ceil(st.remainingMs / 1000)}s)`, ok: false });
    return { error: "locked", remainingMs: st.remainingMs };
  }
  const u = Accounts.getByName(username);
  if (!u || !verifyPassword(password, u.salt, u.hash)) {
    recordFail(username, ip);
    Audit.add({ type: "auth", action: "login-failed", detail: username || "", ok: false });
    return null;
  }
  clearFails(username, ip);
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { id: u.id, username: u.username, role: u.role, expires: Date.now() + SESSION_TTL_MS });
  Accounts.touchLogin(u.id);
  Audit.add({ type: "auth", action: "login", detail: u.username, ok: true });
  return { token, user: { id: u.id, username: u.username, role: u.role } };
}

export function logout(token) {
  if (token) sessions.delete(token);
}

// Security nudge: is the 'admin' account still using the default password "admin"?
export function isDefaultAdminPassword() {
  try {
    const u = Accounts.getByName("admin");
    if (!u) return false;
    return verifyPassword("admin", u.salt, u.hash);
  } catch { return false; }
}

export function sessionUser(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  s.expires = Date.now() + SESSION_TTL_MS; // sliding expiry
  return { id: s.id, username: s.username, role: s.role };
}

export function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Refresh role on all live sessions for a user (after a role change).
export function refreshSessionsForUser(id, role) {
  for (const s of sessions.values()) if (s.id === id) s.role = role;
}
export function dropSessionsForUser(id) {
  for (const [t, s] of sessions) if (s.id === id) sessions.delete(t);
}
