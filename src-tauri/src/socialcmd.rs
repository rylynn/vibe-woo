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

/// 注册 / 登录：免鉴权 POST，响应解成 AuthResp。
async fn post_public(path: &str, body: &serde_json::Value) -> Result<AuthResp, String> {
    let v = crate::syncclient::post_public(path, body).await?;
    serde_json::from_value(v).map_err(|_| "响应解析失败".to_string())
}

// ---------- 自动开户 ----------

/// 自动开户用的公共邀请码 —— 服务端允许无限次使用（不消耗、不写回 used_by）。
const PUBLIC_INVITE: &str = "PET888";

/// 昵称词库：自动开户的昵称从这里挑一个，再拼随机后缀保证唯一。
/// 纯 uid 串的机器味太重 —— 好友列表和气泡里会直接显示它。
const NICK_WORDS: &[&str] = &[
    "汤圆", "橘子", "雪球", "布丁", "奶糖", "芝麻", "可乐", "年糕", "豆豆", "棉花",
];

const HEX: &[u8] = b"0123456789abcdef";

fn pick(rng: &mut impl rand::Rng, alphabet: &[u8]) -> char {
    alphabet[rng.gen_range(0..alphabet.len())] as char
}

/// 自动生成的账号：pet_ + 6 位 hex（10 位，满足服务端的 3-12 位限制）。
pub fn random_account(rng: &mut impl rand::Rng) -> String {
    let mut s = String::from("pet_");
    for _ in 0..6 {
        s.push(pick(rng, HEX));
    }
    s
}

/// 自动生成的密码：服务端要求同时含大小写，这里各来 4 个再洗牌。
pub fn random_password(rng: &mut impl rand::Rng) -> String {
    // 去掉容易混淆的字符，密码反正用户看不到
    const LOWER: &[u8] = b"abcdefghijkmnpqrstuvwxyz";
    const UPPER: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
    const DIGIT: &[u8] = b"23456789";
    let mut chars: Vec<char> = Vec::new();
    for _ in 0..4 {
        chars.push(pick(rng, LOWER));
    }
    for _ in 0..4 {
        chars.push(pick(rng, UPPER));
    }
    for _ in 0..2 {
        chars.push(pick(rng, DIGIT));
    }
    // 洗牌：否则密码形态永远是「小写段 + 大写段 + 数字段」
    for i in (1..chars.len()).rev() {
        let j = rng.gen_range(0..=i);
        chars.swap(i, j);
    }
    chars.into_iter().collect()
}

/// 自动生成的昵称：词库 + 6 位 hex 后缀（词库会撞，后缀保证唯一）。
pub fn random_nick(rng: &mut impl rand::Rng) -> String {
    let w = NICK_WORDS[rng.gen_range(0..NICK_WORDS.len())];
    let mut suffix = String::new();
    for _ in 0..6 {
        suffix.push(pick(rng, HEX));
    }
    format!("{w}_{suffix}")
}

/// 自动开户：没有身份时静默注册一个，用户不需要填任何东西。
///
/// 账号、密码、昵称全部本地生成，走公共邀请码注册；
/// 注册成功之后用户只需要做一件事 —— 给宠物起名字。
///
/// 前端命令与启动自检（socialdrive）共用这一段。
/// 失败不打扰：注册不上宠物照样活着，调用方负责退避重试。
pub async fn ensure_account(app: &AppHandle) -> Result<AuthResult, String> {
    // 已经有身份就别再注册一个
    let cur = configcmd::current();
    if !cur.social.uid.is_empty() && !cur.social.token.is_empty() {
        return Ok(AuthResult {
            uid: cur.social.uid.clone(),
            nick: cur.social.nick.clone(),
            pet_name: cur.social.pet_name.clone(),
            register_date: cur.social.register_date.clone(),
            invite_code: cur.social.invite_code.clone(),
        });
    }

    // 用 StdRng 而不是 thread_rng：ThreadRng 不是 Send，
    // 跨 await 持有会让这条命令的 Future 不满足 Tauri 的 Send 约束。
    use rand::SeedableRng as _;
    let mut rng = rand::rngs::StdRng::from_entropy();

    // 只试一次。服务端的注册接口有 10 秒/IP 限频，连打三次必然被
    // 「请求太频繁」挡回来，还会把真正的错误（撞号、校验不过）覆盖成
    // 限频文案，排查时更费劲。随机账号撞号的概率本来就极低，
    // 真撞上了交给外层的退避重试更划算。
    let account = random_account(&mut rng);
    let password = random_password(&mut rng);
    let nick = random_nick(&mut rng);
    let r = post_public(
        "/register",
        &serde_json::json!({
            "account": account,
            "password": password,
            "nick": nick,
            "invite_code": PUBLIC_INVITE,
        }),
    )
    .await?;

    let date = ms_to_date(r.created_at);
    apply_auth(app, &r, &account)?;
    eprintln!("[social] 自动开户成功 uid={}", r.uid);
    Ok(AuthResult {
        uid: r.uid,
        nick: r.nick,
        pet_name: r.pet_name,
        register_date: date,
        invite_code: r.invite_code,
    })
}

