#!/usr/bin/env node
// ============================================================================
// EdgeEver 邮件提醒 · 本地 SMTP 中转 (relay/server.mjs)
//
// 用途：EdgeEver 插件沙箱可能没有 Node 套接字能力，无法直连 SMTP。
// 在本机运行本脚本后，插件会通过 HTTP(仅 127.0.0.1) 把邮件交给它，由它完成 SMTP 发送。
//
// 使用：node relay/server.mjs
//   环境变量：PORT（默认 8787）、TOKEN（可选，设置后插件请求需带 x-relay-token 头）
// 然后在插件设置「本地中转地址」填 http://127.0.0.1:8787
// ============================================================================

import http from "node:http";
import net from "node:net";
import tls from "node:tls";

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.TOKEN || "";

// ---------------------------------------------------------------- SMTP 客户端 --

const b64 = (str) => Buffer.from(str, "utf8").toString("base64");
const wrap76 = (str) => (str.match(/.{1,76}/g) ?? []).join("\r\n");

class SmtpClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.pending = null;
    this.closed = false;
    this.ehloName = "edgeever-email";
    socket.on("data", (chunk) => { this.buffer += chunk.toString("utf8"); this.pump(); });
    socket.on("error", (err) => this.fail(err));
    socket.on("close", () => { this.closed = true; this.fail(new Error("连接被服务器关闭")); });
    socket.setTimeout(30000, () => { socket.destroy(); this.fail(new Error("连接空闲超时")); });
  }

  pump() {
    if (!this.pending) return;
    const idx = this.buffer.lastIndexOf("\n");
    if (idx === -1) return;
    const lines = this.buffer.slice(0, idx + 1).split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1];
    if (!/^\d{3}([ -])/.test(last)) return;
    this.buffer = this.buffer.slice(idx + 1);
    const { resolve } = this.pending;
    clearTimeout(this.pending.timer);
    this.pending = null;
    resolve({ code: parseInt(last.slice(0, 3), 10), text: lines.map((l) => l.slice(4)).join("\n") });
  }

  fail(error) {
    if (!this.pending) return;
    const { reject, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    reject(error);
  }

  readReply() {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("连接已关闭"));
      const timer = setTimeout(() => this.fail(new Error("等待服务器响应超时")), 30000);
      this.pending = { resolve, reject, timer };
      this.pump();
    });
  }

  async cmd(line, expects) {
    const allowed = Array.isArray(expects) ? expects : [expects];
    await new Promise((resolve) => this.socket.write(line + "\r\n", resolve));
    const reply = await this.readReply();
    if (!allowed.includes(reply.code)) {
      throw new Error(`SMTP ${line.split(" ")[0]} 失败（${reply.code}）：${reply.text}`);
    }
    return reply;
  }

  async startTls(host) {
    await this.cmd("STARTTLS", 220);
    const raw = this.socket;
    raw.removeAllListeners("data");
    raw.removeAllListeners("error");
    raw.removeAllListeners("close");
    raw.removeAllListeners("timeout");
    this.socket = await new Promise((resolve, reject) => {
      const secure = tls.connect({ socket: raw, servername: host, rejectUnauthorized: true }, () => resolve(secure));
      secure.once("error", reject);
    });
    this.buffer = "";
    this.socket.on("data", (chunk) => { this.buffer += chunk.toString("utf8"); this.pump(); });
    this.socket.on("error", (err) => this.fail(err));
    this.socket.on("close", () => { this.closed = true; this.fail(new Error("连接被服务器关闭")); });
    this.socket.setTimeout(30000, () => { this.socket.destroy(); this.fail(new Error("连接空闲超时")); });
    await this.cmd(`EHLO ${this.ehloName}`, 250);
  }

  async close() {
    try { await this.cmd("QUIT", 221); } catch { /* 尽力而为 */ }
    this.socket.destroy();
  }
}

