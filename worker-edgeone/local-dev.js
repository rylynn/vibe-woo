/**
 * 本机同步服务 —— 用于 KV 申请期间的功能验证。
 *
 * 复用与线上完全相同的业务逻辑（lib-sync.js），存储改为一个 JSON 文件，
 * 因此跑通的行为就是线上行为，不会出现「本地过、线上挂」。
 *
 * 用法：
 *   node worker-edgeone/local-dev.js [端口]
 *
 * 默认监听 8787。然后在宠物「好友 → 服务器」填 http://localhost:8787。
 *
 * 注意：这是测试工具，不是生产服务 —— 单机、无鉴权、明文存文件。
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch, CORS, statusFor } from "./edge-functions/api/lib-sync.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(HERE, ".local-data.json");

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
  const segs = url.pathname.split("/").filter(Boolean);
  const action = segs[segs.length - 1] || "status";

  let result;
  try {
    result = await dispatch(store, req.method, action, url.searchParams, body);
  } catch (e) {
    result = { error: String(e) };
  }

  const status = statusFor(result);
  const out = JSON.stringify(
    action === "status" && result.ok ? { ...result, storage: "file" } : result,
  );
  res.writeHead(status, {
    ...CORS,
    "Content-Length": Buffer.byteLength(out),
    "X-Pet-Sync-Storage": "file",
  });
  res.end(out);

  console.log(
    `${req.method} ${url.pathname} → ${status} ${out.slice(0, 90)}`,
  );
}).listen(port, () => {
  console.log(`[vibe-pet 本地同步服务] http://localhost:${port}`);
  console.log(`数据文件：${DATA_FILE}`);
  console.log("在宠物「好友 → 服务器」填 http://localhost:" + port);
});
