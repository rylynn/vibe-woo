//! 配置相关的前后端命令。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::config::{self, Config, USER_KIND_MAX_CHARS};

/// 配置变更推送事件名。
pub const EVENT_CONFIG: &str = "pet://config";

static CURRENT: Mutex<Option<Config>> = Mutex::new(None);

/// 配置版本号，每次写入内存递增。
///
/// 采样循环每 120ms 跑一轮，每轮 `current()` 都要 clone 整个 Config
/// （含三个 Vec<String>）。高频纯读取不该付这个代价 ——
/// 让调用方用版本号判断，只在真正变更时重建派生数据。
static VERSION: AtomicU64 = AtomicU64::new(1);

/// 当前配置版本。变化即意味着配置被改过。
pub fn config_version() -> u64 {
    VERSION.load(Ordering::Relaxed)
}

/// 启动时载入配置到内存。
pub fn init(app: &AppHandle) -> Config {
    let cfg = config::load(app);
    set_current(&cfg);
    cfg
}

/// 取当前配置的副本。
pub fn current() -> Config {
    CURRENT
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default()
}

/// 直接替换内存中的当前配置（socialcmd 登录等直接写 token 的通道）。
/// 调用方负责先 config::save 落盘。
pub fn set_current(cfg: &Config) {
    if let Ok(mut g) = CURRENT.lock() {
        *g = Some(cfg.clone());
    }
    VERSION.fetch_add(1, Ordering::Relaxed);
}

/// 供前端展示的配置。api_key 已掩码，绝不把明文送进 webview ——
/// 录屏和截图会意外泄漏。
#[derive(Debug, Serialize)]
pub struct ConfigView {
    pub size_index: usize,
    pub roam_scope: config::RoamScope,
    pub persona: config::Persona,
    /// 用户自述的「在忙什么」。空串 = 未填写，宠物不预设任何身份。
    pub user_kind: String,
    pub autostart: bool,
    pub notes_vault: String,
    pub reminders: Vec<crate::reminder::Reminder>,
    pub pomodoro_enabled: bool,
    pub pomodoro_work_mins: u32,
    pub pomodoro_break_mins: u32,
    /// 习惯记忆开关。关掉后不再用 LLM 归纳作息与风格。
    pub habit_enabled: bool,
    pub coding_apps: Vec<String>,
    pub browsing_apps: Vec<String>,
    pub excluded_apps: Vec<String>,
    pub llm_base_url: String,
    pub llm_model: String,
    pub llm_protocol: config::LlmProtocol,
    pub llm_enabled: bool,
    pub llm_thinking: bool,
    /// 掩码后的 key，仅用于显示。
    pub llm_api_key_masked: String,
    /// 是否已配置 key。
    pub llm_has_key: bool,
    pub social_server: String,
    pub social_uid: String,
    pub social_nick: String,
    pub social_pet_name: String,
    pub social_register_date: String,
    pub social_invite_code: String,
    pub social_hidden: bool,
    /// 已领养的形象，None 表示首次安装未选择。
    pub avatar: Option<config::AvatarConfig>,
}

fn to_view(c: &Config) -> ConfigView {
    ConfigView {
        size_index: c.size_index,
        roam_scope: c.roam_scope,
        persona: c.persona,
        user_kind: c.user_kind.clone(),
        autostart: c.autostart,
        notes_vault: c.notes_vault.clone(),
        reminders: c.reminders.clone(),
        pomodoro_enabled: c.pomodoro.enabled,
        pomodoro_work_mins: c.pomodoro.work_mins,
        pomodoro_break_mins: c.pomodoro.break_mins,
        habit_enabled: c.habit_enabled,
        coding_apps: c.coding_apps.clone(),
        browsing_apps: c.browsing_apps.clone(),
        excluded_apps: c.excluded_apps.clone(),
        llm_base_url: c.llm.base_url.clone(),
        llm_model: c.llm.model.clone(),
        llm_protocol: c.llm.protocol,
        llm_enabled: c.llm.enabled,
        llm_thinking: c.llm.thinking,
        llm_api_key_masked: config::mask_key(&c.llm.api_key),
        llm_has_key: !c.llm.api_key.is_empty(),
        social_server: c.social.server.clone(),
        social_uid: c.social.uid.clone(),
        social_nick: c.social.nick.clone(),
        social_pet_name: c.social.pet_name.clone(),
        social_register_date: c.social.register_date.clone(),
        social_invite_code: c.social.invite_code.clone(),
        social_hidden: c.social.hidden,
        avatar: c.avatar.clone(),
    }
}

