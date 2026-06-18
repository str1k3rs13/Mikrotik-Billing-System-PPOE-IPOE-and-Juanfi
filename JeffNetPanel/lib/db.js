// lib/db.js
// Billing database using Node's BUILT-IN SQLite (node:sqlite). Zero external
// dependencies. The data lives in a single file next to the app (billing.db),
// so it's easy to back up — just copy that one file.

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { loadEnv } from "./env.js";

loadEnv(); // ensure .env is applied before we read DB_FILE (imports run early)

const DB_FILE = process.env.DB_FILE || path.resolve(process.cwd(), "billing.db");
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  speed TEXT DEFAULT '',
  validity_days INTEGER DEFAULT 30,
  router_profile TEXT DEFAULT 'default',
  type TEXT DEFAULT 'pppoe',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT DEFAULT '',
  address TEXT DEFAULT '',
  username TEXT DEFAULT '',
  password TEXT DEFAULT '',
  plan_id INTEGER,
  billing_day INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  due_date TEXT,
  status TEXT DEFAULT 'unpaid',
  created_at TEXT DEFAULT (datetime('now')),
  paid_at TEXT,
  UNIQUE(customer_id, period)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER,
  invoice_id INTEGER,
  amount REAL NOT NULL DEFAULT 0,
  method TEXT DEFAULT 'cash',
  reference TEXT DEFAULT '',
  note TEXT DEFAULT '',
  paid_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT DEFAULT (datetime('now')),
  type TEXT DEFAULT 'auto',
  customer_id INTEGER,
  customer_name TEXT DEFAULT '',
  action TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  ok INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS hotspot_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT DEFAULT (datetime('now')),
  type TEXT DEFAULT '',
  user TEXT DEFAULT '',
  amount REAL DEFAULT 0,
  mac TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  detail TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS vendos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  port INTEGER DEFAULT 80,
  username TEXT DEFAULT '',
  password TEXT DEFAULT '',
  apikey TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  last_seen TEXT,
  online INTEGER DEFAULT 0,
  last_data TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coin_log_seen (
  sig TEXT PRIMARY KEY,
  at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  role TEXT DEFAULT 'cashier',
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT
);
`);

// --- lightweight migration: add columns introduced after Phase 1 ---
function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
ensureColumn("customers", "auto_suspended", "INTEGER DEFAULT 0");
ensureColumn("hotspot_events", "vendo", "TEXT DEFAULT ''");
ensureColumn("hotspot_events", "device", "TEXT DEFAULT ''");
ensureColumn("invoices", "payment_link_id", "TEXT DEFAULT ''");
ensureColumn("invoices", "payment_url", "TEXT DEFAULT ''");
ensureColumn("invoices", "note", "TEXT DEFAULT ''");
ensureColumn("customers", "expiry", "TEXT DEFAULT ''");
ensureColumn("plans", "validity_mins", "INTEGER");
try { db.exec("UPDATE plans SET validity_mins = COALESCE(validity_mins, validity_days*1440)"); } catch {}
ensureColumn("customers", "last_reminded", "TEXT DEFAULT ''");
ensureColumn("customers", "area", "TEXT DEFAULT ''");
ensureColumn("customers", "lat", "REAL");
ensureColumn("customers", "lng", "REAL");

const run = (sql, ...args) => db.prepare(sql).run(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const get = (sql, ...args) => db.prepare(sql).get(...args);

function pad2(n) { return String(n).padStart(2, "0"); }
export function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

// ---- Plans ---------------------------------------------------------------
export const Plans = {
  list: () => all("SELECT * FROM plans ORDER BY price ASC"),
  create: (p) => {
    const mins = Number(p.validity_mins) || (Number(p.validity_days) || 30) * 1440;
    const r = run(
      "INSERT INTO plans (name,price,speed,validity_days,validity_mins,router_profile,type,data_cap_gb) VALUES (?,?,?,?,?,?,?,?)",
      p.name, Number(p.price) || 0, p.speed || "", Math.max(1, Math.round(mins / 1440)), mins,
      p.router_profile || "default", p.type || "pppoe", Number(p.data_cap_gb) || 0
    );
    return get("SELECT * FROM plans WHERE id=?", r.lastInsertRowid);
  },
  update: (id, p) => {
    const mins = Number(p.validity_mins) || (Number(p.validity_days) || 30) * 1440;
    run(
      "UPDATE plans SET name=?,price=?,speed=?,validity_days=?,validity_mins=?,router_profile=?,type=?,data_cap_gb=? WHERE id=?",
      p.name, Number(p.price) || 0, p.speed || "", Math.max(1, Math.round(mins / 1440)), mins,
      p.router_profile || "default", p.type || "pppoe", Number(p.data_cap_gb) || 0, id
    );
    return get("SELECT * FROM plans WHERE id=?", id);
  },
  remove: (id) => run("DELETE FROM plans WHERE id=?", id),
};

// ---- Customers -----------------------------------------------------------
export const Customers = {
  list: () =>
    all(`SELECT c.*, p.name AS plan_name, p.price AS plan_price, p.type AS plan_type,
                p.router_profile AS plan_profile, p.validity_days AS plan_days, p.validity_mins AS plan_mins, p.data_cap_gb AS plan_cap, p.speed AS plan_speed
         FROM customers c LEFT JOIN plans p ON p.id=c.plan_id
         ORDER BY c.name ASC`),
  get: (id) =>
    get(`SELECT c.*, p.name AS plan_name, p.price AS plan_price, p.type AS plan_type,
                p.router_profile AS plan_profile, p.validity_days AS plan_days, p.validity_mins AS plan_mins, p.data_cap_gb AS plan_cap, p.speed AS plan_speed
         FROM customers c LEFT JOIN plans p ON p.id=c.plan_id WHERE c.id=?`, id),
  create: (c) => {
    // Random subscriber code like IPOE-5NIHH1VKH3MQ (or PPPOE-… for PPPoE).
    const prefix = (c.conn_type || "pppoe") === "ipoe" ? "IPOE" : (c.conn_type || "pppoe") === "hotspot" ? "HS" : "PPPOE";
    const rand = () => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };
    let code = c.account_code || (prefix + "-" + rand());
    let guard = 0;
    while (get("SELECT id FROM customers WHERE account_code=?", code) && guard++ < 8) code = prefix + "-" + rand();
    const r = run(
      `INSERT INTO customers (name,contact,address,area,username,password,plan_id,billing_day,status,notes,lat,lng,conn_type,mac,static_ip,vlan_iface,account_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.name, c.contact || "", c.address || "", c.area || "", c.username || "", c.password || "",
      c.plan_id || null, Number(c.billing_day) || 1, c.status || "active", c.notes || "",
      c.lat != null && c.lat !== "" ? Number(c.lat) : null, c.lng != null && c.lng !== "" ? Number(c.lng) : null,
      c.conn_type || "pppoe", (c.mac || "").toUpperCase(), c.static_ip || "", c.vlan_iface || "", code
    );
    return Customers.get(r.lastInsertRowid);
  },
  update: (id, c) => {
    run(
      `UPDATE customers SET name=?,contact=?,address=?,area=?,username=?,password=?,plan_id=?,billing_day=?,notes=?,conn_type=?,mac=?,static_ip=?,vlan_iface=? WHERE id=?`,
      c.name, c.contact || "", c.address || "", c.area || "", c.username || "", c.password || "",
      c.plan_id || null, Number(c.billing_day) || 1, c.notes || "",
      c.conn_type || "pppoe", (c.mac || "").toUpperCase(), c.static_ip || "", c.vlan_iface || "", id
    );
    return Customers.get(id);
  },
  setLocation: (id, lat, lng, napId) => { run("UPDATE customers SET lat=?, lng=?, nap_id=? WHERE id=?", lat == null || lat === "" ? null : Number(lat), lng == null || lng === "" ? null : Number(lng), napId ? Number(napId) : null, id); return Customers.get(id); },
  located: () => all("SELECT c.*, p.name AS plan_name FROM customers c LEFT JOIN plans p ON p.id=c.plan_id WHERE c.lat IS NOT NULL AND c.lng IS NOT NULL"),
  areas: () => all("SELECT DISTINCT area FROM customers WHERE area<>'' ORDER BY area").map((r) => r.area),
  addCredit: (id, amount, reason) => {
    const amt = Number(amount) || 0;
    run("UPDATE customers SET credit = COALESCE(credit,0) + ? WHERE id=?", amt, id);
    run("INSERT INTO credit_ledger (customer_id,amount,reason) VALUES (?,?,?)", id, amt, reason || "");
    // Option A (cash basis): a POSITIVE credit change = real money arriving (a top-up), so record
    // it as income tagged "Wallet topup:". A NEGATIVE change = spending wallet credit, which is
    // NOT new cash (already counted at top-up), so we never record income for it here.
    // Skip internal moves that shouldn't be income: a "wallet renewal"/"wallet" spend is negative
    // anyway; an explicit reason starting with "no-income" is also skipped.
    if (amt > 0 && !/^no-income/i.test(reason || "")) {
      try { run("INSERT INTO payments (customer_id,amount,method,note) VALUES (?,?,?,?)", id, amt, "wallet", "Wallet topup: " + (reason || "")); } catch {}
    }
    return get("SELECT credit FROM customers WHERE id=?", id).credit;
  },
  creditLedger: (id) => all("SELECT * FROM credit_ledger WHERE customer_id=? ORDER BY id DESC LIMIT 20", id),
  byUsername: (u) => get(
    `SELECT c.*, p.name AS plan_name, p.price AS plan_price, p.type AS plan_type, p.router_profile AS plan_profile, p.validity_days AS plan_days, p.validity_mins AS plan_mins, p.data_cap_gb AS plan_cap, p.speed AS plan_speed
     FROM customers c LEFT JOIN plans p ON p.id=c.plan_id WHERE LOWER(c.username)=LOWER(?)`, String(u || "")),
  byArea: (area) => all("SELECT * FROM customers WHERE area=? AND contact<>''", area),
  // Match a customer by mobile number (last 10 digits, ignoring formatting / +63 / 0 prefix).
  byContact: (phone) => {
    const d = String(phone || "").replace(/\D/g, "");
    if (d.length < 7) return null;
    const tail = d.slice(-10);
    return all("SELECT * FROM customers WHERE contact<>''").find((c) => String(c.contact).replace(/\D/g, "").endsWith(tail)) || null;
  },
  setStatus: (id, status) => { run("UPDATE customers SET status=? WHERE id=?", status, id); return Customers.get(id); },
  setExpiry: (id, date) => { run("UPDATE customers SET expiry=? WHERE id=?", date, id); return Customers.get(id); },
  // Active customers whose expiry is at/before the given time (datetime, router clock).
  expiredAsOf: (nowStr) => all(
    `SELECT c.*, p.name AS plan_name, p.price AS plan_price, p.type AS plan_type, p.router_profile AS plan_profile, p.validity_days AS plan_days, p.validity_mins AS plan_mins, p.data_cap_gb AS plan_cap, p.speed AS plan_speed
     FROM customers c LEFT JOIN plans p ON p.id=c.plan_id
     WHERE c.status='active' AND c.expiry <> '' AND datetime(c.expiry) <= datetime(?)
       AND (c.username <> '' OR c.static_ip <> '')`, nowStr),
  // Active customers whose expiry is exactly this date (for reminders N days ahead).
  expiringOn: (ymd) => all(
    `SELECT c.*, p.name AS plan_name FROM customers c LEFT JOIN plans p ON p.id=c.plan_id
     WHERE c.status='active' AND c.expiry <> '' AND date(c.expiry) = date(?)`, ymd),
  // Active customers expiring within [today, toYmd] inclusive (for the daily report).
  expiringBy: (toYmd) => all(
    `SELECT c.*, p.name AS plan_name FROM customers c LEFT JOIN plans p ON p.id=c.plan_id
     WHERE c.status='active' AND c.expiry <> '' AND date(c.expiry) <= date(?) ORDER BY date(c.expiry)`, toYmd),
  setReminded: (id, ymd) => run("UPDATE customers SET last_reminded=? WHERE id=?", ymd, id),
  setStatusAndAuto: (id, status, autoFlag) => {
    run("UPDATE customers SET status=?, auto_suspended=? WHERE id=?", status, autoFlag ? 1 : 0, id);
    return Customers.get(id);
  },
  remove: (id) => run("DELETE FROM customers WHERE id=?", id),
};

