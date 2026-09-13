// ============================================================================
// EdgeEver 邮件提醒 (edgeever-email) v1.0.0
//
// 工作方式：
// 1. 扫描全部笔记（可按标签缩小范围），识别两类提醒：
//    - 待办任务：兼容 edgeever-tasks 语法，如 `- [ ] 写公告 [due:: 2026-09-10]`，
//      到「due/scheduled/start 日期 + 待办提醒时刻」发邮件；行内带时间
//      （如 [due:: 2026-09-10 14:30]）时按行内时间；支持提前量。
//    - 笔记提醒：任意非待办行含 `[remind:: 2026-09-20 09:00]` 即注册一次性提醒。
// 2. 调度器按「扫描间隔」轮询，到期即通过 SMTP 发送通知邮件，错过 24 小时内
//    的提醒会补发（标题带「补发」），更早的不再打扰。
// 3. 已发送记录写入专用笔记本下的状态笔记（重启 EdgeEver 不会重发）。
// 4. 发送通道：优先本地中转（relay/server.mjs，适合无 Node 套接字的沙箱），
//    否则若插件环境可访问 Node net/tls 则直连 SMTP（SSL / STARTTLS）。
//    默认发件人 = 收件人 = 自己（自发自收，避免进垃圾箱）。
// ============================================================================

// ------------------------------------------------------------------ 小工具 --

const MSG = (error) => (error instanceof Error ? error.message : String(error));

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const b64utf8 = (str) => {
  if (typeof Buffer !== "undefined") return Buffer.from(str, "utf8").toString("base64");
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const wrap76 = (str) => (str.match(/.{1,76}/g) ?? []).join("\r\n");

const hashKey = (str) => {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

const escapeHtml = (str) =>
  String(str ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const pad2 = (n) => String(n).padStart(2, "0");

const fmtDateTime = (date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

const splitList = (value) =>
  String(value ?? "").split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);

const splitAddresses = (value) =>
  splitList(value).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));

// 本地时区解析 "YYYY-MM-DD" / "YYYY-MM-DD HH:mm"（new Date(str) 会按 UTC 解析纯日期，须手动解析）
const parseLocalDateTime = (value) => {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(String(value ?? "").trim());
  if (!m) return null;
  const date = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0));
  return isNaN(date.getTime()) ? null : { date, hasTime: m[4] !== undefined };
};

const parseHHmm = (value) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return { h: +m[1], m: +m[2] };
};

const atTime = (date, { h, m }) => {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setHours(h, m, 0, 0);
  return copy;
};

// ---------------------------------------------------------------- 提醒解析 --

const TASK_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX/\\-])\]\s+(.*)$/;
const INLINE_FIELD_RE = /\[([A-Za-z][A-Za-z0-9_-]*)::\s*([^\]]*)\]/g;
const REMIND_FIELD_RE = /\[remind::\s*([^\]]+)\]/i;

