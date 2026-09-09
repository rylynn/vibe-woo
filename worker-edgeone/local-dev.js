/**
 * 自托管同步服务（单机 Node 版）。
 *
 * 复用与线上**完全相同**的业务逻辑（lib-account.js），只有存储换成一个
 * JSON 文件 —— 所以这里跑通的行为就是线上行为，不会出现「本地过、线上挂」。
 *
 * 两种用法：
 *
 * 1) 本地联调
 *      node worker-edgeone/local-dev.js [端口]
 *    然后在宠物「设置 → 同步服务（高级）」填 http://localhost:8787/api
 *
 * 2) 部署到自己的服务器（国内机器没备案时的可行方案）
 *      node worker-edgeone/local-dev.js 8787
 *    用 systemd 或 pm2 守护，安全组放行该端口，
 *    客户端填 http://<公网IP>:8787/api
 *    **国内云主机未备案时 80/443 会被阻断，必须用非标端口（如 8787）。**
 *
 * 环境变量：
 *   ADMIN_USER / ADMIN_PASS   admin 看板口令（不设则 /api/admin/* 整体禁用）
 *   DEBUG_ERRORS=1            把内部异常摘要放进响应头，排障用
 *   SYNC_DATA_FILE            数据文件路径（默认 worker-edgeone/.local-data.json）
 *   SYNC_HOST                 监听地址（默认 0.0.0.0，即允许外部访问）
 *
 * 自托管前要知道的三件事：
 *   - 单机单文件、没有副本 —— 数据文件要定期备份
 *   - 明文 HTTP，会话 token 在链路上可被窃听（域名备案后请改用 https）
 *   - 密码存的是 PBKDF2 哈希，但账号、昵称、宠物名是明文落盘的
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { webcrypto } from "node:crypto";

// 业务逻辑里的密码哈希（PBKDF2）、会话 token、昵称索引全靠 WebCrypto。
// Node 18 起才有全局 crypto，16 只有 node:crypto 里的 webcrypto ——
// 补上这一行，16 也能跑。低于 16 的请先升级 Node。
globalThis.crypto ??= webcrypto;
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch, CORS, statusFor } from "./edge-functions/api/lib-account.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.SYNC_DATA_FILE
  ? resolve(process.env.SYNC_DATA_FILE)
  : resolve(HERE, ".local-data.json");

/** 极简文件存储：进程内 Map 落盘，接口与 KV 一致。 */
class FileStore {
  constructor(path) {
    this.path = path;
    this.data = new Map();
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        for (const [k, v] of Object.entries(raw)) this.data.set(k, v);
      } catch {
        // 数据损坏就从头开始，测试服务不需要健壮性
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
  }

  flush() {
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.data)));
  }

  async get(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  }

  async put(key, value) {
    this.data.set(key, value);
    this.flush();
  }

  async delete(key) {
    this.data.delete(key);
    this.flush();
  }
}

const store = new FileStore(DATA_FILE);
const port = Number(process.argv[2] || 8787);
/** 默认监听所有网卡：自托管时要能被外部访问。只想本机联调就设 SYNC_HOST=127.0.0.1。 */
const HOST = process.env.SYNC_HOST || "0.0.0.0";

/** 与线上一致：内部异常摘要默认不回传，需要时 DEBUG_ERRORS=1。 */
function debugErrors() {
  const v = process.env.DEBUG_ERRORS;
  return v === "1" || v === "true";
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  let body = {};
  if (req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      body = {};
    }
  }

  // 兼容两种前缀：/api/xxx 与 /xxx
  const segs = url.pathname.split("/").filter((s) => s && s !== "api");

  let result;
  try {
    result = await dispatch(store, req.method, segs, url.searchParams, body, process.env, {
      ip: req.socket.remoteAddress || "local",
      auth: req.headers.authorization || "",
    });
  } catch (e) {
    console.error("[sync] dispatch failed:", e);
    result = { error: "server error", _status: 500, detail: String(e) };
  }

  const status = statusFor(result);
  const detail = result && result.detail;
  if (detail !== undefined) delete result.detail;
  if (result && result._status !== undefined) delete result._status;
  const out = JSON.stringify(result);

  const headers = {
    ...CORS,
    "Content-Length": Buffer.byteLength(out),
    "X-Pet-Sync-Storage": "file",
  };
  if (detail !== undefined && debugErrors()) {
    headers["X-Pet-Sync-Error"] = encodeURIComponent(String(detail)).slice(0, 180);
  }
  res.writeHead(status, headers);
  res.end(out);

  console.log(
    `${req.method} ${url.pathname} → ${status} ${out.slice(0, 90)}`,
  );
}).listen(port, HOST, () => {
  console.log(`[vibe-pet 同步服务] 监听 http://${HOST}:${port}`);
  console.log(`数据文件：${DATA_FILE}`);
  if (HOST === "127.0.0.1" || HOST === "localhost") {
    console.log(`本机联调：客户端服务地址填 http://${HOST}:${port}/api`);
  } else {
    console.log(`客户端服务地址填：http://<这台机器的IP>:${port}/api`);
    console.log("提醒：国内云主机未备案时 80/443 会被阻断，别用这两个端口");
  }
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
    console.log("提示：未设置 ADMIN_USER/ADMIN_PASS，admin 接口不可用");
  }
});
