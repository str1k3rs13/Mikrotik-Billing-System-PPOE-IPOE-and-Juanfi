// lib/ai.js
// The "AI function": turns a natural-language instruction into a STRUCTURED,
// VALIDATED command. The model never emits raw RouterOS commands. It only
// chooses from a fixed whitelist of actions, and the server validates the
// result before executing anything. This is the safe way to put an LLM in
// front of network gear.
//
// Zero-dependency: calls the Anthropic Messages API directly with built-in fetch.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

// AI config comes from a provider the server sets (so the key/toggle live in Settings, not env).
// Falls back to env vars if the server never sets a provider.
let _cfgProvider = () => ({
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  model: process.env.ANTHROPIC_MODEL || MODEL,
  enabled: !!process.env.ANTHROPIC_API_KEY,
  base: process.env.AI_BASE || "https://api.anthropic.com",
});
export function setAiConfigProvider(fn) { if (typeof fn === "function") _cfgProvider = fn; }
function aiCfg() { try { return _cfgProvider() || {}; } catch { return {}; } }

// The only actions the AI is allowed to produce. Keep this list and the
// switch() in server.js in sync.
export const ALLOWED_ACTIONS = {
  list_pppoe: [],
  list_pppoe_active: [],
  create_pppoe: ["name", "password", "profile", "comment"],
  enable_pppoe: ["name"],
  disable_pppoe: ["name"],
  delete_pppoe: ["name"],
  disconnect_pppoe: ["name"],
  list_hotspot_users: [],
  list_hotspot_active: [],
  create_hotspot_user: ["name", "password", "profile", "limitUptime"],
  enable_hotspot_user: ["name"],
  disable_hotspot_user: ["name"],
  delete_hotspot_user: ["name"],
  disconnect_hotspot: ["user"],
  list_hotspot_profiles: [],
  create_hotspot_profile: ["name", "rateLimit", "sharedUsers", "sessionTimeout"],
  list_pppoe_profiles: [],
  sync_config: [],
  system_resource: [],
  interface_traffic: [],
};

const SYSTEM_PROMPT = `You are a command parser for a MikroTik RouterOS v7 control panel.
Convert the user's instruction into ONE JSON object describing the intended action.

Respond with JSON ONLY. No prose, no markdown, no code fences. Shape:
{ "action": "<action>", "params": { ... }, "explanation": "<one short sentence for the operator>" }

Allowed actions and their params:
- list_pppoe                 {}                         -> list all PPPoE accounts
- list_pppoe_active          {}                         -> list live PPPoE sessions
- create_pppoe               {name, password, profile?, comment?}
- enable_pppoe               {name}
- disable_pppoe              {name}                      -> suspend an account
- delete_pppoe               {name}
- disconnect_pppoe           {name}                      -> kick a live session, keep account
- list_hotspot_users         {}
- list_hotspot_active        {}
- create_hotspot_user        {name, password?, profile?, limitUptime?}  (limitUptime like "1d", "6h", "30m")
- enable_hotspot_user        {name}
- disable_hotspot_user       {name}
- delete_hotspot_user        {name}
- disconnect_hotspot         {user}
- list_hotspot_profiles      {}                          -> list hotspot user profiles ("packages")
- create_hotspot_profile     {name, rateLimit?, sharedUsers?, sessionTimeout?}  (rateLimit like "5M/5M", sessionTimeout like "1d")
- list_pppoe_profiles        {}                          -> list PPP profiles
- sync_config                {}                          -> pull a full snapshot of ALL router config, info and users
- system_resource            {}                          -> CPU, memory, uptime
- interface_traffic          {}                          -> per-interface throughput

Rules:
- Pick exactly ONE action. If the instruction is ambiguous, unsupported, or
  unsafe, use action "unknown" with an explanation telling the operator what to clarify.
- Never invent passwords unless the user clearly wants a new account and gives none;
  in that case set "password" to "" and mention it in the explanation.
- "kick"/"disconnect" maps to disconnect_*, NOT delete_*. "remove"/"delete" maps to delete_*.
- "suspend"/"block"/"freeze" maps to disable_*. "unblock"/"resume" maps to enable_*.
- Keep "explanation" under 20 words.`;

