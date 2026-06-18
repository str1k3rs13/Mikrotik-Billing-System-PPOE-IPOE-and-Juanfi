// lib/watchdog.js — pure decision logic for the network watchdog.
// Kept free of I/O so it can be unit-tested exactly.

// Router reachability: alert DOWN only after `failsNeeded` consecutive failures,
// alert UP on the first success after a confirmed DOWN. Returns events to emit.
export function evalRouter(state, reachable, now, failsNeeded = 2) {
  state.lastCheck = now;
  const events = [];
  if (reachable) {
    state.fails = 0;
    if (state.up === false) {
      const downFor = state.downSince ? minutesBetween(state.downSince, now) : null;
      events.push({ type: "router-up", msg: "Router is back ONLINE" + (downFor != null ? ` (down ~${downFor} min)` : ""), at: now });
    }
    if (state.up !== true) state.up = true;
    state.downSince = null;
  } else {
    state.fails = (state.fails || 0) + 1;
    if (state.fails >= failsNeeded && state.up !== false) {
      state.up = false;
      state.downSince = now;
      events.push({ type: "router-down", msg: "ROUTER UNREACHABLE — check power/uplink at the router site", at: now });
    }
  }
  return events;
}

// Mass-offline detection: compare current online count to a rolling baseline.
// Fires once when count drops below (1 - pct/100) of baseline (baseline >= minBase),
// clears when count recovers to 80% of baseline.
export function evalMassDrop(state, onlineCount, now, { pct = 50, minBase = 5 } = {}) {
  const events = [];
  if (state.baseline == null) { state.baseline = onlineCount; return events; }
  const threshold = state.baseline * (1 - pct / 100);
  if (!state.massAlert && state.baseline >= minBase && onlineCount <= threshold) {
    state.massAlert = true;
    state.massAt = now;
    events.push({ type: "mass-drop", msg: `MASS OFFLINE: ${state.baseline} → ${onlineCount} clients online. Possible tower/fiber problem — consider declaring an outage.`, at: now, from: state.baseline, to: onlineCount });
  } else if (state.massAlert && onlineCount >= state.baseline * 0.8) {
    state.massAlert = false;
    events.push({ type: "mass-recover", msg: `Clients back online: ${onlineCount} (was ${state.baseline} before the drop)`, at: now });
    state.baseline = onlineCount;
  }
  // baseline follows normal conditions only (never while alarmed)
  if (!state.massAlert) state.baseline = Math.max(onlineCount, Math.round(state.baseline * 0.7));
  return events;
}

function minutesBetween(a, b) {
  const t1 = Date.parse(String(a).replace(" ", "T"));
  const t2 = Date.parse(String(b).replace(" ", "T"));
  if (isNaN(t1) || isNaN(t2)) return null;
  return Math.max(0, Math.round((t2 - t1) / 60000));
}

// Diff online sets → per-client state changes for last-seen tracking.
// prev: Map(username -> online bool) or null; current: Set of online usernames; all: array of usernames
export function diffClientStates(allUsers, onlineSet, prevMap) {
  const changes = [];
  for (const u of allUsers) {
    const on = onlineSet.has(u);
    const was = prevMap ? prevMap.get(u) : undefined;
    if (was === undefined || was !== on) changes.push({ username: u, online: on });
  }
  return changes;
}
