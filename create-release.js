#!/usr/bin/env node
// EdgeEver 邮件提醒 · 创建 / 更新 GitHub Release（v1.0.0+）
//
// 需要凭据（三选一，优先级从高到低）：
//   1. 环境变量 GITHUB_TOKEN（repo 权限）
//   2. 环境变量 GH_TOKEN
//   3. 命令行参数 node create-release.js <token>
//
// 只推 tag 不够——EdgeEver 插件安装依赖 Release 附件里的 zip，必须走 API 创建 Release 并上传附件。
// 用法：node create-release.js [token] [--dry-run]

const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const zlib = require("node:zlib");

// 本脚本放在插件根目录（与 manifest.json 同级），ROOT 就是 __dirname
const ROOT = path.resolve(__dirname);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const TAG = `v${MANIFEST.version}`;
const OWNER = "zwjdujin";
const REPO = "edgeever-email";
const ZIP = path.join(ROOT, `edgeever-email-${MANIFEST.version}.zip`);

const token = process.argv[2] || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const dryRun = process.argv.includes("--dry-run");
if (!token) {
  console.error("❌ 缺少 GitHub token。请按以下方式之一提供：");
  console.error("   node create-release.js <token>");
  console.error("   GITHUB_TOKEN=ghp_... node create-release.js");
  console.error("   GH_TOKEN=ghp_... node create-release.js");
  process.exit(1);
}

const enc = (s) => Buffer.from(s, "utf8");

// --------------------------------------------------------------- GitHub API --
// api(method, path, { json, raw }) -> { status, body }
const api = async (method, path, opts = {}) => {
  let body = null;
  let headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "edgeever-email-release",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.json !== undefined) {
    body = enc(JSON.stringify(opts.json));
    headers["Content-Type"] = "application/json";
  } else if (opts.raw) {
    body = opts.raw;
    headers["Content-Type"] = opts.contentType || "application/octet-stream";
  }
  if (headers["Content-Type"] === undefined) delete headers["Content-Type"];

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.github.com",
      path: path.startsWith("/") ? path : `/${path}`,
      method,
      headers: { ...headers, "Content-Length": body ? String(body.length) : undefined },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode,
          body: (() => {
            try { return JSON.parse(text); } catch { return text; }
          })(),
        });
      });
    });
    req.on("error", (err) => reject(new Error(`请求失败: ${err.message}`)));
    if (body) req.write(body);
    req.end();
  });
};

// 请求失败（无 token/网络）按"不存在"处理，让后续进入新建分支并自然报错
const is404 = (res) => !res || res.status === 404;

// ----------------------------------------------------------------- 本地 zip --
// 仅 deflate + local file header / central directory / EOCD，满足 GitHub 附件上传即可
const buildZip = (entries) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate());

  const crc32 = (data) => {
    const table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c >>> 0;
      }
      return t;
    })();
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };

  for (const entry of entries) {
    const data = fs.readFileSync(entry.src);
    const name = enc(entry.name);
    const compressed = zlib.deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const fh = Buffer.alloc(30);
    fh.writeUInt32LE(0x04034b50, 0); fh.writeUInt16LE(20, 4); fh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    fh.writeUInt16LE(method, 8); fh.writeUInt16LE(dosTime, 10); fh.writeUInt16LE(dosDate, 12);
    fh.writeUInt32LE(crc, 14); fh.writeUInt32LE(payload.length, 18); fh.writeUInt32LE(data.length, 22);
    fh.writeUInt16LE(name.length, 26); fh.writeUInt16LE(0, 28);
    const local = Buffer.concat([fh, name, payload]);
    locals.push(local);

    // central directory 字段偏移与 local header 不同（各多 2 字节），须单独写
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(3, 4);   // version made by (Unix)
    cd.writeUInt16LE(20, 6);  // version needed to extract
    cd.writeUInt16LE(0x0800, 8);  // UTF-8 文件名
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);  // extra field
    cd.writeUInt16LE(0, 32);  // comment
    cd.writeUInt16LE(0, 34);  // disk start
    cd.writeUInt16LE(0, 36);  // internal attrs
    cd.writeUInt32LE(0, 38);  // external attrs
    cd.writeUInt16LE(offset, 42); // local header offset
    centrals.push(Buffer.concat([cd, name]));

    offset += local.length;
  }

  const centralOffset = offset;
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(centralOffset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, central, eocd]);
};

