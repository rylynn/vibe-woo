/**
 * Vibe Pet 同步服务 —— EdgeOne Pages Functions 版（薄封装）。
 *
 * 业务逻辑在 lib-account.js（账号体系 + 用量统计 + admin 查询），
 * 与本地测试服务 local-dev.js 共用同一份，保证行为一致。
 *
 * 部署后需在 EdgeOne 控制台完成（一次性）：
 *   1. KV 绑定：项目详情 → KV 存储 → 绑定命名空间 → 变量名 `SYNC_KV`
 *   2. 环境变量（Secret 类型）：ADMIN_USER / ADMIN_PASS —— admin 数据看板口令
 *
 * 可选环境变量：
 *   DEBUG_ERRORS = "1" —— 把内部异常摘要放进响应头 X-Pet-Sync-Error 便于排查。
 *   默认关闭：异常可能含 KV key、内部路径等信息，不应发给任意客户端。
 *
 * 路由（catch-all，支持 /api 前缀）：
 *   POST /api/register        { account, password, nick, invite_code } → { uid, token }
 *   POST /api/login           { account, password }                    → { uid, token, expires_in }
 *   POST /api/logout          Bearer token —— 吊销当前会话
 *   GET  /api/me              Bearer token
 *   POST /api/profile/pet-name / friends/add / friends/remove / heartbeat / visit / home
 *   POST /api/greet           { target } —— 打招呼（60 秒冷却）
 *   POST /api/online/random   Bearer token —— 今日随机在线用户（按日期确定性取样）
 *   GET  /api/friends         Bearer token
 *   POST /api/admin/login     { user, pass }（ADMIN_USER/ADMIN_PASS 校验）→ { token }
 *   GET  /api/admin/overview|users|user?uid=   Bearer admin token
 *   GET  /api/update/latest   匿名 —— 更新镜像清单（无发布 404，客户端回退 GitHub）
 *   GET  /api/update/pkg?v=   匿名 —— 更新镜像包字节
 *   POST /api/admin/update/pkg?v=X.Y.Z        Bearer admin token，octet-stream 包字节
 *   POST /api/admin/update/manifest           Bearer admin token，latest.json 原文
 *
 * 存储：优先使用绑定的 KV 命名空间（SYNC_KV）；
 * 未绑定时降级为进程内存 —— 仅能验证单请求，完整流程测试请用 local-dev.js。
 */

import { dispatch, CORS, statusFor } from "./lib-account.js";

const memory = new Map();
const memoryStore = {
  async get(key) {
    return memory.has(key) ? memory.get(key) : null;
  },
  async put(key, value) {
    memory.set(key, value);
  },
  async delete(key) {
    memory.delete(key);
  },
};

/**
 * EdgeOne KV → store 契约。字符串路径原样透传；二进制（更新镜像的包字节）
 * 按 CF KV 的 { type: "arrayBuffer" } 惯例尝试 —— EdgeOne Pages KV 对二进制
 * 值的支持待核实（见 docs/plans/2026-09-20-update-mirror-verification.md）：
 * 若平台不支持，发布时 put 抛错 → 500 → 镜像保持空库，客户端回退 GitHub，
 * 属设计内降级，不影响账号/好友等既有功能。
 */
function kvStore() {
  const kv = SYNC_KV;
  return {
    get: async (key, opts) =>
      opts && opts.binary
        ? kv.get(key, { type: "arrayBuffer" }).then((b) => (b ? new Uint8Array(b) : null))
        : kv.get(key),
    put: async (key, value) => {
      const v = value instanceof Uint8Array
        ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        : value;
      await kv.put(key, v);
    },
    delete: async (key) => {
      await kv.delete(key);
    },
  };
}

function store() {
  return typeof SYNC_KV === "undefined" ? memoryStore : kvStore();
}

function storageKind() {
  return typeof SYNC_KV === "undefined" ? "memory" : "kv";
}

/** 环境变量：边缘函数为全局 env 对象；Node（测试）回退 process.env。 */
function envVars() {
  if (typeof env !== "undefined" && env) return env;
  if (typeof process !== "undefined" && process.env) return process.env;
  return {};
}

/** 客户端 IP（限频用；服务端只存摘要，不存原始 IP）。 */
function clientIp(request) {
  return (
    request.headers.get("EO-Client-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown"
  );
}

/** 是否把内部异常摘要回传给客户端。默认否 —— 需要时配 DEBUG_ERRORS=1。 */
function debugErrors() {
  const v = envVars().DEBUG_ERRORS;
  return v === "1" || v === "true";
}

export async function onRequest({ request, params }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(request.url);
  let segs = Array.isArray(params.default)
    ? params.default
    : params.default
      ? [params.default]
      : [];
  // 兼容直接命中（无 /api 前缀部署）与多余空段
  segs = segs.filter(Boolean);

  let body = {};
  if (request.method === "POST") {
    if ((request.headers.get("Content-Type") || "").includes("application/octet-stream")) {
      // 更新镜像的包字节：不能过 JSON，原样转交 dispatch
      body = { __bytes: new Uint8Array(await request.arrayBuffer()) };
    } else {
      try {
        body = await request.json();
      } catch {
        body = {};
      }
    }
  }

  let result;
  try {
    result = await dispatch(store(), request.method, segs, url.searchParams, body, envVars(), {
      ip: clientIp(request),
      auth: request.headers.get("Authorization") || "",
      url: request.url,
    });
  } catch (e) {
    // 异常始终记服务端日志；仅在显式开启调试时才回传给客户端。
    console.error("[sync] dispatch failed:", e);
    result = { error: "server error", _status: 500, detail: String(e) };
  }

  const headers = { ...CORS, "X-Pet-Sync-Storage": storageKind() };
  // detail 默认丢弃（可能含 KV key、内部路径等）；仅 DEBUG_ERRORS=1 时进响应头
  if (result && result.detail !== undefined) {
    if (debugErrors()) {
      headers["X-Pet-Sync-Error"] = encodeURIComponent(result.detail).slice(0, 180);
    }
    delete result.detail;
  }

  // _status 是状态码元信息：先取状态码，再从响应体剔除
  const status = statusFor(result);
  if (result && result._status !== undefined) delete result._status;

  // __raw：更新镜像的清单/包字节 —— 绕过 JSON.stringify，按 __rawHeaders 出响应
  if (result && result.__raw !== undefined) {
    const rawHeaders = { ...CORS, ...(result.__rawHeaders || {}) };
    return new Response(result.__raw, { status, headers: rawHeaders });
  }

  return new Response(JSON.stringify(result), { status, headers });
}
