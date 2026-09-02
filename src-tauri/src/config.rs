//! 配置持久化。
//!
//! 存为 JSON 明文（用户已确认：API key 也存明文，仅 UI 展示时掩码）。
//! 位置遵循 macOS 惯例：~/Library/Application Support/dev.vibepet.app/

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 宠物人格档位。决定它主动说话的频率。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Persona {
    /// 只用动作表达，永不主动弹文字。默认。
    Quiet,
    /// 关键时刻冒一句短气泡。
    Occasional,
    /// 主动关心与提问。
    Chatty,
}

impl Default for Persona {
    fn default() -> Self {
        // 默认最安静 —— 第一次打开就被打扰是最差的第一印象
        Self::Quiet
    }
}

/// 用户自述「在忙什么」的最大字符数。
///
/// 这段文本会原文进入 system prompt —— 太长既挤占上下文，也说明是误粘贴。
/// 手改 config.json 能绕过 `update_config`，因此 `load` 里再兜一次。
pub const USER_KIND_MAX_CHARS: usize = 40;

/// LLM 请求协议。三种主流 API 形态各走各的端点与报文格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LlmProtocol {
    /// OpenAI Chat Completions（POST {base}/chat/completions）。
    /// 也是 DeepSeek / Kimi / Ollama 等兼容接口的事实标准。
    OpenaiCompletions,
    /// OpenAI Responses（POST {base}/responses）。
    OpenaiResponse,
    /// Anthropic Messages（POST {base}/v1/messages）。
    AnthropicMessages,
}

impl Default for LlmProtocol {
    fn default() -> Self {
        // 兼容旧配置与绝大多数 OpenAI 兼容服务
        Self::OpenaiCompletions
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LlmConfig {
    /// OpenAI 兼容端点。一套字段通吃 OpenAI / DeepSeek / Kimi / Ollama。
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub protocol: LlmProtocol,
    /// 总开关。关闭后说话/整理全部走本地，测试连接也会提示先启用。
    pub enabled: bool,
    /// 深度思考（opt-in）。开启时按协议标准参数申请思考预算：
    /// completions → enable_thinking，responses → reasoning.effort，
    /// anthropic → thinking.budget_tokens。
    /// 默认关闭 = 不附加任何字段，对任何后端零兼容风险。
    /// 注：部分模型（如 hy4-preview）无条件思考，该开关对它们无效果。
    pub thinking: bool,
}

impl Default for LlmConfig {
    fn default() -> Self {
        // 默认不接任何 LLM：空 key 即纯本地语料运行，零外发请求。
        // 仓库里绝不内置任何端点或密钥 —— 那是用户自己的东西。
        Self {
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            protocol: LlmProtocol::default(),
            enabled: false,
            thinking: false,
        }
    }
}

/// 社交配置。留空 server 即完全不启用（不联网）。
///
/// 账号体系：邀请码注册 → 永久会话 token。uid/注册日期来自服务端，
/// 本地只做缓存展示（「关于」页）。token 等同永久 cookie。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SocialConfig {
    /// 同步服务地址（Cloudflare Worker URL）。
    pub server: String,
    /// 服务端生成的数字 uid（8 位）。空表示未登录。
    pub uid: String,
    /// 永久会话 token。本地保存，等同永久 cookie。
    pub token: String,
    /// 登录账号（仅本地缓存展示，登录时不再需要输入）。
    pub account: String,
    /// 昵称（全局唯一，注册时确定，不可改）。
    pub nick: String,
    /// 宠物名（随时可改，改后异步同步到服务端）。
    pub pet_name: String,
    /// 注册日期（服务端返回，本地缓存）。
    pub register_date: String,
    /// 自己的邀请码（注册时服务端签发，可邀请一位好友注册）。
    pub invite_code: String,
    /// 隐身开关：开启后上报恒为 idle，连「在忙」都不说。
    pub hidden: bool,
}

/// 宠物的活动范围。
///
/// 比抽象的「活跃度」滑块更好理解 —— 用户真正关心的是「它会跑多远」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoamScope {
    /// 完全不动，纯挂件。
    Still,
    /// 只在原地附近小范围晃动。
    Nearby,
    /// 半屏范围内活动。
    Halfscreen,
    /// 整个屏幕都可以去。
    Fullscreen,
}

