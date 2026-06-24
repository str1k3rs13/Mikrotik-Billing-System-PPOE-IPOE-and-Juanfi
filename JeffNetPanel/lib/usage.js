// lib/usage.js — turn RouterOS /queue/simple rows into per-client usage.
// RouterOS simple-queue fields: bytes="upload/download", total-bytes="up/down" (cumulative),
// rate="up/down" (bits/s). Counters reset on reboot or when the dynamic queue is recreated.

function split2(s) {
  const a = String(s == null ? "0/0" : s).split("/");
  return [Number(a[0]) || 0, Number(a[1]) || 0];
}

// queues: array of queue rows; customers: array from Customers.list()
export function parseQueues(queues, customers) {
  const byName = new Map((customers || []).map((c) => [String(c.username || "").toLowerCase(), c]));
  const rows = (queues || []).map((q) => {
    const [up, down] = split2(q["total-bytes"] || q.bytes);
    const [rUp, rDown] = split2(q.rate);
    const cust = byName.get(String(q.name || "").toLowerCase()) || null;
    return {
      name: q.name || "",
      target: q.target || "",
      up, down, total: up + down,
      rateUp: rUp, rateDown: rDown,
      disabled: String(q.disabled) === "true",
      customer: cust ? { id: cust.id, name: cust.name, plan: cust.plan_name || "", status: cust.status } : null,
    };
  });
  rows.sort((a, b) => b.total - a.total);
  const totalUp = rows.reduce((s, r) => s + r.up, 0);
  const totalDown = rows.reduce((s, r) => s + r.down, 0);
  return { rows, totalUp, totalDown, total: totalUp + totalDown, count: rows.length };
}