// 解析一条待办清单行（兼容 edgeever-tasks：[ ] 待办 / [/] 进行中 / [x] 完成 / [-] 取消）
const parseTaskLine = (line) => {
  const m = TASK_LINE_RE.exec(line ?? "");
  if (!m) return null;
  const done = !(m[1] === " " || m[1] === "/");
  const fields = {};
  for (const fm of m[2].matchAll(INLINE_FIELD_RE)) {
    fields[fm[1].toLowerCase()] = fm[2].trim();
  }
  const desc = m[2].replace(/\[[A-Za-z][A-Za-z0-9_-]*::\s*[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  return { done, desc, fields };
};

// 从一篇笔记中提取提醒（待办 + [remind:: …] 字段）
const extractReminders = (meta, content, settings) => {
  const reminders = [];
  const remindTime = parseHHmm(settings.taskRemindTime) ?? { h: 8, m: 30 };
  const leadMs = Math.max(0, settings.leadMinutes) * 60000;

  for (const raw of String(content ?? "").split(/\r?\n/)) {
    const task = parseTaskLine(raw);
    if (!task) {
      // 笔记级提醒：只认非待办行上的 [remind:: …]，避免与任务日期字段混淆
      const m = REMIND_FIELD_RE.exec(raw);
      if (m) {
        const parsed = parseLocalDateTime(m[1]);
        if (parsed) {
          const when = parsed.hasTime ? parsed.date : atTime(parsed.date, remindTime);
          reminders.push({
            key: hashKey(`note|${meta.id}|${when.getTime()}`),
            type: "note",
            fire: when,
            due: when,
            title: (meta.title || "未命名笔记").trim() || "未命名笔记",
            noteId: meta.id,
            noteTitle: meta.title || "未命名笔记",
            detail: `提醒时间 ${fmtDateTime(when)}`,
          });
        }
      }
      continue;
    }
    if (task.done || !task.desc) continue;
    const dateVal = task.fields.due ?? task.fields.scheduled ?? task.fields.start;
    if (!dateVal) continue;
    const parsed = parseLocalDateTime(dateVal);
    if (!parsed) continue;
    const due = parsed.hasTime ? parsed.date : atTime(parsed.date, remindTime);
    const fire = new Date(due.getTime() - leadMs);
    const extras = [];
    if (task.fields.priority) extras.push(`优先级 ${task.fields.priority}`);
    if (task.fields.repeat) extras.push(`重复 ${task.fields.repeat}`);
    extras.push(`截止 ${fmtDateTime(due)}`);
    reminders.push({
      key: hashKey(`task|${meta.id}|${task.desc}|${fire.getTime()}`),
      type: "task",
      fire,
      due,
      title: task.desc,
      noteId: meta.id,
      noteTitle: meta.title || "未命名笔记",
      detail: extras.join(" · "),
    });
  }
  return reminders;
};

// ---------------------------------------------------------------- 设置读取 --

const resolveSetting = async (context, key, fallback) => {
  try {
    const value = await context.settings.get(key);
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  } catch {
    return fallback;
  }
};

const readSettings = async (context) => {
  const num = async (key, fallback) => {
    const value = parseInt(await resolveSetting(context, key, String(fallback)), 10);
    return isNaN(value) ? fallback : value;
  };
  return {
    host: await resolveSetting(context, "smtp-host", "smtp.qq.com"),
    port: await num("smtp-port", 465),
    secure: await resolveSetting(context, "smtp-secure", "ssl"),
    user: await resolveSetting(context, "smtp-user", ""),
    pass: await resolveSetting(context, "smtp-pass", ""),
    from: await resolveSetting(context, "mail-from", ""),
    to: await resolveSetting(context, "mail-to", ""),
    taskRemindTime: await resolveSetting(context, "task-remind-time", "08:30"),
    leadMinutes: await num("task-lead-minutes", 0),
    scanSeconds: clamp(await num("scan-interval-seconds", 60), 30, 3600),
    scanTags: await resolveSetting(context, "scan-tags", ""),
    relayUrl: await resolveSetting(context, "relay-url", ""),
    stateNotebook: await resolveSetting(context, "state-notebook", "EdgeEver 邮件提醒"),
  };
};

const settingsSig = (settings) =>
  [settings.taskRemindTime, settings.leadMinutes, settings.scanTags].join("|");

// ------------------------------------------------------------ 邮件内容构建 --

const rfc2047 = (text) => {
  const encoded = b64utf8(String(text ?? ""));
  return (encoded.match(/.{1,48}/g) ?? [])
    .map((chunk) => `=?UTF-8?B?${chunk}?=`)
    .join("\r\n ");
};

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
    wrap76(b64utf8(text)),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64utf8(html)),
    `--${boundary}--`,
    "",
  ].join("\r\n");
};

const TYPE_LABEL = { task: "待办任务", note: "笔记提醒", test: "测试邮件" };

