//! 今日特效奖励：认真休息的奖励，隔天（自然日）失效。
//!
//! 与配置分开存（rewards.json）—— 奖励是「今天挣来的」，
//! 不是用户设置，不该出现在设置面板里。
//! 随机发放、可叠加：每个合格的休息都可能得一个新特效，
//! 全部集齐后不再重复发。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use rand::seq::SliceRandom;
use tauri::{AppHandle, Manager};

/// 奖励特效事件名。前端据此给宠物换外观。
pub const EVENT_REWARDS: &str = "pet://rewards";

/// 特效种类。前端按小写名渲染对应动画。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RewardEffect {
    /// 嘴里时不时吃番茄。
    Tomato,
    /// 头顶吐泡泡。
    Bubbles,
    /// 身上偶尔闪星星。
    Sparkle,
}

impl RewardEffect {
    pub fn all() -> [RewardEffect; 3] {
        [RewardEffect::Tomato, RewardEffect::Bubbles, RewardEffect::Sparkle]
    }

    /// 中文名，供提示文案。
    pub fn label(&self) -> &'static str {
        match self {
            RewardEffect::Tomato => "吃番茄",
            RewardEffect::Bubbles => "吐泡泡",
            RewardEffect::Sparkle => "星星闪",
        }
    }

    /// emoji，供提示文案。
    pub fn emoji(&self) -> &'static str {
        match self {
            RewardEffect::Tomato => "🍅",
            RewardEffect::Bubbles => "🫧",
            RewardEffect::Sparkle => "✨",
        }
    }
}

/// 当日奖励状态。date 不同即视为全部过期。
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RewardsState {
    /// "YYYY-MM-DD"。跨天即清零。
    pub date: String,
    pub effects: Vec<RewardEffect>,
}

/// 前端展示用的载荷。
#[derive(serde::Serialize, Clone)]
pub struct RewardsEvent {
    /// 当前生效的全部特效（含刚获得的）。
    pub effects: Vec<RewardEffect>,
    /// 刚获得的新特效；None 表示只是同步状态。
    pub granted: Option<RewardEffect>,
}

static CACHE: Mutex<Option<RewardsState>> = Mutex::new(None);

fn rewards_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("rewards.json"))
}

/// 启动时载入。文件损坏按无奖励处理 —— 奖励丢了不致命。
pub fn init(app: &AppHandle) {
    let state = rewards_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<RewardsState>(&t).ok())
        .unwrap_or_default();
    if let Ok(mut g) = CACHE.lock() {
        *g = Some(state);
    }
}

/// 今日生效的特效。跨天自动清零。
pub fn today_effects(today: &str) -> Vec<RewardEffect> {
    let Ok(g) = CACHE.lock() else { return Vec::new() };
    match g.as_ref() {
        Some(s) if s.date == today => s.effects.clone(),
        _ => Vec::new(),
    }
}

/// 随机发放一个尚未拥有的特效。全部集齐返回 None。
///
/// 随机性来自洗牌取首个 —— 每种概率相等，且保证不重复。
pub fn grant_random(app: &AppHandle, today: &str) -> Option<RewardEffect> {
    let owned = today_effects(today);
    let mut pool: Vec<RewardEffect> = RewardEffect::all()
        .into_iter()
        .filter(|e| !owned.contains(e))
        .collect();
    pool.shuffle(&mut rand::thread_rng());
    let picked = pool.first().copied()?;

    let mut next = RewardsState {
        date: today.to_string(),
        effects: owned,
    };
    next.effects.push(picked);

    if let Ok(mut g) = CACHE.lock() {
        *g = Some(next.clone());
    }
    if let Some(p) = rewards_path(app) {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&next) {
            let _ = fs::write(&p, text);
        }
    }
    Some(picked)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() {
        if let Ok(mut g) = CACHE.lock() {
            *g = Some(RewardsState::default());
        }
    }

    #[test]
    fn 跨天特效清零() {
        fresh();
        if let Ok(mut g) = CACHE.lock() {
            *g = Some(RewardsState {
                date: "2026-08-29".into(),
                effects: vec![RewardEffect::Tomato],
            });
        }
        assert!(today_effects("2026-08-30").is_empty(), "隔天必须失效");
        assert_eq!(
            today_effects("2026-08-29"),
            vec![RewardEffect::Tomato],
            "同一天应保留"
        );
    }

    #[test]
    fn 空状态无特效() {
        fresh();
        assert!(today_effects("2026-08-30").is_empty());
    }

    #[test]
    fn 特效枚举序列化为小写() {
        assert_eq!(
            serde_json::to_string(&RewardEffect::Tomato).unwrap(),
            "\"tomato\""
        );
        let e: RewardEffect = serde_json::from_str("\"bubbles\"").unwrap();
        assert_eq!(e, RewardEffect::Bubbles);
    }
}
