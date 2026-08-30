//! 社交同步循环：心跳在线、好友/事件拉取、自动串门。
//!
//! 节奏（用户需求）：心跳 3 分钟一次（服务端下发 next_secs 可调），
//! 一次往返带回好友列表 + 事件队列 + 在家访客 —— 不做单独的高频轮询。
//!
//! 串门由 persona 自动决策（非人工发起），依据：
//!   - 性格：唠唠 > 偶尔 > 安静的出门概率
//!   - 主人是否忙：主人在写代码时宠物留守陪伴，不出门
//!   - 好友度：达到门槛才出门，出门消耗 8 点防连环打扰
//!   - 对方在线且家中访客 <3（服务端判定）
//!
//! 宠物不在家：全局状态供 talkdrive/react 噤声、前端切右下角图标。

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::configcmd;
use crate::share;
use crate::social::Affinity;

/// 好友列表刷新事件。
pub const EVENT_FRIENDS: &str = "pet://friends";
/// 收到串门/互动/离开事件。
pub const EVENT_SOCIAL: &str = "pet://social";
/// 宠物离家/回家事件。
pub const EVENT_AWAY: &str = "pet://home-away";

/// 心跳间隔默认值（服务端未下发 next_secs 时使用）。
#[allow(dead_code)]
const DEFAULT_HEARTBEAT_SECS: u64 = 180;
/// 串门时长：到点自动回家。
const VISIT_DURATION_SECS: u64 = 8 * 60;

#[derive(Serialize, Deserialize, Clone)]
pub struct FriendView {
    pub uid: String,
    pub nick: String,
    pub pet_name: String,
    pub state: String,
    pub affinity: f64,
    pub online: bool,
}

/// 离家/回家事件载荷。
#[derive(Serialize, Clone)]
pub struct AwayNotice {
    /// true = 出门了，false = 回家了。
    pub away: bool,
    /// 去谁家（出门时）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_nick: Option<String>,
}

#[derive(Clone)]
struct Visiting {
    target_uid: String,
    target_nick: String,
}

/// 全局离家状态。
static VISITING: Mutex<Option<Visiting>> = Mutex::new(None);

/// 宠物当前是否不在家。
pub fn is_away() -> bool {
    VISITING.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// 正在拜访的家庭 uid（供召回）。
pub fn visiting_uid() -> Option<String> {
    VISITING
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|v| v.target_uid.clone()))
}

/// 串门决策（纯函数，可单测）。roll 为 0..1 均匀随机（每轮心跳掷一次）。
pub fn decide_visit(
    persona: crate::config::Persona,
    owner_busy: bool,
    affinity_ready: bool,
    roll: f64,
) -> bool {
    if owner_busy || !affinity_ready {
        return false;
    }
    let threshold = match persona {
        crate::config::Persona::Quiet => 0.02, // 安静的几乎不出门
        crate::config::Persona::Occasional => 0.06,
        crate::config::Persona::Chatty => 0.15,
    };
    roll < threshold
}

/// 主人是否正忙（宠物应留守陪伴，不出门）。
///
/// 写代码的任何节奏都算忙 —— 盯屏幕思考也一样；
/// 上网闲逛/人不在 → 宠物自由活动。
pub fn owner_busy(doing: crate::state::Doing) -> bool {
    matches!(doing, crate::state::Doing::Coding)
}

fn set_visiting(app: &AppHandle, v: Option<Visiting>) {
    let notice = AwayNotice {
        away: v.is_some(),
        at_nick: v.as_ref().map(|x| x.target_nick.clone()),
    };
    if let Ok(mut g) = VISITING.lock() {
        *g = v;
    }
    let _ = app.emit(EVENT_AWAY, notice);
}

/// 立即回家（用户点召回图标）。上报服务端 + 本地状态即时恢复，
/// 不等下一轮心跳。
pub fn come_home(app: &AppHandle, target: Option<String>) {
    let target = target.or_else(visiting_uid);
    set_visiting(app, None);
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(_) => return,
    };
    rt.block_on(async {
        let body = serde_json::json!({ "target": target });
        if let Err(e) = post_authed("/home", &body).await {
            eprintln!("[social] 召回上报失败：{e}");
        }
    });
}