impl Default for RoamScope {
    fn default() -> Self {
        // 默认只在附近晃 —— 不打扰是第一原则，想让它跑远由用户主动选
        Self::Nearby
    }
}

/// 身体形状（形象维度，与前端 BodyShape 对齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BodyShape {
    Box,
    Round,
    Blob,
    Tall,
    Wide,
    /// 蘑菇：底宽顶窄。
    Shroom,
    /// 水滴：顶尖底圆。
    Drop,
}

/// 眼睛风格（长相维度，与 EyeShape 表情维度正交）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EyeStyle {
    Classic,
    Big,
    Dot,
    Almond,
    Sleepy,
}

/// 眉毛风格。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowStyle {
    None,
    Flat,
    Slanted,
    Arched,
    Bushy,
}

/// 动作风格：待机小动作的触发偏好。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionStyle {
    Calm,
    Bouncy,
    Curious,
}

/// 特征件：画在身体上沿的轮廓特征（从图片轮廓的顶部凸起识别）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Attachment {
    /// 无特征件。默认。
    #[default]
    None,
    /// 圆耳（熊/鼠）：顶部两个矮宽凸起。
    Ears,
    /// 尖耳（猫）：顶部两个高窄凸起。
    PointyEars,
    /// 角：顶部两侧尖锥。
    Horns,
    /// 触角：居中细杆顶珠。
    Antenna,
}

/// 身体颜色纹理（从图片双主色的空间分布识别）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pattern {
    /// 无纹理。默认。
    #[default]
    None,
    /// 条纹：次色按行聚集。
    Stripes,
    /// 斑点：次色分散分布。
    Spots,
}

/// 宠物形象配置（首次启动三选一选定后持久化）。
///
/// 全部为值语义小字段，前端渲染层据此程序化绘制；无外部资源引用。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AvatarConfig {
    pub shape: BodyShape,
    pub eye_style: EyeStyle,
    pub brow_style: BrowStyle,
    pub action_style: ActionStyle,
    /// 身体基色 #RRGGBB，状态色调在其上变换。
    pub body_color: String,
    /// 点缀色 #RRGGBB（高光/眉毛）。
    pub accent_color: String,
    /// 特征件。旧配置缺省为 None（渲染无变化）。
    #[serde(default)]
    pub attachment: Attachment,
    /// 身体纹理。旧配置缺省为 None。
    #[serde(default)]
    pub pattern: Pattern,
    /// 次色 #RRGGBB（纹理用色）；空串表示无。
    #[serde(default)]
    pub secondary_color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// 尺寸档位下标，对应 48/96/144/192 px。
    pub size_index: usize,
    /// 活动范围。
    pub roam_scope: RoamScope,
    pub persona: Persona,
    /// 用户自述的「平时主要在忙什么」。空串表示未填写 ——
    /// 此时不预设任何身份：宠物只描述正在做的事，绝不假设主人的职业。
    ///
    /// 只在本地使用（进 system prompt 与本地语料选取），不参与任何上报。
    pub user_kind: String,
    /// 开机自启。
    pub autostart: bool,
    /// Obsidian vault 目录（速记的额外落点）。空字符串表示不启用。
    pub notes_vault: String,
    /// 每日提醒列表。
    pub reminders: Vec<crate::reminder::Reminder>,
    /// 习惯记忆：每 12 小时用 LLM 归纳一次作息规律、生活习惯与应用风格，
    /// 作为宠物说话的物料。关掉只停分析，已积累的日志保留。
    ///
    /// 默认开 —— 但它只在 LLM 已启用时才真正发请求，不会凭空花钱。
    #[serde(default = "default_true")]
    pub habit_enabled: bool,
    /// 用户自定义的应用分类规则。
    pub coding_apps: Vec<String>,
    pub browsing_apps: Vec<String>,
    pub excluded_apps: Vec<String>,
    pub llm: LlmConfig,
    pub social: SocialConfig,
    /// 已领养的形象。None 表示首次安装尚未选择，前端据此弹选择窗。
    pub avatar: Option<AvatarConfig>,
}