// ---- Invoices ------------------------------------------------------------
export const Invoices = {
  get: (id) => get(`SELECT i.*, c.name AS customer_name, c.username, c.contact, c.address, c.plan_id,
                            p.name AS plan_name FROM invoices i JOIN customers c ON c.id=i.customer_id
                     LEFT JOIN plans p ON p.id=c.plan_id WHERE i.id=?`, id),
  list: (filter = {}) => {
    let sql = `SELECT i.*, c.name AS customer_name, c.username AS username
               FROM invoices i JOIN customers c ON c.id=i.customer_id`;
    const where = [], args = [];
    if (filter.status) { where.push("i.status=?"); args.push(filter.status); }
    if (filter.period) { where.push("i.period=?"); args.push(filter.period); }
    if (filter.customer_id) { where.push("i.customer_id=?"); args.push(filter.customer_id); }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY i.created_at DESC LIMIT 500";
    return all(sql, ...args);
  },
  // One-off charge (e.g. installation fee + router cost). Uses a unique period tag.
  addOne: (o) => {
    const period = o.period || ("CHG-" + Date.now());
    const r = run("INSERT INTO invoices (customer_id,period,amount,due_date,status,note) VALUES (?,?,?,?, 'unpaid', ?)",
      o.customer_id, period, Number(o.amount) || 0, o.due_date || period, o.note || "");
    return get("SELECT * FROM invoices WHERE id=?", r.lastInsertRowid);
  },

  // Create one invoice per active customer (with a plan) for the period,
  // skipping any that already exist. Returns how many were created.
  generateMonthly: (period) => {
    period = period || currentPeriod();
    // only "monthly or longer" plans (>= 28 days) — skips short time/piso plans
    const cust = all(
      `SELECT c.*, p.price AS plan_price FROM customers c
       JOIN plans p ON p.id=c.plan_id
       WHERE c.status='active' AND c.plan_id IS NOT NULL
         AND COALESCE(p.validity_mins, p.validity_days*1440, 43200) >= 40320`
    );
    let created = 0;
    for (const c of cust) {
      if (get("SELECT id FROM invoices WHERE customer_id=? AND period=?", c.id, period)) continue;
      const day = Math.min(Math.max(Number(c.billing_day) || 1, 1), 28);
      run("INSERT INTO invoices (customer_id,period,amount,due_date,status) VALUES (?,?,?,?, 'unpaid')",
        c.id, period, Number(c.plan_price) || 0, `${period}-${pad2(day)}`);
      created++;
    }
    return { period, created };
  },
  generate: (period) => {
    period = period || currentPeriod();
    const cust = all(
      `SELECT c.*, p.price AS plan_price FROM customers c
       JOIN plans p ON p.id=c.plan_id
       WHERE c.status='active' AND c.plan_id IS NOT NULL`
    );
    let created = 0;
    for (const c of cust) {
      const exists = get("SELECT id FROM invoices WHERE customer_id=? AND period=?", c.id, period);
      if (exists) continue;
      const day = Math.min(Math.max(Number(c.billing_day) || 1, 1), 28);
      const due = `${period}-${pad2(day)}`;
      run("INSERT INTO invoices (customer_id,period,amount,due_date,status) VALUES (?,?,?,?, 'unpaid')",
        c.id, period, Number(c.plan_price) || 0, due);
      created++;
    }
    return { period, created };
  },

  setLink: (id, linkId, url) => run("UPDATE invoices SET payment_link_id=?, payment_url=? WHERE id=?", linkId, url, id),
  byLink: (linkId) => get(`SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.payment_link_id=?`, linkId),
  byCustomer: (id) => all("SELECT * FROM invoices WHERE customer_id=? ORDER BY period DESC, id DESC", id),

  // Record a (possibly partial) payment. Overpayment beyond the balance goes to
  // the customer's wallet credit. Returns { invoice, applied, toCredit }.
  pay: (id, pay = {}) => {
    const inv = get("SELECT * FROM invoices WHERE id=?", id);
    if (!inv) throw new Error("Invoice not found");
    if (inv.status === "paid") return { invoice: inv, applied: 0, toCredit: 0 };
    const already = Number(inv.paid_amount) || 0;
    const balance = Math.max(0, Number(inv.amount) - already);
    const amt = pay.amount != null && pay.amount !== "" ? Number(pay.amount) : balance;
    if (!(amt > 0)) throw new Error("Payment amount must be more than zero");
    const applied = Math.min(amt, balance);
    const toCredit = Math.max(0, amt - balance);
    const newPaid = already + applied;
    const fully = newPaid >= Number(inv.amount) - 0.005;
    run("UPDATE invoices SET paid_amount=?, status=?, paid_at=CASE WHEN ? THEN datetime('now') ELSE paid_at END WHERE id=?",
      newPaid, fully ? "paid" : "unpaid", fully ? 1 : 0, id);
    run("INSERT INTO payments (customer_id,invoice_id,amount,method,reference,note) VALUES (?,?,?,?,?,?)",
      inv.customer_id, id, amt, pay.method || "cash", pay.reference || "", pay.note || (applied < amt ? `₱${toCredit.toFixed(2)} to wallet` : ""));
    if (toCredit > 0 && inv.customer_id) Customers.addCredit(inv.customer_id, toCredit, "no-income: overpayment on invoice #" + id);
    return { invoice: get("SELECT * FROM invoices WHERE id=?", id), applied, toCredit, fully };
  },
};

// ---- Payments ------------------------------------------------------------
export const Payments = {
  get: (id) => get(`SELECT pm.*, c.name AS customer_name, c.username AS customer_username, c.contact AS customer_contact, c.address AS customer_address
                    FROM payments pm LEFT JOIN customers c ON c.id=pm.customer_id WHERE pm.id=?`, id),
  list: () =>
    all(`SELECT pm.*, c.name AS customer_name FROM payments pm
         LEFT JOIN customers c ON c.id=pm.customer_id
         ORDER BY pm.paid_at DESC LIMIT 200`),
  byCustomer: (id) => all("SELECT * FROM payments WHERE customer_id=? ORDER BY paid_at DESC", id),
  lastForCustomer: (id) => get("SELECT * FROM payments WHERE customer_id=? ORDER BY paid_at DESC LIMIT 1", id),
  record: (p) => {
    const r = run(
      "INSERT INTO payments (customer_id,invoice_id,amount,method,reference,note) VALUES (?,?,?,?,?,?)",
      p.customer_id || null, p.invoice_id || null, Number(p.amount) || 0,
      p.method || "cash", p.reference || "", p.note || ""
    );
    return get("SELECT * FROM payments WHERE id=?", r.lastInsertRowid);
  },
};

// ---- Collections (auto-suspend / auto-reconnect candidates) --------------
export const Collections = {
  collectedOn: (ymd) => get("SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM payments WHERE date(paid_at)=date(?)", ymd),
  // Customers that should be SUSPENDED: active, have a router username, and have
  // an unpaid invoice whose due date + grace period has passed.
  toSuspend: (graceDays = 0) =>
    all(
      `SELECT DISTINCT c.* FROM customers c
       JOIN invoices i ON i.customer_id = c.id
       WHERE c.status='active' AND c.username <> ''
         AND i.status='unpaid'
         AND date(i.due_date, '+' || ? || ' days') < date('now')`,
      Number(graceDays) || 0
    ),
  // Customers that should be RECONNECTED: previously AUTO-suspended (not manual)
  // and with no unpaid invoices left.
  toReconnect: () =>
    all(
      `SELECT c.* FROM customers c
       WHERE c.status='suspended' AND c.auto_suspended=1 AND c.username <> ''
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id=c.id AND i.status='unpaid')`
    ),
};