const buildHtml = (title, rows, footer) => `
<div style="max-width:560px;margin:0 auto;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#1f2937;">
  <div style="background:#2563eb;color:#fff;padding:14px 20px;border-radius:10px 10px 0 0;font-size:15px;font-weight:600;">
    ⏰ EdgeEver 提醒
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 10px 10px;">
    <div style="font-size:17px;font-weight:600;margin-bottom:14px;">${escapeHtml(title)}</div>
    ${rows.map(([k, v]) => `
      <div style="margin:6px 0;font-size:14px;">
        <span style="display:inline-block;width:76px;color:#6b7280;">${escapeHtml(k)}</span>
        <span>${v}</span>
      </div>`).join("")}
    <div style="margin-top:18px;padding-top:12px;border-top:1px solid #f3f4f6;font-size:12px;color:#9ca3af;">
      ${escapeHtml(footer)}
    </div>
  </div>
</div>`;

// reminder → {subject, text, html}
const buildMailContent = (reminder, late) => {
  const typeLabel = TYPE_LABEL[reminder.type] ?? "提醒";
  const subject = `【EdgeEver提醒】${late ? "（补发）" : ""}${reminder.title}`.slice(0, 120);
  const rows = [
    ["类型", escapeHtml(typeLabel)],
    ["提醒时间", escapeHtml(fmtDateTime(reminder.due ?? new Date()))],
  ];
  if (reminder.detail) rows.push(["详情", escapeHtml(reminder.detail)]);
  if (reminder.noteTitle) rows.push(["来源笔记", escapeHtml(reminder.noteTitle)]);
  const footer = "本邮件由 EdgeEver 邮件提醒插件自动发送 · 自发自收不易进垃圾箱";
  const text = [
    `${reminder.title}`,
    `类型：${typeLabel}`,
    `提醒时间：${fmtDateTime(reminder.due ?? new Date())}`,
    reminder.detail ? `详情：${reminder.detail}` : "",
    reminder.noteTitle ? `来源笔记：${reminder.noteTitle}` : "",
    footer,
  ].filter(Boolean).join("\n");
  return { subject, text, html: buildHtml(reminder.title, rows, footer) };
};

const buildTestMail = (transportLabel) => {
  const now = fmtDateTime(new Date());
  const title = "EdgeEver 邮件提醒 · 测试邮件";
  const rows = [["发送时间", escapeHtml(now)], ["发送通道", escapeHtml(transportLabel)]];
  const footer = "收到这封邮件说明 SMTP 配置成功，到期的待办与笔记提醒将发送到本邮箱。";
  const text = `测试成功！\n发送时间：${now}\n发送通道：${transportLabel}\n${footer}`;
  return { subject: `【EdgeEver提醒】测试邮件（${now}）`, text, html: buildHtml(title, rows, footer) };
};

// ------------------------------------------------------------- SMTP 发送通道 --

// 在插件沙箱 / Electron 渲染进程中探测 Node 套接字能力
// 测试注入：globalThis.__esmRequire__ = require（纯 ESM 脚本无全局 require 时使用）
const getNodeRequire = () => {
  if (typeof globalThis.__esmRequire__ === "function") return globalThis.__esmRequire__;
  const candidates = [];
  try { if (typeof globalThis.require === "function") candidates.push(globalThis.require); } catch { /* 忽略 */ }
  try { if (typeof window !== "undefined" && typeof window.require === "function") candidates.push(window.require); } catch { /* 忽略 */ }
  for (const req of candidates) {
    try {
      if (typeof req("net")?.connect === "function" && typeof req("tls")?.connect === "function") return req;
    } catch { /* 沙箱禁止 require 时忽略 */ }
  }
  return null;
};

// 极简 SMTP 客户端：465 SSL 直连 / 587 STARTTLS 升级 / AUTH LOGIN，正文全程 ASCII（UTF-8 均 base64 编码）
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
    if (!/^\d{3}([ -])/.test(last)) return; // 多行回复未结束
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
    const tls = getNodeRequire()("tls");
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