#[tauri::command]
pub async fn auto_register(app: AppHandle) -> Result<AuthResult, String> {
    ensure_account(&app).await
}

// ---------- 今日在线 & 打招呼 ----------

/// 今日在线的一条推荐（服务端按日期确定性取样，同一天名单稳定）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineUser {
    pub uid: String,
    pub nick: String,
    pub pet_name: String,
    pub state: String,
}

#[tauri::command]
pub async fn online_random() -> Result<Vec<OnlineUser>, String> {
    let v =
        crate::syncclient::post_authed("/online/random", &serde_json::json!({})).await?;
    serde_json::from_value(v["users"].clone()).map_err(|_| "响应解析失败".to_string())
}

/// 打招呼：每人每分钟最多一次（服务端权威限频，前端只做倒计时展示）。
///
/// 话术按**当前宠物心情**在本地挑好，只把句子发出去 ——
/// 心情本身（tempo/mood/activity）绝不出本机，见 share.rs 的红线。
#[tauri::command]
pub async fn greet(target: String) -> Result<(), String> {
    let target = account::valid_target(&target)?;
    let mood = crate::sensedrive::shared_state()
        .map(|s| s.mood)
        .unwrap_or(crate::mood::Mood::Focused);
    use rand::Rng as _;
    let line = crate::persona::greet_line(mood, rand::thread_rng().gen());
    crate::syncclient::post_authed(
        "/greet",
        &serde_json::json!({ "target": target, "line": line }),
    )
    .await?;
    Ok(())
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

    let r = post_public(
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

    let r = post_public(
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
///
/// **保留 account**：它是「用户主动退出过」的唯一标记。
/// 启动自检据此判断该不该自动开户 —— 退出了又立刻开一个新号，
/// 等于没退出，还白白丢掉原来的身份。
#[tauri::command]
pub async fn logout(app: AppHandle) -> Result<(), String> {
    let mut cur = configcmd::current();
    cur.social.uid = String::new();
    cur.social.token = String::new();
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
            if let Err(e) = crate::syncclient::post_authed("/profile/pet-name", &body).await {
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
    let v = crate::syncclient::post_authed("/friends/add", &serde_json::json!({ "target": target })).await?;
    Ok(v["note"].as_str().unwrap_or("已添加").to_string())
}

/// 删好友：任何一方删除即双向解除。
#[tauri::command]
pub async fn remove_friend(target: String) -> Result<String, String> {
    let target = account::valid_target(&target)?;
    crate::syncclient::post_authed("/friends/remove", &serde_json::json!({ "target": target })).await?;
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
    use rand::SeedableRng as _;

    #[test]
    fn 毫秒转日期() {
        assert_eq!(ms_to_date(0), "1970-01-01");
        assert_eq!(ms_to_date(1_759_276_800_000), "2025-10-01");
    }

    fn rng() -> rand::rngs::StdRng {
        rand::rngs::StdRng::seed_from_u64(42)
    }

    #[test]
    fn 自动生成的账号密码昵称全部过本地校验() {
        // 自动开户不发请求就不知道账号撞没撞，但至少不能因为
        // 「自己生成的字符串不符合自己的规则」而失败 —— 那纯属 bug。
        let mut r = rng();
        for _ in 0..200 {
            let account = random_account(&mut r);
            let password = random_password(&mut r);
            let nick = random_nick(&mut r);
            assert!(
                account::valid_account(&account).is_ok(),
                "生成的账号不合法：{account}"
            );
            assert!(
                account::valid_password(&password).is_ok(),
                "生成的密码不合法：{password}"
            );
            assert!(account::valid_nick(&nick).is_ok(), "生成的昵称不合法：{nick}");
        }
    }

    #[test]
    fn 自动生成的密码总含大小写() {
        // 服务端的硬要求，随机拼字符串最容易漏掉这一条
        let mut r = rng();
        for _ in 0..200 {
            let p = random_password(&mut r);
            assert!(p.chars().any(|c| c.is_ascii_lowercase()), "{p}");
            assert!(p.chars().any(|c| c.is_ascii_uppercase()), "{p}");
        }
    }

    #[test]
    fn 自动生成的账号昵称不重复() {
        // 撞号重试只有 3 次，生成器本身得足够分散
        let mut r = rng();
        let accounts: std::collections::HashSet<String> =
            (0..500).map(|_| random_account(&mut r)).collect();
        let nicks: std::collections::HashSet<String> =
            (0..500).map(|_| random_nick(&mut r)).collect();
        assert_eq!(accounts.len(), 500, "500 次生成出现了账号重复");
        assert_eq!(nicks.len(), 500, "500 次生成出现了昵称重复");
    }
}
