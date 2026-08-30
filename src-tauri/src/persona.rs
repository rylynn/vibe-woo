//! 宠物人格对话。
//!
//! 双轨制（用户需求）：绑定了 LLM 就用 LLM 生成；没绑定则用本地语料库。
//! 本地语料按（人格 × 心情 × 活动）三维选取，选不到时用兜底池保底 ——
//! 说话频率是硬性要求，非睡觉/串门期不能一直沉默。

use crate::activity::Activity;
use crate::config::Persona;
use crate::mood::Mood;

/// 本地语料库。
///
/// 编写原则（参考业界拟人化产品的 prompt 风格）：
///   - 短。桌宠气泡超过 20 个字就是在打扰。
///   - 有生活感，不用感叹号轰炸。
///   - 不评价用户（「你真棒」是客服话术），只表达自己的感受。
///   - 允许不说话 —— 选不到合适的就不说，比尬说好。
const LINES: &[(Persona, Mood, Activity, &[&str])] = &[
    // —— 心满意足 ——
    (
        Persona::Quiet,
        Mood::Content,
        Activity::Working,
        &["（哼起了小曲）", "（尾巴摇了摇）"],
    ),
    (
        Persona::Occasional,
        Mood::Content,
        Activity::Working,
        &["这节奏舒服。", "（小声）写顺了的感觉真好"],
    ),
    (
        Persona::Chatty,
        Mood::Content,
        Activity::Working,
        &[
            "你现在这个状态就很对，保持住。",
            "我看你写了这么久都不带停的。",
            "写得这么顺，是不是偷偷开了外挂？",
            "这手感热得发烫，趁现在多写点，别浪费了。",
        ],
    ),
    (
        Persona::Occasional,
        Mood::Content,
        Activity::Listening,
        &["这歌不错。", "边听边写，稳。"],
    ),
    // —— 烦躁 ——
    (
        Persona::Quiet,
        Mood::Frustrated,
        Activity::Thinking,
        &["（挠了挠头）", "（盯着屏幕看了很久）"],
    ),
    (
        Persona::Occasional,
        Mood::Frustrated,
        Activity::Thinking,
        &["卡住了？出去走走吧。", "要不要先记下来，明天再想？"],
    ),
    (
        Persona::Chatty,
        Mood::Frustrated,
        Activity::Thinking,
        &[
            "你已经盯着这段代码很久了。喝口水再回来看？",
            "这bug修得我看着都急，要不让我上？",
            "你跟这段代码，迟早得有一个先崩溃。",
        ],
    ),
    (
        Persona::Chatty,
        Mood::Frustrated,
        Activity::Working,
        &["改了半天还报错，这代码跟你有仇吧。"],
    ),
    (
        Persona::Occasional,
        Mood::Frustrated,
        Activity::Working,
        &["（把脸埋进了爪子里）", "深呼吸。"],
    ),
    // —— 无聊 ——
    (
        Persona::Quiet,
        Mood::Bored,
        Activity::Slacking,
        &["（打了个哈欠）"],
    ),
    (
        Persona::Occasional,
        Mood::Bored,
        Activity::Slacking,
        &["摸鱼时间？我什么都没看见。", "（无聊地用爪子划地板）"],
    ),
    (
        Persona::Chatty,
        Mood::Bored,
        Activity::Slacking,
        &[
            "这集我看你刷第三遍了。要不要回来干活？",
            "无聊的话可以逗逗我。",
            "我就静静看着你假装很忙，剧都刷完一集了吧。",
            "摸鱼一时爽，deadline 火葬场，说的就是你。",
        ],
    ),
    (
        Persona::Chatty,
        Mood::Bored,
        Activity::Working,
        &["这活儿干得跟复制粘贴似的，一点灵魂都没有。"],
    ),
    (
        Persona::Occasional,
        Mood::Bored,
        Activity::Working,
        &["（趴在桌上看你工作）"],
    ),
    // —— 专注（默认）——
    (
        Persona::Occasional,
        Mood::Focused,
        Activity::Thinking,
        &["（安静地陪你一起看屏幕）"],
    ),
    (
        Persona::Occasional,
        Mood::Focused,
        Activity::Listening,
        &["（跟着音乐轻轻点头）"],
    ),
    (
        Persona::Chatty,
        Mood::Focused,
        Activity::Thinking,
        &["专注得连我都不理了，行吧，你厉害。"],
    ),
    (
        Persona::Chatty,
        Mood::Content,
        Activity::Listening,
        &["这歌单品味可以啊，下次给我也拷一份。"],
    ),
];