const smtpSend = async (cfg, mail) => {
  const require = getNodeRequire();
  if (!require) throw new Error("当前插件沙箱不支持直连 SMTP，请运行本地中转并在设置中填写「本地中转地址」");
  const lib = cfg.secure === "ssl" ? require("tls") : require("net");
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
      if (!/starttls/i.test(ehlo.text)) throw new Error("服务器不支持 STARTTLS，请把加密方式改为 ssl 或 none");
      await client.startTls(cfg.host);
    }
    if (cfg.user) {
      await client.cmd("AUTH LOGIN", 334);
      await client.cmd(b64utf8(cfg.user), 334);
      await client.cmd(b64utf8(cfg.pass), [235, 502]);
    }
    await client.cmd(`MAIL FROM:<${cfg.from}>`, 250);
    for (const addr of cfg.toList) await client.cmd(`RCPT TO:<${addr}>`, [250, 251]);
    await client.cmd("DATA", 354);
    const payload = mail.mime
      .replace(/\r?\n/g, "\r\n")
      .split("\r\n")
      .map((line) => (line.startsWith(".") ? "." + line : line))
      .join("\r\n");
    await new Promise((resolve) => client.socket.write(payload + "\r\n.\r\n", resolve));
    const sent = await client.readReply();
    if (sent.code !== 250) throw new Error(`邮件被拒绝（${sent.code}）：${sent.text}`);
    await client.close();
    return sent;
  } catch (error) {
    try { client.socket.destroy(); } catch { /* 忽略 */ }
    throw error;
  }
};

// 本地中转（relay/server.mjs）：POST 语义字段，由中转进程完成 SMTP
const relaySend = async (relayUrl, payload) => {
  const response = await fetch(relayUrl.replace(/\/+$/, "") + "/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`本地中转发送失败：${data.error || `HTTP ${response.status}`}`);
  }
  return data;
};

const resolveTransport = (settings) => {
  if (!settings.host || !settings.user) return { mode: "none" };
  if (settings.relayUrl) return { mode: "relay" };
  if (getNodeRequire()) return { mode: "smtp" };
  return { mode: "none", reason: "插件沙箱不支持直连 SMTP，请运行 relay/server.mjs 并在设置中填写「本地中转地址」" };
};

const transportLabel = (transport) =>
  transport.mode === "relay" ? `本地中转 ${transport.label ?? ""}`.trim() : "SMTP 直连";

const sendMail = async (settings, transport, mail) => {
  const from = settings.from || settings.user;
  const toList = splitAddresses(settings.to || settings.user);
  if (!toList.length) throw new Error("收件人地址无效，请在插件设置中检查「收件人 / SMTP 账号」");
  if (transport.mode === "relay") {
    return relaySend(settings.relayUrl, {
      host: settings.host, port: settings.port, secure: settings.secure,
      user: settings.user, pass: settings.pass, from, to: toList,
      subject: mail.subject, text: mail.text, html: mail.html,
    });
  }
  const mime = buildMime({ from, toList, subject: mail.subject, text: mail.text, html: mail.html });
  return smtpSend(
    { host: settings.host, port: settings.port, secure: settings.secure, user: settings.user, pass: settings.pass, from, toList },
    { mime },
  );
};

// ------------------------------------------------------------- 发送状态记录 --

const STATE_TAG = "edgeever-email-state";
const STATE_MARKER = "<!--edgeever-email:state:v1-->";
const STATE_TITLE = "发送记录（自动维护，勿编辑）";
const MISS_WINDOW_MS = 24 * 60 * 60 * 1000; // 错过超过 24 小时的提醒不再补发
const PRUNE_MS = 14 * 24 * 60 * 60 * 1000;  // 发送记录保留 14 天

const stateStore = { loaded: false, noteId: null, sent: new Map() };

const resolveNotebook = async (context, name) => {
  const notebooks = await context.notebooks.list();
  const existing = (notebooks ?? []).find((notebook) => (notebook.name ?? "").trim() === name);
  if (existing) return existing;
  return context.notebooks.create({ name });
};

