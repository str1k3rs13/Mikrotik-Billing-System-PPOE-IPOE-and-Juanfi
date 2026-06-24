// lib/telegram.js — minimal Telegram Bot API client (node:https only).
// Supports sendMessage, sendPhoto (multipart), getUpdates (long-poll),
// answerCallbackQuery. baseUrl is configurable for testing.
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

function httpJson(urlStr, { method = "POST", body = null, timeout = 65000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error("bad URL")); }
    const lib = u.protocol === "http:" ? http : https;
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (data) headers["Content-Length"] = data.length;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + u.search, method, headers, timeout }, (res) => {
      let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json: j, text: d }); });
    });
    req.on("timeout", () => req.destroy(new Error("Telegram timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function multipart(urlStr, fields, file) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch { return reject(new Error("bad URL")); }
    const lib = u.protocol === "http:" ? http : https;
    const boundary = "----tg" + Date.now().toString(36);
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    if (file) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType || "application/octet-stream"}\r\n\r\n`));
      parts.push(file.buffer);
      parts.push(Buffer.from("\r\n"));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const payload = Buffer.concat(parts);
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname, method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": payload.length }, timeout: 30000 }, (res) => {
      let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on("timeout", () => req.destroy(new Error("Telegram timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export function makeClient(token, baseUrl = "https://api.telegram.org") {
  const base = `${baseUrl.replace(/\/$/, "")}/bot${token}`;
  return {
    sendMessage: (chatId, text, replyMarkup) =>
      httpJson(`${base}/sendMessage`, { body: { chat_id: chatId, text, parse_mode: "HTML", reply_markup: replyMarkup } }),
    sendPhoto: (chatId, photoBuffer, caption, replyMarkup, filename = "proof.jpg") =>
      multipart(`${base}/sendPhoto`, { chat_id: String(chatId), caption: caption || "", parse_mode: "HTML", ...(replyMarkup ? { reply_markup: JSON.stringify(replyMarkup) } : {}) },
        { field: "photo", filename, contentType: "image/jpeg", buffer: photoBuffer }),
    sendDocument: (chatId, fileBuffer, filename, caption) =>
      multipart(`${base}/sendDocument`, { chat_id: String(chatId), caption: caption || "" },
        { field: "document", filename: filename || "file.txt", contentType: "application/octet-stream", buffer: fileBuffer }),
    answerCallback: (id, text) => httpJson(`${base}/answerCallbackQuery`, { body: { callback_query_id: id, text: text || "" } }),
    editMessageText: (chatId, messageId, text) => httpJson(`${base}/editMessageText`, { body: { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" } }),
    getUpdates: (offset, timeoutSec = 50) => httpJson(`${base}/getUpdates?timeout=${timeoutSec}&offset=${offset || 0}`, { method: "GET", timeout: (timeoutSec + 10) * 1000 }),
    getMe: () => httpJson(`${base}/getMe`, { method: "GET", timeout: 10000 }),
  };
}