// ---- Audit log -----------------------------------------------------------
db.exec("CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)");
db.exec(`CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, contact TEXT, message TEXT, image TEXT,
  status TEXT DEFAULT 'open', reply TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);
ensureColumn("tickets", "category", "TEXT DEFAULT ''");
ensureColumn("tickets", "reply_image", "TEXT DEFAULT ''");
db.exec(`CREATE TABLE IF NOT EXISTS payment_proofs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER, customer_id INTEGER, username TEXT,
  image TEXT, note TEXT, amount REAL,
  status TEXT DEFAULT 'pending',
  tg_message_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
)`);
ensureColumn("payment_proofs", "reference", "TEXT DEFAULT ''");
ensureColumn("payment_proofs", "reject_reason", "TEXT DEFAULT ''");
ensureColumn("plans", "data_cap_gb", "REAL DEFAULT 0");
db.exec(`CREATE TABLE IF NOT EXISTS usage_live (key TEXT PRIMARY KEY, last_up INTEGER DEFAULT 0, last_down INTEGER DEFAULT 0, updated_at TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS usage_period (key TEXT, period TEXT, up INTEGER DEFAULT 0, down INTEGER DEFAULT 0, PRIMARY KEY (key, period))`);

export const Tickets = {
  add: (t) => { const r = run("INSERT INTO tickets (name,contact,message,image,category) VALUES (?,?,?,?,?)", t.name||"", t.contact||"", t.message||"", t.image||"", t.category||""); return Tickets.get(r.lastInsertRowid); },
  get: (id) => get("SELECT * FROM tickets WHERE id=?", id),
  list: (status) => status ? all("SELECT * FROM tickets WHERE status=? ORDER BY id DESC", status) : all("SELECT * FROM tickets ORDER BY id DESC LIMIT 200"),
  statusView: (id) => get("SELECT id, name, contact, category, message, status, reply, reply_image, created_at FROM tickets WHERE id=?", id),
  setStatus: (id, status) => run("UPDATE tickets SET status=? WHERE id=?", status, id),
  reply: (id, reply, image) => run("UPDATE tickets SET reply=?, reply_image=?, status='answered' WHERE id=?", reply, image || "", id),
  openCount: () => get("SELECT COUNT(*) c FROM tickets WHERE status='open'").c,
};

export const Proofs = {
  add: (p) => { const r = run("INSERT INTO payment_proofs (invoice_id,customer_id,username,image,note,amount,reference,flags) VALUES (?,?,?,?,?,?,?,?)", p.invoice_id||null, p.customer_id||null, p.username||"", p.image||"", p.note||"", p.amount||0, p.reference||"", p.flags||""); return Proofs.get(r.lastInsertRowid); },
  allRefs: () => all("SELECT id, reference, customer_id FROM payment_proofs WHERE reference<>''"),
  get: (id) => get("SELECT * FROM payment_proofs WHERE id=?", id),
  list: (status) => status ? all("SELECT * FROM payment_proofs WHERE status=? ORDER BY id DESC", status) : all("SELECT * FROM payment_proofs ORDER BY id DESC LIMIT 200"),
  latestForUser: (username) => get("SELECT * FROM payment_proofs WHERE lower(username)=lower(?) ORDER BY id DESC LIMIT 1", username),
  setStatus: (id, status) => run("UPDATE payment_proofs SET status=? WHERE id=?", status, id),
  reject: (id, reason) => run("UPDATE payment_proofs SET status='rejected', reject_reason=? WHERE id=?", reason||"", id),
  setMsgId: (id, mid) => run("UPDATE payment_proofs SET tg_message_id=? WHERE id=?", mid, id),
  pendingCount: () => get("SELECT COUNT(*) c FROM payment_proofs WHERE status='pending'").c,
};
export const Settings = {
  get: (k, dflt = "") => { const r = get("SELECT v FROM settings WHERE k=?", k); return r ? r.v : dflt; },
  all: () => { const o = {}; for (const r of all("SELECT k,v FROM settings")) o[r.k] = r.v; return o; },
  set: (k, v) => run("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, String(v == null ? "" : v)),
  setMany: (obj) => { for (const k of Object.keys(obj || {})) Settings.set(k, obj[k]); return Settings.all(); },
};

export const Accounts = {
  count: () => get("SELECT COUNT(*) c FROM users").c,
  list: () => all("SELECT id, username, role, created_at, last_login FROM users ORDER BY username"),
  getByName: (username) => get("SELECT * FROM users WHERE username=?", username),
  getById: (id) => get("SELECT id, username, role, created_at, last_login FROM users WHERE id=?", id),
  create: ({ username, salt, hash, role }) => {
    const r = run("INSERT INTO users (username,salt,hash,role) VALUES (?,?,?,?)", username, salt, hash, role || "cashier");
    return Accounts.getById(r.lastInsertRowid);
  },
  setPassword: (id, salt, hash) => run("UPDATE users SET salt=?, hash=? WHERE id=?", salt, hash, id),
  setUsername: (id, username) => run("UPDATE users SET username=? WHERE id=?", username, id),
  setRole: (id, role) => run("UPDATE users SET role=? WHERE id=?", role, id),
  touchLogin: (id) => run("UPDATE users SET last_login=datetime('now') WHERE id=?", id),
  remove: (id) => run("DELETE FROM users WHERE id=?", id),
};

export const Audit = {
  add: (e) =>
    run(
      "INSERT INTO audit (type,customer_id,customer_name,action,detail,ok) VALUES (?,?,?,?,?,?)",
      e.type || "auto", e.customer_id || null, e.customer_name || "",
      e.action || "", e.detail || "", e.ok === false ? 0 : 1
    ),
  list: (limit = 50) => all("SELECT * FROM audit ORDER BY id DESC LIMIT ?", Number(limit) || 50),
};

// ---- Data maintenance: stats + archive-then-clear for growing log tables ----
export const Maintenance = {
  // Tables that grow over time and are safe to archive/prune (logs, not core records).
  PRUNABLE: [
    { table: "audit", dateCol: "at", label: "Activity log" },
    { table: "sms_messages", dateCol: "at", label: "SMS messages" },
    { table: "usage_period", dateCol: "period", label: "Usage history", isPeriod: true },
    { table: "customer_sessions", dateCol: "expires", label: "Portal sessions" },
    { table: "coin_log_seen", dateCol: null, label: "Coin-log dedup markers" },
  ],
  // Core tables we never auto-clear (just report sizes).
  CORE: ["customers", "plans", "payments", "invoices", "inventory_items", "inventory_units", "inventory_moves", "installs", "job_orders", "expenses"],
  stats: () => {
    const rows = [];
    const countOf = (t) => { try { const r = get(`SELECT COUNT(*) n FROM ${t}`); return r ? r.n : 0; } catch { return 0; } };
    for (const p of Maintenance.PRUNABLE) rows.push({ table: p.table, label: p.label, rows: countOf(p.table), prunable: true });
    for (const t of Maintenance.CORE) rows.push({ table: t, label: t, rows: countOf(t), prunable: false });
    // DB file size if available
    let dbBytes = 0;
    try { const pc = get("PRAGMA page_count"); const ps = get("PRAGMA page_size"); dbBytes = (pc.page_count || 0) * (ps.page_size || 0); } catch {}
    return { tables: rows, dbBytes };
  },
  // Return rows older than cutoff (for archiving) for one prunable table.
  oldRows: (table, cutoffYmd) => {
    const def = Maintenance.PRUNABLE.find((p) => p.table === table);
    if (!def) return [];
    if (!def.dateCol) return all(`SELECT * FROM ${table}`); // no date -> all are archivable (dedup markers)
    if (def.isPeriod) return all(`SELECT * FROM ${table} WHERE ${def.dateCol} < ?`, cutoffYmd.slice(0, 7));
    return all(`SELECT * FROM ${table} WHERE ${def.dateCol} < ?`, cutoffYmd);
  },
  // Delete rows older than cutoff for one table. Returns rows removed.
  clearOld: (table, cutoffYmd) => {
    const def = Maintenance.PRUNABLE.find((p) => p.table === table);
    if (!def) return 0;
    let r;
    if (!def.dateCol) r = run(`DELETE FROM ${table}`);
    else if (def.isPeriod) r = run(`DELETE FROM ${table} WHERE ${def.dateCol} < ?`, cutoffYmd.slice(0, 7));
    else r = run(`DELETE FROM ${table} WHERE ${def.dateCol} < ?`, cutoffYmd);
    return r.changes || 0;
  },
  vacuum: () => { try { db.exec("VACUUM"); return true; } catch { return false; } },
};


// ---- Sales time series (daily / weekly / monthly / yearly) ---------------
function genLabels(range) {
  const out = [], now = new Date();
  if (range === "daily") {
    for (let i = 13; i >= 0; i--) { const d = new Date(now); d.setDate(now.getDate() - i); out.push(d.toISOString().slice(0, 10)); }
  } else if (range === "weekly") {
    const d0 = new Date(now); const day = (d0.getDay() + 6) % 7; d0.setDate(d0.getDate() - day);
    for (let i = 11; i >= 0; i--) { const d = new Date(d0); d.setDate(d0.getDate() - i * 7); out.push(d.toISOString().slice(0, 10)); }
  } else if (range === "yearly") {
    const y = now.getFullYear(); for (let i = 5; i >= 0; i--) out.push(String(y - i));
  } else {
    for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); out.push(d.toISOString().slice(0, 7)); }
  }
  return out;
}

function seriesFrom(rows, range, field) {
  const keyOf = (s) => {
    const dt = s.slice(0, 10);
    if (range === "daily") return dt;
    if (range === "yearly") return s.slice(0, 4);
    if (range === "weekly") { const d = new Date(dt + "T00:00:00"); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return d.toISOString().slice(0, 10); }
    return s.slice(0, 7);
  };
  const sums = {};
  for (const r of rows) { if (!r[field]) continue; const k = keyOf(r[field]); sums[k] = (sums[k] || 0) + Number(r.amount || 0); }
  const labels = genLabels(range);
  const series = labels.map((l) => ({ label: l, amount: sums[l] || 0 }));
  return { range, series, total: series.reduce((s, x) => s + x.amount, 0) };
}

export const Sales = {
  series: (range = "monthly") =>
    seriesFrom(all("SELECT paid_at, amount FROM payments WHERE paid_at IS NOT NULL"), range, "paid_at"),
};

// ---- Hotspot events: login / logout / coin (from MikroTik webhooks) ------
export const HotspotEvents = {
  add: (e) =>
    run(
      "INSERT INTO hotspot_events (type,user,amount,mac,ip,detail,vendo,device) VALUES (?,?,?,?,?,?,?,?)",
      e.type || "", e.user || "", Number(e.amount) || 0, e.mac || "", e.ip || "", e.detail || "", e.vendo || "", e.device || ""
    ),
  recent: (limit = 40) => all("SELECT * FROM hotspot_events ORDER BY id DESC LIMIT ?", Number(limit) || 40),
};

// Per-vendo sales (matches the "Vendo | Client | Credit | Sold" view).
export const VendoSales = {
  // recent coin drops for one vendo (for anomaly detection)
  eventsForVendo: (vendo, limit = 200) =>
    all("SELECT at, amount FROM hotspot_events WHERE type='coin' AND vendo=? ORDER BY id DESC LIMIT ?", String(vendo || ""), Number(limit) || 200),
  summary: () => ({
    today: all("SELECT COALESCE(NULLIF(vendo,''),'(unknown)') vendo, COUNT(*) c, SUM(amount) s FROM hotspot_events WHERE type='coin' AND substr(at,1,10)=date('now') GROUP BY vendo ORDER BY s DESC"),
    month: all("SELECT COALESCE(NULLIF(vendo,''),'(unknown)') vendo, COUNT(*) c, SUM(amount) s FROM hotspot_events WHERE type='coin' AND substr(at,1,7)=strftime('%Y-%m','now') GROUP BY vendo ORDER BY s DESC"),
  }),
  recent: (limit = 80) =>
    all("SELECT at, COALESCE(NULLIF(vendo,''),'(unknown)') vendo, user, amount FROM hotspot_events WHERE type='coin' ORDER BY id DESC LIMIT ?", Number(limit) || 80),
};

// Recent hotspot logins enriched with the coin amount/vendo (matched by voucher).
export const NewUsers = {
  recent: (limit = 20) => {
    const logins = all("SELECT * FROM hotspot_events WHERE type='login' ORDER BY id DESC LIMIT ?", Number(limit) || 20);
    for (const l of logins) {
      const coin = get("SELECT amount, vendo FROM hotspot_events WHERE type='coin' AND user=? ORDER BY id DESC LIMIT 1", l.user || "");
      l.coin = coin ? coin.amount : 0;
      l.vendo = coin ? coin.vendo : "";
    }
    return logins;
  },
};

// Reset / clear sales data (kept separate so it's an explicit, audited action).
export const SalesAdmin = {
  reset: (scope = "all") => {
    if (scope === "payments" || scope === "all") run("DELETE FROM payments");
    if (scope === "coins" || scope === "all") run("DELETE FROM hotspot_events WHERE type='coin'");
    return { scope };
  },
};

export const Coins = {
  // Today's coin-drop totals, broken down by denomination.
  today: () => {
    const rows = all(
      "SELECT amount, COUNT(*) c, SUM(amount) s FROM hotspot_events WHERE type='coin' AND substr(at,1,10)=date('now') GROUP BY amount"
    );
    const denom = { 1: 0, 5: 0, 10: 0, 20: 0, other: 0 };
    let count = 0, total = 0;
    for (const r of rows) {
      const a = Number(r.amount);
      if (denom[a] !== undefined) denom[a] += r.c; else denom.other += r.c;
      count += r.c; total += Number(r.s) || 0;
    }
    const monthTotal = get(
      "SELECT COALESCE(SUM(amount),0) s FROM hotspot_events WHERE type='coin' AND substr(at,1,7)=strftime('%Y-%m','now')"
    ).s;
    return { date: new Date().toISOString().slice(0, 10), denom, count, total, monthTotal };
  },
};

export const HotspotSales = {
  series: (range = "monthly") =>
    seriesFrom(all("SELECT at, amount FROM hotspot_events WHERE type='coin'"), range, "at"),
};

// ---- Coin-log ingestion dedupe -------------------------------------------
export const CoinLog = {
  // returns true if this signature is new (and records it), false if seen before
  markNew: (sig) => run("INSERT OR IGNORE INTO coin_log_seen (sig) VALUES (?)", sig).changes > 0,
};

// ---- Vendos (JuanFi NodeMCU registry) ------------------------------------
export const Vendos = {
  list: () => all("SELECT * FROM vendos ORDER BY name ASC"),
  get: (id) => get("SELECT * FROM vendos WHERE id=?", id),
  create: (v) => {
    const r = run(
      "INSERT INTO vendos (name,ip,port,username,password,apikey,enabled) VALUES (?,?,?,?,?,?,?)",
      v.name, v.ip, Number(v.port) || 80, v.username || "", v.password || "", v.apikey || "", v.enabled === false ? 0 : 1
    );
    return Vendos.get(r.lastInsertRowid);
  },
  update: (id, v) => {
    run("UPDATE vendos SET name=?,ip=?,port=?,username=?,password=?,apikey=?,enabled=? WHERE id=?",
      v.name, v.ip, Number(v.port) || 80, v.username || "", v.password || "", v.apikey || "", v.enabled === false ? 0 : 1, id);
    return Vendos.get(id);
  },
  remove: (id) => run("DELETE FROM vendos WHERE id=?", id),
  saveSnapshot: (id, online, data) =>
    run("UPDATE vendos SET online=?, last_seen=datetime('now'), last_data=? WHERE id=?",
      online ? 1 : 0, typeof data === "string" ? data : JSON.stringify(data || {}), id),
};

// ---- Dashboard summary ---------------------------------------------------
export function summary() {
  const period = currentPeriod();
  const totalCustomers = get("SELECT COUNT(*) n FROM customers").n;
  const active = get("SELECT COUNT(*) n FROM customers WHERE status='active'").n;
  const suspended = get("SELECT COUNT(*) n FROM customers WHERE status='suspended'").n;
  const revenueMonth = get(
    "SELECT COALESCE(SUM(amount),0) s FROM payments WHERE substr(paid_at,1,7)=?", period
  ).s;
  const outstanding = get("SELECT COALESCE(SUM(amount),0) s FROM invoices WHERE status='unpaid'").s;
  const overdue = get(
    "SELECT COUNT(*) n FROM invoices WHERE status='unpaid' AND due_date < date('now')"
  ).n;
  return { period, totalCustomers, active, suspended, revenueMonth, outstanding, overdue };
}

// ---- Backup / restore (portable JSON of the important tables) ------------
const BACKUP_TABLES = ["settings", "plans", "customers", "invoices", "payments", "users", "vendos", "tickets", "payment_proofs"];
export function kpis() {
  const s = summary();
  const ct = get("SELECT COALESCE(SUM(amount),0) v, COUNT(*) n FROM payments WHERE date(paid_at)=date('now')");
  const expiring7 = get("SELECT COUNT(*) n FROM customers WHERE status='active' AND expiry<>'' AND date(expiry) >= date('now') AND date(expiry) <= date('now','+7 day')").n;
  const planValue = get("SELECT COALESCE(SUM(p.price),0) v FROM customers c JOIN plans p ON p.id=c.plan_id WHERE c.status='active'").v;
  let pendingProofs = 0, openTickets = 0, openOutages = 0;
  try { pendingProofs = get("SELECT COUNT(*) n FROM payment_proofs WHERE status='pending'").n; } catch {}
  try { openTickets = get("SELECT COUNT(*) n FROM tickets WHERE status='open'").n; } catch {}
  try { openOutages = get("SELECT COUNT(*) n FROM outages WHERE status='open'").n; } catch {}
  return { ...s, collectedToday: ct.v, collectedTodayCount: ct.n, expiring7, planValue, pendingProofs, openTickets, openOutages };
}

db.exec(`CREATE TABLE IF NOT EXISTS naps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, area TEXT DEFAULT '', lat REAL, lng REAL, notes TEXT DEFAULT ''
)`);
ensureColumn("customers", "nap_id", "INTEGER");
ensureColumn("customers", "credit", "REAL DEFAULT 0");
ensureColumn("customers", "conn_type", "TEXT DEFAULT 'pppoe'");
ensureColumn("customers", "mac", "TEXT DEFAULT ''");
ensureColumn("customers", "static_ip", "TEXT DEFAULT ''");
ensureColumn("customers", "vlan_iface", "TEXT DEFAULT ''");
ensureColumn("customers", "account_code", "TEXT DEFAULT ''");
try {
  const need = db.prepare("SELECT id, conn_type FROM customers WHERE account_code IS NULL OR account_code=''").all();
  const mkcode = (ct) => { const p = ct === "ipoe" ? "IPOE" : ct === "hotspot" ? "HS" : "PPPOE"; const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)]; return p + "-" + s; };
  for (const row of need) db.prepare("UPDATE customers SET account_code=? WHERE id=?").run(mkcode(row.conn_type || "pppoe"), row.id);
} catch {}
ensureColumn("invoices", "paid_amount", "REAL DEFAULT 0");
ensureColumn("payment_proofs", "flags", "TEXT DEFAULT ''");
try { db.exec("UPDATE invoices SET paid_amount=amount WHERE status='paid' AND (paid_amount IS NULL OR paid_amount=0)"); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
  amount REAL NOT NULL, reason TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime'))
)`);