const loadState = async (context, settings) => {
  if (stateStore.loaded) return stateStore;
  try {
    const result = await context.notes.query({ tags: [STATE_TAG], limit: 5 });
    const meta = (result.notes ?? [])[0];
    if (meta) {
      const full = await context.notes.get(meta.id);
      stateStore.noteId = meta.id;
      const jsonLine = String(full.contentMarkdown ?? "").split(/\r?\n/).find((l) => l.startsWith("{"));
      if (jsonLine) {
        const parsed = JSON.parse(jsonLine);
        for (const [key, entry] of Object.entries(parsed.sent ?? {})) stateStore.sent.set(key, entry);
      }
    }
  } catch { /* 状态读取失败仅影响去重，不阻断发送 */ }
  stateStore.loaded = true;
  return stateStore;
};

const persistState = async (context, settings) => {
  const now = Date.now();
  for (const [key, entry] of stateStore.sent) {
    if (now - new Date(entry.at).getTime() > PRUNE_MS) stateStore.sent.delete(key);
  }
  const content = `${STATE_MARKER}\n${JSON.stringify({ v: 1, sent: Object.fromEntries(stateStore.sent) }, null, 0)}\n`;
  try {
    if (stateStore.noteId) {
      await context.notes.update(stateStore.noteId, { contentMarkdown: content });
    } else {
      const notebook = await resolveNotebook(context, settings.stateNotebook);
      const created = await context.notes.create({
        notebookId: notebook.id,
        title: STATE_TITLE,
        contentMarkdown: content,
        tags: [STATE_TAG],
      });
      stateStore.noteId = created.id;
    }
  } catch { /* 持久化失败时退化为仅内存去重（本次会话内不重发） */ }
};

// -------------------------------------------------------------------- 调度 --

const contentCache = new Map(); // noteId → { updated, sig, reminders }
const failCounts = new Map();   // reminder key → 连续失败次数
const lastNoticeAt = new Map(); // 限流 key → 时间戳

const throttledNotice = (context, key, message, gapMs = 5 * 60000) => {
  const now = Date.now();
  if (now - (lastNoticeAt.get(key) ?? 0) < gapMs) return;
  lastNoticeAt.set(key, now);
  try { context.ui.showNotice(message); } catch { /* 忽略 */ }
};

const collectReminders = async (context, settings) => {
  const request = { sort: "updated-desc", limit: 1000 };
  const tags = splitList(settings.scanTags);
  if (tags.length) request.tags = tags;
  const result = await context.notes.query(request);
  const metas = result.notes ?? [];
  const sig = settingsSig(settings);
  const reminders = [];
  const stale = [];
  for (const meta of metas) {
    const cached = contentCache.get(meta.id);
    if (cached && cached.updated === meta.updated && cached.sig === sig) reminders.push(...cached.reminders);
    else stale.push(meta);
  }
  const CHUNK = 8;
  for (let i = 0; i < stale.length; i += CHUNK) {
    await Promise.all(stale.slice(i, i + CHUNK).map(async (meta) => {
      try {
        const full = await context.notes.get(meta.id);
        const parsed = extractReminders(meta, full.contentMarkdown ?? "", settings);
        contentCache.set(meta.id, { updated: meta.updated, sig, reminders: parsed });
        reminders.push(...parsed);
      } catch { /* 单篇读取失败不阻断扫描，下个周期自动重试 */ }
    }));
  }
  return { reminders, total: metas.length };
};