async function callAnthropic(system, instruction) {
  const cfg = aiCfg();
  if (!cfg.enabled || !cfg.apiKey) {
    throw new Error("AI is turned off. Enable it and add your API key in Settings.");
  }
  const res = await fetch((cfg.base || "https://api.anthropic.com") + "/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model || MODEL,
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: instruction }],
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = json?.error?.message || JSON.stringify(json);
    throw new Error(`Anthropic API error (${res.status}): ${m}`);
  }
  return (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function parseCommand(instruction) {
  const raw = await callAnthropic(SYSTEM_PROMPT, instruction);

  // Strip stray code fences just in case, then parse.
  const clean = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`Could not parse AI output as JSON: ${raw}`);
  }

  if (parsed.action === "unknown") {
    return { ok: false, reason: parsed.explanation || "Could not understand the request." };
  }

  if (!(parsed.action in ALLOWED_ACTIONS)) {
    return { ok: false, reason: `AI returned a non-whitelisted action: ${parsed.action}` };
  }

  // Drop any params the action doesn't allow.
  const allowedKeys = ALLOWED_ACTIONS[parsed.action];
  const params = {};
  for (const k of allowedKeys) {
    if (parsed.params && parsed.params[k] !== undefined) params[k] = parsed.params[k];
  }

  return { ok: true, action: parsed.action, params, explanation: parsed.explanation || "" };
}

// ---- General-purpose text generation (used for reply drafting + digests) ----
// Returns plain text. Honors a base-URL override for testing (AI_BASE).
export function aiEnabled() { const c = aiCfg(); return !!(c.enabled && c.apiKey); }

async function aiText(system, user, maxTokens = 500) {
  const cfg = aiCfg();
  if (!cfg.enabled || !cfg.apiKey) throw new Error("AI is turned off. Enable it and add your API key in Settings.");
  const base = cfg.base || process.env.AI_BASE || "https://api.anthropic.com";
  const res = await fetch(base + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: cfg.model || MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${json?.error?.message || JSON.stringify(json)}`);
  return (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// Draft a polite customer-support reply. Tagalog/Taglish aware. Returns a short SMS-length reply.
export async function draftReply({ bizName, customerName, category, message, language }) {
  const system = `You are a friendly customer-support agent for "${bizName || "a Philippine internet provider"}", a small WISP/piso-WiFi ISP in the Philippines.
Write a SHORT reply (max 2 sentences, under 320 characters) suitable for SMS.
Match the customer's language: if they wrote in Tagalog/Taglish, reply in warm conversational Tagalog; if English, reply in English.
Be polite, concrete, and reassuring. Do NOT promise specific refund amounts, exact restoration times, or make commitments you cannot keep. Do NOT invent account details.
If it is a no-internet/outage complaint, acknowledge and say it is being checked. If billing, explain politely how to pay or that you will verify. Sign off with the business name.
Reply with ONLY the message text — no quotes, no preamble.`;
  const user = `Customer: ${customerName || "(unknown)"}
Topic: ${category || "general"}
Their message: "${message || ""}"
${language ? "Preferred language: " + language : ""}`;
  return aiText(system, user, 300);
}

// Summarize the day's operations into a short plain-language digest for the operator.
export async function dailyDigest(facts) {
  const system = `You are an operations assistant for a small Philippine ISP. Given today's numbers and events, write a brief, plain-language end-of-day digest for the owner.
Use 4-6 short bullet points. Highlight what needs attention (overdue payers, outages, offline vendos, anomalies) and end with a one-line suggestion of what to follow up tomorrow. Keep it under 120 words. No fluff.`;
  return aiText(system, JSON.stringify(facts), 400);
}