export const Naps = {
  list: () => all(`SELECT n.*, 
      (SELECT COUNT(*) FROM customers c WHERE c.nap_id=n.id) AS clients,
      (SELECT COUNT(*) FROM customers c WHERE c.nap_id=n.id AND c.status='suspended') AS suspended
    FROM naps n ORDER BY n.name`),
  create: (n) => { const r = run("INSERT INTO naps (name,area,lat,lng,notes) VALUES (?,?,?,?,?)", n.name, n.area || "", n.lat != null && n.lat !== "" ? Number(n.lat) : null, n.lng != null && n.lng !== "" ? Number(n.lng) : null, n.notes || ""); return get("SELECT * FROM naps WHERE id=?", r.lastInsertRowid); },
  update: (id, n) => {
    const cur = get("SELECT * FROM naps WHERE id=?", id);
    if (!cur) throw new Error("Tower not found");
    run("UPDATE naps SET name=?, area=?, lat=?, lng=?, notes=? WHERE id=?",
      n.name != null && String(n.name).trim() !== "" ? String(n.name).trim() : cur.name,
      n.area != null ? n.area : cur.area,
      n.lat != null && n.lat !== "" ? Number(n.lat) : (n.lat === "" ? null : cur.lat),
      n.lng != null && n.lng !== "" ? Number(n.lng) : (n.lng === "" ? null : cur.lng),
      n.notes != null ? n.notes : cur.notes, id);
    return get("SELECT * FROM naps WHERE id=?", id);
  },
  remove: (id) => { run("UPDATE customers SET nap_id=NULL WHERE nap_id=?", id); return run("DELETE FROM naps WHERE id=?", id); },
};

db.exec(`CREATE TABLE IF NOT EXISTS outages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  scope_type TEXT DEFAULT 'all',      -- 'nap' | 'area' | 'all'
  scope_value TEXT DEFAULT '',        -- nap id or area name
  status TEXT DEFAULT 'open',         -- 'open' | 'resolved'
  started_at TEXT DEFAULT (datetime('now','localtime')),
  resolved_at TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  notified INTEGER DEFAULT 0
)`);

db.exec(`CREATE TABLE IF NOT EXISTS customer_sessions (
  token TEXT PRIMARY KEY, customer_id INTEGER NOT NULL, expires TEXT NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS client_status (
  username TEXT PRIMARY KEY, online INTEGER DEFAULT 0,
  last_seen TEXT DEFAULT '', last_change TEXT DEFAULT ''
)`);

export const ClientStatus = {
  map: () => { const m = new Map(); for (const r of all("SELECT * FROM client_status")) m.set(r.username, !!r.online); return m; },
  all: () => all("SELECT * FROM client_status"),
  apply: (changes, onlineSet, now) => {
    for (const ch of changes) {
      run(`INSERT INTO client_status (username,online,last_seen,last_change) VALUES (?,?,?,?)
           ON CONFLICT(username) DO UPDATE SET online=?, last_change=?`,
        ch.username, ch.online ? 1 : 0, ch.online ? now : "", now, ch.online ? 1 : 0, now);
    }
    // refresh last_seen for everyone currently online
    for (const u of onlineSet) run("UPDATE client_status SET last_seen=? WHERE username=?", now, u);
  },
};

db.exec(`CREATE TABLE IF NOT EXISTS sms_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT DEFAULT 'in',
  number TEXT DEFAULT '',
  name TEXT DEFAULT '',
  body TEXT DEFAULT '',
  gcash INTEGER DEFAULT 0,
  amount REAL DEFAULT 0,
  reference TEXT DEFAULT '',
  status TEXT DEFAULT '',
  read INTEGER DEFAULT 0,
  at TEXT DEFAULT (datetime('now','localtime'))
)`);

// ---- Inventory: stock items + movements (in/out/consume/return) ----
db.exec(`CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT DEFAULT '',
  unit TEXT DEFAULT 'pcs',
  qty REAL DEFAULT 0,
  reorder_level REAL DEFAULT 0,
  cost REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS inventory_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER,
  type TEXT DEFAULT 'in',         -- in | out | consume | return | adjust
  qty REAL DEFAULT 0,             -- positive number; sign applied by type
  customer_id INTEGER,            -- optional: install/job this was used on
  install_id INTEGER,             -- optional: install job id
  tech TEXT DEFAULT '',           -- optional: technician who took/used it
  note TEXT DEFAULT '',
  at TEXT DEFAULT (datetime('now','localtime'))
)`);

// Serialized units: individual physical items (routers/ONUs) tracked by serial + MAC.
db.exec(`CREATE TABLE IF NOT EXISTS inventory_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER,                 -- which item type (e.g. "Wireless Router")
  serial TEXT DEFAULT '',
  mac TEXT DEFAULT '',
  status TEXT DEFAULT 'in_stock',  -- in_stock | assigned | installed | returned | defective
  tech TEXT DEFAULT '',            -- technician currently holding it (if assigned)
  customer_id INTEGER,             -- client it's installed at (if installed)
  install_id INTEGER,              -- the install job it belongs to
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
)`);
// Per-unit lifecycle events (trace a router's history: stocked, assigned, installed,
// pulled out, marked defective, returned, replaced).
db.exec(`CREATE TABLE IF NOT EXISTS unit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER,
  event TEXT DEFAULT '',           -- stocked | assigned | installed | pulled_out | defective | returned | replaced_by | replaces
  from_status TEXT DEFAULT '',
  to_status TEXT DEFAULT '',
  customer_id INTEGER,
  tech TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  at TEXT DEFAULT (datetime('now','localtime'))
)`);
// Install jobs: bundle client + tech + materials/units + client sign-off.
db.exec(`CREATE TABLE IF NOT EXISTS installs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER,
  tech TEXT DEFAULT '',
  status TEXT DEFAULT 'open',      -- open | completed
  approval_type TEXT DEFAULT '',   -- signature | typed | photo
  approved_by TEXT DEFAULT '',     -- client name who confirmed
  approval_data TEXT DEFAULT '',   -- signature dataURL / photo dataURL / typed text
  approved_at TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
)`);

// Install applications / job orders (public apply -> admin pipeline).
db.exec(`CREATE TABLE IF NOT EXISTS job_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  area TEXT DEFAULT '',
  lat REAL, lng REAL,
  plan_id INTEGER,
  conn_type TEXT DEFAULT 'pppoe',
  notes TEXT DEFAULT '',
  install_fee REAL DEFAULT 0,
  router_cost REAL DEFAULT 0,
  pay_choice TEXT DEFAULT 'on_install',
  pay_status TEXT DEFAULT 'unpaid',
  pay_reference TEXT DEFAULT '',
  pay_proof TEXT DEFAULT '',
  agreed INTEGER DEFAULT 0,
  status TEXT DEFAULT 'applied',
  tech TEXT DEFAULT '',
  customer_id INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
)`);
ensureColumn("job_orders", "install_id", "INTEGER");
ensureColumn("job_orders", "reject_reason", "TEXT DEFAULT ''");
ensureColumn("inventory_items", "serialized", "INTEGER DEFAULT 0");
ensureColumn("inventory_items", "sell_price", "REAL DEFAULT 0");

// Business expenses (utilities, fuel, vehicle, salary, etc.) for profit tracking.
db.exec(`CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT DEFAULT 'misc',
  description TEXT DEFAULT '',
  amount REAL DEFAULT 0,
  vendor TEXT DEFAULT '',
  paid_by TEXT DEFAULT '',
  spent_at TEXT DEFAULT (date('now','localtime')),
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
)`);

// Hardware sales: router/equipment sold to clients, with cost vs sell price for margin.
db.exec(`CREATE TABLE IF NOT EXISTS hardware_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER,
  item_id INTEGER,
  unit_id INTEGER,
  item_name TEXT DEFAULT '',
  cost REAL DEFAULT 0,
  sell_price REAL DEFAULT 0,
  margin REAL DEFAULT 0,
  method TEXT DEFAULT 'cash',
  payment_id INTEGER,
  expense_id INTEGER,
  note TEXT DEFAULT '',
  sold_at TEXT DEFAULT (datetime('now','localtime'))
)`);