// ------------------------------------------------------------------- 主流程 --
(async () => {
  console.log(`📦 ${MANIFEST.name} v${MANIFEST.version} — 准备发布`);
  console.log(`   仓库 : https://github.com/${OWNER}/${REPO}`);
  console.log(`   标签 : ${TAG}`);
  console.log(`   附件 : ${path.basename(ZIP)}`);
  console.log(`   模式 : ${dryRun ? "仅预览（不写磁盘、不调 API）" : "正式发布"}`);
  console.log("");

  const entries = [
    { src: path.join(ROOT, "main.js"), name: "main.js" },
    { src: path.join(ROOT, "manifest.json"), name: "manifest.json" },
    { src: path.join(ROOT, "README.md"), name: "README.md" },
    { src: path.join(ROOT, "relay", "server.mjs"), name: "relay/server.mjs" },
  ];
  for (const f of entries) {
    if (!fs.existsSync(f.src)) throw new Error(`附件缺失: ${f.name}`);
  }

  // --- 1. 本地 tag ---
  const tagOut = execSync(`git tag -l ${TAG}`, { cwd: ROOT, encoding: "utf8" }).trim();
  if (tagOut !== TAG) {
    console.log(`1️⃣  创建本地标签 ${TAG}`);
    if (dryRun) console.log("   （--dry-run 跳过）");
    else execSync(`git tag -a ${TAG} -m "Release ${MANIFEST.version}"`, { cwd: ROOT, stdio: "inherit" });
  } else { console.log(`1️⃣  本地标签 ${TAG} 已存在，跳过`); }

  // --- 2. 推送 tag ---
  console.log(`2️⃣  推送标签 ${TAG}`);
  if (dryRun) console.log("   （--dry-run 跳过）");
  else execSync(`git push origin ${TAG}`, { cwd: ROOT, stdio: "inherit" });

  // --- 3. 打包 zip ---
  console.log("3️⃣  打包 Release 附件");
  if (dryRun) {
    const total = entries.reduce((a, f) => a + fs.statSync(f.src).size, 0);
    console.log(`   （--dry-run 跳过打包，预估 ${total / 1024} KB）`);
  } else {
    fs.writeFileSync(ZIP, buildZip(entries));
    console.log(`   ✅ ${ZIP} (${Math.round(fs.statSync(ZIP).size / 1024)} KB)`);
  }

  // --- 4. 创建 / 更新 Release ---
  console.log("4️⃣  创建 / 更新 GitHub Release");
  let existing;
  try { existing = await api("GET", `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`); } catch (err) { existing = null; }
  const found = !is404(existing) && existing.status === 200 && existing.body?.id;

  const releaseBody = [
    `## ${MANIFEST.name} v${MANIFEST.version}`,
    "",
    MANIFEST.description,
    "",
    "### 功能",
    "- 待办提醒：兼容 edgeever-tasks 语法，`- [ ] 任务 [due:: 日期]` 到期自动发邮件",
    "- 笔记提醒：正文写 `[remind:: 日期 时间]`，到点以笔记标题发通知邮件",
    "- SMTP 发信：465 SSL / 587 STARTTLS / AUTH LOGIN，或 relay/server.mjs 本地中转",
    "- 自发自收：默认发件人 = 收件人 = 自己，避免进垃圾箱",
    "- 已发送记录存入状态笔记，重启 EdgeEver 不重发",
    "",
    "### 安装",
    `在 EdgeEver 插件市场安装，或下载本 Release 附件 \`edgeever-email-${MANIFEST.version}.zip\` 后从「本地安装」导入。`,
  ].join("\n");

  let release = found ? existing.body : null;
  if (release) {
    console.log(`   已存在 Release (id ${release.id})，更新描述与附件`);
    if (dryRun) console.log("   （--dry-run 跳过 PATCH）");
    else await api("PATCH", `/repos/${OWNER}/${REPO}/releases/${release.id}`, { json: { name: `${MANIFEST.name} ${MANIFEST.version}`, body: releaseBody } });
  } else {
    console.log("   新建 Release");
    if (dryRun) {
      console.log("   （--dry-run 跳过 POST）");
      // 模拟一个 release id 以便展示后续步骤，不实际调用 API
      release = { id: "<dry-run placeholder>" };
    } else {
      const created = await api("POST", `/repos/${OWNER}/${REPO}/releases`, {
        json: { tag_name: TAG, name: `${MANIFEST.name} ${MANIFEST.version}`, body: releaseBody, draft: false, prerelease: false },
      });
      if (created.status !== 201) throw new Error(`创建 Release 失败 HTTP ${created.status}: ${JSON.stringify(created.body).slice(0, 400)}`);
      release = created.body;
    }
  }

  // --- 5. 上传附件 ---
  if (!dryRun && release) {
    const assets = await api("GET", `/repos/${OWNER}/${REPO}/releases/${release.id}/assets`);
    const old = (assets.body || []).find((a) => a.name === path.basename(ZIP));
    if (old) {
      console.log(`   附件 ${old.name} 已存在（id ${old.id}），先删除旧版`);
      const del = await api("DELETE", `/repos/${OWNER}/${REPO}/releases/assets/${old.id}`);
      if (del.status !== 204) throw new Error(`删除旧附件失败 HTTP ${del.status}`);
    }

    const fileData = fs.readFileSync(ZIP);
    const boundary = "----edgeever";
    const payload = Buffer.concat([
      enc(`--${boundary}\r\n`),
      enc('Content-Disposition: form-data; name="name"\r\n\r\n'),
      enc(`${path.basename(ZIP)}\r\n`),
      enc(`--${boundary}\r\n`),
      enc(`Content-Disposition: form-data; name="file"; filename="${path.basename(ZIP)}"\r\n`),
      enc("Content-Type: application/zip\r\n\r\n"),
      fileData,
      enc(`\r\n--${boundary}--\r\n`),
    ]);
    console.log(`5️⃣  上传附件 ${path.basename(ZIP)} (${Math.round(fileData.length / 1024)} KB)`);
    const upload = await api("POST", `/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(path.basename(ZIP))}`, {
      raw: payload,
      contentType: `multipart/form-data; boundary=${boundary}`,
    });
    if (upload.status !== 201) throw new Error(`上传附件失败 HTTP ${upload.status}: ${JSON.stringify(upload.body).slice(0, 400)}`);
    console.log(`   ✅ 附件已上传：${upload.body.browser_download_url}`);
  }

  console.log("");
  console.log("✅ 发布完成");
  console.log(`   标签   : https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
  console.log(`   Release: https://github.com/${OWNER}/${REPO}/releases/latest`);
  if (dryRun) console.log("（--dry-run 模式：未实际调用 GitHub API）");
})();