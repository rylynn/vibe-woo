//! 插件系统契约与注册表。
//!
//! 解耦三原则（设计文档 docs/plans/2026-09-02-plugin-system-design.md 第 3 节）：
//! 宿主不认识具体插件（只认 trait）；仲裁器不认识具体插件（只认优先级与
//! 频率）；前端渲染器不认识 Rust（只认 PluginCard 的 JSON 契约）。

// P1 骨架的接口先于使用者落地（P2 番茄迁移起逐一被引用），
// 期间的 dead_code 告警统一豁免，避免淹没真正的告警。
#![allow(dead_code)]

pub mod arbiter;
pub mod host;
pub mod news;
pub mod pomodoro;
pub mod stocks;
pub mod store;
pub mod words;

use std::time::Duration;

use serde::Serialize;

/// 插件卡片事件名。前端按 payload.kind 找渲染器。
pub const EVENT_PLUGIN_CARD: &str = "pet://plugin-card";

/// 卡片优先级。由插件在产出时自己标注，仲裁器只消费不计算 ——
/// 「这条要不要压过闲聊」是插件自己的判断。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    Normal,
    High,
}

/// 一张想展示的卡片。跨 IPC 的唯一契约。
#[derive(Debug, Clone, Serialize)]
pub struct PluginCard {
    pub plugin_id: String,
    /// 前端渲染器注册表的 key。
    pub kind: String,
    pub priority: Priority,
    /// 气泡停留秒数。
    pub ttl_secs: u32,
    /// 各插件自定义的展示数据。
    pub payload: serde_json::Value,
}

/// `pet://plugin-card` 事件载荷。
///
/// deferred_count > 1 表示这是延迟合并后的补发（「刚才攒了 N 条」），
/// 正常路径恒为 0。
#[derive(Debug, Clone, Serialize)]
pub struct CardEvent {
    #[serde(flatten)]
    pub card: PluginCard,
    pub deferred_count: u32,
}

/// 插件元信息：plugin_summary 命令的返回项（左键面板 / 设置用）。
#[derive(Debug, Clone, Serialize)]
pub struct PluginMeta {
    pub id: String,
    pub name: String,
    /// 前端渲染器 key（与 PluginCard.kind 同源）。
    pub kind: String,
    /// 当日汇总数据（左键面板分区内容），由插件从自己的缓存拼装。
    pub summary: serde_json::Value,
}

/// 插件接口。所有网络 / LLM 调用只发生在 tick 里；
/// next_tick 必须是纯查询（无副作用），宿主可能反复问。
pub trait Plugin: Send {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    /// 距下次 tick 的时长；零 = 立即；None = 本轮不参与
    ///（如被禁用），宿主下个空闲轮询再来问。
    fn next_tick(&self, ctx: &ScheduleCtx) -> Option<Duration>;
    /// 执行一轮取数并决定此刻想发什么。
    fn tick(&mut self, ctx: &mut TickCtx) -> Vec<PluginCard>;
}

/// next_tick 的只读环境。
pub struct ScheduleCtx {
    pub now: std::time::Instant,
}

/// tick 的受控环境。config()/llm() 随需要时再扩展（YAGNI）——
/// 目前插件经 store 直接读写自己的配置文件。
pub struct TickCtx<'a> {
    pub app: &'a tauri::AppHandle,
}

impl TickCtx<'_> {
    /// 通知仲裁器番茄是否处于工作期（进入休息时自动补发延迟队列）。
    ///
    /// 这是全系统唯一的插件→仲裁器特例（设计文档 6.4）：
    /// 「工作期静默」的闸门需要有人置位，而只有番茄插件知道相位。
    pub fn set_pomodoro_phase(&self, working: bool) {
        arbiter::on_pomodoro_phase(self.app, working);
    }

    /// 当前宠物状态（doing / tempo 等），供插件做时间窗判断。
    /// 测不到（感知未就绪）返回 None，插件自行决定沉默。
    pub fn state(&self) -> Option<crate::state::PetState> {
        crate::sensedrive::shared_state()
    }
}

/// 已安装插件清单（注册点：加插件在此与 host::registry 各加一行）。
pub fn installed(app: &tauri::AppHandle) -> Vec<PluginMeta> {
    vec![
        pomodoro::meta(app),
        words::meta(app),
        news::meta(app),
        stocks::meta(app),
    ]
}

/// 左键面板的一次性汇总：Rust 从各插件缓存拼装，不现场拉网。
#[tauri::command]
pub fn plugin_summary(app: tauri::AppHandle) -> Vec<PluginMeta> {
    installed(&app)
}

/// 读某插件的配置（设置表单用）。未知插件报错。
#[tauri::command]
pub fn plugin_get_config(
    app: tauri::AppHandle,
    id: String,
) -> Result<serde_json::Value, String> {
    match id.as_str() {
        pomodoro::ID => {
            serde_json::to_value(pomodoro::load_config(&app)).map_err(|e| e.to_string())
        }
        words::ID => {
            serde_json::to_value(words::load_config(&app)).map_err(|e| e.to_string())
        }
        news::ID => serde_json::to_value(news::load_config(&app)).map_err(|e| e.to_string()),
        stocks::ID => {
            serde_json::to_value(stocks::load_config(&app)).map_err(|e| e.to_string())
        }
        _ => Err(format!("未知插件：{id}")),
    }
}

/// 写某插件的配置。插件在下一个 tick 读到新值（≤30s 生效）。
#[tauri::command]
pub fn plugin_set_config(
    app: tauri::AppHandle,
    id: String,
    cfg: serde_json::Value,
) -> Result<(), String> {
    match id.as_str() {
        pomodoro::ID => {
            let c: pomodoro::PomodoroConfig = serde_json::from_value(cfg)
                .map_err(|e| format!("配置不合法：{e}"))?;
            store::save(&app, pomodoro::ID, &c)
        }
        words::ID => {
            let c: words::WordsConfig = serde_json::from_value(cfg)
                .map_err(|e| format!("配置不合法：{e}"))?;
            store::save(&app, words::ID, &c)
        }
        news::ID => {
            let c: news::NewsConfig = serde_json::from_value(cfg)
                .map_err(|e| format!("配置不合法：{e}"))?;
            store::save(&app, news::ID, &c)
        }
        stocks::ID => {
            let c: stocks::StocksConfig = serde_json::from_value(cfg)
                .map_err(|e| format!("配置不合法：{e}"))?;
            store::save(&app, stocks::ID, &c)
        }
        _ => Err(format!("未知插件：{id}")),
    }
}