// Technical team: the field crew, their rank, availability, and areas they cover.
db.exec(`CREATE TABLE IF NOT EXISTS techs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rank TEXT DEFAULT 'Technician',
  phone TEXT DEFAULT '',
  status TEXT DEFAULT 'available',     -- available | on_job | off_duty
  areas TEXT DEFAULT '',               -- comma-separated areas/barangays they cover
  active INTEGER DEFAULT 1,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
)`);

export const Sms = {
  add: (m) => { const r = run("INSERT INTO sms_messages (direction,number,name,body,gcash,amount,reference,status,read) VALUES (?,?,?,?,?,?,?,?,?)",
      m.direction || "in", m.number || "", m.name || "", m.body || "", m.gcash ? 1 : 0, m.amount || 0, m.reference || "", m.status || "", m.read ? 1 : 0);
    return get("SELECT * FROM sms_messages WHERE id=?", r.lastInsertRowid); },
  list: (limit = 100) => all("SELECT * FROM sms_messages ORDER BY id DESC LIMIT ?", Number(limit) || 100),
  gcashList: (limit = 50) => all("SELECT * FROM sms_messages WHERE gcash=1 ORDER BY id DESC LIMIT ?", Number(limit) || 50),
  byNumber: (number, limit = 50) => all("SELECT * FROM sms_messages WHERE number=? ORDER BY id ASC LIMIT ?", String(number || ""), Number(limit) || 50),
  unread: () => get("SELECT COUNT(*) c FROM sms_messages WHERE direction='in' AND read=0").c,
  markRead: (number) => run("UPDATE sms_messages SET read=1 WHERE number=? AND direction='in'", String(number || "")),
  refExists: (ref) => !!(ref && get("SELECT 1 FROM sms_messages WHERE reference=? AND gcash=1 LIMIT 1", String(ref))),
  // Find a received GCash/Maya payment text matching a reference (preferred) or exact amount.
  findPayment: (reference, amount) => {
    const ref = String(reference || "").replace(/\s+/g, "");
    if (ref) { const r = get("SELECT * FROM sms_messages WHERE direction='in' AND gcash=1 AND replace(reference,' ','')=? ORDER BY id DESC LIMIT 1", ref); if (r) return r; }
    if (amount > 0) { const r = get("SELECT * FROM sms_messages WHERE direction='in' AND gcash=1 AND ABS(amount-?)<0.01 ORDER BY id DESC LIMIT 1", Number(amount)); if (r) return r; }
    return null;
  },
};

