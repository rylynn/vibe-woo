//! 版本信息：「关于」面板的数据源。
//!
//! 版本号只有一个真源 —— tauri.conf.json 的 `version`（即打包产物的版本，
//! 与 Cargo.toml、package.json 三处保持同步）。这里读运行期配置而非编译期
//! 常量，改版本只需改配置，不必碰代码。
//!
//! 构建时间与 git 哈希由 build.rs 注入，缺失时回落 "unknown"。

use serde::Serialize;
use tauri::AppHandle;

/// 关于面板展示的全部信息。字段与前端 `AppInfo` 一一对应。
#[derive(Debug, Serialize)]
pub struct AppInfo {
    /// 产品名（productName）。
    pub name: String,
    /// 版本号，形如 "0.1.0"。
    pub version: String,
    /// 包标识符，形如 "dev.vibepet.app"。
    pub identifier: String,
    /// 构建时间（UTC），形如 "2026-09-01 12:34:56Z"。
    pub build_time: String,
    /// 构建时的 git 短哈希，拿不到时为 "unknown"。
    pub git_hash: String,
    /// 构建档：debug / release。
    pub profile: String,
    /// 操作系统与架构，形如 "macos · aarch64"。
    pub platform: String,
}

#[tauri::command]
pub fn get_app_info(app: AppHandle) -> AppInfo {
    let cfg = app.config();
    AppInfo {
        name: cfg
            .product_name
            .clone()
            .unwrap_or_else(|| "Vibe Pet".to_string()),
        version: cfg.version.clone().unwrap_or_else(fallback_version),
        identifier: cfg.identifier.clone(),
        build_time: env_or_unknown(option_env!("PET_BUILD_TIME")),
        git_hash: env_or_unknown(option_env!("PET_GIT_HASH")),
        profile: if cfg!(debug_assertions) {
            "debug".to_string()
        } else {
            "release".to_string()
        },
        platform: format!("{} · {}", std::env::consts::OS, std::env::consts::ARCH),
    }
}

/// tauri.conf.json 里没写 version 时的兜底。宁可显示个粗略值，
/// 也不要让「关于」里空一块 —— 用户报障时是照着这里抄版本号的。
fn fallback_version() -> String {
    format!("{} (未声明)", env!("CARGO_PKG_VERSION"))
}

/// build.rs 未注入（比如跳过了构建脚本）时落成 "unknown"。
fn env_or_unknown(v: Option<&'static str>) -> String {
    match v {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => "unknown".to_string(),
    }
}
