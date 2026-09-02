#!/usr/bin/env python3
"""从 ECDICT 生成学外语插件的英语扩展词书（可复现的数据工程）。

用法:
    # 1. 下载 ECDICT（全量 csv 在仓库内，约 65MB）
    curl -sL "https://codeload.github.com/skywind3000/ECDICT/tar.gz/refs/heads/master" \
        -o /tmp/ecdict-repo.tar.gz
    tar -xzf /tmp/ecdict-repo.tar.gz ECDICT-master/ecdict.csv -C /tmp

    # 2. 生成并合并进词库（幂等：重复运行不会重复添加）
    python3 scripts/gen-words-ecdict.py /tmp/ECDICT-master/ecdict.csv

产出三本新词书（加到 words-dict.json 的 english 段）:
    ielts_x  雅思扩展（tag 含 ielts，词频优先，500 词）
    toefl_x  托福扩展（tag 含 toefl 且不含 ielts，400 词）
    daily_x  日常扩展（中考/四级词，400 词）

例句留空（ECDICT 无例句）—— 词卡出卡后由插件已有的 LLM 异步增强机制
（spawn_enhance）生成例句与记忆钩子；未配置 LLM 时前端不渲染空例句行。

数据来源: skywind3000/ECDICT (MIT License)。
"""
import csv
import json
import sys
from pathlib import Path

DICT_PATH = Path(__file__).resolve().parents[1] / "src-tauri/src/plugin/words-dict.json"

# 各词书的筛选规则：(tag 必含, tag 必不含, 取词数)
BOOKS = [
    ("ielts_x", "雅思扩展", {"ielts"}, set(), 500, "intermediate"),
    ("toefl_x", "托福扩展", {"toefl"}, {"ielts"}, 400, "advanced"),
    ("daily_x", "日常扩展（高频）", {"zk", "cet4"}, {"ielts", "toefl", "gre", "ky"}, 400, None),
]

# ECDICT 音标用西里尔 ә 等变体字符，规范化为标准 IPA
PHONETIC_FIXES = {
    "ә": "ə",  # U+04D9 → U+0259
    "є": "ɛ",  # U+0454 → U+025B
    "Ӣ": "iː",
    "ӯ": "uː",
    "′": "ˈ",
    "’": "ˈ",
}


def clean_phonetic(p: str) -> str:
    for k, v in PHONETIC_FIXES.items():
        p = p.replace(k, v)
    p = p.strip().strip("'\"")
    return f"/{p}/" if p else ""


def clean_translation(t: str) -> str:
    """取第一行、第一义项，压到 24 字内。

    ECDICT 的多义项分隔是字面 `\\n` 转义（不是真实换行），先统一成换行再切。
    """
    t = t.replace("\\n", "\n")
    first = t.split("\n")[0].strip()
    # 按中文逗号取第一义项，但至少保留词性 + 一个词（如 "n. 能力"）
    for sep in ("，", ","):
        if sep in first:
            head = first.split(sep)[0].strip()
            # 词性前缀（n./vt./a. 等）不足以独立成义项，向后并一个词
            if head.rstrip(".").isalpha() and "." in head:
                parts = first.split(sep)
                head = (parts[0] + sep + parts[1]).strip() if len(parts) > 1 else head
            if len(head) >= 3:
                first = head
            break
    return first[:24].rstrip(",， ")


def main(csv_path: str) -> None:
    dict_data = json.loads(DICT_PATH.read_text())
    english = dict_data["english"]

    # 真正幂等：先删除上次生成的扩展词书再重建
    for book_id, *_ in BOOKS:
        english.pop(book_id, None)

    # 已有词条去重基准（全部语言都查，防跨语言重复无意义但英语内必须防）
    existing = set()
    for lang in dict_data.values():
        for book in lang.values():
            existing.update(w["t"] for w in book["words"])

    # 读 ECDICT：按词频排序收集候选
    candidates = {book_id: [] for book_id, *_ in BOOKS}
    with open(csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            word = (row.get("word") or "").strip().lower()
            trans = (row.get("translation") or "").strip()
            phon = (row.get("phonetic") or "").strip()
            tag = set((row.get("tag") or "").split())
            if not word or not trans or " " in word or "-" in word:
                continue  # 只要单词（词组与连字符词先不要，保证卡面干净）
            if word in existing:
                continue
            frq = int(row.get("frq") or 0)
            for book_id, _name, need, ban, _n, _lvl in BOOKS:
                if tag & need and not (tag & ban):
                    candidates[book_id].append(
                        (frq, word, clean_phonetic(phon), clean_translation(trans), tag)
                    )

    added = 0
    for book_id, name, _need, _ban, limit, level in BOOKS:
        # 词频降序（frq 越大越常用），稳定去重
        seen = set()
        picked = []
        for frq, word, phon, trans, tag in sorted(
            candidates[book_id], key=lambda x: -x[0]
        ):
            if word in seen:
                continue
            seen.add(word)
            if level is None:
                lvl = "beginner" if "zk" in tag else "intermediate"
            else:
                lvl = level
            picked.append(
                {
                    "t": word,
                    "r": phon,
                    "m": trans,
                    "e": "",  # 例句留给 LLM 异步增强
                    "d": "general",
                    "l": lvl,
                }
            )
            if len(picked) >= limit:
                break
        english[book_id] = {"name": name, "words": picked}
        existing.update(w["t"] for w in picked)
        added += len(picked)
        print(f"{book_id}: {len(picked)} 词")

    DICT_PATH.write_text(json.dumps(dict_data, ensure_ascii=False, indent=2) + "\n")
    total = sum(len(b["words"]) for b in dict_data["english"].values())
    print(f"english 总词量: {total}（新增 {added}）")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/ECDICT-master/ecdict.csv")
