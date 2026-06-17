// lib/coinlog.js
// Parse a MikroTik /log entry to detect a coin-drop / sale and extract:
//   amount (1/5/10/20...), user/voucher, MAC address, vendo name.
//
// MikroTik log wording varies by the script that writes it, so this is written
// to be tolerant and is easy to tighten once we see the operator's real lines.
// A line is treated as a coin event ONLY if it both (a) looks coin-related and
// (b) yields a peso amount — this avoids turning ordinary logins into "sales".

const MAC_RE = /([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/;
const COIN_WORDS = /(coin|peso|piso|₱|\bphp\b|inserted|insert|credit|sales|sold|topup|top-?\s?up|dropped)/i;
const KNOWN_DENOMS = [1, 5, 10, 20];

function extractAmount(msg) {
  const low = msg.toLowerCase();
  // 1) explicit "<keyword> <n>"  e.g. coin: 5 / amount=10 / credit 20 / inserted 1
  let m = low.match(/(?:coin|amount|credit|inserted|insert|peso[s]?|piso|php|₱|value|denom(?:ination)?)[:=\s]*?(\d{1,4})/);
  // 2) "<n> peso" / "5php" / "₱5"
  if (!m) m = low.match(/(\d{1,4})\s*(?:peso[s]?|piso|php|₱)/);
  if (!m) m = low.match(/[₱]\s*(\d{1,4})/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function extractUser(msg) {
  const m =
    msg.match(/(?:user(?:name)?|voucher|code|account)[:=\s]+["']?([A-Za-z0-9._\-]{2,})/i) ||
    msg.match(/\bby\s+["']?([A-Za-z0-9._\-]{2,})/i) ||
    msg.match(/\bfor\s+["']?([A-Za-z0-9._\-]{2,})/i);
  return m ? m[1] : "";
}

function extractVendo(msg, vendoNames) {
  const low = msg.toLowerCase();
  // prefer matching a registered vendo name (longest first)
  const names = (vendoNames || []).filter(Boolean).slice().sort((a, b) => b.length - a.length);
  for (const vn of names) if (low.includes(vn.toLowerCase())) return vn;
  // otherwise an explicit "vendo: X" style token
  const m = msg.match(/vendo[:=\s]+["']?([A-Za-z0-9._\- ]{1,40}?)["']?(?:[,;|]|\s{2,}|$)/i);
  return m ? m[1].trim() : "";
}

function extractDevice(msg) {
  const m = msg.match(/(?:device|host(?:name)?|hostname)[:=\s]+["']?([A-Za-z0-9._\- ]{1,40}?)["']?(?:[,;|]|\s{2,}|$)/i);
  return m ? m[1].trim() : "";
}

// entry: { time, topics, message }  ->  parsed coin event or null
export function parseCoinLog(entry, vendoNames = []) {
  const msg = (entry && entry.message) || "";
  if (!msg) return null;

  // ---- Exact format from the JuanFi/Arts On-Login script ----
  // ">>Customer User: <user> - IP: <ip> - Device: <device> - Mac: <mac> inserted: <amt> Vendo: <vendo>"
  const exact = msg.match(
    /User:\s*(.+?)\s*-\s*IP:\s*(.+?)\s*-\s*Device:\s*(.+?)\s*-\s*Mac:\s*(.+?)\s*inserted:\s*(\d+(?:\.\d+)?)\s*Vendo:\s*(.+?)\s*$/i
  );
  if (exact) {
    const dev = exact[3].trim();
    const amount = Number(exact[5]);
    return {
      amount,
      knownDenom: KNOWN_DENOMS.includes(amount),
      user: exact[1].trim(),
      ip: exact[2].trim(),
      device: /^notfound$/i.test(dev) ? "" : dev,
      mac: exact[4].trim().toUpperCase(),
      vendo: exact[6].trim(),
      time: (entry && entry.time) || "",
      topics: (entry && entry.topics) || "",
      message: msg,
    };
  }

  // ---- Heuristic fallback (other / unknown log formats) ----
  if (!COIN_WORDS.test(msg)) return null;
  const amount = extractAmount(msg);
  if (amount == null) return null;
  const macM = msg.match(MAC_RE);
  return {
    amount,
    knownDenom: KNOWN_DENOMS.includes(amount),
    user: extractUser(msg),
    mac: macM ? macM[1].toUpperCase() : "",
    vendo: extractVendo(msg, vendoNames),
    device: extractDevice(msg),
    time: (entry && entry.time) || "",
    topics: (entry && entry.topics) || "",
    message: msg,
  };
}

// Stable-ish signature for dedupe across repeated log reads.
export function coinSig(entry) {
  return ((entry && entry.time) || "") + "|" + ((entry && entry.message) || "");
}