const runTick = async (context, manual) => {
  const settings = await readSettings(context);
  const transport = resolveTransport(settings);
  if (transport.mode === "none") {
    const message = transport.reason || "邮件提醒：SMTP 尚未配置，请在插件设置中填写服务器、账号与授权码。";
    if (manual) context.ui.showNotice(message);
    else throttledNotice(context, "unconfigured", message);
    return { configured: false };
  }
  const { reminders, total } = await collectReminders(context, settings);
  const state = await loadState(context, settings);
  const now = Date.now();
  const due = reminders
    .filter((r) => r.fire.getTime() <= now && now - r.fire.getTime() <= MISS_WINDOW_MS)
    .sort((a, b) => a.fire - b.fire);
  const results = [];
  for (const reminder of due) {
    if (state.sent.has(reminder.key)) continue;
    if ((failCounts.get(reminder.key) ?? 0) >= 3) continue; // 连续失败 3 次后停止重试，避免刷屏
    const lateMinutes = Math.round((now - reminder.fire.getTime()) / 60000);
    try {
      await sendMail(settings, transport, buildMailContent(reminder, lateMinutes > 15));
      state.sent.set(reminder.key, { at: new Date(now).toISOString(), title: reminder.title });
      await persistState(context, settings);
      context.ui.showNotice(`已发送提醒邮件：${reminder.title} → ${splitAddresses(settings.to || settings.user)[0]}`);
      results.push({ ok: true, reminder });
    } catch (error) {
      failCounts.set(reminder.key, (failCounts.get(reminder.key) ?? 0) + 1);
      throttledNotice(context, `send-${reminder.key}`, `发送提醒邮件失败（${reminder.title}）：${MSG(error)}`);
      results.push({ ok: false, reminder, error });
    }
  }
  return { configured: true, total, reminders: reminders.length, results };
};

const startScheduler = (context) => {
  let timer = null;
  let initial = null;
  let ticking = false;
  let intervalMs = 60000;
  const tick = async (manual = false) => {
    if (ticking) return;
    ticking = true;
    try { return await runTick(context, manual); }
    catch (error) { throttledNotice(context, "tick", `邮件提醒扫描失败：${MSG(error)}`); }
    finally { ticking = false; }
  };
  const restart = async () => {
    if (timer) clearInterval(timer);
    const settings = await readSettings(context);
    intervalMs = settings.scanSeconds * 1000;
    timer = setInterval(() => tick(false), intervalMs);
  };
  initial = setTimeout(() => { tick(false); restart(); }, 4000);
  return {
    tick,
    restart,
    stop: () => { clearTimeout(initial); if (timer) clearInterval(timer); },
    get intervalMs() { return intervalMs; },
  };
};

// -------------------------------------------------------------------- 面板 --

