//! 宠物人格对话。
//!
//! 双轨制（用户需求）：绑定了 LLM 就用 LLM 生成；没绑定则用本地语料库。
//! 本地语料按（人格 × 心情 × 活动）三维选取，选不到时用兜底池保底 ——
//! 说话频率是硬性要求，非睡觉/串门期不能一直沉默。

use crate::activity::Activity;
use crate::config::Persona;
use crate::mood::Mood;

/// 本地语料库（通用中性）。
///
/// 编写原则（参考业界拟人化产品的 prompt 风格）：
///   - 短。桌宠气泡超过 20 个字就是在打扰。
///   - 有生活感，不用感叹号轰炸。
///   - 不评价用户（「你真棒」是客服话术），只表达自己的感受。
///   - 允许不说话 —— 选不到合适的就不说，比尬说好。
///   - **不提任何工种**：主人可能在写代码，也可能在做设计、写方案、对表格。
///     只说「这件事顺不顺 / 卡不卡」，具体是什么事一概不猜。
///   - **每格至少 4 条**：硬编码语料量有限，格子太薄两三轮就听腻了。
///
/// 个性化差异交给 LLM —— 主人的自述（`user_kind`）只进 system prompt，
/// 本地语料保持全中性，没接 LLM 的用户看到的是同一套通用表达。
const LINES: &[(Persona, Mood, Activity, &[&str])] = &[
    // —— 心满意足 ——
    (
        Persona::Quiet,
        Mood::Content,
        Activity::Working,
        &[
            "（哼起了小曲）",
            "（尾巴摇了摇）",
            "（轻轻晃了晃）",
            "（眯着眼待着）",
        ],
    ),
    // —— 寡言（第二档：10–15 分钟一句，极简克制）——
    (
        Persona::Reserved,
        Mood::Content,
        Activity::Working,
        &[
            "节奏挺好。",
            "顺就好。",
            "（安静陪着）",
            "（眯着眼看你忙）",
        ],
    ),
    (
        Persona::Reserved,
        Mood::Focused,
        Activity::Working,
        &[
            "（不打扰）",
            "忙吧，我在。",
            "（趴在旁边）",
            "这个状态不错。",
        ],
    ),
    (
        Persona::Reserved,
        Mood::Frustrated,
        Activity::Thinking,
        &[
            "（陪着你卡）",
            "缓缓也行。",
            "别硬磕。",
            "（把下巴搁在爪子上）",
        ],
    ),
    (
        Persona::Reserved,
        Mood::Bored,
        Activity::Slacking,
        &[
            "（看你刷屏）",
            "摸鱼就摸吧。",
            "（打了个哈欠）",
            "刷完记得回来。",
        ],
    ),
    (
        Persona::Occasional,
        Mood::Content,
        Activity::Working,
        &[
            "这节奏舒服。",
            "（小声）顺起来的感觉真好",
            "这会儿别打断你。",
            "（安安静静趴着）",
        ],
    ),
    (
        Persona::Chatty,
        Mood::Content,
        Activity::Working,
        &[
            "你现在这个状态就很对，保持住。",
            "我看你忙了这么久都不带停的。",
            "这么顺，是不是偷偷开了外挂？",
            "这手感热得发烫，趁现在多推进点，别浪费了。",
            "我都不敢出声，怕打断你。",
        ],
    ),
    (
        Persona::Occasional,
        Mood::Content,
        Activity::Listening,
        &[
            "这歌不错。",
            "边听边干，稳。",
            "（跟着晃了两下）",
            "这旋律挺配现在的节奏。",
        ],
    ),
    // —— 烦躁 ——
    (
        Persona::Quiet,
        Mood::Frustrated,
        Activity::Thinking,
        &[
            "（挠了挠头）",
            "（盯着屏幕看了很久）",
            "（轻轻叹了口气）",
            "（把下巴搁在爪子上）",
        ],
    ),
    (
        Persona::Occasional,
        Mood::Frustrated,
        Activity::Thinking,
        &[
            "卡住了？出去走走吧。",
            "要不要先记下来，明天再想？",
            "（默默挪近了一点）",
            "先放一放也行。",
        ],
    ),
    (
        Persona::Chatty,
        Mood::Frustrated,
        Activity::Thinking,
        &[
            "你已经盯着这块很久了。喝口水再回来看？",
            "卡这么久，要不要先放一放？",
            "这题确实不好啃，我陪你耗着。",
            "换个顺序试试？死磕不一定有用。",
            "要不先把能做的做了，卡着的留最后？",
        ],
    ),
    (
        Persona::Chatty,
        Mood::Frustrated,
        Activity::Working,
        &[
            "折腾了半天还是老样子，要不先歇口气？",
            "这活儿越干越拧巴，我说真的。",
            "先去倒杯水，回来再看？",
            "别跟它较劲了，缓一缓。",
        ],
    ),
    (
        Persona::Occasional,
        Mood::Frustrated,
        Activity::Working,
        &[
            "（把脸埋进了爪子里）",
            "深呼吸。",
            "（皱着眉看你）",
            "这会儿挺难熬的。",
        ],
    ),
    // —— 无聊 ——
    (
        Persona::Quiet,
        Mood::Bored,
        Activity::Slacking,
        &[
            "（打了个哈欠）",
            "（百无聊赖地翻了个身）",
            "（盯着窗外）",
            "（尾巴有一下没一下地拍着）",
        ],
    ),
    (
        Persona::Occasional,
        Mood::Bored,
        Activity::Slacking,
        &[
            "摸鱼时间？我什么都没看见。",
            "（无聊地用爪子划地板）",
            "刷够了吧？",
            "（趴着看你）",
        ],
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
            "要不咱俩一起发会儿呆？",
        ],
    ),
    (
        Persona::Chatty,
        Mood::Bored,
        Activity::Working,
        &[
            "这活儿干得跟复制粘贴似的，一点灵魂都没有。",
            "你自己也知道这事儿没意思吧。",
            "要不要换个顺序，先干点别的？",
            "重复到这个程度，闭着眼都能做了。",
        ],
    ),
    (
        Persona::Occasional,
        Mood::Bored,
        Activity::Working,
        &[
            "（趴在桌上看你忙）",
            "还在磨呢。",
            "（打了个哈欠，又撑住）",
            "这活儿挺熬人的。",
        ],
    ),
    // —— 专注（默认）——
    (
        Persona::Occasional,
        Mood::Focused,
        Activity::Thinking,
        &[
            "（安静地陪你一起看屏幕）",
            "（不出声，就待着）",
            "（托着腮看你想）",
            "慢慢来，不急。",
        ],
    ),
    (
        Persona::Occasional,
        Mood::Focused,
        Activity::Listening,
        &[
            "（跟着音乐轻轻点头）",
            "（耳朵跟着节奏动了一下）",
            "（闭着眼听）",
            "这首也还行。",
        ],
    ),
    (
        Persona::Chatty,
        Mood::Focused,
        Activity::Thinking,
        &[
            "专注得连我都不理了，行吧，你厉害。",
            "你这一沉默，我都不敢喘气。",
            "在想什么这么入神？算了，我不问。",
            "（凑过去又悄悄退回来）",
        ],
    ),
    (
        Persona::Chatty,
        Mood::Content,
        Activity::Listening,
        &[
            "这歌单品味可以啊，下次给我也拷一份。",
            "这首我给满分。",
            "听着听着我也困了。",
            "要不把音量再开大点？",
        ],
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
    let exact = collect(persona, Some(mood), Some(activity));
    if !exact.is_empty() {
        return pick_from(&exact, rng);
    }

    // 宽松匹配只给爱说话的人格用。安静人格不精确匹配就沉默 ——
    // 「找话说」本身就违背安静的语义。
    if persona == Persona::Quiet {
        return None;
    }

    let loose = collect(persona, Some(mood), None);
    if loose.is_empty() {
        return None;
    }
    pick_from(&loose, rng)
}

