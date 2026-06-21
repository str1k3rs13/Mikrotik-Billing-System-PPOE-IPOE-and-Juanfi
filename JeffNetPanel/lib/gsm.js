// lib/gsm.js — send & receive SMS through a USB GSM dongle (your own SIM).
// Zero external deps: the dongle's modem serial port is configured with the OS
// tool (Windows `mode`, Linux `stty`) and then opened as a file.
//
// Works with dongles that expose a classic AT-command modem port (Huawei
// E3531/E303 in "modem/serial" mode, ZTE MF-series, SIM800/SIM900 USB sticks).
// HiLink-mode Huawei dongles (the ones that open 192.168.8.1) do NOT expose a
// serial port — flip them to modem mode or use a different stick.

import fs from "node:fs";
import { execFile } from "node:child_process";

function configurePort(port, baud) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("mode", [`${port}:`, `BAUD=${baud}`, "PARITY=n", "DATA=8", "STOP=1"], { shell: true }, () => resolve());
    } else {
      execFile("stty", ["-F", port, String(baud), "raw", "-echo"], () => resolve());
    }
  });
}

function winPath(port) {
  if (process.platform === "win32" && /^COM\d+$/i.test(port)) return "\\\\.\\" + port.toUpperCase();
  return port;
}

// Default transport: open the serial device as a file (read+write).
async function fileTransport(port, baud) {
  await configurePort(port, baud);
  const p = winPath(port);
  const fh = await fs.promises.open(p, "r+");
  const rs = fh.createReadStream({ autoClose: false });
  return {
    write: (buf) => fh.write(Buffer.from(buf)),
    onData: (cb) => rs.on("data", cb),
    close: async () => { try { rs.destroy(); } catch {} try { await fh.close(); } catch {} },
  };
}

export class GsmModem {
  // opts: { port, baud } ; transportFactory optional (tests inject a fake)
  constructor(opts = {}, transportFactory = fileTransport) {
    this.port = opts.port;
    this.baud = Number(opts.baud) || 115200;
    this._factory = transportFactory;
    this._t = null;
    this._buf = "";
    this._waiters = [];   // {match(line/buffer) -> bool, resolve}
    this._q = Promise.resolve(); // command serialization
  }

  async open() {
    if (this._t) return;
    if (!this.port) throw new Error("GSM port not set (e.g. COM3 or /dev/ttyUSB0)");
    this._t = await this._factory(this.port, this.baud);
    this._t.onData((chunk) => {
      this._buf += chunk.toString("utf8");
      // wake any waiter whose condition now matches the buffer
      this._waiters = this._waiters.filter((w) => {
        if (w.match(this._buf)) { w.resolve(this._buf); return false; }
        return true;
      });
    });
  }

  async close() { if (this._t) { await this._t.close(); this._t = null; } }

  _waitFor(matchFn, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (matchFn(this._buf)) return resolve(this._buf);
      const w = { match: matchFn, resolve };
      this._waiters.push(w);
      setTimeout(() => {
        const i = this._waiters.indexOf(w);
        if (i >= 0) { this._waiters.splice(i, 1); reject(new Error("modem timeout (no response) — check port/baud and that the dongle is a modem-mode stick")); }
      }, timeoutMs);
    });
  }

  // Send one AT command, wait until the buffer contains `expect` (default OK/ERROR).
  _cmd(cmd, { expect = /(\r|\n)(OK|ERROR|\+CMS ERROR.*|\+CME ERROR.*)\r?\n/, timeout = 10000, raw = false } = {}) {
    const run = async () => {
      await this.open();
      this._buf = "";
      await this._t.write(raw ? cmd : cmd + "\r");
      const out = await this._waitFor((b) => expect.test(b), timeout);
      if (/\bERROR\b|\+CMS ERROR|\+CME ERROR/.test(out) && !/\bOK\b/.test(out)) {
        throw new Error("modem error: " + out.replace(/\s+/g, " ").trim().slice(0, 160));
      }
      return out;
    };
    // serialize all commands through one queue
    this._q = this._q.then(run, run);
    return this._q;
  }

  async init() {
    await this._cmd("AT");
    await this._cmd("ATE0").catch(() => {});       // echo off
    await this._cmd('AT+CMGF=1');                   // text mode
    await this._cmd('AT+CSCS="GSM"').catch(() => {});
  }

  async signal() {
    const out = await this._cmd("AT+CSQ");
    const m = out.match(/\+CSQ:\s*(\d+)/);
    const rssi = m ? Number(m[1]) : null;           // 0..31, 99 = unknown
    return { rssi, bars: rssi == null || rssi === 99 ? null : Math.round((rssi / 31) * 5) };
  }

  async sendSms(number, text) {
    await this.init();
    const to = String(number).replace(/[\s-]/g, "");
    const body = String(text).replace(/[\x00-\x09\x0b-\x1f]/g, " ").slice(0, 765); // up to ~5 concatenated parts
    // CMGS: wait for the "> " prompt, then body + Ctrl+Z
    await this._cmd(`AT+CMGS="${to}"`, { expect: />\s?$/m, timeout: 10000 });
    const out = await this._cmd(body + "\x1a", { raw: true, expect: /(\+CMGS:\s*\d+[\s\S]*?(OK|ERROR))|(\r|\n)(ERROR|\+CMS ERROR.*)\r?\n/, timeout: 30000 });
    const m = out.match(/\+CMGS:\s*(\d+)/);
    if (!m) throw new Error("send failed: " + out.replace(/\s+/g, " ").trim().slice(0, 160));
    return { ok: true, ref: Number(m[1]) };
  }

  // Read messages. which: "REC UNREAD" (new) or "ALL".
  async readSms(which = "REC UNREAD") {
    await this.init();
    const out = await this._cmd(`AT+CMGL="${which}"`, { timeout: 15000 });
    return parseCmgl(out);
  }

  async deleteSms(index) { await this._cmd(`AT+CMGD=${Number(index)}`); }
}

// Parse +CMGL blocks: +CMGL: 3,"REC UNREAD","+639171234567",,"24/06/12,10:31:02+32"\r\nMessage text
export function parseCmgl(buffer) {
  const msgs = [];
  const lines = String(buffer).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^\+CMGL:\s*(\d+),"([^"]*)","([^"]*)"(?:,[^,]*)?,"([^"]*)"/);
    if (!h) continue;
    const text = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\+CMGL:/.test(lines[j]) || /^OK\s*$/.test(lines[j])) break;
      text.push(lines[j]); i = j;
    }
    msgs.push({ index: Number(h[1]), status: h[2], from: h[3], at: h[4], text: text.join("\n").trim() });
  }
  return msgs;
}