export const Inventory = {
  items: () => all("SELECT * FROM inventory_items ORDER BY category, name"),
  item: (id) => get("SELECT * FROM inventory_items WHERE id=?", id),
  addItem: (i) => {
    // For serialized items (routers/ONUs) the on-hand count is driven ENTIRELY by the
    // individual units you add (each unit = qty+1). So ignore any manual opening qty here,
    // otherwise adding the item with qty=1 and then adding 1 unit would double to 2.
    const openingQty = i.serialized ? 0 : (Number(i.qty) || 0);
    const r = run("INSERT INTO inventory_items (name,category,unit,qty,reorder_level,cost,sell_price,notes,serialized) VALUES (?,?,?,?,?,?,?,?,?)",
      i.name, i.category || "", i.unit || "pcs", openingQty, Number(i.reorder_level) || 0, Number(i.cost) || 0, Number(i.sell_price) || 0, i.notes || "", i.serialized ? 1 : 0);
    const item = Inventory.item(r.lastInsertRowid);
    if (openingQty > 0) run("INSERT INTO inventory_moves (item_id,type,qty,note) VALUES (?,?,?,?)", item.id, "in", openingQty, "opening stock");
    return item;
  },
  updateItem: (id, i) => {
    run("UPDATE inventory_items SET name=?,category=?,unit=?,reorder_level=?,cost=?,sell_price=?,notes=?,serialized=? WHERE id=?",
      i.name, i.category || "", i.unit || "pcs", Number(i.reorder_level) || 0, Number(i.cost) || 0, Number(i.sell_price) || 0, i.notes || "", i.serialized ? 1 : 0, id);
    return Inventory.item(id);
  },
  removeItem: (id) => { run("DELETE FROM inventory_moves WHERE item_id=?", id); return run("DELETE FROM inventory_items WHERE id=?", id); },
  // Record a movement row WITHOUT adjusting qty (used when qty was already changed elsewhere,
  // e.g. a serialized unit released/returned via setUnit, which adjusts the parent item qty).
  logMove: (m) => {
    if (!m.item_id) return;
    run("INSERT INTO inventory_moves (item_id,type,qty,customer_id,install_id,tech,note) VALUES (?,?,?,?,?,?,?)",
      m.item_id, m.type || "out", Math.abs(Number(m.qty) || 1), m.customer_id || null, m.install_id || null, m.tech || "", m.note || "");
  },
  // Record a movement and adjust qty. type: in|out|consume|return|adjust
  move: (m) => {
    const item = Inventory.item(m.item_id);
    if (!item) throw new Error("Item not found");
    const q = Math.abs(Number(m.qty) || 0);
    if (q <= 0 && m.type !== "adjust") throw new Error("Quantity must be greater than zero");
    let delta = 0;
    if (m.type === "in" || m.type === "return") delta = q;
    else if (m.type === "out" || m.type === "consume") delta = -q;
    else if (m.type === "adjust") delta = Number(m.qty) || 0; // signed for adjust
    const newQty = Number(item.qty) + delta;
    if (newQty < 0) throw new Error(`Not enough stock: ${item.name} has ${item.qty} ${item.unit}, tried to remove ${q}.`);
    run("UPDATE inventory_items SET qty=? WHERE id=?", newQty, item.id);
    run("INSERT INTO inventory_moves (item_id,type,qty,customer_id,install_id,tech,note) VALUES (?,?,?,?,?,?,?)",
      item.id, m.type, m.type === "adjust" ? (Number(m.qty) || 0) : q, m.customer_id || null, m.install_id || null, m.tech || "", m.note || "");
    return Inventory.item(item.id);
  },
  moves: (limit = 200) => all(
    `SELECT mv.*, it.name AS item_name, it.unit AS unit, c.name AS customer_name
     FROM inventory_moves mv LEFT JOIN inventory_items it ON it.id=mv.item_id
     LEFT JOIN customers c ON c.id=mv.customer_id
     ORDER BY mv.id DESC LIMIT ?`, Number(limit) || 200),
  movesForCustomer: (cid) => all(
    `SELECT mv.*, it.name AS item_name, it.unit AS unit FROM inventory_moves mv
     LEFT JOIN inventory_items it ON it.id=mv.item_id
     WHERE mv.customer_id=? AND mv.type IN ('consume','out') ORDER BY mv.id DESC`, cid),
  lowStock: () => all("SELECT * FROM inventory_items WHERE reorder_level > 0 AND qty <= reorder_level ORDER BY name"),
  summary: () => {
    // Materials = non-serialized items (qty is a real stock count like meters/pcs).
    // Serialized = routers/ONUs tracked as individual units (serial+MAC).
    const mat = get("SELECT COUNT(*) n, COALESCE(SUM(qty),0) units, COALESCE(SUM(qty*cost),0) val FROM inventory_items WHERE COALESCE(serialized,0)=0");
    // Serialized value = cost of units still IN STOCK (not assigned/installed/returned/defective).
    const serVal = get(`SELECT COALESCE(SUM(it.cost),0) val
                        FROM inventory_units u JOIN inventory_items it ON it.id=u.item_id
                        WHERE u.status='in_stock'`);
    const unitsInStock = get("SELECT COUNT(*) n FROM inventory_units WHERE status='in_stock'");
    const unitsTotal = get("SELECT COUNT(*) n FROM inventory_units");
    const low = get("SELECT COUNT(*) n FROM inventory_items WHERE reorder_level > 0 AND qty <= reorder_level");
    const itemCount = get("SELECT COUNT(*) n FROM inventory_items");
    return {
      items: itemCount.n,
      // serialized routers/ONUs physically in stock (not yet assigned/installed)
      unitsInStock: unitsInStock.n, unitsTotal: unitsTotal.n,
      // material stock (cable/connectors etc.)
      materialUnits: mat.units,
      // total stock value = material value + value of in-stock serialized units
      value: (mat.val || 0) + (serVal.val || 0),
      low: low.n,
    };
  },

  // ---- Serialized units (serial + MAC per physical router/ONU) ----
  units: (filter) => {
    let sql = `SELECT u.*, it.name AS item_name, c.name AS customer_name
               FROM inventory_units u LEFT JOIN inventory_items it ON it.id=u.item_id
               LEFT JOIN customers c ON c.id=u.customer_id`;
    const args = [];
    if (filter && filter.status) { sql += " WHERE u.status=?"; args.push(filter.status); }
    sql += " ORDER BY u.id DESC";
    return all(sql, ...args);
  },
  unit: (id) => get("SELECT * FROM inventory_units WHERE id=?", id),
  addUnit: (u) => {
    const it = u.item_id ? Inventory.item(u.item_id) : null;
    if (!it) throw new Error("Choose a valid item.");
    if (!it.serialized) throw new Error(`"${it.name}" isn't a serialized item (router/ONU). Only serialized items track serial + MAC. Edit the item and tick "Serialized" if it should.`);
    if (!u.serial || !String(u.serial).trim()) throw new Error("Serial number is required.");
    const mac = (u.mac || "").toUpperCase().replace(/[^0-9A-F]/g, "");
    if (mac.length !== 12) throw new Error("A valid MAC (6 pairs) is required, e.g. A8:A5:EF:26:2B:55.");
    const macFmt = mac.match(/.{2}/g).join(":");
    if (get("SELECT 1 FROM inventory_units WHERE serial=? AND serial<>''", u.serial)) throw new Error("Serial " + u.serial + " already exists.");
    if (get("SELECT 1 FROM inventory_units WHERE mac=? AND mac<>''", macFmt)) throw new Error("MAC " + macFmt + " already exists.");
    const r = run("INSERT INTO inventory_units (item_id,serial,mac,status,notes) VALUES (?,?,?,?,?)",
      u.item_id || null, String(u.serial).trim(), macFmt, "in_stock", u.notes || "");
    // bump the item's qty to reflect the new physical unit
    if (u.item_id) run("UPDATE inventory_items SET qty=qty+1 WHERE id=?", u.item_id);
    Inventory.logUnitEvent(r.lastInsertRowid, "stocked", "", "in_stock", { detail: "added to stock" });
    return Inventory.unit(r.lastInsertRowid);
  },
  setUnit: (id, patch) => {
    const u = Inventory.unit(id); if (!u) throw new Error("Unit not found");
    const prevStatus = u.status;
    const fields = [], args = [];
    for (const k of ["serial", "mac", "status", "tech", "customer_id", "install_id", "notes"]) {
      if (patch[k] !== undefined) { fields.push(k + "=?"); args.push(patch[k]); }
    }
    if (!fields.length) return u;
    fields.push("updated_at=datetime('now','localtime')");
    args.push(id);
    run("UPDATE inventory_units SET " + fields.join(",") + " WHERE id=?", ...args);
    // log a lifecycle event when status changes
    if (patch.status !== undefined && patch.status !== prevStatus) {
      const evMap = { assigned: "assigned", installed: "installed", returned: "returned", defective: "defective", in_stock: "returned" };
      Inventory.logUnitEvent(id, evMap[patch.status] || "status", prevStatus, patch.status, { customer_id: patch.customer_id != null ? patch.customer_id : u.customer_id, tech: patch.tech != null ? patch.tech : u.tech, detail: patch._reason || "" });
      // Keep the parent item's on-hand qty in sync with physical reality:
      // leaving stock (in_stock -> assigned/installed/defective/returned) decrements on-hand,
      // coming back to stock (-> in_stock) increments it. Never go below zero.
      const leftStock = prevStatus === "in_stock" && patch.status !== "in_stock";
      const cameBack = prevStatus !== "in_stock" && patch.status === "in_stock";
      if (u.item_id && leftStock) run("UPDATE inventory_items SET qty=MAX(0, qty-1) WHERE id=?", u.item_id);
      if (u.item_id && cameBack) run("UPDATE inventory_items SET qty=qty+1 WHERE id=?", u.item_id);
    }
    return Inventory.unit(id);
  },
  logUnitEvent: (unitId, event, fromStatus, toStatus, opts = {}) => run(
    "INSERT INTO unit_events (unit_id,event,from_status,to_status,customer_id,tech,detail) VALUES (?,?,?,?,?,?,?)",
    unitId, event, fromStatus || "", toStatus || "", opts.customer_id || null, opts.tech || "", opts.detail || ""),
  // Find a unit by MAC or serial (for scan/search). Accepts loose MAC formats.
  findByMacOrSerial: (q) => {
    const raw = String(q || "").trim();
    if (!raw) return null;
    const hex = raw.toUpperCase().replace(/[^0-9A-F]/g, "");
    let u = null;
    if (hex.length === 12) { const mac = hex.match(/.{2}/g).join(":"); u = get("SELECT * FROM inventory_units WHERE REPLACE(REPLACE(UPPER(mac),':',''),'-','')=? ", hex); }
    if (!u) u = get("SELECT * FROM inventory_units WHERE UPPER(serial)=?", raw.toUpperCase());
    if (!u) u = get("SELECT * FROM inventory_units WHERE REPLACE(REPLACE(UPPER(mac),':',''),'-','')=?", hex);
    if (!u) return null;
    return Inventory.unitFull(u.id);
  },
  unitFull: (id) => {
    const u = get(`SELECT u.*, it.name AS item_name, c.name AS customer_name
                   FROM inventory_units u LEFT JOIN inventory_items it ON it.id=u.item_id
                   LEFT JOIN customers c ON c.id=u.customer_id WHERE u.id=?`, id);
    if (!u) return null;
    u.history = all(`SELECT e.*, c.name AS customer_name FROM unit_events e LEFT JOIN customers c ON c.id=e.customer_id WHERE e.unit_id=? ORDER BY e.id DESC`, id);
    return u;
  },
  // Pull a router out from a client (e.g. disconnection or swap). Marks defective or returned.
  pullOut: (id, opts = {}) => {
    const u = Inventory.unit(id); if (!u) throw new Error("Unit not found");
    const toStatus = opts.defective ? "defective" : "returned";
    const cid = u.customer_id;
    run("UPDATE inventory_units SET status=?, customer_id=NULL, updated_at=datetime('now','localtime') WHERE id=?", toStatus, id);
    Inventory.logUnitEvent(id, "pulled_out", u.status, toStatus, { customer_id: cid, tech: opts.tech || "", detail: opts.reason || (opts.defective ? "pulled out — defective" : "pulled out — returned to stock") });
    return Inventory.unitFull(id);
  },
  // Replace a pulled unit with a new in-stock unit for the same customer.
  replaceUnit: (oldId, newId, opts = {}) => {
    const oldU = Inventory.unit(oldId); if (!oldU) throw new Error("Old unit not found");
    const newU = Inventory.unit(newId); if (!newU) throw new Error("Replacement unit not found");
    if (newU.status !== "in_stock") throw new Error("Replacement must be an in-stock unit.");
    const cid = opts.customer_id || oldU.customer_id;
    // old unit -> defective/returned (pulled), new unit -> installed at the customer
    const oldTo = opts.defective === false ? "returned" : "defective";
    run("UPDATE inventory_units SET status=?, customer_id=NULL, updated_at=datetime('now','localtime') WHERE id=?", oldTo, oldId);
    run("UPDATE inventory_units SET status='installed', customer_id=?, updated_at=datetime('now','localtime') WHERE id=?", cid || null, newId);
    Inventory.logUnitEvent(oldId, "replaced_by", oldU.status, oldTo, { customer_id: cid, tech: opts.tech || "", detail: `Replaced by unit #${newId} (${newU.serial || newU.mac})` });
    Inventory.logUnitEvent(newId, "replaces", "in_stock", "installed", { customer_id: cid, tech: opts.tech || "", detail: `Replaces unit #${oldId} (${oldU.serial || oldU.mac})` });
    return { old: Inventory.unitFull(oldId), new: Inventory.unitFull(newId) };
  },
  removeUnit: (id) => { const u = Inventory.unit(id); if (u && u.item_id) run("UPDATE inventory_items SET qty=MAX(0,qty-1) WHERE id=?", u.item_id); return run("DELETE FROM inventory_units WHERE id=?", id); },
  unitsForCustomer: (cid) => all(`SELECT u.*, it.name AS item_name FROM inventory_units u LEFT JOIN inventory_items it ON it.id=u.item_id WHERE u.customer_id=? ORDER BY u.id DESC`, cid),

  // ---- Per-technician custody ("what's on my truck") ----
  // Serialized units currently assigned to (held by) a technician, not yet installed/returned.
  techUnits: () => all(`SELECT u.*, it.name AS item_name FROM inventory_units u
     LEFT JOIN inventory_items it ON it.id=u.item_id
     WHERE u.status='assigned' AND COALESCE(u.tech,'')<>'' ORDER BY u.tech, it.name`),
  // Net materials a technician took out but hasn't consumed/returned: out - consume - return.
  techMaterials: () => all(`SELECT t.tech, t.item_id, it.name AS item_name, it.unit AS unit,
       SUM(CASE WHEN t.type='out' THEN t.qty
                WHEN t.type IN ('consume','return') THEN -t.qty
                ELSE 0 END) AS held
     FROM inventory_moves t LEFT JOIN inventory_items it ON it.id=t.item_id
     WHERE COALESCE(t.tech,'')<>'' AND t.type IN ('out','consume','return')
     GROUP BY t.tech, t.item_id HAVING held > 0 ORDER BY t.tech, it.name`),
  // Roll the above up into one object per technician.
  techCustody: () => {
    const units = Inventory.techUnits();
    const mats = Inventory.techMaterials();
    const techs = {};
    const ensure = (name) => (techs[name] = techs[name] || { tech: name, units: [], materials: [], unitCount: 0, matLines: 0 });
    for (const u of units) { const t = ensure(u.tech); t.units.push(u); t.unitCount++; }
    for (const m of mats) { const t = ensure(m.tech); t.materials.push(m); t.matLines++; }
    return Object.values(techs).sort((a, b) => a.tech.localeCompare(b.tech));
  },

  // ---- Install jobs (client + tech + materials/units + sign-off) ----
  createInstall: (i) => {
    const r = run("INSERT INTO installs (customer_id,tech,notes) VALUES (?,?,?)", i.customer_id || null, i.tech || "", i.notes || "");
    return get("SELECT * FROM installs WHERE id=?", r.lastInsertRowid);
  },
  install: (id) => get(`SELECT ins.*, c.name AS customer_name FROM installs ins LEFT JOIN customers c ON c.id=ins.customer_id WHERE ins.id=?`, id),
  installsForCustomer: (cid) => all("SELECT * FROM installs WHERE customer_id=? ORDER BY id DESC", cid),
  approveInstall: (id, a) => {
    run("UPDATE installs SET status='completed', approval_type=?, approved_by=?, approval_data=?, approved_at=datetime('now','localtime') WHERE id=?",
      a.approval_type || "typed", a.approved_by || "", a.approval_data || "", id);
    return Inventory.install(id);
  },
  // One-time / idempotent repair: set each serialized item's on-hand qty to the real number
  // of its units that are still in_stock. Fixes historical double-counts. Safe to run anytime.
  recalcSerializedQty: () => {
    const items = all("SELECT id FROM inventory_items WHERE serialized=1");
    let fixed = 0;
    for (const it of items) {
      const r = get("SELECT COUNT(*) n FROM inventory_units WHERE item_id=? AND status='in_stock'", it.id);
      const real = r ? r.n : 0;
      const cur = get("SELECT qty FROM inventory_items WHERE id=?", it.id);
      if (cur && Number(cur.qty) !== Number(real)) { run("UPDATE inventory_items SET qty=? WHERE id=?", real, it.id); fixed++; }
    }
    return fixed;
  },
  installUnits: (id) => all(`SELECT u.*, it.name AS item_name FROM inventory_units u LEFT JOIN inventory_items it ON it.id=u.item_id WHERE u.install_id=?`, id),
  installMoves: (id) => all(`SELECT mv.*, it.name AS item_name, it.unit AS unit FROM inventory_moves mv LEFT JOIN inventory_items it ON it.id=mv.item_id WHERE mv.install_id=?`, id),
  // Back-fill the customer on an install + its material movements once the account is created
  // (equipment is released before the account exists, so these start with customer_id NULL).
  setInstallCustomer: (id, cid) => { run("UPDATE installs SET customer_id=? WHERE id=?", cid || null, id); return Inventory.install(id); },
  setMovesCustomerByInstall: (installId, cid) => { run("UPDATE inventory_moves SET customer_id=? WHERE install_id=? AND (customer_id IS NULL OR customer_id='')", cid || null, installId); },
};

