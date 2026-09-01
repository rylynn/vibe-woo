//! 习惯分析驱动：每 12 小时用 LLM 归纳一次最近的行为统计。
//!
//! 这是全应用最慢的循环 —— 习惯是长期慢变量，一天分析两次足够，
//! 分析多了也只是重复花钱。调度骨架与 talkdrive 一致，区别只在周期。
//!
//! 原则同 llm.rs：失败静默。旧结论继续用，宠物不会因此少说话。

use std::time::{Duration, Instant};

use crate::configcmd;
use crate::habitmemory;
use crate::llm;

/// 分析周期。习惯是慢变量，12 小时一次足够。
const ANALYZE_INTERVAL: Duration = Duration::from_secs(12 * 60 * 60);
/// 检查间隔。12 小时的调度精度到分钟毫无压力。
const CHECK_INTERVAL: Duration = Duration::from_secs(60);
/// 首次分析的延迟：刚启动还没数据，先攒一会儿。
const FIRST_DELAY: Duration = Duration::from_secs(120);
/// 条件不满足（开关关着 / 数据不够 / 调用失败）时的重试间隔。
///
/// 比分析周期短得多：开关可能被重新打开，数据可能刚攒够。
const RETRY_INTERVAL: Duration = Duration::from_secs(600);

/// 分析用的 system prompt。
const SYSTEM: &str = r#"你是行为数据分析师。输入是某人电脑最近若干天的匿名使用统计，
只有：日期、星期、各小时的活跃秒数、各类应用的时长、专注段、以及当天触发的提醒文本。
其中不含任何窗口标题、文件与输入内容 —— 你只能依据这些做归纳。

请归纳他的工作与生活规律，只输出下面这个 JSON，不要输出任何其他内容：
{
  "workday_pattern": "工作日作息规律，40字内的中文短句",
  "weekend_pattern": "周末作息规律，40字内的中文短句",
  "typical_work_start": "HH:MM",
  "typical_work_end": "HH:MM",
  "daily_work_hours": 6.5,
  "reminder_habits": ["从提醒内容归纳的生活习惯短句，每条25字内，最多5条"],
  "app_style": "应用使用风格，40字内",
  "style_tags": ["2到4个风格标签，每个不超过6个字"],
  "confidence": 0.8
}

规则：
- 只认给出的数据。数据少、起伏大或自相矛盾时，把 confidence 调低（低于0.3），
  并少写断言 —— 宁可说「看不出规律」，也不要编。
- 不要推断职业、公司、具体工作内容，也不要评价这个人的习惯好坏。
- 提醒文本是用户自己写的待办，归纳成习惯即可，不要复述隐私细节。
- 没有把握的字段留空字符串或空数组，不要填空洞的套话。"#;

/// 启动习惯分析循环。
pub fn spawn(app: &tauri::AppHandle) {
    let app = app.clone();
    // 目录与缓存必须在感知循环跑起来之前就位
    habitmemory::init(&app);

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let mut next_at = Instant::now() + FIRST_DELAY;

        loop {
            std::thread::sleep(CHECK_INTERVAL);
            let now = Instant::now();
            if now < next_at {
                continue;
            }

            let cfg = configcmd::current();
            // 开关关着，或根本没接 LLM：不花这个钱
            if !cfg.habit_enabled || !cfg.llm.enabled || cfg.llm.api_key.is_empty() {
                next_at = now + RETRY_INTERVAL;
                continue;
            }

            // 先把今天累计中的部分写盘，分析才能看到最新数据
            habitmemory::flush();
            let days = habitmemory::load_days(habitmemory::WINDOW_DAYS);
            if days.len() < habitmemory::MIN_DAYS {
                eprintln!(
                    "[habit] 只有 {} 天数据，不足 {} 天，跳过本轮",
                    days.len(),
                    habitmemory::MIN_DAYS
                );
                next_at = now + RETRY_INTERVAL;
                continue;
            }

            let user = habitmemory::prompt_input(&days);
            let out = rt.block_on(llm::complete(&cfg.llm, SYSTEM, &user, true));

            match out {
                Ok(raw) => match habitmemory::parse_insight(&raw) {
                    Some(mut ins) => {
                        ins.updated_at = days.last().map(|d| d.date.clone()).unwrap_or_default();
                        eprintln!(
                            "[habit] 已更新习惯记忆（confidence={:.2}）：{}",
                            ins.confidence,
                            ins.narration().unwrap_or_default()
                        );
                        habitmemory::save_insight(&ins);
                        next_at = now + ANALYZE_INTERVAL;
                    }
                    None => {
                        eprintln!("[habit] 输出不是预期 JSON，保留旧结论");
                        next_at = now + RETRY_INTERVAL;
                    }
                },
                Err(e) => {
                    eprintln!("[habit] 分析失败，保留旧结论：{e}");
                    next_at = now + RETRY_INTERVAL;
                }
            }
        }
    });
}