const renderPanel = (context, container, shell, scheduler) => {
  const row = (left, right) => {
    const el = document.createElement("div");
    el.style.cssText = "display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(148,163,184,0.25);font-size:14px;align-items:baseline;";
    const l = document.createElement("span");
    l.style.cssText = "flex:0 0 110px;opacity:0.65;";
    l.textContent = left;
    const r = document.createElement("span");
    r.textContent = right;
    el.append(l, r);
    return el;
  };

  const sectionTitle = (text) => {
    const el = document.createElement("div");
    el.style.cssText = "font-size:15px;font-weight:600;margin:20px 0 8px 0;";
    el.textContent = text;
    return el;
  };

  const reminderItem = (reminder, statusText, statusColor) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.cssText = "display:block;width:100%;text-align:left;padding:10px 14px;margin-bottom:8px;border:1px solid rgba(148,163,184,0.45);border-radius:8px;background:transparent;cursor:pointer;font:inherit;color:inherit;";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;gap:8px;align-items:baseline;";
    const title = document.createElement("span");
    title.style.cssText = "font-weight:500;";
    title.textContent = reminder.title;
    const time = document.createElement("span");
    time.style.cssText = "font-size:12px;opacity:0.7;white-space:nowrap;";
    time.textContent = fmtDateTime(reminder.fire);
    head.append(title, time);
    const meta = document.createElement("div");
    meta.style.cssText = "font-size:12px;opacity:0.65;margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;";
    const type = document.createElement("span");
    type.textContent = TYPE_LABEL[reminder.type] ?? "提醒";
    const status = document.createElement("span");
    status.style.cssText = `color:${statusColor};`;
    status.textContent = statusText;
    meta.append(type, status);
    if (reminder.detail) {
      const detail = document.createElement("span");
      detail.textContent = reminder.detail;
      meta.append(detail);
    }
    const note = document.createElement("div");
    note.style.cssText = "font-size:12px;opacity:0.55;margin-top:2px;";
    note.textContent = `来源：${reminder.noteTitle}`;
    btn.append(head, meta, note);
    btn.addEventListener("click", async () => {
      try { await context.ui.openNote(reminder.noteId); }
      catch (error) { context.ui.showNotice(`打开笔记失败：${MSG(error)}`); }
    });
    return btn;
  };

  const render = async () => {
    container.replaceChildren();
    const settings = await readSettings(context);
    const transport = resolveTransport(settings);
    const toAddr = splitAddresses(settings.to || settings.user)[0] || "（未设置）";
    const fromAddr = settings.from || settings.user || "（未设置）";

    // 状态卡
    const card = document.createElement("div");
    card.style.cssText = "border:1px solid rgba(148,163,184,0.45);border-radius:10px;padding:8px 16px;max-width:640px;";
    card.append(
      row("发送通道", transport.mode === "none"
        ? "未就绪（未配置或沙箱不支持直连）"
        : transportLabel(transport)),
      row("SMTP 服务器", `${settings.host}:${settings.port}（${settings.secure}）`),
      row("发件人 → 收件人", `${fromAddr} → ${toAddr}`),
      row("扫描间隔", `${Math.round(scheduler.intervalMs / 1000)} 秒`),
      row("自发自收建议", "发件人 = 收件人 = 自己，最不容易进垃圾箱"),
    );
    if (transport.mode === "none" && transport.reason) {
      const hint = document.createElement("div");
      hint.style.cssText = "font-size:13px;color:#d97706;padding:8px 0 2px 0;";
      hint.textContent = transport.reason;
      card.appendChild(hint);
    }
    container.appendChild(card);

    // 提醒列表
    let data = { reminders: [], total: 0 };
    try { data = await collectReminders(context, settings); }
    catch (error) {
      const p = document.createElement("p");
      p.style.cssText = "color:#dc2626;font-size:14px;";
      p.textContent = `扫描失败：${MSG(error)}`;
      container.appendChild(p);
    }
    const state = await loadState(context, settings);
    const now = Date.now();
    const sorted = [...data.reminders].sort((a, b) => a.fire - b.fire);
    const dueNow = sorted.filter((r) => r.fire.getTime() <= now && now - r.fire.getTime() <= MISS_WINDOW_MS && !state.sent.has(r.key));
    const upcoming = sorted.filter((r) => r.fire.getTime() > now && r.fire.getTime() <= now + 14 * 86400000);
    const expired = sorted.filter((r) => now - r.fire.getTime() > MISS_WINDOW_MS && !state.sent.has(r.key));

    container.appendChild(sectionTitle(`已到期未发送（${dueNow.length}）`));
    if (dueNow.length) dueNow.forEach((r) => container.appendChild(reminderItem(r, "等待发送", "#d97706")));
    else {
      const p = document.createElement("p");
      p.style.cssText = "opacity:0.6;font-size:13px;";
      p.textContent = "没有待发送的提醒。";
      container.appendChild(p);
    }

    container.appendChild(sectionTitle(`未来 14 天（${upcoming.length}）`));
    if (upcoming.length) upcoming.forEach((r) => container.appendChild(reminderItem(r, "计划中", "#2563eb")));
    else {
      const p = document.createElement("p");
      p.style.cssText = "opacity:0.6;font-size:13px;";
      p.textContent = `在笔记中写 - [ ] 待办 [due:: 日期] 或 [remind:: 日期 时间] 即可注册提醒，当前共扫描 ${data.total} 篇笔记。`;
      container.appendChild(p);
    }

    if (expired.length) {
      container.appendChild(sectionTitle(`已过期超 24 小时（${expired.length}，不再补发）`));
      expired.slice(0, 20).forEach((r) => container.appendChild(reminderItem(r, "已过期", "#9ca3af")));
    }

    // 最近发送记录
    const history = [...state.sent.values()].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 20);
    container.appendChild(sectionTitle(`最近发送（${history.length}）`));
    if (history.length) {
      history.forEach((entry) => {
        const el = document.createElement("div");
        el.style.cssText = "font-size:13px;padding:6px 0;border-bottom:1px solid rgba(148,163,184,0.2);display:flex;justify-content:space-between;gap:12px;";
        const t = document.createElement("span");
        t.textContent = entry.title || "（未知）";
        const at = document.createElement("span");
        at.style.cssText = "opacity:0.55;white-space:nowrap;";
        at.textContent = fmtDateTime(new Date(entry.at));
        el.append(t, at);
        container.appendChild(el);
      });
    } else {
      const p = document.createElement("p");
      p.style.cssText = "opacity:0.6;font-size:13px;";
      p.textContent = "暂无发送记录。";
      container.appendChild(p);
    }

    shell.set({
      header: {
        title: "邮件提醒",
        description: `扫描 ${data.total} 篇笔记 · 到期自动发送通知邮件`,
        actions: [
          { id: "scan-now", label: "立即扫描" },
          { id: "send-test", label: "发送测试邮件" },
          { id: "refresh", label: "刷新" },
        ],
      },
      onAction: async (id) => {
        if (id === "refresh") await render();
        else if (id === "scan-now") {
          const outcome = await scheduler.tick(true);
          if (outcome?.configured) {
            const sent = (outcome.results ?? []).filter((r) => r.ok).length;
            context.ui.showNotice(`扫描完成：${outcome.reminders} 条提醒，本次发送 ${sent} 封。`);
          }
          await render();
        } else if (id === "send-test") {
          await sendTestMail(context);
          await render();
        }
      },
    });
  };

  return render();
};