/// 按三维选一条语料。带小随机。
///
/// 匹配顺序：精确（人格+心情+活动）→ 宽松（人格+心情）。
/// 返回 None 表示没有合适的 —— 安静人格的大多数组合都会落到这里。
/// 调用方（talkdrive）会接着走 fallback 兜底：
/// 频率是硬性要求，沉默只发生在睡觉/串门。
pub fn pick_local(
    persona: Persona,
    mood: Mood,
    activity: Activity,
    rng: f64,
) -> Option<&'static str> {
    let exact: Vec<&[&'static str]> = LINES
        .iter()
        .filter(|(p, m, a, _)| *p == persona && *m == mood && *a == activity)
        .map(|(_, _, _, ls)| *ls)
        .collect();
    if !exact.is_empty() {
        return pick_from(&exact, rng);
    }

    // 宽松匹配只给爱说话的人格用。安静人格不精确匹配就沉默 ——
    // 「找话说」本身就违背安静的语义。
    if persona == Persona::Quiet {
        return None;
    }

    let loose: Vec<&[&'static str]> = LINES
        .iter()
        .filter(|(p, m, _, _)| *p == persona && *m == mood)
        .map(|(_, _, _, ls)| *ls)
        .collect();
    if loose.is_empty() {
        return None;
    }
    pick_from(&loose, rng)
}

fn pick_from(pool: &[&[&'static str]], rng: f64) -> Option<&'static str> {
    let total: usize = pool.iter().map(|l| l.len()).sum();
    if total == 0 {
        return None;
    }
    let mut idx = (rng.abs().fract() * total as f64) as usize;
    for lines in pool {
        if idx < lines.len() {
            return Some(lines[idx]);
        }
        idx -= lines.len();
    }
    None
}

/// 兜底语料：三维选取落空时的保底。
///
/// 说话频率是硬性要求（唠唠 1–3 分钟、其余最多 5 分钟一次），
/// 选不到「合适」的话也要说点什么 —— 安静人格用极简动作型，
/// 保持人设的同时不违反频率要求。
const FALLBACKS: [(Persona, &[&str]); 3] = [
    (
        Persona::Quiet,
        &["（眨了眨眼）", "（甩了甩尾巴）", "（看了你一眼）"],
    ),
    (
        Persona::Occasional,
        &["（凑过来看了看屏幕）", "还在呢。", "（打了个哈欠）"],
    ),
    (
        Persona::Chatty,
        &[
            "你不说话我就自己说了，反正闲着也是闲着。",
            "我一直在的，随叫随到，不客气。",
            "要不要休息一下？我陪你发会儿呆也行。",
        ],
    ),
];

/// 兜底选取。任何人格都有返回值，不会沉默。
pub fn fallback(persona: Persona, rng: f64) -> Option<&'static str> {
    let pool = FALLBACKS
        .iter()
        .find(|(p, _)| *p == persona)
        .map(|(_, ls)| *ls)?;
    pick_from(&[pool], rng)
}

/// system prompt 的上下文。除 persona 外全部来自传感器与当日记忆，
/// 不含任何需要用户手填的内容。
#[derive(Debug, Clone, Copy)]
pub struct PromptCtx {
    pub persona: Persona,
    pub mood: Mood,
    pub activity: Activity,
    pub doing: crate::state::Doing,
    pub tempo: crate::state::Tempo,
    pub late_night: bool,
    pub keystrokes_per_min: f64,
}

/// LLM 的 system prompt。
///
/// 设计要点（参考角色扮演/拟人化助手 prompt 的通行实践）：
///   - 分段结构：身份 → 性格 → 你的状态 → 主人的状态 → 今天 → 要求。
///     短段落比一整句更利于小模型遵循。
///   - 感知接地：只描述可观察的事实（敲键节奏、前台应用、时长），
///     让模型自己决定怎么说，而不是替它写台词。
///   - 输出硬约束前置 + 后置双提：15 字、无 emoji、不评价、不复述状态。
///     「不评价」很重要 —— 「你真棒」是客服话术，宠物只表达自己的感受。
///   - 记忆只给当日摘要，不给原始日志：摘要里有推断（累了），
///     模型可以顺着说，但禁止把摘要念出来。
pub fn system_prompt(ctx: &PromptCtx, memory: Option<&str>) -> String {
    let (style, length_rule) = match ctx.persona {
        Persona::Quiet => (
            "你话很少，常常只用动作或一两个词表达。括号里写动作。",
            "不超过10个字",
        ),
        Persona::Occasional => (
            "你偶尔说一句，简短、有生活感。",
            "不超过15个字",
        ),
        Persona::Chatty => (
            "你爱说话，像主人的损友：嘴贱但热心，可以适当用最近流行的网络梗，\
            贱贱地吐槽，但分寸要拿捏好。",
            "一句15到30个字，长短可以有变化",
        ),
    };
    let mood_s = match ctx.mood {
        Mood::Content => "心满意足",
        Mood::Focused => "专注",
        Mood::Bored => "无聊",
        Mood::Frustrated => "有点烦躁",
    };
    let doing_s = match ctx.doing {
        crate::state::Doing::Coding => "在写代码",
        crate::state::Doing::Browsing => "在上网",
        crate::state::Doing::Other => "在做别的事",
        crate::state::Doing::Away => "不在电脑前",
    };
    let tempo_s = match ctx.tempo {
        crate::state::Tempo::Flow => "敲键很快，进入了状态",
        crate::state::Tempo::Normal => "节奏平稳",
        crate::state::Tempo::Stuck => "盯着屏幕很久没敲键，在思考或卡住了",
        crate::state::Tempo::Resting => "手离开键盘了",
    };
    let act_s = match ctx.activity {
        Activity::Thinking => "编辑器前台但没有输入，大概率在想问题",
        Activity::Listening => "在听音乐",
        Activity::Slacking => "在浏览器里闲逛，大概率在摸鱼",
        Activity::Working => "正常干活",
    };
    let pace = if ctx.keystrokes_per_min >= 180.0 {
        "手速很快"
    } else if ctx.keystrokes_per_min >= 120.0 {
        "手速偏快"
    } else {
        "手速平缓"
    };

    let mut p = format!(
        "你是一只桌面宠物，陪一位写代码的主人。{style}\n\
你的状态：{mood_s}。\n\
主人的状态：{doing_s}，{tempo_s}，{pace}，{act_s}。"
    );
    if ctx.late_night {
        p.push_str("现在是深夜。");
    }
    if let Some(m) = memory {
        p.push_str(&format!("\n今天你们一起度过：{m}"));
    }
    p.push_str(&format!(
        "\n说一句你当下的感受或想说的话。要求：{length_rule}；不用emoji；\
不评价主人的表现；不要复述上面的状态；像活物，不像助手。\
只输出这一句话。",
    ));
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 安静人格大多组合不出声() {
        // 安静就要真的安静 —— 除少数组合外都该沉默
        let mut spoken = 0;
        let mut total = 0;
        for mood in [Mood::Content, Mood::Focused, Mood::Bored, Mood::Frustrated] {
            for act in [
                Activity::Thinking,
                Activity::Listening,
                Activity::Slacking,
                Activity::Working,
            ] {
                total += 1;
                if pick_local(Persona::Quiet, mood, act, 0.5).is_some() {
                    spoken += 1;
                }
            }
        }
        assert!(
            (spoken as f64 / total as f64) < 0.35,
            "安静人格沉默率过低：{spoken}/{total}"
        );
    }

    #[test]
    fn 唠唠人格在显眼组合有话说() {
        assert!(pick_local(Persona::Chatty, Mood::Bored, Activity::Slacking, 0.5).is_some());
        assert!(
            pick_local(Persona::Chatty, Mood::Content, Activity::Working, 0.5).is_some()
        );
    }

    #[test]
    fn 偶尔人格卡住时会关心() {
        assert!(
            pick_local(Persona::Occasional, Mood::Frustrated, Activity::Thinking, 0.5).is_some()
        );
    }

    #[test]
    fn 精确匹配不到时偶尔人格落到宽松匹配() {
        // Occasional + Content + Listening 无精确条目，
        // 但 Occasional+Content（任意活动）有 → 宽松层兜底
        assert!(
            pick_local(Persona::Occasional, Mood::Content, Activity::Working, 0.5).is_some()
        );
    }

    #[test]
    fn 完全无匹配的组合返回无() {
        assert!(pick_local(Persona::Quiet, Mood::Focused, Activity::Slacking, 0.5).is_none());
    }

    #[test]
    fn 不同rng倾向给出不同语料() {
        let mut seen = std::collections::HashSet::new();
        for i in 0..10 {
            if let Some(line) = pick_local(
                Persona::Chatty,
                Mood::Bored,
                Activity::Slacking,
                i as f64 / 10.0,
            ) {
                seen.insert(line);
            }
        }
        assert!(seen.len() >= 2, "随机应能覆盖多条语料，实际 {seen:?}");
    }

    #[test]
    fn 兜底池任何人格都有话说() {
        // 频率硬性要求：三维选取落空时兜底必出话
        for p in [Persona::Quiet, Persona::Occasional, Persona::Chatty] {
            assert!(fallback(p, 0.5).is_some(), "{p:?} 兜底池为空");
            // 兜底也不该只有一条 —— 否则重复太快就腻了
            assert!(
                fallback(p, 0.0) != fallback(p, 0.99),
                "{p:?} 兜底池没有随机性"
            );
        }
    }

    #[test]
    fn 唠唠prompt要求玩梗与长度浮动() {
        let ctx = PromptCtx {
            persona: Persona::Chatty,
            mood: Mood::Bored,
            activity: Activity::Slacking,
            doing: crate::state::Doing::Browsing,
            tempo: crate::state::Tempo::Resting,
            late_night: false,
            keystrokes_per_min: 0.0,
        };
        let p = system_prompt(&ctx, None);
        assert!(p.contains("15到30个字"), "{p}");
        assert!(p.contains("网络梗"), "{p}");
        assert!(p.contains("损友"), "{p}");
    }

    #[test]
    fn 安静人格prompt长度更短() {
        let ctx = PromptCtx {
            persona: Persona::Quiet,
            mood: Mood::Focused,
            activity: Activity::Working,
            doing: crate::state::Doing::Coding,
            tempo: crate::state::Tempo::Normal,
            late_night: false,
            keystrokes_per_min: 30.0,
        };
        assert!(system_prompt(&ctx, None).contains("不超过10个字"));
    }

    #[test]
    fn system_prompt_包含人格风格与状态上下文() {
        let ctx = PromptCtx {
            persona: Persona::Occasional,
            mood: Mood::Frustrated,
            activity: Activity::Thinking,
            doing: crate::state::Doing::Coding,
            tempo: crate::state::Tempo::Stuck,
            late_night: false,
            keystrokes_per_min: 10.0,
        };
        let p = system_prompt(&ctx, None);
        assert!(p.contains("偶尔说一句"));
        assert!(p.contains("烦躁"));
        assert!(p.contains("思考"));
        assert!(p.contains("15个字"));
        assert!(p.contains("不评价"));
    }

    #[test]
    fn system_prompt_包含主人的行为与节奏() {
        let ctx = PromptCtx {
            persona: Persona::Chatty,
            mood: Mood::Content,
            activity: Activity::Working,
            doing: crate::state::Doing::Coding,
            tempo: crate::state::Tempo::Flow,
            late_night: false,
            keystrokes_per_min: 200.0,
        };
        let p = system_prompt(&ctx, None);
        assert!(p.contains("进入了状态"), "{p}");
        assert!(p.contains("手速很快"), "{p}");
    }

    #[test]
    fn system_prompt_带上当日记忆与疲劳推断() {
        let ctx = PromptCtx {
            persona: Persona::Occasional,
            mood: Mood::Focused,
            activity: Activity::Working,
            doing: crate::state::Doing::Coding,
            tempo: crate::state::Tempo::Normal,
            late_night: false,
            keystrokes_per_min: 30.0,
        };
        let p = system_prompt(&ctx, Some("今天写码约3小时，记了5条速记。看起来有点累了"));
        assert!(p.contains("今天你们一起度过"), "{p}");
        assert!(p.contains("有点累"), "{p}");
    }

    #[test]
    fn system_prompt_深夜有标记() {
        let ctx = PromptCtx {
            persona: Persona::Quiet,
            mood: Mood::Focused,
            activity: Activity::Working,
            doing: crate::state::Doing::Coding,
            tempo: crate::state::Tempo::Normal,
            late_night: true,
            keystrokes_per_min: 30.0,
        };
        let p = system_prompt(&ctx, None);
        assert!(p.contains("深夜"), "{p}");
    }
}
