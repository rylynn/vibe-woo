//! 社交命令层：注册 / 登录 / 宠物改名 / 加删好友 / 召回。
//!
//! 安全要点：
//!   - 全部输入先过本地校验（account.rs），不合格不发起网络请求
//!   - 会话 token 走 `Authorization: Bearer` 头，绝不放 URL（日志泄漏面）
//!   - 密码只在注册/登录请求体内出现一次，不落盘
//!   - 服务端错误原样带回前端展示（气泡），不带内部细节

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::account;
use crate::configcmd;

#[derive(Debug, Serialize)]
pub struct AuthResult {
    pub uid: String,
    pub nick: String,
    pub pet_name: String,
    pub register_date: String,
    pub invite_code: String,
}

/// 注册/登录响应（服务端）。token 只写配置不回前端。
#[derive(Debug, Deserialize)]
struct AuthResp {
    uid: String,
    token: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    nick: String,
    #[serde(default)]
    pet_name: String,
    #[serde(default)]
    invite_code: String,
}

/// Unix 毫秒 → YYYY-MM-DD（civil_from_days 算法，无时区依赖）。
fn ms_to_date(ms: i64) -> String {
    let days = ms / 1000 / 86400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// 带鉴权的 POST。服务端 {error} 统一转为 Err 展示给用户。
async fn post_authed<T: serde::Serialize>(
    path: &str,
    body: &T,
) -> Result<serde_json::Value, String> {
    let cfg = configcmd::current();
    if cfg.social.server.is_empty() {
        return Err("请先在设置里填写服务器地址".into());
    }
    if cfg.social.token.is_empty() {
        return Err("请先登录".into());
    }
    let url = format!("{}{path}", cfg.social.server.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.social.token))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("网络错误：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取失败：{e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "响应解析失败".to_string())?;
    if !status.is_success() {
        return Err(v["error"].as_str().unwrap_or("请求失败").to_string());
    }
    if let Some(e) = v["error"].as_str() {
        return Err(e.to_string());
    }
    Ok(v)
}

/// 注册/登录成功后：写内存 + 落盘。
fn apply_auth(app: &AppHandle, r: &AuthResp, account: &str) -> Result<(), String> {
    let mut cur = configcmd::current();
    cur.social.account = account.to_string();
    cur.social.uid = r.uid.clone();
    cur.social.token = r.token.clone();
    cur.social.nick = r.nick.clone();
    cur.social.pet_name = r.pet_name.clone();
    cur.social.register_date = ms_to_date(r.created_at);
    cur.social.invite_code = r.invite_code.clone();
    crate::config::save(app, &cur)?;
    configcmd::set_current(&cur);
    Ok(())
}

async fn post_public(server: &str, path: &str, body: &serde_json::Value) -> Result<AuthResp, String> {
    let url = format!("{server}{path}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("网络错误：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取失败：{e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "响应解析失败".to_string())?;
    if !status.is_success() || v["error"].is_string() {
        return Err(v["error"].as_str().unwrap_or("请求失败").to_string());
    }
    serde_json::from_value(v).map_err(|_| "响应解析失败".to_string())
}

fn server_base() -> Result<String, String> {
    let cfg = configcmd::current();
    if cfg.social.server.is_empty() {
        return Err("请先在设置里填写服务器地址".into());
    }
    Ok(cfg.social.server.trim_end_matches('/').to_string())
}

/// 邀请码注册（首个使用邀请码的人）。
#[tauri::command]
pub async fn register(
    app: AppHandle,
    account: String,
    password: String,
    nick: String,
    invite_code: String,
) -> Result<AuthResult, String> {
    account::valid_account(&account)?;
    account::valid_password(&password)?;
    let nick = account::valid_nick(&nick)?;
    let invite = account::valid_invite(&invite_code)?;

    let base = server_base()?;
    let r = post_public(
        &base,
        "/register",
        &serde_json::json!({
            "account": account,
            "password": password,
            "nick": nick,
            "invite_code": invite,
        }),
    )
    .await?;

    apply_auth(&app, &r, &account)?;
    eprintln!("[social] 注册成功 uid={}", r.uid);
    Ok(AuthResult {
        uid: r.uid,
        nick: r.nick,
        pet_name: r.pet_name,
        register_date: ms_to_date(r.created_at),
        invite_code: r.invite_code,
    })
}

/// 登录。会话 token 永久有效，存本地配置。
#[tauri::command]
pub async fn login(
    app: AppHandle,
    account: String,
    password: String,
) -> Result<AuthResult, String> {
    account::valid_account(&account)?;
    account::valid_password(&password)?;

    let base = server_base()?;
    let r = post_public(
        &base,
        "/login",
        &serde_json::json!({ "account": account, "password": password }),
    )
    .await?;

    apply_auth(&app, &r, &account)?;
    eprintln!("[social] 登录成功 uid={}", r.uid);
    Ok(AuthResult {
        uid: r.uid,
        nick: r.nick,
        pet_name: r.pet_name,
        register_date: ms_to_date(r.created_at),
        invite_code: r.invite_code,
    })
}

/// 退出登录：清空本地会话（服务端会话保留，重新登录即恢复）。
#[tauri::command]
pub async fn logout(app: AppHandle) -> Result<(), String> {
    let mut cur = configcmd::current();
    cur.social.uid = String::new();
    cur.social.token = String::new();
    cur.social.account = String::new();
    crate::config::save(&app, &cur).map_err(|e| e.to_string())?;
    configcmd::set_current(&cur);
    Ok(())
}

/// 改宠物名：本地立即生效，异步推送到服务端（好友可见）。
///
/// 失败不回滚本地 —— 名字是本地资产，网络只是同步渠道；
/// 心跳会带上最新名字兜底重试。
#[tauri::command]
pub async fn set_pet_name(app: AppHandle, name: String) -> Result<String, String> {
    let name = account::valid_pet_name(&name)?;

    // 1. 本地生效
    let mut cur = configcmd::current();
    cur.social.pet_name = name.clone();
    crate::config::save(&app, &cur).map_err(|e| e.to_string())?;
    configcmd::set_current(&cur);

    // 2. 异步联网同步（不阻塞返回；未登录时静默跳过）
    if !cur.social.token.is_empty() {
        let body = serde_json::json!({ "pet_name": name });
        tokio::spawn(async move {
            if let Err(e) = post_authed("/profile/pet-name", &body).await {
                eprintln!("[social] 宠物名同步失败（心跳会重试）：{e}");
            }
        });
    }
    Ok(name)
}

/// 加好友：uid 或昵称。
#[tauri::command]
pub async fn add_friend(target: String) -> Result<String, String> {
    let target = account::valid_target(&target)?;
    let v = post_authed("/friends/add", &serde_json::json!({ "target": target })).await?;
    Ok(v["note"].as_str().unwrap_or("已添加").to_string())
}

/// 删好友：任何一方删除即双向解除。
#[tauri::command]
pub async fn remove_friend(target: String) -> Result<String, String> {
    let target = account::valid_target(&target)?;
    post_authed("/friends/remove", &serde_json::json!({ "target": target })).await?;
    Ok("已删除".into())
}

/// 召回在外串门的宠物。本地状态立即恢复，服务端上报异步进行。
#[tauri::command]
pub async fn return_home(app: AppHandle, target: Option<String>) -> Result<(), String> {
    let target = target.filter(|t| t.len() == 8 && t.chars().all(|c| c.is_ascii_digit()));
    crate::socialdrive::come_home(&app, target);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 毫秒转日期() {
        assert_eq!(ms_to_date(0), "1970-01-01");
        assert_eq!(ms_to_date(1_759_276_800_000), "2025-10-01");
    }
}