pub fn spawn(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(_) => return,
        };
        let mut affinity = Affinity::new();
        let mut last_min_mark = std::time::Instant::now();
        let mut interval = Duration::from_secs(5); // 首拍快速拿数据
        let mut visit_deadline: Option<std::time::Instant> = None;

        loop {
            std::thread::sleep(interval);

            let cfg = configcmd::current();
            if cfg.social.server.is_empty() || cfg.social.token.is_empty() {
                interval = Duration::from_secs(30); // 未登录，低频探测
                continue;
            }

            // 共同在线时长计入好友度
            let elapsed_min = last_min_mark.elapsed().as_secs_f64() / 60.0;
            last_min_mark = std::time::Instant::now();
            affinity.tick_online(elapsed_min);

            // 心跳状态：离家串门时为 visiting，其余按传感器（隐身在此层生效）
            let share_state = if is_away() {
                "visiting".to_string()
            } else {
                crate::sensedrive::shared_state()
                    .map(|s| share::state_str(&s, cfg.social.hidden))
                    .unwrap_or_else(|| "idle".into())
            };

            let beat = serde_json::json!({
                "state": share_state,
                "affinity": affinity.value as u32,
                "pet_name": cfg.social.pet_name,
            });

            let mut went_visiting: Option<Visiting> = None;
            rt.block_on(async {
                match post_authed("/heartbeat", &beat).await {
                    Ok(v) => {
                        if let Some(secs) = v["next_secs"].as_u64() {
                            // 服务端可配置心跳间隔（30 秒 ~ 1 小时内的合理界）
                            interval = Duration::from_secs(secs.clamp(30, 3600));
                        }

                        // 好友列表
                        if let Ok(friends) =
                            serde_json::from_value::<Vec<FriendView>>(v["friends"].clone())
                        {
                            if !friends.is_empty() {
                                let _ = app.emit(EVENT_FRIENDS, friends.clone());

                                // —— 串门决策（persona 自动触发，非人工）——
                                if !is_away() {
                                    let online: Vec<&FriendView> = friends
                                        .iter()
                                        .filter(|f| f.online && f.state != "visiting")
                                        .collect();
                                    let busy = crate::sensedrive::shared_state()
                                        .map(|s| owner_busy(s.doing))
                                        .unwrap_or(false);
                                    use rand::Rng as _;
                                    let roll: f64 = rand::thread_rng().gen();
                                    if !online.is_empty()
                                        && decide_visit(
                                            cfg.persona,
                                            busy,
                                            affinity.can_visit(),
                                            roll,
                                        )
                                    {
                                        let t = online
                                            [rand::thread_rng().gen_range(0..online.len())];
                                        let body = serde_json::json!({ "target": t.uid });
                                        match post_authed("/visit", &body).await {
                                            Ok(_) => {
                                                eprintln!(
                                                    "[social] 宠物出门去 {} 家串门了",
                                                    t.nick
                                                );
                                                affinity.spend_for_visit();
                                                went_visiting = Some(Visiting {
                                                    target_uid: t.uid.clone(),
                                                    target_nick: t.nick.clone(),
                                                });
                                            }
                                            Err(e) => {
                                                eprintln!("[social] 串门被拒：{e}");
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // 事件队列（读即清空）
                        if let Some(events) = v["events"].as_array() {
                            for e in events {
                                handle_event(e, &mut affinity, &app);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[social] 心跳失败（继续运行）：{e}");
                        interval = Duration::from_secs(60); // 失败退避
                    }
                }
            });

            if let Some(v) = went_visiting {
                set_visiting(&app, Some(v));
                visit_deadline =
                    Some(std::time::Instant::now() + Duration::from_secs(VISIT_DURATION_SECS));
            }

            // 串门到点自动回家
            if let Some(dl) = visit_deadline {
                if std::time::Instant::now() >= dl && is_away() {
                    visit_deadline = None;
                    let target = visiting_uid();
                    rt.block_on(async {
                        let body = serde_json::json!({ "target": target });
                        if let Err(e) = post_authed("/home", &body).await {
                            eprintln!("[social] 回家上报失败：{e}");
                        }
                    });
                    set_visiting(&app, None);
                }
            }
        }
    });
}

fn handle_event(e: &serde_json::Value, affinity: &mut Affinity, app: &AppHandle) {
    let kind = e["event"]["type"].as_str().unwrap_or("");
    let from_nick = e["event"]["from_nick"]
        .as_str()
        .unwrap_or("好友")
        .to_string();
    match kind {
        "visit" => {
            affinity.on_visit();
            let _ = app.emit(
                EVENT_SOCIAL,
                serde_json::json!({ "event": { "type": "visit", "from_nick": from_nick } }),
            );
        }
        "leave" => {
            let _ = app.emit(
                EVENT_SOCIAL,
                serde_json::json!({ "event": { "type": "leave", "from_nick": from_nick } }),
            );
        }
        "interaction" => {
            affinity.on_interacted();
            let _ = app.emit(
                EVENT_SOCIAL,
                serde_json::json!({ "event": { "type": "interaction", "from_nick": from_nick } }),
            );
        }
        _ => {}
    }
}

async fn post_authed(path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let cfg = configcmd::current();
    if cfg.social.server.is_empty() || cfg.social.token.is_empty() {
        return Err("未登录".into());
    }
    let url = format!("{}{path}", cfg.social.server.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.social.token))
        .json(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "解析失败".to_string())?;
    if !status.is_success() || v["error"].is_string() {
        return Err(v["error"].as_str().unwrap_or("请求失败").to_string());
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Persona;
    use crate::state::Doing;

    #[test]
    fn 主人写代码时宠物留守() {
        for p in [Persona::Quiet, Persona::Occasional, Persona::Chatty] {
            assert!(!decide_visit(p, true, true, 0.0), "忙时任何人格都不出门");
        }
    }

    #[test]
    fn 好友度不足时不出门() {
        assert!(!decide_visit(Persona::Chatty, false, false, 0.0));
    }

    #[test]
    fn 性格决定出门概率() {
        // 同样的低 roll，唠唠出门、安静的不出
        assert!(decide_visit(Persona::Chatty, false, true, 0.1));
        assert!(!decide_visit(Persona::Quiet, false, true, 0.1));
        assert!(!decide_visit(Persona::Occasional, false, true, 0.1));
    }

    #[test]
    fn 高roll任何性格都不出门() {
        assert!(!decide_visit(Persona::Chatty, false, true, 0.99));
    }

    #[test]
    fn 写代码算忙_其他不算() {
        assert!(owner_busy(Doing::Coding));
        assert!(!owner_busy(Doing::Browsing));
        assert!(!owner_busy(Doing::Other));
        assert!(!owner_busy(Doing::Away));
    }
}
