#!/usr/bin/env python3
"""用 LLM 重写 ECDICT 扩展词书（*_x）的释义、音标与例句。

ECDICT 直出的数据有三个顽疾：音标 KK/DJ 混杂且带乱码（/i:gl/、/mi:^ə(r)/、
/wulin/），释义常取非核心义（favourable→有用的、meagre→瘦的），例句缺失。
本脚本批量调用已配置的 LLM（OpenAI 兼容端点）重写这三项，风格对齐
基础词书：英式 DJ 音标（/ˈænəlaɪz/）、「词性. 核心义」释义、自然例句。

用法:
    # 凭据自动从应用配置读（~/Library/Application Support/dev.vibepet.app/config.json）
    python3 scripts/rewrite-words-llm.py --limit 5    # 先试 5 个词看效果
    python3 scripts/rewrite-words-llm.py              # 全量（约 1300 词）
    python3 scripts/rewrite-words-llm.py --force      # 已重写过的也重来

    # 或显式给凭据（优先级高于配置文件）
    OPENAI_API_KEY=sk-... python3 scripts/rewrite-words-llm.py \
        --base-url https://api.deepseek.com/v1 --model deepseek-chat

幂等：只处理例句为空的 *_x 词条（重写后例句非空即视为已完成）；每批写盘，
中断后重跑自动续。跑完后在 src-tauri 下 `cargo test words` 兜底校验。

注意：只支持 OpenAI Chat Completions 形态的端点（OpenAI/DeepSeek/Kimi/
Ollama 等都兼容）。Anthropic 原生协议请走兼容网关。
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DICT_PATH = ROOT / "src-tauri/src/plugin/words-dict.json"
CONFIG_CANDIDATES = [
    Path.home() / "Library/Application Support/dev.vibepet.app/config.json",
    Path.home() / ".config/dev.vibepet.app/config.json",
]

SYSTEM = (
    "你是严谨的英语词典编辑。输入一批英语单词，为每个词给出：\n"
    "1. m：准确中文释义，格式「词性缩写. 释义」，词性只用 n./v./vt./vi./adj./adv./prep./conj.，"
    "核心义在前，可并列一两个常见义，30 字内；\n"
    "2. r：英式 DJ 音标，前后带斜杠，如 /ˈænəlaɪz/，只用标准 IPA 字符"
    "（ˈ ˌ ː ə ɪ ʊ æ ɒ ʃ ʒ θ ð ŋ），禁止 KK 音标与 . ^ 等替代符号；\n"
    "3. e：一句自然的英文例句，8-15 个单词，日常或考试语境，不含中文。\n"
    '只输出 JSON 数组，不要任何其他文字：[{"t":"原词","m":"...","r":"...","e":"..."}]，'
    "数组元素与输入一一对应。"
)


def load_llm(args):
    """凭据优先级：CLI/env > 应用配置文件。"""
    llm = {}
    for path in CONFIG_CANDIDATES:
        if path.is_file():
            try:
                llm = json.loads(path.read_text()).get("llm", {})
            except (OSError, ValueError):
                pass
            break
    base = args.base_url or os.environ.get("OPENAI_BASE_URL") or llm.get("base_url", "")
    key = args.api_key or os.environ.get("OPENAI_API_KEY") or llm.get("api_key", "")
    model = args.model or os.environ.get("OPENAI_MODEL") or llm.get("model", "")
    if not (base and key and model):
        sys.exit("缺 LLM 凭据：--base-url/--api-key/--model，或先在应用里配置 LLM。")
    return {"base_url": base, "api_key": key, "model": model}


def chat(llm, system, user, retries=2):
    # 网关普遍只支持流式（SSE）：stream 恒开，逐块拼接 delta.content
    url = llm["base_url"].rstrip("/") + "/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(
            {
                "model": llm["model"],
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.2,
                "stream": True,
            }
        ).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {llm['api_key']}",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    last = None
    for _ in range(retries + 1):
        try:
            parts = []
            with urllib.request.urlopen(req, timeout=300) as resp:
                for raw in resp:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:") :].strip()
                    if data == "[DONE]":
                        break
                    try:
                        delta = json.loads(data)["choices"][0].get("delta", {})
                        parts.append(delta.get("content") or "")
                    except (ValueError, KeyError, IndexError):
                        continue
            return "".join(parts)
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            time.sleep(3)
    raise RuntimeError(f"LLM 请求失败：{last}")


def parse_json_array(out):
    """剥掉可能的 ```json 围栏，解析出 JSON 数组。"""
    text = out.strip()
    m = re.search(r"\[[\s\S]*\]", text)
    if not m:
        raise ValueError("输出里找不到 JSON 数组")
    return json.loads(m.group(0))


def valid_reading(r):
    """音标必须是 /.../ 形态，无 ASCII 冒号、无 . ^ 等乱码替代符。"""
    if not r or not re.fullmatch(r"/[^/]{1,60}/", r):
        return False
    if ":" in r or "^" in r or "%" in r or r[1] == ".":
        return False
    return True


def valid_meaning(m):
    return bool(m) and len(m) <= 40


def valid_example(e):
    return (
        bool(e)
        and len(e) <= 200
        and re.search(r"[A-Za-z]", e)
        and not re.search(r"[\u4e00-\u9fff]", e)
    )


def rewrite_batch(llm, terms):
    """一批词条 -> {词: 新字段}。单条不合格则不进结果（保留原值，下轮重试）。"""
    user = json.dumps([{"t": t} for t in terms], ensure_ascii=False)
    out = chat(llm, SYSTEM, user)
    items = parse_json_array(out)
    result = {}
    for it in items:
        t = (it.get("t") or "").strip().lower()
        if t not in terms:
            print(f"  警告：返回了未知词 {t!r}，丢弃")
            continue
        m, r, e = (it.get("m") or "").strip(), (it.get("r") or "").strip(), (it.get("e") or "").strip()
        problems = []
        if not valid_meaning(m):
            problems.append(f"释义不合格: {m!r}")
        if not valid_reading(r):
            problems.append(f"音标不合格: {r!r}")
        if not valid_example(e):
            problems.append(f"例句不合格: {e!r}")
        if problems:
            print(f"  警告：{t} {'；'.join(problems)}，保留原值")
            continue
        result[t] = {"m": m, "r": r, "e": e}
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url")
    ap.add_argument("--api-key")
    ap.add_argument("--model")
    ap.add_argument("--batch-size", type=int, default=15)
    ap.add_argument("--concurrency", type=int, default=4, help="并发批数（默认 4）")
    ap.add_argument("--limit", type=int, help="只处理前 N 个词条（试跑用）")
    ap.add_argument("--force", action="store_true", help="例句非空的也重写")
    args = ap.parse_args()

    llm = load_llm(args)
    print(f"端点: {llm['base_url']}  模型: {llm['model']}")

    dict_data = json.loads(DICT_PATH.read_text())
    english = dict_data["english"]

    # 目标：所有 *_x 扩展词书中「未完成」的词条（例句为空 = 尚未重写）
    todo = []
    for book_id, book in english.items():
        if not book_id.endswith("_x"):
            continue
        for w in book["words"]:
            if args.force or not w.get("e"):
                todo.append((book_id, w))
    if args.limit is not None:
        todo = todo[: args.limit]
    if not todo:
        print("没有待重写的词条。")
        return
    print(f"待重写: {len(todo)} 词")

    batches = [todo[i : i + args.batch_size] for i in range(0, len(todo), args.batch_size)]
    done = 0

    def run_batch(i_batch):
        idx, batch = i_batch
        terms = [w["t"] for _, w in batch]
        try:
            return idx, rewrite_batch(llm, terms)
        except Exception as e:  # noqa: BLE001 —— 单批失败不能拖垮整轮
            print(f"  批 {idx + 1} 失败：{e}")
            return idx, {}

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for idx, updates in pool.map(run_batch, enumerate(batches)):
            batch = batches[idx]
            hit = 0
            for book_id, w in batch:
                u = updates.get(w["t"])
                if u:
                    w.update(u)
                    hit += 1
            done += hit
            print(f"批 {idx + 1}/{len(batches)}: {hit}/{len(batch)} 有效")
            # 每批写盘：中断可续跑
            DICT_PATH.write_text(
                json.dumps(dict_data, ensure_ascii=False, indent=2) + "\n"
            )

    print(f"完成：本次重写 {done} 词。无效词条保留原值，重跑本脚本即可重试。")


if __name__ == "__main__":
    main()