/// 布尔字段的默认值：新功能默认开（详见 `Config::habit_enabled` 的注释）。
fn default_true() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            size_index: 1, // 96px
            roam_scope: RoamScope::default(),
            persona: Persona::default(),
            user_kind: String::new(),
            autostart: false,
            notes_vault: String::new(),
            reminders: Vec::new(),
            habit_enabled: true,
            coding_apps: Vec::new(),
            browsing_apps: Vec::new(),
            excluded_apps: Vec::new(),
            llm: LlmConfig::default(),
            social: SocialConfig::default(),
            avatar: None,
        }
    }
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("config.json"))
}

/// 读取配置。任何失败都回退到默认值 —— 配置损坏绝不能导致宠物起不来。
pub fn load(app: &AppHandle) -> Config {
    let Some(path) = config_path(app) else {
        return Config::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return Config::default();
    };
    let mut c = match serde_json::from_str::<Config>(&text) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[config] 解析失败，使用默认值：{e}");
            Config::default()
        }
    };
    // 手改配置文件可以绕过 update_config 的截断，这里统一收口
    c.user_kind = c.user_kind.chars().take(USER_KIND_MAX_CHARS).collect();
    c
}

/// 写入配置。
pub fn save(app: &AppHandle, cfg: &Config) -> Result<(), String> {
    let path = config_path(app).ok_or("无法确定配置目录")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let text =
        serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败：{e}"))?;
    fs::write(&path, text).map_err(|e| format!("写入失败：{e}"))?;
    Ok(())
}

