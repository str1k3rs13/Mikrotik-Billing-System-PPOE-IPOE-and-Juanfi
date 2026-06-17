// lib/routeros-api.js
// Zero-dependency client for the MikroTik binary API (TCP port 8728, or 8729
// with TLS). This is the classic RouterOS API protocol — length-prefixed
// "words" grouped into "sentences" — NOT the REST/JSON API.
//
// It exposes the SAME public methods as the REST client (lib/mikrotik.js) so the
// rest of the app doesn't care which transport is in use. Commands are tagged,
// so many requests can be multiplexed over a single connection (used by the
// full-sync snapshot, which fires ~23 calls at once).

import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

// ---- protocol length encoding/decoding ----------------------------------
function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) return Buffer.from([0x80 | (len >> 8), len & 0xff]);
  if (len < 0x200000) return Buffer.from([0xc0 | (len >> 16), (len >> 8) & 0xff, len & 0xff]);
  if (len < 0x10000000) return Buffer.from([0xe0 | (len >> 24), (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.from([0xf0, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

// Returns { len, next } or null if not enough bytes yet.
function readLen(buf, pos) {
  if (pos >= buf.length) return null;
  const c = buf[pos];
  if ((c & 0x80) === 0x00) return { len: c, next: pos + 1 };
  if ((c & 0xc0) === 0x80) { if (pos + 1 >= buf.length) return null; return { len: ((c & 0x3f) << 8) | buf[pos + 1], next: pos + 2 }; }
  if ((c & 0xe0) === 0xc0) { if (pos + 2 >= buf.length) return null; return { len: ((c & 0x1f) << 16) | (buf[pos + 1] << 8) | buf[pos + 2], next: pos + 3 }; }
  if ((c & 0xf0) === 0xe0) { if (pos + 3 >= buf.length) return null; return { len: ((c & 0x0f) << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3], next: pos + 4 }; }
  if (pos + 4 >= buf.length) return null;
  return { len: (buf[pos + 1] * 0x1000000) + (buf[pos + 2] << 16) + (buf[pos + 3] << 8) + buf[pos + 4], next: pos + 5 };
}

function encodeSentence(words) {
  const parts = [];
  for (const w of words) {
    const b = Buffer.from(w, "utf8");
    parts.push(encodeLength(b.length), b);
  }
  parts.push(Buffer.from([0])); // empty word terminates a sentence
  return Buffer.concat(parts);
}

function parseSentence(words) {
  const type = words[0] || "";
  const attrs = {};
  let tag = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith(".tag=")) { tag = w.slice(5); continue; }
    if (w[0] === "=") {
      const eq = w.indexOf("=", 1);
      if (eq === -1) attrs[w.slice(1)] = "";
      else attrs[w.slice(1, eq)] = w.slice(eq + 1);
    }
  }
  return { type, attrs, tag };
}

// ---- client --------------------------------------------------------------
export class RouterOSAPI {
  // Dry-run mode (set from server). When true, write commands are logged, not sent.
  static dryRun = false;
  static onDryRun = null; // optional callback(humanCommand) for logging
  constructor({ host, user, password, port = 8728, ssl = false, timeout = 8000 }) {
    this.configured = !!host;
    this.host = host || "";
    this.user = user || "";
    this.password = password || "";
    this.port = Number(port) || (ssl ? 8729 : 8728);
    this.ssl = !!ssl;
    this.timeout = timeout;

    this.sock = null;
    this.connected = false;
    this.connecting = null;
    this.inbuf = Buffer.alloc(0);
    this.curWords = [];
    this.pending = new Map();
    this.tagSeq = 0;
  }

  ensureConnected() {
    if (!this.configured) return Promise.reject(new Error("Router not configured yet — open Settings and enter your MikroTik IP, username, and password."));
    if (this.connected) return Promise.resolve();
    if (!this.connecting) this.connecting = this._connect();
    return this.connecting;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const opts = { host: this.host, port: this.port };
      let settled = false;
      const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(connectTimer); fn(arg); };

      // Explicit connect-phase guard: net.connect()'s socket.setTimeout only applies
      // once connected (idle timeout), so a wrong/unreachable IP can hang for a very
      // long time. This timer aborts the attempt cleanly.
      const connectTimer = setTimeout(() => {
        try { this.sock && this.sock.destroy(); } catch {}
        this.connected = false; this.connecting = null;
        finish(reject, new Error(`Cannot reach ${this.host}:${this.port} — connection timed out (check IP, port, and that API service is enabled on the router)`));
      }, this.timeout);

      const onConnect = async () => {
        this.connected = true;
        try {
          await this._login();
          this.connecting = null;
          finish(resolve);
        } catch (e) {
          this.connected = false;
          this.connecting = null;
          try { this.sock.destroy(); } catch {}
          finish(reject, e);
        }
      };

      this.sock = this.ssl
        ? tls.connect({ ...opts, rejectUnauthorized: false }, onConnect)
        : net.connect(opts, onConnect);

      this.sock.setTimeout(this.timeout);
      this.sock.on("timeout", () => this.sock.destroy(new Error("connection timed out")));
      this.sock.on("data", (chunk) => this._onData(chunk));
      this.sock.on("error", (e) => {
        if (!this.connected && this.connecting) {
          this.connecting = null;
          finish(reject, new Error(`Cannot connect to ${this.host}:${this.port} — ${e.message}`));
        }
        this._failAll(new Error(`socket error: ${e.message}`));
      });
      this.sock.on("close", () => {
        this.connected = false;
        this.connecting = null;
        this._failAll(new Error("connection closed"));
      });
    });
  }

  _failAll(err) {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
    this.connected = false;
  }

  _onData(chunk) {
    this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, chunk]) : chunk;
    let pos = 0;
    while (true) {
      const L = readLen(this.inbuf, pos);
      if (!L) break;
      const end = L.next + L.len;
      if (end > this.inbuf.length) break;
      if (L.len === 0) {
        this._handleSentence(this.curWords);
        this.curWords = [];
      } else {
        this.curWords.push(this.inbuf.subarray(L.next, end).toString("utf8"));
      }
      pos = end;
    }
    this.inbuf = this.inbuf.subarray(pos);
  }

  _handleSentence(words) {
    if (!words.length) return;
    const { type, attrs, tag } = parseSentence(words);

    if (type === "!fatal") {
      this._failAll(new Error("RouterOS fatal: " + (words.slice(1).join(" ") || "session closed")));
      return;
    }
    const entry = tag != null ? this.pending.get(tag) : null;
    if (!entry) return;

    if (type === "!re") {
      entry.replies.push(attrs);
    } else if (type === "!trap") {
      entry.trap = attrs.message || "command failed";
    } else if (type === "!done") {
      this.pending.delete(tag);
      if (entry.trap) entry.reject(new Error(entry.trap));
      else {
        if (attrs.ret !== undefined && entry.replies.length === 0) entry.replies.push({ ret: attrs.ret });
        entry.resolve(entry.replies);
      }
    }
  }

  // Send a command (array of words) and resolve with an array of reply rows.
  talk(words) {
    // Dry-run safety: when enabled, WRITE commands are logged but NOT sent to the router.
    // Reads (print/getall/login/done) still go through so the UI keeps working.
    if (RouterOSAPI.dryRun) {
      const cmd = (words[0] || "");
      const isWrite = /\/(add|remove|set|enable|disable|move|reset|unset)$/.test(cmd);
      if (isWrite) {
        const human = words.join(" ");
        try { (RouterOSAPI.onDryRun || (() => {}))(human); } catch {}
        // pretend it succeeded with no data
        return Promise.resolve([]);
      }
    }
    return this.ensureConnected().then(
      () =>
        new Promise((resolve, reject) => {
          const tag = String(++this.tagSeq);
          this.pending.set(tag, { replies: [], resolve, reject, trap: null });
          this.sock.write(encodeSentence([...words, ".tag=" + tag]));
        })
    );
  }

  async _login() {
    // RouterOS 6.43+ / v7: plaintext login. Older routers answer with a
    // challenge in =ret=, which we then solve with the legacy MD5 method.
    const r = await this.talk(["/login", "=name=" + this.user, "=password=" + this.password]);
    const challenge = r && r[0] && r[0].ret;
    if (challenge) {
      const md5 = crypto.createHash("md5");
      md5.update(Buffer.concat([Buffer.from([0]), Buffer.from(this.password, "utf8"), Buffer.from(challenge, "hex")]));
      await this.talk(["/login", "=name=" + this.user, "=response=00" + md5.digest("hex")]);
    }
  }

  // ---- generic menu helpers ----------------------------------------------
  print(menu, query) {
    const w = [menu + "/print"];
    if (query) for (const [k, v] of Object.entries(query)) w.push((k.startsWith("?") ? k : "?" + k) + "=" + v);
    return this.talk(w);
  }
  one(menu) { return this.print(menu).then((rows) => rows[0] || {}); }
  add(menu, attrs) { return this.talk([menu + "/add", ...this._words(attrs)]); }
  setById(menu, id, attrs) { return this.talk([menu + "/set", "=.id=" + id, ...this._words(attrs)]); }
  removeById(menu, id) { return this.talk([menu + "/remove", "=.id=" + id]); }
  _words(attrs) { return Object.entries(attrs).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `=${k}=${v}`); }

  async findId(menu, field, value) {
    const rows = await this.print(menu);
    const m = rows.find((r) => r[field] === value);
    return m ? m[".id"] : null;
  }

  // ---- PPPoe -------------------------------------------------------------
  listPppoe() { return this.print("/ppp/secret"); }
  listPppoeActive() { return this.print("/ppp/active"); }
  createPppoe({ name, password, profile = "default", comment = "", service = "pppoe" }) {
    return this.add("/ppp/secret", { name, password, profile, service: service || "pppoe", comment });
  }
  async setPppoeDisabled(name, disabled) {
    const id = await this.findId("/ppp/secret", "name", name);
    if (!id) throw new Error(`PPPoE account "${name}" not found`);
    return this.setById("/ppp/secret", id, { disabled: disabled ? "yes" : "no" });
  }
  async deletePppoe(name) {
    const id = await this.findId("/ppp/secret", "name", name);
    if (!id) throw new Error(`PPPoE account "${name}" not found`);
    return this.removeById("/ppp/secret", id);
  }
  async updatePppoe(oldName, p) {
    const id = await this.findId("/ppp/secret", "name", oldName);
    if (!id) throw new Error(`PPPoE account "${oldName}" not found`);
    const a = {};
    if (p.name) a.name = p.name;
    if (p.password) a.password = p.password;
    if (p.profile) a.profile = p.profile;
    if (p.service) a.service = p.service;
    if (p.comment != null) a.comment = p.comment;
    return this.setById("/ppp/secret", id, a);
  }
  async disconnectPppoe(name) {
    const s = (await this.listPppoeActive()).find((x) => x.name === name);
    if (!s) throw new Error(`No active PPPoE session for "${name}"`);
    return this.removeById("/ppp/active", s[".id"]);
  }

  // ---- Hotspot -----------------------------------------------------------
  listHotspotUsers() { return this.print("/ip/hotspot/user"); }
  listHotspotActive() { return this.print("/ip/hotspot/active"); }
  createHotspotUser({ name, password = "", profile = "default", limitUptime = "" }) {
    const a = { name, password, profile };
    if (limitUptime) a["limit-uptime"] = limitUptime;
    return this.add("/ip/hotspot/user", a);
  }
  async setHotspotUserDisabled(name, disabled) {
    const id = await this.findId("/ip/hotspot/user", "name", name);
    if (!id) throw new Error(`Hotspot user "${name}" not found`);
    return this.setById("/ip/hotspot/user", id, { disabled: disabled ? "yes" : "no" });
  }
  async deleteHotspotUser(name) {
    const id = await this.findId("/ip/hotspot/user", "name", name);
    if (!id) throw new Error(`Hotspot user "${name}" not found`);
    return this.removeById("/ip/hotspot/user", id);
  }
  async updateHotspotUser(oldName, p) {
    const id = await this.findId("/ip/hotspot/user", "name", oldName);
    if (!id) throw new Error(`Hotspot user "${oldName}" not found`);
    const a = {};
    if (p.name) a.name = p.name;
    if (p.password) a.password = p.password;
    if (p.profile) a.profile = p.profile;
    if (p.limitUptime != null && p.limitUptime !== "") a["limit-uptime"] = p.limitUptime;
    return this.setById("/ip/hotspot/user", id, a);
  }
  async disconnectHotspot(user) {
    const s = (await this.listHotspotActive()).find((x) => x.user === user);
    if (!s) throw new Error(`No active hotspot session for "${user}"`);
    return this.removeById("/ip/hotspot/active", s[".id"]);
  }
  createHotspotProfile({ name, rateLimit = "", sharedUsers = "", sessionTimeout = "" }) {
    const a = { name };
    if (rateLimit) a["rate-limit"] = rateLimit;
    if (sharedUsers) a["shared-users"] = String(sharedUsers);
    if (sessionTimeout) a["session-timeout"] = sessionTimeout;
    return this.add("/ip/hotspot/user/profile", a);
  }
  async updateHotspotProfile(name, p) {
    const id = await this.findId("/ip/hotspot/user/profile", "name", name);
    if (!id) throw new Error(`Hotspot profile "${name}" not found`);
    const a = {};
    if (p.rateLimit != null) a["rate-limit"] = p.rateLimit;
    if (p.sharedUsers != null && p.sharedUsers !== "") a["shared-users"] = String(p.sharedUsers);
    if (p.sessionTimeout != null) a["session-timeout"] = p.sessionTimeout;
    return this.setById("/ip/hotspot/user/profile", id, a);
  }
  createPppProfile({ name, rateLimit = "", localAddress = "", remoteAddress = "" }) {
    const a = { name };
    if (rateLimit) a["rate-limit"] = rateLimit;
    if (localAddress) a["local-address"] = localAddress;
    if (remoteAddress) a["remote-address"] = remoteAddress;
    return this.add("/ppp/profile", a);
  }
  async updatePppProfile(name, p) {
    const id = await this.findId("/ppp/profile", "name", name);
    if (!id) throw new Error(`PPP profile "${name}" not found`);
    const a = {};
    if (p.rateLimit != null) a["rate-limit"] = p.rateLimit;
    if (p.localAddress != null) a["local-address"] = p.localAddress;
    if (p.remoteAddress != null) a["remote-address"] = p.remoteAddress;
    return this.setById("/ppp/profile", id, a);
  }

  // ---- monitoring / config -----------------------------------------------
  systemResource() { return this.one("/system/resource"); }
  identity() { return this.one("/system/identity"); }
  routerboard() { return this.one("/system/routerboard"); }
  clock() { return this.one("/system/clock"); }
  interfaces() { return this.print("/interface"); }
  ipAddresses() { return this.print("/ip/address"); }
  pools() { return this.print("/ip/pool"); }
  queues() { return this.print("/queue/simple"); }
  dhcpServers() { return this.print("/ip/dhcp-server"); }
  dhcpLeases() { return this.print("/ip/dhcp-server/lease"); }
  radius() { return this.print("/radius"); }
  pppProfiles() { return this.print("/ppp/profile"); }
  pppoeServers() { return this.print("/interface/pppoe-server/server"); }
  hotspotServers() { return this.print("/ip/hotspot"); }
  hotspotServerProfiles() { return this.print("/ip/hotspot/profile"); }
  hotspotUserProfiles() { return this.print("/ip/hotspot/user/profile"); }
  hotspotIpBindings() { return this.print("/ip/hotspot/ip-binding"); }
  // DHCP lease + IP-binding management (NodeMCU/vendo onboarding)
  leaseMakeStatic(id) { return this.talk(["/ip/dhcp-server/lease/make-static", "=numbers=" + id]); }
  // ---- IPoE provisioning (static lease by MAC + rate-limit, address-list suspend) ----
  leaseAddStatic(l) {
    const w = ["/ip/dhcp-server/lease/add", "=address=" + l.address, "=mac-address=" + l.mac];
    if (l.server) w.push("=server=" + l.server);
    if (l.rateLimit) w.push("=rate-limit=" + l.rateLimit); // e.g. "5M/5M"
    if (l.comment) w.push("=comment=" + l.comment);
    if (l.lists) w.push("=address-lists=" + l.lists);
    return this.talk(w);
  }
  leaseFindByMac(mac) {
    return this.print("/ip/dhcp-server/lease", { "?mac-address": mac });
  }
  leaseRemoveByMac(mac) {
    return this.leaseFindByMac(mac).then((rows) => {
      const r = (rows || [])[0];
      return r ? this.talk(["/ip/dhcp-server/lease/remove", "=.id=" + r[".id"]]) : null;
    });
  }
  // firewall address-list (used for the suspended -> portal redirect)
  addrListAdd(list, address, comment) {
    const w = ["/ip/firewall/address-list/add", "=list=" + list, "=address=" + address];
    if (comment) w.push("=comment=" + comment);
    return this.talk(w);
  }
  addrListRemove(list, address) {
    return this.print("/ip/firewall/address-list", { "?list": list, "?address": address }).then((rows) => {
      const r = (rows || [])[0];
      return r ? this.talk(["/ip/firewall/address-list/remove", "=.id=" + r[".id"]]) : null;
    });
  }
  queueSimpleAdd(q) {
    const w = ["/queue/simple/add", "=name=" + q.name, "=target=" + q.target];
    if (q.maxLimit) w.push("=max-limit=" + q.maxLimit); // e.g. "5M/5M"
    if (q.comment) w.push("=comment=" + q.comment);
    return this.talk(w);
  }
  queueSimpleRemoveByName(name) {
    return this.print("/queue/simple", { "?name": name }).then((rows) => {
      const r = (rows || [])[0];
      return r ? this.talk(["/queue/simple/remove", "=.id=" + r[".id"]]) : null;
    });
  }
  // Web proxy access: redirect a suspended client's HTTP to the pay page.
  // Requires the web proxy + transparent-proxy NAT to already be running (as for PPPoE).
  proxyAccessAddRedirect(srcAddress, redirectTo, comment) {
    const w = ["/ip/proxy/access/add", "=src-address=" + srcAddress, "=action=deny", "=redirect-to=" + redirectTo];
    if (comment) w.push("=comment=" + comment);
    return this.talk(w);
  }
  proxyAccessRemoveBySrc(srcAddress) {
    return this.print("/ip/proxy/access", { "?src-address": srcAddress }).then((rows) => {
      // remove every matching rule (in case of dupes)
      const list = (rows || []).filter((r) => r[".id"]);
      return Promise.all(list.map((r) => this.talk(["/ip/proxy/access/remove", "=.id=" + r[".id"]])));
    });
  }
  // Per-IP firewall dst-nat redirect: this client's HTTP (port 80) -> local pay page.
  natRedirectAdd(srcAddress, toAddress, toPort, comment) {
    const w = ["/ip/firewall/nat/add", "=chain=dstnat", "=protocol=tcp", "=dst-port=80",
      "=src-address=" + srcAddress, "=action=dst-nat", "=to-addresses=" + toAddress, "=to-ports=" + String(toPort)];
    if (comment) w.push("=comment=" + comment);
    return this.talk(w);
  }
  natRedirectRemoveBySrc(srcAddress) {
    return this.print("/ip/firewall/nat", { "?src-address": srcAddress, "?chain": "dstnat" }).then((rows) => {
      const list = (rows || []).filter((r) => r[".id"]);
      return Promise.all(list.map((r) => this.talk(["/ip/firewall/nat/remove", "=.id=" + r[".id"]])));
    });
  }
  leaseSet(id, attrs) {
    const w = ["/ip/dhcp-server/lease/set", "=.id=" + id];
    if (attrs.address) w.push("=address=" + attrs.address);
    if (attrs.mac) w.push("=mac-address=" + attrs.mac);
    if (attrs.server) w.push("=server=" + attrs.server);
    if (attrs.lists != null) w.push("=address-lists=" + attrs.lists);
    if (attrs.comment != null) w.push("=comment=" + attrs.comment);
    return this.talk(w);
  }
  ipBindingAdd(b) {
    const w = ["/ip/hotspot/ip-binding/add"];
    if (b.mac) w.push("=mac-address=" + b.mac);
    if (b.address) w.push("=address=" + b.address);
    if (b.server) w.push("=server=" + b.server);
    w.push("=type=" + (b.type || "bypassed"));
    if (b.comment) w.push("=comment=" + b.comment);
    return this.talk(w);
  }
  ipBindingSet(id, b) {
    const w = ["/ip/hotspot/ip-binding/set", "=.id=" + id];
    if (b.mac != null) w.push("=mac-address=" + b.mac);
    if (b.address != null) w.push("=address=" + b.address);
    if (b.server != null) w.push("=server=" + (b.server || "all"));
    if (b.type != null) w.push("=type=" + b.type);
    return this.talk(w);
  }
  ipBindingRemove(id) { return this.talk(["/ip/hotspot/ip-binding/remove", "=.id=" + id]); }
  firewallAddressLists() { return this.print("/ip/firewall/address-list"); }
  // ---- Network provisioning (VLAN → IP → pool → DHCP → hotspot) ----
  vlans() { return this.print("/interface/vlan"); }
  vlanAdd(v) {
    const w = ["/interface/vlan/add", "=name=" + v.name, "=vlan-id=" + v.vlanId, "=interface=" + v.interface];
    if (v.comment) w.push("=comment=" + v.comment);
    return this.talk(w);
  }
  vlanRemove(id) { return this.talk(["/interface/vlan/remove", "=.id=" + id]); }
  ipAddressAdd(a) {
    const w = ["/ip/address/add", "=address=" + a.address, "=interface=" + a.interface];
    if (a.comment) w.push("=comment=" + a.comment);
    return this.talk(w);
  }
  ipAddressRemove(id) { return this.talk(["/ip/address/remove", "=.id=" + id]); }
  poolAdd(p) { return this.talk(["/ip/pool/add", "=name=" + p.name, "=ranges=" + p.ranges]); }
  poolRemove(id) { return this.talk(["/ip/pool/remove", "=.id=" + id]); }
  dhcpNetworks() { return this.print("/ip/dhcp-server/network"); }
  dhcpNetworkAdd(n) {
    const w = ["/ip/dhcp-server/network/add", "=address=" + n.address];
    if (n.gateway) w.push("=gateway=" + n.gateway);
    if (n.dns) w.push("=dns-server=" + n.dns);
    return this.talk(w);
  }
  dhcpServerAdd(d) {
    const w = ["/ip/dhcp-server/add", "=name=" + d.name, "=interface=" + d.interface, "=address-pool=" + d.pool, "=disabled=no"];
    if (d.leaseTime) w.push("=lease-time=" + d.leaseTime);
    return this.talk(w);
  }
  dhcpServerRemove(id) { return this.talk(["/ip/dhcp-server/remove", "=.id=" + id]); }
  dhcpServerSet(id, d) {
    const w = ["/ip/dhcp-server/set", "=.id=" + id];
    if (d.name != null) w.push("=name=" + d.name);
    if (d.interface != null) w.push("=interface=" + d.interface);
    if (d.pool != null) w.push("=address-pool=" + d.pool);
    if (d.leaseTime != null) w.push("=lease-time=" + d.leaseTime);
    return this.talk(w);
  }
  hotspotProfileAdd(p) {
    const w = ["/ip/hotspot/profile/add", "=name=" + p.name];
    if (p.hotspotAddress) w.push("=hotspot-address=" + p.hotspotAddress);
    if (p.dnsName) w.push("=dns-name=" + p.dnsName);
    if (p.loginBy) w.push("=login-by=" + p.loginBy);
    return this.talk(w);
  }
  hotspotProfileSet(id, p) {
    const w = ["/ip/hotspot/profile/set", "=.id=" + id];
    if (p.name != null) w.push("=name=" + p.name);
    if (p.hotspotAddress != null) w.push("=hotspot-address=" + p.hotspotAddress);
    if (p.dnsName != null) w.push("=dns-name=" + p.dnsName);
    if (p.loginBy != null) w.push("=login-by=" + p.loginBy);
    return this.talk(w);
  }
  hotspotServerAdd(h) {
    const w = ["/ip/hotspot/add", "=name=" + h.name, "=interface=" + h.interface, "=address-pool=" + h.pool, "=disabled=no"];
    if (h.profile) w.push("=profile=" + h.profile);
    if (h.addressesPerMac != null) w.push("=addresses-per-mac=" + h.addressesPerMac);
    return this.talk(w);
  }
  hotspotServerSet(id, h) {
    const w = ["/ip/hotspot/set", "=.id=" + id];
    if (h.name != null) w.push("=name=" + h.name);
    if (h.profile != null) w.push("=profile=" + h.profile);
    if (h.addressesPerMac != null) w.push("=addresses-per-mac=" + h.addressesPerMac);
    if (h.interface != null) w.push("=interface=" + h.interface);
    return this.talk(w);
  }
  hotspotServerRemove(id) { return this.talk(["/ip/hotspot/remove", "=.id=" + id]); }
  hotspotWalledGarden() { return this.print("/ip/hotspot/walled-garden"); }
  hotspotHosts() { return this.print("/ip/hotspot/host"); }
  systemLogs() { return this.print("/log"); }
  scripts() { return this.print("/system/script"); }
  schedulers() { return this.print("/system/scheduler"); }

  // ---- full snapshot (same shape as the REST client) ---------------------
  async snapshot() {
    const sections = {
      identity: () => this.identity(),
      resource: () => this.systemResource(),
      routerboard: () => this.routerboard(),
      clock: () => this.clock(),
      interfaces: () => this.interfaces(),
      ipAddresses: () => this.ipAddresses(),
      pools: () => this.pools(),
      queues: () => this.queues(),
      dhcpServers: () => this.dhcpServers(),
      dhcpLeases: () => this.dhcpLeases(),
      radius: () => this.radius(),
      pppProfiles: () => this.pppProfiles(),
      pppoeServers: () => this.pppoeServers(),
      pppoeAccounts: () => this.listPppoe(),
      pppoeActive: () => this.listPppoeActive(),
      hotspotServers: () => this.hotspotServers(),
      hotspotServerProfiles: () => this.hotspotServerProfiles(),
      hotspotUserProfiles: () => this.hotspotUserProfiles(),
      hotspotUsers: () => this.listHotspotUsers(),
      hotspotActive: () => this.listHotspotActive(),
      hotspotIpBindings: () => this.hotspotIpBindings(),
      hotspotWalledGarden: () => this.hotspotWalledGarden(),
      hotspotHosts: () => this.hotspotHosts(),
    };
    const keys = Object.keys(sections);
    const results = await Promise.allSettled(keys.map((k) => sections[k]()));
    const data = {}, errors = {};
    results.forEach((r, i) => {
      if (r.status === "fulfilled") data[keys[i]] = r.value;
      else errors[keys[i]] = r.reason?.message || String(r.reason);
    });
    return { syncedAt: new Date().toISOString(), data, errors };
  }

  close() { try { this.sock?.end(); } catch {} }
}
