/**
 * Vibe Pet 同步服务 —— Cloudflare Worker 版（薄封装）。
 *
 * 业务逻辑与 EdgeOne 版共用同一份 `lib-account.js`。这是刻意的：
 * 两版行为必须逐字一致，否则就会出现「在 Cloudflare 上好好的、
 * 换到 EdgeOne 就挂」这种最难排查的 bug。本文件只做运行时适配。
 *
 * 与 EdgeOne 版的差异只有三点：
 *   1. KV binding 通过 `env.SYNC_KV` 拿到，包成 store 接口再交给 dispatch
 *   2. 客户端 IP 取 CF-Connecting-IP（限频用，只存摘要不存原值）
 *   3. 环境变量从 handler 的 env 参数取，不依赖全局
 *
 * 路由：/api/xxx 与 /xxx 都支持（客户端可以按需选一种 base URL）。
 */

import {
  dispatch,
  CORS,
  statusFor,
} from "../../worker-edgeone/edge-functions/api/lib-account.js";

/** Cloudflare KV binding → lib-account 需要的 store 接口。 */
function kvStore(env) {
  const kv = env.SYNC_KV;
  if (!kv) return null;
  return {
    // binary: 更新镜像的包字节（upd_pkg_*）；其余仍是字符串
    get: async (key, opts) =>
      opts && opts.binary
        ? toUint8(await kv.get(key, { type: "arrayBuffer" }))
        : kv.get(key),
    put: async (key, value) => {
      // CF KV put 只收 string | ArrayBuffer | ReadableStream，视图要拷贝成独立 buffer
      // （slice 兜底 byteOffset ≠ 0 的视图，直接传 .buffer 会带上偏移前的脏字节）
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

/** ArrayBuffer | null → Uint8Array | null（store 契约统一以 Uint8Array 交字节）。 */
function toUint8(buf) {
  return buf ? new Uint8Array(buf) : null;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    // /api/heartbeat 与 /heartbeat 都解析成 ["heartbeat"]
    let segs = url.pathname.split("/").filter(Boolean);
    if (segs[0] === "api") segs = segs.slice(1);

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

    const store = kvStore(env);
    if (!store) {
      // 不静默降级成内存：那样数据会在每次冷启动后清空，
      // 表现为「注册成功，隔一会儿账号没了」，极难排查。
      return new Response(
        JSON.stringify({ error: "KV 未绑定，binding 名必须是 SYNC_KV" }),
        { status: 500, headers: CORS },
      );
    }

    let result;
    try {
      result = await dispatch(
        store,
        request.method,
        segs,
        url.searchParams,
        body,
        env,
        {
          ip:
            request.headers.get("CF-Connecting-IP") ||
            request.headers.get("X-Forwarded-For") ||
            "unknown",
          auth: request.headers.get("Authorization") || "",
          url: request.url,
        },
      );
    } catch (e) {
      console.error("[sync] dispatch failed:", e);
      result = { error: "server error", _status: 500, detail: String(e) };
    }

    const headers = { ...CORS };
    // detail 可能含 KV key、内部路径，默认丢弃；只有显式开启才回传
    if (result && result.detail !== undefined) {
      if (env.DEBUG_ERRORS === "1") {
        headers["X-Pet-Sync-Error"] = encodeURIComponent(result.detail).slice(0, 180);
      }
      delete result.detail;
    }
    const status = statusFor(result);
    if (result && result._status !== undefined) delete result._status;

    // __raw：更新镜像的清单/包字节 —— 绕过 JSON.stringify，按 __rawHeaders 出响应
    if (result && result.__raw !== undefined) {
      const rawHeaders = { ...CORS, ...(result.__rawHeaders || {}) };
      return new Response(result.__raw, { status, headers: rawHeaders });
    }

    return new Response(JSON.stringify(result), { status, headers });
  },
};