/// 把 api_key 掩码后返回，供 UI 展示。
///
/// 明文存盘是用户明确同意的取舍，但界面上仍不应直接显示 —— 录屏、
/// 截图、演示时会意外泄漏。
pub fn mask_key(key: &str) -> String {
    let n = key.chars().count();
    if n == 0 {
        return String::new();
    }
    if n <= 8 {
        return "•".repeat(n);
    }
    let head: String = key.chars().take(3).collect();
    let tail: String = key.chars().skip(n - 4).collect();
    format!("{head}{}{tail}", "•".repeat(6))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 默认配置为安静人格与九十六像素() {
        let c = Config::default();
        assert_eq!(c.persona, Persona::Quiet, "首次打开不应打扰用户");
        assert_eq!(c.size_index, 1);
        assert!(!c.autostart, "不应默认开机自启");
    }

    #[test]
    fn 默认活动范围为附近而非全屏() {
        // 不打扰是第一原则，想让它跑远应由用户主动选择
        assert_eq!(Config::default().roam_scope, RoamScope::Nearby);
    }

    #[test]
    fn 空_key_掩码为空() {
        assert_eq!(mask_key(""), "");
    }

    #[test]
    fn 短_key_全部掩码() {
        assert_eq!(mask_key("abc"), "•••");
        assert_eq!(mask_key("12345678"), "••••••••");
    }

    #[test]
    fn 长_key_保留首尾便于辨识() {
        let masked = mask_key("sk-proj-1234567890abcdef");
        assert!(masked.starts_with("sk-"));
        assert!(masked.ends_with("cdef"));
        assert!(!masked.contains("1234567890"), "中段必须被掩码");
    }

    #[test]
    fn 协议枚举序列化为短横线小写() {
        let p = LlmProtocol::AnthropicMessages;
        assert_eq!(serde_json::to_string(&p).unwrap(), "\"anthropic-messages\"");
        let p: LlmProtocol = serde_json::from_str("\"openai-response\"").unwrap();
        assert_eq!(p, LlmProtocol::OpenaiResponse);
    }

    #[test]
    fn 旧配置缺协议字段时补默认值() {
        let json = r#"{"llm": {"base_url": "https://x/v1", "api_key": "k", "model": "m"}}"#;
        let c: Config = serde_json::from_str(json).unwrap();
        assert_eq!(c.llm.protocol, LlmProtocol::OpenaiCompletions);
        assert!(!c.llm.enabled, "缺省时 LLM 应关闭 —— 默认纯本地，不外发");
        assert!(!c.llm.thinking, "缺省时深度思考应为关闭");
    }

    #[test]
    fn 默认配置不内置任何端点与密钥() {
        // 仓库不能带任何 LLM 端点或 key：那属于使用者自己的凭据
        let c = Config::default();
        assert!(c.llm.base_url.is_empty());
        assert!(c.llm.api_key.is_empty());
        assert!(c.llm.model.is_empty());
        assert!(!c.llm.enabled, "未配置时不应发起任何外发请求");
    }

    #[test]
    fn 缺字段的配置能补齐默认值() {
        // serde(default) 保证旧版本配置文件不会因新增字段而失效
        let json = r#"{"size_index": 2}"#;
        let c: Config = serde_json::from_str(json).unwrap();
        assert_eq!(c.size_index, 2);
        assert_eq!(c.persona, Persona::Quiet);
        assert_eq!(c.roam_scope, RoamScope::Nearby);
        assert!(c.habit_enabled, "旧配置升级后习惯记忆应默认开启");
    }

    #[test]
    fn 习惯开关可关闭且能往返() {
        let mut c = Config::default();
        c.habit_enabled = false;
        let back: Config = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert!(!back.habit_enabled);
    }

    #[test]
    fn 旧配置缺身份字段时解析为空串而非预设() {
        // 不预设身份是硬要求：老用户升级后绝不能被当成程序员
        let c: Config = serde_json::from_str(r#"{"size_index": 2}"#).unwrap();
        assert!(c.user_kind.is_empty(), "缺省必须为空串，不能预设任何身份");
        assert!(Config::default().user_kind.is_empty());
    }

    #[test]
    fn 身份字段可往返序列化且空串能清空() {
        let mut c = Config::default();
        c.user_kind = "在做电商运营".into();
        let back: Config = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back.user_kind, "在做电商运营");

        // Some("") 表示用户主动清空，回退到中性
        let cleared: Config =
            serde_json::from_str(r#"{"user_kind": ""}"#).unwrap();
        assert!(cleared.user_kind.is_empty());
    }

    #[test]
    fn 旧社交配置的pet_id字段被忽略而不报错() {
        // 旧版有 pet_id/invite_code 字段；serde 默认忽略未知字段
        let json = r#"{"social": {"server": "https://x", "pet_id": "abc", "invite_code": "XX", "nick": "n", "hidden": true}}"#;
        let c: Config = serde_json::from_str(json).unwrap();
        assert_eq!(c.social.server, "https://x");
        assert_eq!(c.social.uid, ""); // 未登录
        assert!(c.social.hidden);
    }

    #[test]
    fn 登录态判断以uid和token为准() {
        let mut c = Config::default();
        assert!(c.social.uid.is_empty() && c.social.token.is_empty());
        c.social.uid = "12345678".into();
        c.social.token = "a".repeat(48);
        assert!(!c.social.uid.is_empty());
    }

    #[test]
    fn 空_json_也能解析为默认配置() {
        let c: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(c.size_index, 1);
    }

    #[test]
    fn 配置可往返序列化() {
        let mut c = Config::default();
        c.roam_scope = RoamScope::Halfscreen;
        c.persona = Persona::Occasional;
        c.coding_apps = vec!["com.foo.bar".into()];
        let text = serde_json::to_string(&c).unwrap();
        let back: Config = serde_json::from_str(&text).unwrap();
        assert_eq!(back.persona, Persona::Occasional);
        assert_eq!(back.coding_apps, vec!["com.foo.bar".to_string()]);
        assert_eq!(back.roam_scope, RoamScope::Halfscreen);
    }

    #[test]
    fn 旧配置无形象字段时解析为未选择() {
        // None 即「首次安装未领养」，前端据此弹出形象选择
        let c: Config = serde_json::from_str(r#"{"size_index": 2}"#).unwrap();
        assert!(c.avatar.is_none(), "旧配置应视为未选择形象");
        assert!(Config::default().avatar.is_none());
    }

    #[test]
    fn 形象配置往返序列化() {
        let mut c = Config::default();
        c.avatar = Some(AvatarConfig {
            shape: BodyShape::Round,
            eye_style: EyeStyle::Big,
            brow_style: BrowStyle::Flat,
            action_style: ActionStyle::Bouncy,
            body_color: "#A85232".into(),
            accent_color: "#FFE066".into(),
            attachment: Attachment::Ears,
            pattern: Pattern::Spots,
            secondary_color: "#7A3B22".into(),
        });
        let text = serde_json::to_string(&c).unwrap();
        let back: Config = serde_json::from_str(&text).unwrap();
        assert_eq!(back.avatar, c.avatar);
    }

    #[test]
    fn 形象枚举序列化为小写字符串与前端类型对齐() {
        assert_eq!(serde_json::to_string(&BodyShape::Blob).unwrap(), "\"blob\"");
        assert_eq!(serde_json::to_string(&EyeStyle::Almond).unwrap(), "\"almond\"");
        assert_eq!(serde_json::to_string(&BrowStyle::Bushy).unwrap(), "\"bushy\"");
        assert_eq!(
            serde_json::to_string(&ActionStyle::Curious).unwrap(),
            "\"curious\""
        );
        let s: BodyShape = serde_json::from_str("\"wide\"").unwrap();
        assert_eq!(s, BodyShape::Wide);
    }

    #[test]
    fn 形象字段名为snake_case与前端约定一致() {
        let a = AvatarConfig {
            shape: BodyShape::Tall,
            eye_style: EyeStyle::Sleepy,
            brow_style: BrowStyle::Arched,
            action_style: ActionStyle::Calm,
            body_color: "#112233".into(),
            accent_color: "#445566".into(),
            attachment: Attachment::None,
            pattern: Pattern::None,
            secondary_color: String::new(),
        };
        let v = serde_json::to_value(&a).unwrap();
        for key in [
            "shape",
            "eye_style",
            "brow_style",
            "action_style",
            "body_color",
            "accent_color",
            "attachment",
            "pattern",
            "secondary_color",
        ] {
            assert!(v.get(key).is_some(), "缺少字段 {key}");
        }
    }

    #[test]
    fn 旧形象配置缺新字段时补默认值且渲染无变化() {
        // 升级前保存的形象没有 attachment/pattern/secondary_color
        // 注意：颜色值含 `"#` 序列，原始字符串必须用 r## 避免提前终止
        let json = r##"{"shape":"round","eye_style":"big","brow_style":"flat","action_style":"calm","body_color":"#A85232","accent_color":"#FFE066"}"##;
        let a: AvatarConfig = serde_json::from_str(json).unwrap();
        assert_eq!(a.attachment, Attachment::None);
        assert_eq!(a.pattern, Pattern::None);
        assert!(a.secondary_color.is_empty(), "无纹理时次色为空串");
    }

    #[test]
    fn 特征件枚举序列化为kebab_case与前端对齐() {
        assert_eq!(
            serde_json::to_string(&Attachment::PointyEars).unwrap(),
            "\"pointy-ears\""
        );
        assert_eq!(serde_json::to_string(&Attachment::None).unwrap(), "\"none\"");
        assert_eq!(serde_json::to_string(&Pattern::Stripes).unwrap(), "\"stripes\"");
        let a: Attachment = serde_json::from_str("\"antenna\"").unwrap();
        assert_eq!(a, Attachment::Antenna);
    }

    #[test]
    fn 新形状枚举序列化与前端对齐() {
        assert_eq!(serde_json::to_string(&BodyShape::Shroom).unwrap(), "\"shroom\"");
        assert_eq!(serde_json::to_string(&BodyShape::Drop).unwrap(), "\"drop\"");
    }
}