/// 收集候选语料。`activity` 传 None 表示该维度不参与过滤（宽松匹配）。
fn collect(
    persona: Persona,
    mood: Option<Mood>,
    activity: Option<Activity>,
) -> Vec<&'static [&'static str]> {
    LINES
        .iter()
        .filter(|(p, m, a, _)| {
            *p == persona
                && mood.map_or(true, |mm| *m == mm)
                && activity.map_or(true, |aa| *a == aa)
        })
        .map(|(_, _, _, ls)| *ls)
        .collect()
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
/// 说话频率是硬性要求（寡言 10–15 分钟、偶尔 5–10 分钟、唠唠 1–5 分钟），
/// 选不到「合适」的话也要说点什么 —— 安静档根本不会走到这里（talkdrive
/// 已短路），寡言用极简动作型，保持人设的同时不违反频率要求。
const FALLBACKS: [(Persona, &[&str]); 4] = [
    (
        Persona::Quiet,
        &[
            "（眨了眨眼）",
            "（甩了甩尾巴）",
            "（看了你一眼）",
            "（换了个姿势趴好）",
        ],
    ),
    (
        Persona::Reserved,
        &[
            "（瞥了一眼屏幕）",
            "（挪了挪窝）",
            "嗯，还在。",
            "（耳朵动了动）",
        ],
    ),
    (
        Persona::Occasional,
        &[
            "（凑过来看了看屏幕）",
            "还在呢。",
            "（打了个哈欠）",
            "（用爪子碰了碰你）",
        ],
    ),
    (
        Persona::Chatty,
        &[
            "你不说话我就自己说了，反正闲着也是闲着。",
            "我一直在的，随叫随到，不客气。",
            "要不要休息一下？我陪你发会儿呆也行。",
            "你忙你的，我自言自语一会儿。",
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

/// system prompt 的上下文。
///
/// 除 persona 外全部来自传感器与当日记忆；`user_kind` 是唯一来自
/// 用户手填的字段，且可留空 —— 留空即「不了解主人是做什么的」。
#[derive(Debug, Clone, Copy)]
pub struct PromptCtx<'a> {
    pub persona: Persona,
    pub mood: Mood,
    pub activity: Activity,
    pub doing: crate::state::Doing,
    pub tempo: crate::state::Tempo,
    pub late_night: bool,
    pub keystrokes_per_min: f64,
    /// 主人自述的「平时在忙什么」。空串 = 未填写，不预设任何身份。
    pub user_kind: &'a str,
    /// 习惯记忆：LLM 归纳出的作息规律与生活习惯（置信度不足时为 None）。
    ///
    /// 与 `user_kind` 的区别：那是主人**自己说的**，这是宠物**观察久了
    /// 总结的** —— 后者只能当熟稔感的来源，不能当事实陈述。
    pub habit: Option<&'a str>,
}

/// LLM 的 system prompt。
///
/// 设计要点（参考角色扮演/拟人化助手 prompt 的通行实践）：
///   - 分段结构：身份 → 性格 → 你的状态 → 主人的状态 → 今天 → 要求。
///     短段落比一整句更利于小模型遵循。
///   - 感知接地：只描述可观察的事实（敲键节奏、前台应用、时长），
///     让模型自己决定怎么说，而不是替它写台词。
///   - **不预设身份**：主人未必是程序员。没填 `user_kind` 时明确告知模型
///     「不了解主人是做什么的」，并禁止它猜测 —— 否则小模型一定会
///     顺着「编辑器 + 敲键快」脑补成写代码。
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
        Persona::Reserved => (
            "你话不多，隔好一阵子才冒一句，简短、克制、有生活感。",
            "不超过12个字",
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
    // 这是「宠物懂不懂你」的关键：只陈述可观察的事实（前台是哪类工具），
    // 不推断主人在产出什么 —— 那属于主人的自述，不该由工具反推。
    let doing_s = match ctx.doing {
        crate::state::Doing::Editing => "在编辑器或终端里",
        crate::state::Doing::Writing => "在写文档或笔记",
        crate::state::Doing::Designing => "在做设计",
        crate::state::Doing::Data => "在处理表格和数据",
        crate::state::Doing::Messaging => "在聊天沟通",
        crate::state::Doing::Browsing => "在阅读浏览",
        crate::state::Doing::Watching => "在看视频或听歌",
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
        Activity::Thinking => "工具在前台但很久没有输入，大概率在想问题",
        Activity::Listening => "在听音乐",
        Activity::Slacking => "在浏览器里闲逛，大概率在摸鱼",
        Activity::Meeting => "在开会或语音通话，不方便说话",
        Activity::Waiting => "在等构建、测试或AI跑完",
        Activity::Working => "正常在忙",
    };
    let pace = if ctx.keystrokes_per_min >= 180.0 {
        "手速很快"
    } else if ctx.keystrokes_per_min >= 120.0 {
        "手速偏快"
    } else {
        "手速平缓"
    };

    // 身份：没填就说不知道，并禁止模型自己脑补职业。
    let who = match ctx.user_kind.trim() {
        "" => "你不了解主人是做什么的".to_string(),
        k => format!("主人自己说他平时{k}"),
    };

    let mut p = format!(
        "你是一只桌面宠物，陪在主人身边。{who}。{style}\n\
你的状态：{mood_s}。\n\
主人的状态：{doing_s}，{tempo_s}，{pace}，{act_s}。"
    );
    if ctx.late_night {
        p.push_str("现在是深夜。");
    }
    if let Some(m) = memory {
        p.push_str(&format!("\n今天你们一起度过：{m}"));
    }
    if let Some(h) = ctx.habit {
        // 熟悉感，不是事实：只说「你习惯了…」，不许拿来下判断
        p.push_str(&format!("\n你们相处久了，知道主人的习惯：{h}。"));
    }
    p.push_str(&format!(
        "\n说一句你当下的感受或想说的话。要求：{length_rule}；不用emoji；\
不评价主人的表现；不要复述上面的状态；不要猜测主人的职业或身份，\
也不要提到任何具体工种；像活物，不像助手。\
只输出这一句话。",
    ));
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 遍历全部（人格 × 心情 × 活动）并多次取样，收集能取到的所有语料。
    fn all_lines() -> Vec<&'static str> {
        let mut out = Vec::new();
        for persona in [Persona::Quiet, Persona::Reserved, Persona::Occasional, Persona::Chatty] {
            for mood in [Mood::Content, Mood::Focused, Mood::Bored, Mood::Frustrated] {
                for act in [
                    Activity::Thinking,
                    Activity::Listening,
                    Activity::Slacking,
                    Activity::Working,
                ] {
                    // 24 次取样足以覆盖单个候选池的全部条目
                    for i in 0..24 {
                        if let Some(line) = pick_local(persona, mood, act, i as f64 / 24.0) {
                            out.push(line);
                        }
                    }
                }
            }
        }
        out
    }

    /// 只有提到具体工种的词才算「编程语料」。
    const CODING_WORDS: &[&str] = &["代码", "写码", "写", "bug", "报错", "程序"];

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
        assert!(pick_local(Persona::Chatty, Mood::Content, Activity::Working, 0.5).is_some());
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
        assert!(pick_local(Persona::Occasional, Mood::Content, Activity::Working, 0.5).is_some());
    }

    #[test]
    fn 完全无匹配的组合返回无() {
        assert!(pick_local(Persona::Quiet, Mood::Focused, Activity::Slacking, 0.5).is_none());
    }

    #[test]
    fn 不同rng倾向给出不同语料() {
        let mut seen = std::collections::HashSet::new();
        for i in 0..10 {
            if let Some(line) =
                pick_local(Persona::Chatty, Mood::Bored, Activity::Slacking, i as f64 / 10.0)
            {
                seen.insert(line);
            }
        }
        assert!(seen.len() >= 2, "随机应能覆盖多条语料，实际 {seen:?}");
    }

    #[test]
    fn 本地语料全中性_不出现任何工种词() {
        // 个性化只交给 LLM：本地语料对所有人一视同仁，
        // 绝不该冒出「代码/bug/写顺了」
        for line in all_lines() {
            for bad in CODING_WORDS {
                assert!(!line.contains(bad), "中性语料里出现了工种词「{bad}」：{line}");
            }
        }
    }

    #[test]
    fn 每个有话说的格子至少四条语料() {
        // 硬编码语料量有限，格子太薄两三轮就听腻了
        for persona in [Persona::Reserved, Persona::Occasional, Persona::Chatty] {
            for mood in [Mood::Content, Mood::Focused, Mood::Bored, Mood::Frustrated] {
                for act in [
                    Activity::Thinking,
                    Activity::Listening,
                    Activity::Slacking,
                    Activity::Working,
                ] {
                    let seen: std::collections::HashSet<&str> = (0..24)
                        .filter_map(|i| pick_local(persona, mood, act, i as f64 / 24.0))
                        .collect();
                    if seen.is_empty() {
                        continue; // 该组合本就沉默（安静人格大多如此）
                    }
                    assert!(
                        seen.len() >= 4,
                        "{persona:?}×{mood:?}×{act:?} 只有 {} 条：{seen:?}",
                        seen.len()
                    );
                }
            }
        }
    }

    #[test]
    fn 兜底池任何人格都有话说() {
        // 频率硬性要求：三维选取落空时兜底必出话（安静档不出场，但仍应有料）
        for p in [Persona::Quiet, Persona::Reserved, Persona::Occasional, Persona::Chatty] {
            assert!(fallback(p, 0.5).is_some(), "{p:?} 兜底池为空");
            // 兜底也不该只有一条 —— 否则重复太快就腻了
            assert!(
                fallback(p, 0.0) != fallback(p, 0.99),
                "{p:?} 兜底池没有随机性"
            );
        }
    }

    /// 默认上下文：未填写身份，其余取最常见的组合。
    fn ctx(persona: Persona, user_kind: &'static str) -> PromptCtx<'static> {
        PromptCtx {
            persona,
            mood: Mood::Focused,
            activity: Activity::Working,
            doing: crate::state::Doing::Editing,
            tempo: crate::state::Tempo::Normal,
            late_night: false,
            keystrokes_per_min: 30.0,
            user_kind,
            habit: None,
        }
    }

    #[test]
    fn 唠唠prompt要求玩梗与长度浮动() {
        let p = system_prompt(&ctx(Persona::Chatty, ""), None);
        assert!(p.contains("15到30个字"), "{p}");
        assert!(p.contains("网络梗"), "{p}");
        assert!(p.contains("损友"), "{p}");
    }

    #[test]
    fn 安静人格prompt长度更短() {
        assert!(system_prompt(&ctx(Persona::Quiet, ""), None).contains("不超过10个字"));
    }

    #[test]
    fn system_prompt_包含人格风格与状态上下文() {
        let mut c = ctx(Persona::Occasional, "");
        c.mood = Mood::Frustrated;
        c.activity = Activity::Thinking;
        c.tempo = crate::state::Tempo::Stuck;
        c.keystrokes_per_min = 10.0;
        let p = system_prompt(&c, None);
        assert!(p.contains("偶尔说一句"));
        assert!(p.contains("烦躁"));
        assert!(p.contains("思考"));
        assert!(p.contains("15个字"));
        assert!(p.contains("不评价"));
    }

    #[test]
    fn system_prompt_包含主人的行为与节奏() {
        let mut c = ctx(Persona::Chatty, "");
        c.mood = Mood::Content;
        c.tempo = crate::state::Tempo::Flow;
        c.keystrokes_per_min = 200.0;
        let p = system_prompt(&c, None);
        assert!(p.contains("进入了状态"), "{p}");
        assert!(p.contains("手速很快"), "{p}");
    }

    #[test]
    fn system_prompt_带上当日记忆与疲劳推断() {
        let p = system_prompt(
            &ctx(Persona::Occasional, ""),
            Some("今天专注了约3小时，记了5条速记。看起来有点累了"),
        );
        assert!(p.contains("今天你们一起度过"), "{p}");
        assert!(p.contains("有点累"), "{p}");
    }

    #[test]
    fn system_prompt_深夜有标记() {
        let mut c = ctx(Persona::Quiet, "");
        c.late_night = true;
        let p = system_prompt(&c, None);
        assert!(p.contains("深夜"), "{p}");
    }

    #[test]
    fn prompt能说出主人正在做的具体的事() {
        // 「根据正在做的事交互」的核心：不同的事要给出不同的描述
        use crate::state::Doing;
        let cases = [
            (Doing::Editing, "编辑器"),
            (Doing::Writing, "写文档"),
            (Doing::Designing, "做设计"),
            (Doing::Data, "表格"),
            (Doing::Messaging, "聊天"),
            (Doing::Browsing, "阅读"),
            (Doing::Watching, "视频"),
            (Doing::Other, "别的事"),
            (Doing::Away, "不在电脑前"),
        ];
        let mut seen = std::collections::HashSet::new();
        for (doing, word) in cases {
            let mut c = ctx(Persona::Occasional, "");
            c.doing = doing;
            let p = system_prompt(&c, None);
            assert!(p.contains(word), "{doing:?} 应描述为含「{word}」：{p}");
            seen.insert(word);
        }
        // 九种事必须有九种说法，不能两种事共用一句
        assert_eq!(seen.len(), cases.len(), "不同类别的事应有不同措辞");
    }

    #[test]
    fn 未填写身份时prompt不假设任何职业() {
        // 不预设身份是硬要求：没填就不能出现任何工种词
        let p = system_prompt(&ctx(Persona::Chatty, ""), None);
        for bad in ["写代码", "程序员", "代码", "设计师", "开发"] {
            assert!(!p.contains(bad), "未填身份时不得出现职业假设「{bad}」：{p}");
        }
        assert!(p.contains("不了解主人是做什么的"), "{p}");
        assert!(p.contains("不要猜测"), "{p}");
    }

    #[test]
    fn 填写了身份时prompt原样带上主人的自述() {
        let p = system_prompt(&ctx(Persona::Occasional, "在做电商运营"), None);
        assert!(p.contains("在做电商运营"), "{p}");
        assert!(!p.contains("不了解主人是做什么的"), "{p}");
    }
}