export const JobOrders = {
  list: (filter = {}) => {
    let sql = `SELECT jo.*, p.name AS plan_name, p.price AS plan_price, c.name AS linked_customer
               FROM job_orders jo LEFT JOIN plans p ON p.id=jo.plan_id
               LEFT JOIN customers c ON c.id=jo.customer_id`;
    const where = [], args = [];
    if (filter.status) { where.push("jo.status=?"); args.push(filter.status); }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY jo.id DESC LIMIT 500";
    return all(sql, ...args);
  },
  get: (id) => get(`SELECT jo.*, p.name AS plan_name, p.price AS plan_price, p.speed AS plan_speed, p.type AS plan_type, c.name AS linked_customer
                    FROM job_orders jo LEFT JOIN plans p ON p.id=jo.plan_id
                    LEFT JOIN customers c ON c.id=jo.customer_id WHERE jo.id=?`, id),
  // Public application submit.
  apply: (a) => {
    const r = run(`INSERT INTO job_orders (name,contact,email,address,area,lat,lng,plan_id,conn_type,notes,install_fee,router_cost,pay_choice,pay_status,pay_reference,pay_proof,agreed,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'applied')`,
      a.name, a.contact || "", a.email || "", a.address || "", a.area || "",
      a.lat != null && a.lat !== "" ? Number(a.lat) : null, a.lng != null && a.lng !== "" ? Number(a.lng) : null,
      a.plan_id || null, a.conn_type || "pppoe", a.notes || "",
      Number(a.install_fee) || 0, Number(a.router_cost) || 0,
      a.pay_choice === "now" ? "now" : "on_install",
      a.pay_choice === "now" ? "paid" : "unpaid",
      a.pay_reference || "", a.pay_proof || "", a.agreed ? 1 : 0);
    return JobOrders.get(r.lastInsertRowid);
  },
  setStatus: (id, status) => { run("UPDATE job_orders SET status=? WHERE id=?", status, id); return JobOrders.get(id); },
  reject: (id, reason) => { run("UPDATE job_orders SET status='rejected', reject_reason=? WHERE id=?", reason || "", id); return JobOrders.get(id); },
  setTech: (id, tech) => { run("UPDATE job_orders SET tech=?, status=CASE WHEN status='applied' THEN 'assigned' ELSE status END WHERE id=?", tech || "", id); return JobOrders.get(id); },
  setPaid: (id) => { run("UPDATE job_orders SET pay_status='paid' WHERE id=?", id); return JobOrders.get(id); },
  link: (id, customer_id) => { run("UPDATE job_orders SET customer_id=? WHERE id=?", customer_id, id); return JobOrders.get(id); },
  setInstall: (id, install_id) => { run("UPDATE job_orders SET install_id=? WHERE id=?", install_id, id); return JobOrders.get(id); },
  remove: (id) => run("DELETE FROM job_orders WHERE id=?", id),
  summary: () => {
    const s = get("SELECT COUNT(*) total, SUM(status='applied') applied, SUM(status IN ('assigned','released','installed')) inprogress, SUM(status='completed') completed FROM job_orders");
    return { total: s.total || 0, applied: s.applied || 0, inprogress: s.inprogress || 0, completed: s.completed || 0 };
  },
  // Things needing attention, for the dashboard/nav badge + alerts panel.
  alerts: () => {
    const newApps = all("SELECT id,name,created_at FROM job_orders WHERE status='applied' ORDER BY id DESC");
    // Only flag "unassigned" as a warning if it's been waiting over ~12 hours — a brand-new
    // application being unassigned is normal, not an error.
    const staleUnassigned = all("SELECT id,name FROM job_orders WHERE status='applied' AND COALESCE(tech,'')='' AND datetime(COALESCE(created_at, datetime('now'))) < datetime('now','-12 hours')");
    const awaitingPay = all("SELECT id,name FROM job_orders WHERE pay_status='proof_submitted'");
    const readyNoAccount = all("SELECT id,name FROM job_orders WHERE status IN ('released','installed') AND customer_id IS NULL");
    const items = [];
    if (newApps.length) items.push({ kind: "new", level: "info", count: newApps.length, text: `${newApps.length} new application${newApps.length === 1 ? "" : "s"} to review`, ids: newApps.map((r) => r.id) });
    if (staleUnassigned.length) items.push({ kind: "unassigned", level: "warn", count: staleUnassigned.length, text: `${staleUnassigned.length} application${staleUnassigned.length === 1 ? "" : "s"} waiting over 12h for a technician`, ids: staleUnassigned.map((r) => r.id) });
    if (awaitingPay.length) items.push({ kind: "pay", level: "warn", count: awaitingPay.length, text: `${awaitingPay.length} payment proof${awaitingPay.length === 1 ? "" : "s"} to verify`, ids: awaitingPay.map((r) => r.id) });
    if (readyNoAccount.length) items.push({ kind: "account", level: "warn", count: readyNoAccount.length, text: `${readyNoAccount.length} installed job${readyNoAccount.length === 1 ? "" : "s"} with no account created yet`, ids: readyNoAccount.map((r) => r.id) });
    return { items, total: items.reduce((s, i) => s + i.count, 0) };
  },
};

export const Techs = {
  RANKS: ["Lead Technician", "Senior Technician", "Technician", "Junior Technician", "Helper/Apprentice"],
  STATUSES: ["available", "on_job", "off_duty"],
  list: () => {
    const techs = all("SELECT * FROM techs WHERE active=1 ORDER BY name");
    // enrich each with their active job orders + areas they've actually installed in
    for (const t of techs) {
      const jobs = all(
        `SELECT id, name AS client, area, address, status FROM job_orders
         WHERE tech=? AND status IN ('assigned','released','installed') ORDER BY id DESC`, t.name);
      t.activeJobs = jobs;
      t.activeCount = jobs.length;
      // distinct areas from completed installs (job orders linked to a customer / completed)
      const doneAreas = all(
        `SELECT DISTINCT COALESCE(NULLIF(area,''),'(no area)') area FROM job_orders
         WHERE tech=? AND status='completed' AND area IS NOT NULL`, t.name).map((r) => r.area);
      t.servedAreas = doneAreas;
      t.completedCount = get("SELECT COUNT(*) n FROM job_orders WHERE tech=? AND status='completed'", t.name).n;
      // a tech is effectively busy if they have any active (not-yet-completed) job
      t.effectiveStatus = t.status === "off_duty" ? "off_duty" : (t.activeCount > 0 ? "on_job" : "available");
    }
    return techs;
  },
  get: (id) => get("SELECT * FROM techs WHERE id=?", id),
  byName: (name) => get("SELECT * FROM techs WHERE name=? AND active=1", name),
  create: (t) => {
    const r = run("INSERT INTO techs (name,rank,phone,status,areas,notes) VALUES (?,?,?,?,?,?)",
      t.name, t.rank || "Technician", t.phone || "", Techs.STATUSES.includes(t.status) ? t.status : "available", t.areas || "", t.notes || "");
    return Techs.get(r.lastInsertRowid);
  },
  update: (id, t) => {
    run("UPDATE techs SET name=?,rank=?,phone=?,status=?,areas=?,notes=? WHERE id=?",
      t.name, t.rank || "Technician", t.phone || "", Techs.STATUSES.includes(t.status) ? t.status : "available", t.areas || "", t.notes || "", id);
    return Techs.get(id);
  },
  setStatus: (id, status) => { run("UPDATE techs SET status=? WHERE id=?", Techs.STATUSES.includes(status) ? status : "available", id); return Techs.get(id); },
  remove: (id) => run("UPDATE techs SET active=0 WHERE id=?", id), // soft-delete: keep history intact
  // Names for assignment dropdowns (active techs only).
  names: () => all("SELECT name FROM techs WHERE active=1 ORDER BY name").map((r) => r.name),
  summary: () => {
    const list = Techs.list();
    return {
      total: list.length,
      available: list.filter((t) => t.effectiveStatus === "available").length,
      onJob: list.filter((t) => t.effectiveStatus === "on_job").length,
      offDuty: list.filter((t) => t.effectiveStatus === "off_duty").length,
    };
  },
};

