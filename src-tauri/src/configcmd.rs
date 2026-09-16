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
    pub auto_update: bool,
    pub notes_vault: String,
    pub reminders: Vec<crate::reminder::Reminder>,
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
    /// 全局快捷键（速记 / 提醒 / 插件面板），存储格式见 shortcut.rs::parse。
    pub shortcut_note: String,
    pub shortcut_reminder: String,
    pub shortcut_hub: String,
    /// 取词（读取其他应用选区）与屏幕框选 OCR 的快捷键。
    pub shortcut_selection: String,
    pub shortcut_ocr: String,
    /// 取词翻译方向，默认英译中。
    pub translation_direction: config::TranslationDirection,
    /// 取词搜索引擎。
    pub search_engine: config::SearchEngine,
}

fn to_view(c: &Config) -> ConfigView {
    ConfigView {
        size_index: c.size_index,
        roam_scope: c.roam_scope,
        persona: c.persona,
        user_kind: c.user_kind.clone(),
        autostart: c.autostart,
        auto_update: c.auto_update,
        notes_vault: c.notes_vault.clone(),
        reminders: c.reminders.clone(),
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
        shortcut_note: c.shortcut_note.clone(),
        shortcut_reminder: c.shortcut_reminder.clone(),
        shortcut_hub: c.shortcut_hub.clone(),
        shortcut_selection: c.shortcut_selection.clone(),
        shortcut_ocr: c.shortcut_ocr.clone(),
        translation_direction: c.translation_direction,
        search_engine: c.search_engine,
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
    pub auto_update: Option<bool>,
    pub notes_vault: Option<String>,
    pub reminders: Option<Vec<crate::reminder::Reminder>>,
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
    pub shortcut_note: Option<String>,
    pub shortcut_reminder: Option<String>,
    pub shortcut_hub: Option<String>,
    pub shortcut_selection: Option<String>,
    pub shortcut_ocr: Option<String>,
    pub translation_direction: Option<config::TranslationDirection>,
    pub search_engine: Option<config::SearchEngine>,
}

/// 校验配置中全部自定义快捷键（格式 / 冲突 / 逃生键占用）。
fn validate_config_shortcuts(cfg: &Config) -> Result<(), String> {
    crate::shortcut::validate_shortcuts(&[
        ("速记", cfg.shortcut_note.as_str()),
        ("提醒", cfg.shortcut_reminder.as_str()),
        ("插件面板", cfg.shortcut_hub.as_str()),
        ("取词", cfg.shortcut_selection.as_str()),
        ("框选识别", cfg.shortcut_ocr.as_str()),
    ])
}

/// 把五个快捷键字段恢复为 old 的值（注册失败回退用）。
fn restore_shortcuts(cfg: &mut Config, old: &Config) {
    cfg.shortcut_note = old.shortcut_note.clone();
    cfg.shortcut_reminder = old.shortcut_reminder.clone();
    cfg.shortcut_hub = old.shortcut_hub.clone();
    cfg.shortcut_selection = old.shortcut_selection.clone();
    cfg.shortcut_ocr = old.shortcut_ocr.clone();
}

/// 把补丁应用到配置副本。返回快捷键是否被改动。纯函数（消耗 patch），无副作用。
fn apply_patch(cfg: &mut Config, patch: ConfigPatch) -> bool {
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
    if let Some(v) = patch.auto_update {
        cfg.auto_update = v;
    }
    if let Some(v) = patch.reminders {
        cfg.reminders = v;
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
    if let Some(v) = patch.translation_direction {
        cfg.translation_direction = v;
    }
    if let Some(v) = patch.search_engine {
        cfg.search_engine = v;
    }

    let mut shortcuts_changed = false;
    if let Some(v) = patch.shortcut_note {
        cfg.shortcut_note = v;
        shortcuts_changed = true;
    }
    if let Some(v) = patch.shortcut_reminder {
        cfg.shortcut_reminder = v;
        shortcuts_changed = true;
    }
    if let Some(v) = patch.shortcut_hub {
        cfg.shortcut_hub = v;
        shortcuts_changed = true;
    }
    if let Some(v) = patch.shortcut_selection {
        cfg.shortcut_selection = v;
        shortcuts_changed = true;
    }
    if let Some(v) = patch.shortcut_ocr {
        cfg.shortcut_ocr = v;
        shortcuts_changed = true;
    }
    shortcuts_changed
}

#[tauri::command]
pub fn update_config(app: AppHandle, patch: ConfigPatch) -> Result<ConfigView, String> {
    let mut cfg = current();
    let old = cfg.clone();
    let shortcuts_changed = apply_patch(&mut cfg, patch);

    // 快捷键改动先做静态校验（格式 / 冲突 / 逃生键），不通过不落盘
    if shortcuts_changed {
        validate_config_shortcuts(&cfg)?;
    }

    config::save(&app, &cfg)?;
    if let Ok(mut g) = CURRENT.lock() {
        *g = Some(cfg.clone());
    }

    // 快捷键变了要立刻重新注册（先反注册旧的再注册新的，见 apply_from_config）。
    // 注册失败（多被其他应用占用）时回退到旧键位，避免用户失去全部快捷键，
    // 并以 Err 反馈设置页 —— 不能只写日志假装保存成功。
    if shortcuts_changed {
        let outcome = crate::shortcut::apply_from_config(&app);
        if !outcome.failures.is_empty() {
            restore_shortcuts(&mut cfg, &old);
            config::save(&app, &cfg)?;
            if let Ok(mut g) = CURRENT.lock() {
                *g = Some(cfg.clone());
            }
            crate::shortcut::apply_from_config(&app);
            let detail = outcome
                .failures
                .iter()
                .map(|(name, spec, _)| format!("{name}（{spec}）"))
                .collect::<Vec<_>>()
                .join("、");
            return Err(format!(
                "快捷键注册失败：{detail}，可能被其他应用占用，已保留原键位"
            ));
        }
    }

    let view = to_view(&cfg);
    // 通知前端应用新配置（尺寸、活跃度需要立即生效）
    let _ = app.emit(EVENT_CONFIG, &view);
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_patch_sets_text_tools_fields_and_flags_shortcut_change() {
        let mut cfg = Config::default();
        let patch = ConfigPatch {
            shortcut_selection: Some("Ctrl+Shift+T".into()),
            shortcut_ocr: Some("Ctrl+Shift+O".into()),
            translation_direction: Some(config::TranslationDirection::Zh2En),
            search_engine: Some(config::SearchEngine::Bing),
            ..Default::default()
        };
        let changed = apply_patch(&mut cfg, patch);
        assert!(changed, "改动了快捷键必须标记 changed");
        assert_eq!(cfg.shortcut_selection, "Ctrl+Shift+T");
        assert_eq!(cfg.shortcut_ocr, "Ctrl+Shift+O");
        assert_eq!(cfg.translation_direction, config::TranslationDirection::Zh2En);
        assert_eq!(cfg.search_engine, config::SearchEngine::Bing);
    }

    #[test]
    fn apply_patch_non_shortcut_change_does_not_flag() {
        let mut cfg = Config::default();
        let patch = ConfigPatch {
            search_engine: Some(config::SearchEngine::Baidu),
            translation_direction: Some(config::TranslationDirection::Zh2En),
            ..Default::default()
        };
        assert!(!apply_patch(&mut cfg, patch), "只改翻译方向/搜索引擎不应触发快捷键重注册");
    }

    #[test]
    fn validate_config_shortcuts_covers_new_fields() {
        let mut cfg = Config::default();
        assert!(validate_config_shortcuts(&cfg).is_ok(), "默认配置的五个快捷键应互不冲突");
        cfg.shortcut_selection = cfg.shortcut_note.clone();
        let err = validate_config_shortcuts(&cfg).unwrap_err();
        assert!(err.contains("取词") && err.contains("速记"), "报错要指明冲突双方：{err}");
    }

    #[test]
    fn restore_shortcuts_reverts_all_five() {
        let old = Config::default();
        let mut cfg = old.clone();
        cfg.shortcut_note = "Alt+X".into();
        cfg.shortcut_reminder = "Alt+Y".into();
        cfg.shortcut_hub = "Alt+Z".into();
        cfg.shortcut_selection = "Alt+S".into();
        cfg.shortcut_ocr = "Alt+D".into();
        restore_shortcuts(&mut cfg, &old);
        assert_eq!(cfg.shortcut_note, old.shortcut_note);
        assert_eq!(cfg.shortcut_reminder, old.shortcut_reminder);
        assert_eq!(cfg.shortcut_hub, old.shortcut_hub);
        assert_eq!(cfg.shortcut_selection, old.shortcut_selection);
        assert_eq!(cfg.shortcut_ocr, old.shortcut_ocr);
    }

    #[test]
    fn to_view_includes_text_tools_fields() {
        let mut cfg = Config::default();
        cfg.translation_direction = config::TranslationDirection::Zh2En;
        cfg.search_engine = config::SearchEngine::Bing;
        let view = to_view(&cfg);
        assert_eq!(view.shortcut_selection, "Ctrl+Alt+T");
        assert_eq!(view.shortcut_ocr, "Ctrl+Alt+O");
        assert_eq!(view.translation_direction, config::TranslationDirection::Zh2En);
        assert_eq!(view.search_engine, config::SearchEngine::Bing);
    }
}
