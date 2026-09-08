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
    get: async (key) => kv.get(key),
    put: async (key, value) => {
      await kv.put(key, value);
    },
    delete: async (key) => {
      await kv.delete(key);
    },
  };
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
      try {
        body = await request.json();
      } catch {
        body = {};
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

    return new Response(JSON.stringify(result), { status, headers });
  },
};
