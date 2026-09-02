//! 宠物说话驱动：按人格频率，结合心情与活动冒一句。
//!
//! 双轨制：有 LLM 配置走 LLM，失败或未配置落回本地语料库，
//! 语料选不到时走兜底池 —— 频率是硬性要求：
//! 唠唠 1–3 分钟一句，其余人格最多 5 分钟必说一次。

use std::time::Duration;

use rand::Rng;
use tauri::{AppHandle, Emitter};

use crate::config::Persona;
use crate::configcmd;
use crate::persona;

/// 说话事件名。前端用气泡展示。
pub const EVENT_TALK: &str = "pet://talk";

#[derive(serde::Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum TalkSource {
    Llm,
    Local,
}

#[derive(serde::Serialize, Clone)]
pub struct Talk {
    pub text: String,
    pub source: TalkSource,
}

/// 各人格的说话间隔（秒）。频率是硬性要求：
/// 唠唠 1–3 分钟一句；安静/偶尔最多 5 分钟必须冒一次。
const TALK_GAP_SECS: [(Persona, u64, u64); 3] = [
    (Persona::Quiet, 240, 300),      // 4–5 分钟
    (Persona::Occasional, 180, 300), // 3–5 分钟
    (Persona::Chatty, 60, 180),      // 1–3 分钟
];

/// 没说上话（睡觉/串门/彻底无语料）时的短重试间隔。
/// 不消耗完整说话间隔 —— 回到电脑前能很快补上一句。
const RETRY_SECS: u64 = 30;

pub fn spawn(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let mut next_at = std::time::Instant::now() + Duration::from_secs(60);

        loop {
            std::thread::sleep(Duration::from_secs(5));
            let now = std::time::Instant::now();
            if now < next_at {
                continue;
            }

            let cfg = configcmd::current();

            let Some(s) = crate::sensedrive::shared_state() else {
                next_at = now + Duration::from_secs(RETRY_SECS);
                continue;
            };
            // 睡觉不说梦话；宠物不在家（去好友家串门了）不说；
            // 专注模式开着不说（用户已用系统开关表达「别打扰」）；
            // 开会 / 语音中也不说（安静陪伴）。都只是短重试，不消耗说话间隔。
            if s.doing == crate::state::Doing::Away
                || s.dnd_on
                || s.activity == crate::activity::Activity::Meeting
                || crate::socialdrive::is_away()
            {
                next_at = now + Duration::from_secs(RETRY_SECS);
                continue;
            }

            // 番茄工作期 / 刚展示过插件卡片：插件信息优先，闲聊让位
            //（2026-08-31 番茄设计 2.2：跳过不排队，本来就是闲聊，不积压）。
            // 同样只做短重试，不消耗说话间隔 —— 休息期只补一句，不连珠炮。
            if !crate::plugin::arbiter::allow_ambient() {
                next_at = now + Duration::from_secs(RETRY_SECS);
                continue;
            }

            let source;
            let text = match rt.block_on(async {
                if cfg.llm.api_key.is_empty() {
                    return None;
                }
                // 习惯记忆：观察久了总结的规律，置信度不足时内部返回 None
                let habit = crate::habitmemory::summary();
                let ctx = persona::PromptCtx {
                    persona: cfg.persona,
                    mood: s.mood,
                    activity: s.activity,
                    doing: s.doing,
                    tempo: s.tempo,
                    late_night: s.late_night,
                    keystrokes_per_min: s.keystrokes_per_min,
                    user_kind: &cfg.user_kind,
                    habit: habit.as_deref(),
                };
                let mem = crate::memory::summary(&crate::memory::snapshot());
                crate::llm::speak(&persona::system_prompt(&ctx, mem.as_deref()), &cfg.llm)
                    .await
            }) {
                Some(t) => {
                    source = TalkSource::Llm;
                    t
                }
                None => {
                    // LLM 不可用 → 本地语料；语料选不到 → 兜底池。
                    // 频率是硬性要求，非睡觉/串门期必有话说。
                    let rng: f64 = rand::thread_rng().gen();
                    match persona::pick_local(cfg.persona, s.mood, s.activity, rng)
                        .or_else(|| persona::fallback(cfg.persona, rng))
                    {
                        Some(t) => {
                            source = TalkSource::Local;
                            t.to_string()
                        }
                        None => {
                            next_at = now + Duration::from_secs(RETRY_SECS);
                            continue;
                        }
                    }
                }
            };

            // 只有真正说了话才推进完整间隔 —— 保证频率硬性要求
            let (lo, hi) = TALK_GAP_SECS
                .iter()
                .find(|(p, _, _)| *p == cfg.persona)
                .map(|(_, lo, hi)| (*lo, *hi))
                .unwrap_or((240, 300));
            next_at = now + Duration::from_secs(rand::thread_rng().gen_range(lo..=hi));

            eprintln!("[talk] {text}");
            let _ = app.emit(EVENT_TALK, Talk { text, source });
        }
    });
}
