// lib/anomaly.js — pure detection logic for the smart-automation pack.
// No I/O so it can be unit-tested exactly. The server feeds it numbers.

// ---- Coin-drop anomaly detection (per vendo) ----
// events: [{ at, amount }] newest-or-any order; we sort. Returns alerts[].
// Detects: (1) a single drop far above this vendo's normal coin size,
//          (2) a burst of coins in a short window (possible jammed acceptor
//              repeatedly firing, or someone gaming the slot),
//          (3) a long stall during active hours (acceptor jammed / coins
//              being diverted = lost income).
export function coinAnomalies(events, opts = {}) {
  const {
    spikeFactor = 4,      // single drop > spikeFactor × median denomination
    minSamples = 8,       // need this many past drops before judging "normal"
    burstWindowMin = 3,   // minutes
    burstCount = 8,       // this many drops inside the window = burst
    stallHours = 6,       // no coins for this long…
    activeFromHour = 6,   // …between these local hours = suspicious
    activeToHour = 23,
    nowMs = Date.now(),
  } = opts;
  const alerts = [];
  const ev = (events || [])
    .map((e) => ({ t: Date.parse(String(e.at).replace(" ", "T")), a: Number(e.amount) || 0 }))
    .filter((e) => !isNaN(e.t))
    .sort((x, y) => x.t - y.t);
  if (!ev.length) return alerts;

  // (1) oversized single drop vs median denomination
  if (ev.length >= minSamples) {
    const amts = ev.map((e) => e.a).filter((a) => a > 0).sort((a, b) => a - b);
    const median = amts.length ? amts[Math.floor(amts.length / 2)] : 0;
    const last = ev[ev.length - 1];
    if (median > 0 && last.a >= median * spikeFactor && last.a >= median + 20) {
      alerts.push({ type: "coin-spike", severity: "warn", amount: last.a, normal: median,
        msg: `Unusually large coin drop: ₱${last.a} (typical is ₱${median}). Check the coin slot / for tampering.` });
    }
  }

  // (2) burst: many drops within a short rolling window
  const winMs = burstWindowMin * 60000;
  let maxInWin = 0;
  for (let i = 0; i < ev.length; i++) {
    let c = 0;
    for (let j = i; j < ev.length && ev[j].t - ev[i].t <= winMs; j++) c++;
    if (c > maxInWin) maxInWin = c;
  }
  if (maxInWin >= burstCount) {
    alerts.push({ type: "coin-burst", severity: "warn", count: maxInWin, windowMin: burstWindowMin,
      msg: `Coin burst: ${maxInWin} drops within ${burstWindowMin} min. Possible stuck acceptor or abuse — verify the machine.` });
  }

  // (3) stall during active hours
  const last = ev[ev.length - 1];
  const idleMin = (nowMs - last.t) / 60000;
  const hr = new Date(nowMs).getHours();
  if (idleMin >= stallHours * 60 && hr >= activeFromHour && hr <= activeToHour && ev.length >= minSamples) {
    alerts.push({ type: "coin-stall", severity: "info", idleHours: Math.round(idleMin / 60),
      msg: `No coins for ~${Math.round(idleMin / 60)}h during active hours. Coin acceptor may be jammed or unplugged (lost income).` });
  }
  return alerts;
}

// ---- Cumulative-total tamper detection ----
// A vendo's lifetime coin/sales counter should only go UP between your
// collections. A decrease you didn't trigger = reset/tamper/theft signal.
// prev/cur are the last two reported totals; collectedSince true if you did a
// collection in between (then a drop is expected and ignored).
export function totalDropTamper(prev, cur, { collectedSince = false, minDrop = 20 } = {}) {
  if (prev == null || cur == null) return null;
  if (collectedSince) return null;
  const drop = prev - cur;
  if (drop >= minDrop) {
    return { type: "total-drop", severity: "alert", from: prev, to: cur, drop,
      msg: `Counter DROPPED ₱${prev} → ₱${cur} without a collection. Possible reset/tampering or theft — check the vendo.` };
  }
  return null;
}

// ---- Smart fault triage: which tower do the offline clients share? ----
// offline: [{ username, nap_id }] ; naps: [{ id, name, clients }]
// Returns the dominant NAP if a clear majority of the drop is on one tower.
export function triageMassDrop(offline, naps, { dominance = 0.6, minOffline = 3 } = {}) {
  const off = offline || [];
  if (off.length < minOffline) return null;
  const byNap = new Map();
  let withNap = 0;
  for (const c of off) {
    if (c.nap_id == null) continue;
    withNap++;
    byNap.set(c.nap_id, (byNap.get(c.nap_id) || 0) + 1);
  }
  if (!withNap) return null;
  let topId = null, topN = 0;
  for (const [id, n] of byNap) if (n > topN) { topN = n; topId = id; }
  if (topN / off.length >= dominance) {
    const nap = (naps || []).find((n) => n.id === topId);
    return { nap_id: topId, name: nap ? nap.name : "tower #" + topId, count: topN, of: off.length };
  }
  return null;
}
