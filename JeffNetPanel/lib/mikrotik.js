// lib/mikrotik.js
// Thin client for the MikroTik RouterOS v7 REST API.
// Docs: https://help.mikrotik.com/docs/spaces/ROS/pages/47579162/REST+API
//
// RouterOS REST conventions used here:
//   GET    /rest/<menu>            -> list items
//   PUT    /rest/<menu>            -> add an item (JSON body)
//   PATCH  /rest/<menu>/<.id>      -> update an item
//   DELETE /rest/<menu>/<.id>      -> remove an item
//   POST   /rest/<menu>/<command>  -> run a command (e.g. active/remove)

import https from "node:https";

// Parse "host" or "host:port" into { hostname, port }.
function splitHost(host) {
  const [hostname, port] = String(host).split(":");
  return { hostname, port: port ? Number(port) : 443 };
}

export class MikroTik {
  constructor({ host, user, password, verifyTls = false }) {
    this.configured = !!host;
    const { hostname, port } = splitHost(host || "0.0.0.0");
    this.hostname = hostname;
    this.port = port;
    this.auth = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
    // RouterOS ships a self-signed cert; default to accepting it.
    this.rejectUnauthorized = !!verifyTls;
  }

  // Uses the https module directly so we can accept the router's self-signed
  // certificate WITHOUT disabling TLS verification globally (the built-in fetch
  // can't do per-request cert handling). This keeps the panel zero-dependency.
  request(method, path, body) {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: this.hostname,
      port: this.port,
      path: `/rest${path}`,
      method,
      rejectUnauthorized: this.rejectUnauthorized,
      headers: {
        Authorization: this.auth,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };
    if (payload) options.headers["Content-Length"] = Buffer.byteLength(payload);

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let data;
          try { data = text ? JSON.parse(text) : null; } catch { data = text; }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
          const detail = data && data.message ? data.message : text || res.statusMessage;
          reject(new Error(`RouterOS ${method} ${path} failed (${res.statusCode}): ${detail}`));
        });
      });
      req.on("error", (e) =>
        reject(new Error(`Cannot reach router at ${this.hostname}:${this.port} — ${e.message}`))
      );
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ---- helpers -----------------------------------------------------------

  // Find an item's .id by a field match (RouterOS PATCH/DELETE need the .id).
  async findId(menu, field, value) {
    const items = await this.request("GET", menu);
    const match = (items || []).find((i) => i[field] === value);
    return match ? match[".id"] : null;
  }

  // ---- PPPoE (/ppp/secret = accounts, /ppp/active = live sessions) -------

  listPppoe() {
    return this.request("GET", "/ppp/secret");
  }

  listPppoeActive() {
    return this.request("GET", "/ppp/active");
  }

  createPppoe({ name, password, profile = "default", comment = "" }) {
    return this.request("PUT", "/ppp/secret", {
      name,
      password,
      profile,
      service: "pppoe",
      comment,
    });
  }

  async setPppoeDisabled(name, disabled) {
    const id = await this.findId("/ppp/secret", "name", name);
    if (!id) throw new Error(`PPPoE account "${name}" not found`);
    return this.request("PATCH", `/ppp/secret/${id}`, { disabled: disabled ? "yes" : "no" });
  }

  async deletePppoe(name) {
    const id = await this.findId("/ppp/secret", "name", name);
    if (!id) throw new Error(`PPPoE account "${name}" not found`);
    return this.request("DELETE", `/ppp/secret/${id}`);
  }

  async updatePppoe(oldName, p) {
    const id = await this.findId("/ppp/secret", "name", oldName);
    if (!id) throw new Error(`PPPoE account "${oldName}" not found`);
    const body = {};
    if (p.name) body.name = p.name;
    if (p.password) body.password = p.password;
    if (p.profile) body.profile = p.profile;
    if (p.comment != null) body.comment = p.comment;
    return this.request("PATCH", `/ppp/secret/${id}`, body);
  }

  // Kick a live PPPoE session (does not delete the account)
  async disconnectPppoe(name) {
    const sessions = await this.listPppoeActive();
    const s = (sessions || []).find((x) => x.name === name);
    if (!s) throw new Error(`No active PPPoE session for "${name}"`);
    return this.request("POST", "/ppp/active/remove", { ".id": s[".id"] });
  }

  // ---- Hotspot (/ip/hotspot/user, /ip/hotspot/active) --------------------

  listHotspotUsers() {
    return this.request("GET", "/ip/hotspot/user");
  }

  listHotspotActive() {
    return this.request("GET", "/ip/hotspot/active");
  }

  createHotspotUser({ name, password = "", profile = "default", limitUptime = "" }) {
    const body = { name, password, profile };
    if (limitUptime) body["limit-uptime"] = limitUptime;
    return this.request("PUT", "/ip/hotspot/user", body);
  }

  async setHotspotUserDisabled(name, disabled) {
    const id = await this.findId("/ip/hotspot/user", "name", name);
    if (!id) throw new Error(`Hotspot user "${name}" not found`);
    return this.request("PATCH", `/ip/hotspot/user/${id}`, { disabled: disabled ? "yes" : "no" });
  }

  async deleteHotspotUser(name) {
    const id = await this.findId("/ip/hotspot/user", "name", name);
    if (!id) throw new Error(`Hotspot user "${name}" not found`);
    return this.request("DELETE", `/ip/hotspot/user/${id}`);
  }

  async updateHotspotUser(oldName, p) {
    const id = await this.findId("/ip/hotspot/user", "name", oldName);
    if (!id) throw new Error(`Hotspot user "${oldName}" not found`);
    const body = {};
    if (p.name) body.name = p.name;
    if (p.password) body.password = p.password;
    if (p.profile) body.profile = p.profile;
    if (p.limitUptime != null && p.limitUptime !== "") body["limit-uptime"] = p.limitUptime;
    return this.request("PATCH", `/ip/hotspot/user/${id}`, body);
  }

  async disconnectHotspot(user) {
    const sessions = await this.listHotspotActive();
    const s = (sessions || []).find((x) => x.user === user);
    if (!s) throw new Error(`No active hotspot session for "${user}"`);
    return this.request("POST", "/ip/hotspot/active/remove", { ".id": s[".id"] });
  }

  // ---- Monitoring --------------------------------------------------------

  systemResource() {
    return this.request("GET", "/system/resource");
  }

  identity() {
    return this.request("GET", "/system/identity");
  }

  interfaces() {
    // includes rx-byte / tx-byte counters per interface
    return this.request("GET", "/interface");
  }

  routerboard() { return this.request("GET", "/system/routerboard"); }
  clock() { return this.request("GET", "/system/clock"); }
  ipAddresses() { return this.request("GET", "/ip/address"); }
  pools() { return this.request("GET", "/ip/pool"); }
  queues() { return this.request("GET", "/queue/simple"); }
  dhcpServers() { return this.request("GET", "/ip/dhcp-server"); }
  dhcpLeases() { return this.request("GET", "/ip/dhcp-server/lease"); }
  radius() { return this.request("GET", "/radius"); }

  // ---- PPP config --------------------------------------------------------
  pppProfiles() { return this.request("GET", "/ppp/profile"); }
  pppoeServers() { return this.request("GET", "/interface/pppoe-server/server"); }

  // ---- Hotspot config ----------------------------------------------------
  hotspotServers() { return this.request("GET", "/ip/hotspot"); }
  systemLogs() { return this.request("GET", "/log"); }
  scripts() { return this.request("GET", "/system/script"); }
  schedulers() { return this.request("GET", "/system/scheduler"); }
  hotspotServerProfiles() { return this.request("GET", "/ip/hotspot/profile"); }
  hotspotUserProfiles() { return this.request("GET", "/ip/hotspot/user/profile"); } // "packages"
  hotspotIpBindings() { return this.request("GET", "/ip/hotspot/ip-binding"); }
  // DHCP lease + IP-binding management (NodeMCU/vendo onboarding)
  leaseMakeStatic(id) { return this.request("POST", "/ip/dhcp-server/lease/make-static", { numbers: id }); }
  leaseSet(id, a) {
    const body = {};
    if (a.address) body.address = a.address;
    if (a.mac) body["mac-address"] = a.mac;
    if (a.server) body.server = a.server;
    if (a.lists != null) body["address-lists"] = a.lists;
    if (a.comment != null) body.comment = a.comment;
    return this.request("PATCH", "/ip/dhcp-server/lease/" + encodeURIComponent(id), body);
  }
  ipBindingAdd(b) {
    const body = { type: b.type || "bypassed" };
    if (b.mac) body["mac-address"] = b.mac;
    if (b.address) body.address = b.address;
    if (b.server) body.server = b.server;
    if (b.comment) body.comment = b.comment;
    return this.request("PUT", "/ip/hotspot/ip-binding", body);
  }
  ipBindingSet(id, b) {
    const body = {};
    if (b.mac != null) body["mac-address"] = b.mac;
    if (b.address != null) body.address = b.address;
    if (b.server != null) body.server = b.server || "all";
    if (b.type != null) body.type = b.type;
    return this.request("PATCH", "/ip/hotspot/ip-binding/" + encodeURIComponent(id), body);
  }
  ipBindingRemove(id) { return this.request("DELETE", "/ip/hotspot/ip-binding/" + encodeURIComponent(id)); }
  dhcpServerSet(id, d) { const body={}; if(d.name!=null)body.name=d.name; if(d.interface!=null)body.interface=d.interface; if(d.pool!=null)body["address-pool"]=d.pool; if(d.leaseTime!=null)body["lease-time"]=d.leaseTime; return this.request("PATCH","/ip/dhcp-server/"+encodeURIComponent(id),body); }
  firewallAddressLists() { return this.request("GET", "/ip/firewall/address-list"); }
  hotspotWalledGarden() { return this.request("GET", "/ip/hotspot/walled-garden"); }
  hotspotHosts() { return this.request("GET", "/ip/hotspot/host"); }

  // Create a hotspot user profile = a bandwidth/time "package".
  createHotspotProfile({ name, rateLimit = "", sharedUsers = "", sessionTimeout = "" }) {
    const body = { name };
    if (rateLimit) body["rate-limit"] = rateLimit;          // e.g. "5M/5M"
    if (sharedUsers) body["shared-users"] = String(sharedUsers);
    if (sessionTimeout) body["session-timeout"] = sessionTimeout; // e.g. "1d"
    return this.request("PUT", "/ip/hotspot/user/profile", body);
  }
  async updateHotspotProfile(name, p) {
    const id = await this.findId("/ip/hotspot/user/profile", "name", name);
    if (!id) throw new Error(`Hotspot profile "${name}" not found`);
    const body = {};
    if (p.rateLimit != null) body["rate-limit"] = p.rateLimit;
    if (p.sharedUsers != null && p.sharedUsers !== "") body["shared-users"] = String(p.sharedUsers);
    if (p.sessionTimeout != null) body["session-timeout"] = p.sessionTimeout;
    return this.request("PATCH", `/ip/hotspot/user/profile/${id}`, body);
  }
  createPppProfile({ name, rateLimit = "", localAddress = "", remoteAddress = "" }) {
    const body = { name };
    if (rateLimit) body["rate-limit"] = rateLimit;
    if (localAddress) body["local-address"] = localAddress;
    if (remoteAddress) body["remote-address"] = remoteAddress;
    return this.request("PUT", "/ppp/profile", body);
  }
  async updatePppProfile(name, p) {
    const id = await this.findId("/ppp/profile", "name", name);
    if (!id) throw new Error(`PPP profile "${name}" not found`);
    const body = {};
    if (p.rateLimit != null) body["rate-limit"] = p.rateLimit;
    if (p.localAddress != null) body["local-address"] = p.localAddress;
    if (p.remoteAddress != null) body["remote-address"] = p.remoteAddress;
    return this.request("PATCH", `/ppp/profile/${id}`, body);
  }

  // ---- Full sync snapshot ------------------------------------------------
  // Pulls every relevant menu in parallel. Uses allSettled so a single blocked
  // menu (e.g. device-mode restrictions, or a feature not configured) does NOT
  // fail the whole sync — that section just lands in `errors`.
  async snapshot() {
    const sections = {
      identity:              () => this.identity(),
      resource:              () => this.systemResource(),
      routerboard:           () => this.routerboard(),
      clock:                 () => this.clock(),
      interfaces:            () => this.interfaces(),
      ipAddresses:           () => this.ipAddresses(),
      pools:                 () => this.pools(),
      queues:                () => this.queues(),
      dhcpServers:           () => this.dhcpServers(),
      dhcpLeases:            () => this.dhcpLeases(),
      radius:                () => this.radius(),
      pppProfiles:           () => this.pppProfiles(),
      pppoeServers:          () => this.pppoeServers(),
      pppoeAccounts:         () => this.listPppoe(),
      pppoeActive:           () => this.listPppoeActive(),
      hotspotServers:        () => this.hotspotServers(),
      hotspotServerProfiles: () => this.hotspotServerProfiles(),
      hotspotUserProfiles:   () => this.hotspotUserProfiles(),
      hotspotUsers:          () => this.listHotspotUsers(),
      hotspotActive:         () => this.listHotspotActive(),
      hotspotIpBindings:     () => this.hotspotIpBindings(),
      hotspotWalledGarden:   () => this.hotspotWalledGarden(),
      hotspotHosts:          () => this.hotspotHosts(),
    };
    const keys = Object.keys(sections);
    const results = await Promise.allSettled(keys.map((k) => sections[k]()));
    const data = {}, errors = {};
    results.forEach((r, i) => {
      const k = keys[i];
      if (r.status === "fulfilled") data[k] = r.value;
      else errors[k] = r.reason?.message || String(r.reason);
    });
    return { syncedAt: new Date().toISOString(), data, errors };
  }
}