export const Hardware = {
  record: (s) => {
    const r = run(`INSERT INTO hardware_sales (customer_id,item_id,unit_id,item_name,cost,sell_price,margin,method,payment_id,expense_id,note)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      s.customer_id || null, s.item_id || null, s.unit_id || null, s.item_name || "",
      Number(s.cost) || 0, Number(s.sell_price) || 0, (Number(s.sell_price) || 0) - (Number(s.cost) || 0),
      s.method || "cash", s.payment_id || null, s.expense_id || null, s.note || "");
    return get("SELECT * FROM hardware_sales WHERE id=?", r.lastInsertRowid);
  },
  list: (limit = 200) => all("SELECT * FROM hardware_sales ORDER BY id DESC LIMIT ?", Number(limit) || 200),
  // Totals for a period (YYYY-MM); omit for all-time.
  summary: (ym) => {
    const where = ym ? "WHERE substr(sold_at,1,7)=?" : "";
    const args = ym ? [ym] : [];
    const row = get(`SELECT COUNT(*) n, COALESCE(SUM(sell_price),0) revenue, COALESCE(SUM(cost),0) cost, COALESCE(SUM(margin),0) margin FROM hardware_sales ${where}`, ...args);
    return { count: row.n, revenue: row.revenue, cost: row.cost, margin: row.margin };
  },
};

export const Expenses = {
  CATEGORIES: ["electricity", "fuel", "vehicle", "salary", "rent", "internet/bandwidth", "equipment", "supplies", "tax/permit", "misc"],
  list: (filter = {}) => {
    let sql = "SELECT * FROM expenses";
    const where = [], args = [];
    if (filter.period) { where.push("substr(spent_at,1,7)=?"); args.push(filter.period); }
    if (filter.category) { where.push("category=?"); args.push(filter.category); }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY spent_at DESC, id DESC LIMIT 500";
    return all(sql, ...args);
  },
  add: (e) => {
    const r = run("INSERT INTO expenses (category,description,amount,vendor,paid_by,spent_at,note) VALUES (?,?,?,?,?,?,?)",
      e.category || "misc", e.description || "", Number(e.amount) || 0, e.vendor || "", e.paid_by || "",
      e.spent_at || new Date().toISOString().slice(0, 10), e.note || "");
    return get("SELECT * FROM expenses WHERE id=?", r.lastInsertRowid);
  },
  update: (id, e) => {
    run("UPDATE expenses SET category=?,description=?,amount=?,vendor=?,paid_by=?,spent_at=?,note=? WHERE id=?",
      e.category || "misc", e.description || "", Number(e.amount) || 0, e.vendor || "", e.paid_by || "",
      e.spent_at || new Date().toISOString().slice(0, 10), e.note || "", id);
    return get("SELECT * FROM expenses WHERE id=?", id);
  },
  remove: (id) => run("DELETE FROM expenses WHERE id=?", id),
  byCategory: (period) => all(
    "SELECT category, COALESCE(SUM(amount),0) total, COUNT(*) n FROM expenses" +
    (period ? " WHERE substr(spent_at,1,7)=?" : "") + " GROUP BY category ORDER BY total DESC",
    ...(period ? [period] : [])),
  totalForPeriod: (period) => {
    const r = get("SELECT COALESCE(SUM(amount),0) total FROM expenses" + (period ? " WHERE substr(spent_at,1,7)=?" : ""), ...(period ? [period] : []));
    return r ? r.total : 0;
  },
};

export const CSessions = {
  create: (customerId, days = 7) => {
    const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const exp = new Date(Date.now() + days * 86400000).toISOString();
    run("INSERT INTO customer_sessions (token,customer_id,expires) VALUES (?,?,?)", token, customerId, exp);
    run("DELETE FROM customer_sessions WHERE expires < datetime('now')");
    return token;
  },
  get: (token) => {
    if (!token) return null;
    const s = get("SELECT * FROM customer_sessions WHERE token=? AND expires > datetime('now')", token);
    return s || null;
  },
  destroy: (token) => run("DELETE FROM customer_sessions WHERE token=?", token),
};

export const Outages = {
  list: () => all(`SELECT o.*, CASE WHEN o.scope_type='nap' THEN (SELECT name FROM naps WHERE id=CAST(o.scope_value AS INTEGER)) ELSE o.scope_value END AS scope_name FROM outages o ORDER BY o.status='resolved', o.started_at DESC`),
  get: (id) => get("SELECT * FROM outages WHERE id=?", id),
  create: (o) => { const r = run("INSERT INTO outages (title,scope_type,scope_value,notes) VALUES (?,?,?,?)", o.title, o.scope_type || "all", String(o.scope_value || ""), o.notes || ""); return Outages.get(r.lastInsertRowid); },
  setNotified: (id, n) => run("UPDATE outages SET notified=? WHERE id=?", n, id),
  resolve: (id) => { run("UPDATE outages SET status='resolved', resolved_at=datetime('now','localtime') WHERE id=?", id); return Outages.get(id); },
  remove: (id) => run("DELETE FROM outages WHERE id=?", id),
  openCount: () => get("SELECT COUNT(*) n FROM outages WHERE status='open'").n,
  // customers affected by a scope (with any contact for notification; all for counting)
  affected: (scope_type, scope_value) => {
    if (scope_type === "nap") return all("SELECT * FROM customers WHERE nap_id=?", Number(scope_value) || 0);
    if (scope_type === "area") return all("SELECT * FROM customers WHERE area=?", String(scope_value));
    return all("SELECT * FROM customers");
  },
};

export const Reports = {
  // last N months of revenue + invoicing performance
  monthly: (n) => {
    n = Math.min(Math.max(Number(n) || 12, 1), 36);
    const rows = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const rev = get("SELECT COALESCE(SUM(amount),0) v, COUNT(*) c FROM payments WHERE substr(paid_at,1,7)=?", period);
      const inv = get("SELECT COALESCE(SUM(amount),0) v, COUNT(*) c FROM invoices WHERE period=?", period);
      const paid = get("SELECT COALESCE(SUM(amount),0) v, COUNT(*) c FROM invoices WHERE period=? AND status='paid'", period);
      rows.push({
        period, revenue: rev.v, payments: rev.c,
        invoiced: inv.v, invoices: inv.c, invoicesPaid: paid.c,
        collectionRate: inv.v > 0 ? Math.round((paid.v / inv.v) * 100) : null,
        newCustomers: get("SELECT COUNT(*) c FROM customers WHERE substr(created_at,1,7)=?", period).c,
      });
    }
    return rows;
  },
  byMethod: (period) => all("SELECT COALESCE(NULLIF(method,''),'cash') method, COALESCE(SUM(amount),0) total, COUNT(*) n FROM payments" + (period ? " WHERE substr(paid_at,1,7)=?" : "") + " GROUP BY 1 ORDER BY total DESC", ...(period ? [period] : [])),
  // Full monthly financial statement: every income stream separated + expenses + net.
  monthlyStatement: (period) => {
    const p = period || new Date().toISOString().slice(0, 7);
    const cf = Reports.cashflow(p); // subscriptions / install / hardware margin / expenses / net
    // Vendo / hotspot coin income for the month
    const vendoRows = all("SELECT COALESCE(NULLIF(vendo,''),'(unknown)') vendo, COUNT(*) c, COALESCE(SUM(amount),0) s FROM hotspot_events WHERE type='coin' AND substr(at,1,7)=? GROUP BY vendo ORDER BY s DESC", p);
    const vendoTotal = vendoRows.reduce((a, r) => a + Number(r.s || 0), 0);
    // Payment method breakdown for subscriptions+install+hardware payments (cash flow visibility)
    const methods = all("SELECT COALESCE(NULLIF(method,''),'cash') method, COALESCE(SUM(amount),0) total, COUNT(*) n FROM payments WHERE substr(paid_at,1,7)=? GROUP BY 1 ORDER BY total DESC", p);
    // Expenses by category
    const expRows = cf.out.byCategory || [];
    // Income streams, in proper order
    const income = {
      subscriptions: cf.in.subscriptions,   // monthly client payments
      installation: cf.in.installFees,       // installation fees
      hardware: (cf.in.hardware != null ? cf.in.hardware : cf.in.hardwareMargin), // resale margin + any untracked hardware payments
      vendo: vendoTotal,                     // hotspot/piso-wifi coin income
    };
    const incomeTotal = income.subscriptions + income.installation + income.hardware + income.vendo;
    const expenseTotal = cf.out.expenses;
    return {
      period: p,
      income,
      incomeTotal,
      hardwareDetail: { revenue: cf.in.hardwareRevenue, cost: cf.in.hardwareCost, margin: cf.in.hardwareMargin },
      vendoByDevice: vendoRows,
      methods,
      expenses: expRows,
      expenseTotal,
      net: incomeTotal - expenseTotal,
    };
  },
  // Payments are tagged by note: "Install:" and "Hardware:"; the rest are subscriptions.
  // Hardware money-in is shown as MARGIN (sell - cost) so it isn't double-counted against
  // the stock value already spent when the unit was bought.
  cashflow: (period) => {
    const pWhere = period ? " WHERE substr(paid_at,1,7)=?" : "";
    const pArgs = period ? [period] : [];
    const sumWhere = (extra) => get(`SELECT COALESCE(SUM(amount),0) total, COUNT(*) n FROM payments${pWhere}${pWhere ? " AND " : " WHERE "}${extra}`, ...pArgs);
    const install = sumWhere("note LIKE 'Install:%'");
    const hardwarePay = sumWhere("note LIKE 'Hardware:%'");
    // Wallet accounting (Option A, cash basis):
    //  • a "Wallet topup:" payment = real cash in → counts as income (under subscriptions stream).
    //  • a method='wallet' payment that is NOT a topup = spending wallet credit on a renewal →
    //    NOT new cash (already counted at top-up time) → excluded from income.
    const walletTopups = sumWhere("note LIKE 'Wallet topup:%'");
    // subscriptions = everything that's NOT install / hardware / a wallet-spend.
    // (Wallet topups stay in because they're real cash; wallet *spends* are filtered out.)
    const subs = sumWhere("COALESCE(note,'') NOT LIKE 'Install:%' AND COALESCE(note,'') NOT LIKE 'Hardware:%' AND NOT (COALESCE(method,'')='wallet' AND COALESCE(note,'') NOT LIKE 'Wallet topup:%')");
    // hardware margin for the period (from hardware_sales)
    const hw = get(`SELECT COALESCE(SUM(sell_price),0) revenue, COALESCE(SUM(cost),0) cost, COALESCE(SUM(margin),0) margin, COUNT(*) n FROM hardware_sales${period ? " WHERE substr(sold_at,1,7)=?" : ""}`, ...(period ? [period] : []));
    // expenses for the period, by category
    const expRows = all("SELECT category, COALESCE(SUM(amount),0) total, COUNT(*) n FROM expenses" + (period ? " WHERE substr(spent_at,1,7)=?" : "") + " GROUP BY category ORDER BY total DESC", ...(period ? [period] : []));
    const expTotal = expRows.reduce((s, r) => s + Number(r.total || 0), 0);
    // Money IN streams. Subscriptions exclude install+hardware (they're tagged separately).
    const inSubs = Number(subs.total || 0);
    const inInstall = Number(install.total || 0);
    // Hardware money-in depends on the costing mode (must match how cost is handled on the
    // expense side, or the cost gets counted twice):
    //  • stock-value mode (cost NOT logged as expense): count MARGIN (sell-cost). The stock
    //    money was already spent when bought, so only the profit is "new" money in.
    //  • cost-as-expense mode (cost IS logged as expense): count full REVENUE here, because the
    //    cost is subtracted separately under expenses. Counting margin AND the expense would
    //    subtract the cost twice.
    // Plus: any payment tagged "Hardware:" with no matching hardware_sales row (recorded
    // directly, not via the sell flow) is added so that money never vanishes from the report.
    let costAsExpense = false;
    try { costAsExpense = Settings.get("inv_cost_as_expense", "0") === "1"; } catch {}
    const inHwMargin = Number(hw.margin || 0);
    const hwSalesRevenue = Number(hw.revenue || 0);
    const hwPayTotal = Number(hardwarePay.total || 0);
    // recorded-sale contribution: revenue (if cost expensed) or margin (stock-value mode)
    const hwSalesContribution = costAsExpense ? hwSalesRevenue : inHwMargin;
    // untracked hardware payments (tagged but no sales row) — count at face value either way
    const hwUntracked = Math.max(0, hwPayTotal - hwSalesRevenue);
    const inHardware = hwSalesContribution + hwUntracked;
    // Vendo / piso-WiFi coin income for the period (so the quick cashflow view matches the
    // printed monthly statement, which also counts vendo).
    let inVendo = 0;
    try {
      const vrow = get("SELECT COALESCE(SUM(amount),0) t FROM hotspot_events WHERE type='coin'" + (period ? " AND substr(at,1,7)=?" : ""), ...(period ? [period] : []));
      inVendo = Number(vrow.t) || 0;
    } catch {}
    const moneyIn = inSubs + inInstall + inHardware + inVendo;
    const moneyOut = expTotal;
    return {
      period: period || "all-time",
      in: {
        subscriptions: inSubs,
        installFees: inInstall,
        hardwareMargin: inHwMargin,
        hardwareRevenue: Number(hw.revenue || 0),
        hardwareCost: Number(hw.cost || 0),
        hardwareUntracked: hwUntracked,
        hardware: inHardware,
        vendo: inVendo,
        walletTopups: Number(walletTopups.total || 0),
        total: moneyIn,
      },
      out: { expenses: expTotal, byCategory: expRows },
      net: moneyIn - moneyOut,
      // Memo (not added to income): total unspent wallet credit you're currently holding.
      // This is money customers prepaid that they haven't used as service yet.
      walletHeld: (() => { try { return Number(get("SELECT COALESCE(SUM(credit),0) t FROM customers").t) || 0; } catch { return 0; } })(),
    };
  },
  // Revenue split by connection type (IPoE vs PPPoE/hotspot), via the paying customer.
  byConnType: (period) => {
    const rows = all(
      "SELECT COALESCE(NULLIF(c.conn_type,''),'pppoe') conn, COALESCE(SUM(pm.amount),0) total, COUNT(*) n " +
      "FROM payments pm LEFT JOIN customers c ON c.id=pm.customer_id" +
      (period ? " WHERE substr(pm.paid_at,1,7)=?" : "") +
      " GROUP BY 1 ORDER BY total DESC", ...(period ? [period] : []));
    return rows;
  },
  snapshot: () => {
    const active = get("SELECT COUNT(*) c FROM customers WHERE status='active'").c;
    const suspended = get("SELECT COUNT(*) c FROM customers WHERE status='suspended'").c;
    const period = currentPeriod();
    const monthRev = get("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE substr(paid_at,1,7)=?", period).v;
    const planValue = get("SELECT COALESCE(SUM(p.price),0) v FROM customers c JOIN plans p ON p.id=c.plan_id WHERE c.status='active'").v;
    return { active, suspended, monthRevenue: monthRev, planValue, arpu: active ? Math.round(monthRev / active) : 0, period };
  },
};

export const Usage = {
  // rows: [{name, up, down}] of current raw counters. Accumulates deltas into the period,
  // detecting counter resets (cur < last => the counter reset, so the delta is `cur`).
  accumulate: (rows, period) => {
    period = period || currentPeriod();
    let accumulated = 0;
    for (const r of rows || []) {
      const key = String(r.name || "").toLowerCase(); if (!key) continue;
      const curUp = Number(r.up) || 0, curDown = Number(r.down) || 0;
      const live = get("SELECT * FROM usage_live WHERE key=?", key);
      let dUp = 0, dDown = 0;
      if (live) {
        dUp = curUp >= live.last_up ? curUp - live.last_up : curUp;
        dDown = curDown >= live.last_down ? curDown - live.last_down : curDown;
      }
      if (live) run("UPDATE usage_live SET last_up=?, last_down=?, updated_at=datetime('now') WHERE key=?", curUp, curDown, key);
      else run("INSERT INTO usage_live (key,last_up,last_down,updated_at) VALUES (?,?,?,datetime('now'))", key, curUp, curDown);
      if (dUp || dDown) {
        run(`INSERT INTO usage_period (key,period,up,down) VALUES (?,?,?,?)
             ON CONFLICT(key,period) DO UPDATE SET up=up+?, down=down+?`, key, period, dUp, dDown, dUp, dDown);
        accumulated++;
      }
    }
    return { period, updated: (rows || []).length, accumulated };
  },
  forPeriod: (period) => all("SELECT * FROM usage_period WHERE period=?", period || currentPeriod()),
  forKey: (key, period) => get("SELECT * FROM usage_period WHERE key=? AND period=?", String(key).toLowerCase(), period || currentPeriod()),
};

export function exportAll() {
  const tables = {};
  for (const t of BACKUP_TABLES) {
    try { tables[t] = all(`SELECT * FROM ${t}`); } catch { tables[t] = []; }
  }
  return { version: 1, exported_at: new Date().toISOString(), tables };
}
export function importAll(data) {
  if (!data || !data.tables) throw new Error("invalid backup file");
  const counts = {};
  db.exec("BEGIN");
  try {
    for (const t of BACKUP_TABLES) {
      const rows = data.tables[t];
      if (!Array.isArray(rows)) continue;      // only touch tables present in the backup
      db.exec(`DELETE FROM ${t}`);
      for (const row of rows) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        const qs = cols.map(() => "?").join(",");
        run(`INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${qs})`, ...cols.map((c) => row[c]));
      }
      counts[t] = rows.length;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return counts;
}

export const dbFile = DB_FILE;

// One-time/idempotent data repair on boot: correct any serialized item on-hand counts that were
// double-counted under the old logic (opening qty + unit add). Safe — only changes wrong values.
try {
  const fixedQty = Inventory.recalcSerializedQty();
  if (fixedQty > 0) console.log("  >> inventory: corrected on-hand for " + fixedQty + " serialized item(s)");
} catch (e) { /* non-fatal */ }
