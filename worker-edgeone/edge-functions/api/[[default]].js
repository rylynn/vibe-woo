/**
 * Vibe Pet 同步服务 —— EdgeOne Pages Functions 版（薄封装）。
 *
 * 业务逻辑在 lib-sync.js，与本地测试服务共用同一份，保证行为一致。
 *
 * 路由（catch-all）：
 *   POST /api/register  { nick }                → { pet_id, invite_code }
 *   POST /api/state     { pet_id, nick, ... }   → { ok }
 *   POST /api/befriend  { pet_id, invite_code } → { ok }
 *   GET  /api/friends?pet_id=                   → [{ ... }]
 *   POST /api/event     { pet_id, to, event }   → { ok }
 *   GET  /api/events?pet_id=                    → { events }
 *   GET  /api/status                            → 自检（含当前存储类型）
 *
 * 存储：优先使用绑定的 KV 命名空间（变量名必须为 SYNC_KV）；
 * KV 未绑定时降级为进程内存 —— 但内存按边缘实例隔离，
 * 跨请求不共享，仅能验证单请求，完整流程测试请用本地服务 local-dev.js。
 */

import { dispatch, CORS, statusFor } from "./lib-sync.js";

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

function store() {
  return typeof SYNC_KV === "undefined" ? memoryStore : SYNC_KV;
}

function storageKind() {
  return typeof SYNC_KV === "undefined" ? "memory" : "kv";
}

export async function onRequest({ request, params }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(request.url);
  const segs = Array.isArray(params.default)
    ? params.default
    : [params.default];
  const action = segs[segs.length - 1];

  let body = {};
  if (request.method === "POST") {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  }

  let result;
  try {
    result = await dispatch(store(), request.method, action, url.searchParams, body);
  } catch (e) {
    result = { error: String(e) };
  }

  const payload =
    action === "status" && result.ok
      ? { ...result, storage: storageKind() }
      : result;

  return new Response(JSON.stringify(payload), {
    status: statusFor(result),
    headers: { ...CORS, "X-Pet-Sync-Storage": storageKind() },
  });
}