const smtpSend = async (cfg) => {
  const lib = cfg.secure === "ssl" ? tls : net;
  const socket = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接 SMTP 服务器超时")), 15000);
    const s = lib.connect({ host: cfg.host, port: cfg.port }, () => { clearTimeout(timer); resolve(s); });
    s.once("error", (err) => { clearTimeout(timer); reject(new Error(`连接 ${cfg.host}:${cfg.port} 失败：${err.message}`)); });
  });
  const client = new SmtpClient(socket);
  try {
    const greeting = await client.readReply();
    if (greeting.code !== 220) throw new Error(`服务器拒绝连接（${greeting.code}）：${greeting.text}`);
    const ehlo = await client.cmd(`EHLO ${client.ehloName}`, 250);
    if (cfg.secure === "starttls") {
      if (!/starttls/i.test(ehlo.text)) throw new Error("服务器不支持 STARTTLS，请改用 ssl 或 none");
      await client.startTls(cfg.host);
    }
    if (cfg.user) {
      await client.cmd("AUTH LOGIN", 334);
      await client.cmd(b64(cfg.user), 334);
      await client.cmd(b64(cfg.pass), [235, 502]);
    }
    await client.cmd(`MAIL FROM:<${cfg.from}>`, 250);
    for (const addr of cfg.toList) await client.cmd(`RCPT TO:<${addr}>`, [250, 251]);
    await client.cmd("DATA", 354);
    const payload = cfg.mime
      .replace(/\r?\n/g, "\r\n")
      .split("\r\n")
      .map((line) => (line.startsWith(".") ? "." + line : line))
      .join("\r\n");
    await new Promise((resolve) => client.socket.write(payload + "\r\n.\r\n", resolve));
    const sent = await client.readReply();
    if (sent.code !== 250) throw new Error(`邮件被拒绝（${sent.code}）：${sent.text}`);
    await client.close();
    return sent.text;
  } catch (error) {
    try { client.socket.destroy(); } catch { /* 忽略 */ }
    throw error;
  }
};

// ---------------------------------------------------------------- MIME 构建 --

const rfc2047 = (text) => (b64(String(text ?? "")).match(/.{1,48}/g) ?? [])
  .map((chunk) => `=?UTF-8?B?${chunk}?=`).join("\r\n ");

const buildMime = ({ from, toList, subject, text, html }) => {
  const boundary = `----edgeever-email-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2, 12)}@edgeever-email>`;
  return [
    `Date: ${new Date().toUTCString()}`,
    `From: <${from}>`,
    `To: ${toList.map((addr) => `<${addr}>`).join(", ")}`,
    `Subject: ${rfc2047(subject)}`,
    "MIME-Version: 1.0",
    `Message-ID: ${messageId}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    "This is a multi-part message in MIME format.",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(text)),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(html)),
    `--${boundary}--`,
    "",
  ].join("\r\n");
};

// ---------------------------------------------------------------- HTTP 服务 --

const json = (res, code, body) => {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-relay-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) { reject(new Error("请求体过大")); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { json(res, 204, {}); return; }
  if (req.method !== "POST" || req.url.replace(/\?.*$/, "") !== "/send") {
    json(res, 404, { ok: false, error: "仅支持 POST /send" });
    return;
  }
  if (TOKEN && req.headers["x-relay-token"] !== TOKEN) {
    json(res, 401, { ok: false, error: "x-relay-token 不正确" });
    return;
  }
  try {
    const body = JSON.parse(await readBody(req));
    const toList = Array.isArray(body.to) ? body.to : String(body.to ?? "").split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
    const from = body.from || body.user;
    if (!body.host || !from || !toList.length) {
      json(res, 400, { ok: false, error: "缺少 host / from / to 字段" });
      return;
    }
    const mime = buildMime({
      from,
      toList,
      subject: body.subject || "(无主题)",
      text: body.text || "",
      html: body.html || `<pre style="font-family:inherit;">${String(body.text || "").replace(/[<>&]/g, "")}</pre>`,
    });
    const reply = await smtpSend({
      host: body.host,
      port: Number(body.port || 465),
      secure: body.secure === "starttls" ? "starttls" : body.secure === "none" ? "none" : "ssl",
      user: body.user || "",
      pass: body.pass || "",
      from,
      toList,
      mime,
    });
    console.log(`[edgeever-email-relay] 已发送: "${body.subject}" -> ${toList.join(", ")}`);
    json(res, 200, { ok: true, reply });
  } catch (error) {
    console.error(`[edgeever-email-relay] 发送失败: ${error.message}`);
    json(res, 200, { ok: false, error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[edgeever-email-relay] 监听 http://127.0.0.1:${PORT} （仅本机可访问）`);
  if (TOKEN) console.log("[edgeever-email-relay] 已启用 x-relay-token 校验");
  console.log("[edgeever-email-relay] 在 EdgeEver 邮件提醒插件设置中把「本地中转地址」填为 http://127.0.0.1:" + PORT);
});
