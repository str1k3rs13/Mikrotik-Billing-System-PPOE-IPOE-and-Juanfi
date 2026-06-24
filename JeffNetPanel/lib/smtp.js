// lib/smtp.js — tiny SMTP client using only node:net / node:tls.
// Supports implicit TLS (port 465) and STARTTLS (587/25), AUTH LOGIN.
import net from "node:net";
import tls from "node:tls";

function readReply(sock) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString("utf8");
      // SMTP multiline: lines "250-..." continue, "250 ..." ends.
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        const code = parseInt(last.slice(0, 3), 10);
        resolve({ code, text: buf });
      }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const cleanup = () => { sock.removeListener("data", onData); sock.removeListener("error", onErr); };
    sock.on("data", onData);
    sock.on("error", onErr);
  });
}

function send(sock, line) { sock.write(line + "\r\n"); }

async function cmd(sock, line, okCodes) {
  if (line != null) send(sock, line);
  const r = await readReply(sock);
  if (okCodes && !okCodes.includes(r.code)) {
    throw new Error(`SMTP ${r.code}: ${r.text.trim()} (after: ${line || "greeting"})`);
  }
  return r;
}

function connect({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const sock = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => resolve(sock))
      : net.connect({ host, port }, () => resolve(sock));
    sock.setTimeout(15000, () => sock.destroy(new Error("SMTP timeout")));
    sock.once("error", reject);
  });
}

function upgradeTls(sock, host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => resolve(s));
    s.once("error", reject);
  });
}

// cfg: { host, port, secure(bool), user, pass, from }
// msg: { to, subject, html, text }
export async function sendMail(cfg, msg) {
  const port = Number(cfg.port) || (cfg.secure ? 465 : 587);
  let sock = await connect({ host: cfg.host, port, secure: !!cfg.secure });
  try {
    await cmd(sock, null, [220]);
    const ehloHost = "mikrotik-panel.local";
    await cmd(sock, `EHLO ${ehloHost}`, [250]);
    if (!cfg.secure) {
      // STARTTLS upgrade
      await cmd(sock, "STARTTLS", [220]);
      sock = await upgradeTls(sock, cfg.host);
      await cmd(sock, `EHLO ${ehloHost}`, [250]);
    }
    if (cfg.user) {
      await cmd(sock, "AUTH LOGIN", [334]);
      await cmd(sock, Buffer.from(cfg.user).toString("base64"), [334]);
      await cmd(sock, Buffer.from(cfg.pass || "").toString("base64"), [235]);
    }
    const from = cfg.from || cfg.user;
    await cmd(sock, `MAIL FROM:<${from}>`, [250]);
    await cmd(sock, `RCPT TO:<${msg.to}>`, [250, 251]);
    await cmd(sock, "DATA", [354]);
    const alt = "alt_" + Date.now().toString(36);
    const altPart =
      `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n` +
      `--${alt}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${(msg.text || "").replace(/\r?\n\./g, "\n..")}\r\n` +
      `--${alt}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${(msg.html || "").replace(/\r?\n\./g, "\n..")}\r\n` +
      `--${alt}--`;
    const atts = Array.isArray(msg.attachments) ? msg.attachments.filter((a) => a && a.buffer) : [];
    let headers, body;
    if (atts.length) {
      const mix = "mix_" + Date.now().toString(36);
      headers = [`From: ${from}`, `To: ${msg.to}`, `Subject: ${msg.subject || ""}`, "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${mix}"`].join("\r\n");
      let b = `--${mix}\r\n${altPart}\r\n`;
      for (const a of atts) {
        const b64 = a.buffer.toString("base64").replace(/(.{76})/g, "$1\r\n");
        b += `--${mix}\r\nContent-Type: ${a.contentType || "application/octet-stream"}; name="${a.filename || "file"}"\r\n` +
             `Content-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${a.filename || "file"}"\r\n\r\n${b64}\r\n`;
      }
      b += `--${mix}--`;
      body = b;
    } else {
      headers = [`From: ${from}`, `To: ${msg.to}`, `Subject: ${msg.subject || ""}`, "MIME-Version: 1.0", altPart.split("\r\n\r\n")[0]].join("\r\n");
      body = altPart.substring(altPart.indexOf("\r\n\r\n") + 4);
    }
    send(sock, headers + "\r\n\r\n" + body + "\r\n.");
    await cmd(sock, null, [250]);
    try { await cmd(sock, "QUIT", [221]); } catch {}
    sock.end();
    return { ok: true };
  } catch (e) {
    try { sock.destroy(); } catch {}
    throw e;
  }
}