const sendTestMail = async (context) => {
  try {
    const settings = await readSettings(context);
    const transport = resolveTransport(settings);
    if (transport.mode === "none") {
      context.ui.showNotice(transport.reason || "邮件提醒：请先在插件设置中完成 SMTP 配置。");
      return false;
    }
    await sendMail(settings, transport, buildTestMail(transportLabel(transport)));
    context.ui.showNotice(`测试邮件已发送到 ${splitAddresses(settings.to || settings.user)[0]}，请查收（注意垃圾箱）。`);
    return true;
  } catch (error) {
    context.ui.showNotice(`测试邮件发送失败：${MSG(error)}`);
    return false;
  }
};

// ---------------------------------------------------------------- activate --

export default {
  activate(context) {
    const scheduler = startScheduler(context);

    const disposePanel = context.ui.panels.register({
      id: "email-reminders",
      title: "邮件提醒",
      purpose: "dashboard",
      presentation: "fullscreen",
      async mount(container, { state, shell }) {
        await renderPanel(context, container, shell, scheduler);
      },
    });

    const disposeOpen = context.commands.register({
      id: "open-panel",
      title: "打开邮件提醒面板",
      async run() { await context.ui.panels.open("email-reminders"); },
    });

    const disposeTest = context.commands.register({
      id: "send-test",
      title: "发送测试邮件",
      async run() { await sendTestMail(context); },
    });

    const disposeScan = context.commands.register({
      id: "scan-now",
      title: "立即扫描并发送到期提醒",
      listed: false,
      async run() {
        const outcome = await scheduler.tick(true);
        if (outcome?.configured) {
          const sent = (outcome.results ?? []).filter((r) => r.ok).length;
          context.ui.showNotice(`扫描完成：${outcome.reminders} 条提醒，本次发送 ${sent} 封。`);
        }
      },
    });

    const disposeInsert = context.commands.register({
      id: "insert-remind-field",
      title: "在光标处插入提醒字段（1 小时后）",
      listed: false,
      async run() {
        const target = new Date(Date.now() + 60 * 60 * 1000);
        try {
          await context.editor.insertAtCursor(`[remind:: ${fmtDateTime(target)}]`);
        } catch (error) {
          context.ui.showNotice(`插入提醒字段失败：${MSG(error)}`);
        }
      },
    });

    return () => {
      scheduler.stop();
      disposePanel();
      disposeOpen();
      disposeTest();
      disposeScan();
      disposeInsert();
    };
  },
};

// 供测试脚本复用（宿主仅使用 default 导出）
export { parseLocalDateTime, parseTaskLine, extractReminders, buildMime, smtpSend, relaySend };