#[tauri::command]
pub fn get_config() -> ConfigView {
    to_view(&current())
}

/// 前端提交的配置改动。全部可选 —— 只改动到的字段。
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct ConfigPatch {
    pub size_index: Option<usize>,
    pub roam_scope: Option<config::RoamScope>,
    pub persona: Option<config::Persona>,
    /// Some("") 表示用户主动清空身份，回退到中性表达。
    pub user_kind: Option<String>,
    pub autostart: Option<bool>,
    pub notes_vault: Option<String>,
    pub reminders: Option<Vec<crate::reminder::Reminder>>,
    pub pomodoro_enabled: Option<bool>,
    pub pomodoro_work_mins: Option<u32>,
    pub pomodoro_break_mins: Option<u32>,
    pub habit_enabled: Option<bool>,
    pub coding_apps: Option<Vec<String>>,
    pub browsing_apps: Option<Vec<String>>,
    pub excluded_apps: Option<Vec<String>>,
    pub llm_base_url: Option<String>,
    pub llm_model: Option<String>,
    pub llm_protocol: Option<config::LlmProtocol>,
    pub llm_enabled: Option<bool>,
    pub llm_thinking: Option<bool>,
    /// 新的 api_key。None 表示不改动，Some("") 表示清空。
    pub llm_api_key: Option<String>,
    pub social_server: Option<String>,
    pub social_nick: Option<String>,
    pub social_hidden: Option<bool>,
    pub avatar: Option<config::AvatarConfig>,
}

#[tauri::command]
pub fn update_config(app: AppHandle, patch: ConfigPatch) -> Result<ConfigView, String> {
    let mut cfg = current();

    if let Some(v) = patch.size_index {
        // 越界会让 SIZE_STEPS 取到 undefined，宠物直接消失
        cfg.size_index = v.min(3);
    }
    if let Some(v) = patch.roam_scope {
        cfg.roam_scope = v;
    }
    if let Some(v) = patch.persona {
        cfg.persona = v;
    }
    if let Some(v) = patch.user_kind {
        // 超长文本会撑爆 prompt，也说明是误粘贴 —— 截断到 40 字符
        cfg.user_kind = v.chars().take(USER_KIND_MAX_CHARS).collect();
    }
    if let Some(v) = patch.autostart {
        cfg.autostart = v;
    }
    if let Some(v) = patch.reminders {
        cfg.reminders = v;
    }
    if let Some(v) = patch.pomodoro_enabled {
        cfg.pomodoro.enabled = v;
    }
    if let Some(v) = patch.pomodoro_work_mins {
        // 钳制到合理区间：太短失去意义，太长形同虚设
        cfg.pomodoro.work_mins = v.clamp(1, 120);
    }
    if let Some(v) = patch.pomodoro_break_mins {
        cfg.pomodoro.break_mins = v.clamp(1, 60);
    }
    if let Some(v) = patch.habit_enabled {
        cfg.habit_enabled = v;
    }
    if let Some(v) = patch.notes_vault {
        cfg.notes_vault = v;
    }
    if let Some(v) = patch.coding_apps {
        cfg.coding_apps = v;
    }
    if let Some(v) = patch.browsing_apps {
        cfg.browsing_apps = v;
    }
    if let Some(v) = patch.excluded_apps {
        cfg.excluded_apps = v;
    }
    if let Some(v) = patch.llm_base_url {
        cfg.llm.base_url = v;
    }
    if let Some(v) = patch.llm_model {
        cfg.llm.model = v;
    }
    if let Some(v) = patch.llm_protocol {
        cfg.llm.protocol = v;
    }
    if let Some(v) = patch.llm_enabled {
        cfg.llm.enabled = v;
    }
    if let Some(v) = patch.llm_thinking {
        cfg.llm.thinking = v;
    }
    if let Some(v) = patch.llm_api_key {
        cfg.llm.api_key = v;
    }
    if let Some(v) = patch.social_server {
        cfg.social.server = v;
    }
    if let Some(v) = patch.social_nick {
        cfg.social.nick = v;
    }
    if let Some(v) = patch.social_hidden {
        cfg.social.hidden = v;
    }
    if let Some(v) = patch.avatar {
        cfg.avatar = Some(v);
    }

    config::save(&app, &cfg)?;
    if let Ok(mut g) = CURRENT.lock() {
        *g = Some(cfg.clone());
    }

    let view = to_view(&cfg);
    // 通知前端应用新配置（尺寸、活跃度需要立即生效）
    let _ = app.emit(EVENT_CONFIG, &view);
    Ok(view)
}
