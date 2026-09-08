//! 社交同步循环：心跳在线、好友/事件拉取、自动串门。
//!
//! 节奏（用户需求）：心跳 3 分钟一次（服务端下发 next_secs 可调），
//! 一次往返带回好友列表 + 事件队列 + 在家访客 —— 不做单独的高频轮询。
//!
//! 串门由 persona 自动决策（非人工发起），依据：
//!   - 性格：唠唠 > 偶尔 > 安静的出门概率
//!   - 主人是否忙：主人专注产出时宠物留守陪伴，不出门
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
/// 收到串门/互动/离开/打招呼事件。
pub const EVENT_SOCIAL: &str = "pet://social";
/// 宠物离家/回家事件。
pub const EVENT_AWAY: &str = "pet://home-away";
/// 家里当前的访客。每拍心跳都发（含空列表 —— 前端据此送走已离开的）。
pub const EVENT_VISITORS: &str = "pet://visitors";

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

/// 今日打过招呼、且此刻仍在线的人（服务端已经筛过在线状态）。
///
/// 字段比 FriendView 少（没有好友度），**不能**用 FriendView 反序列化 ——
/// 少了字段会整包解析失败，候选池就永远是空的。
#[derive(Serialize, Deserialize, Clone)]
pub struct GreetView {
    pub uid: String,
    pub nick: String,
    pub pet_name: String,
    pub state: String,
}

/// 在家做客的别人家宠物。
#[derive(Serialize, Deserialize, Clone)]
pub struct VisitorView {
    pub uid: String,
    pub nick: String,
    pub pet_name: String,
}

/// 串门候选：好友与今日打过招呼的人都归到这个形状再一起抽签。
///
/// 只留抽签与上报真正要用的字段 —— 「对方在不在家」在入池前就判完了。
#[derive(Clone)]
struct Candidate {
    uid: String,
    nick: String,
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

/// 今日打过招呼、且此刻仍在线的人 —— 串门候选池的一部分。
///
/// 服务端已经筛过在线状态，这里只做缓存，不再二次判定。
static GREETED_TODAY: Mutex<Vec<GreetView>> = Mutex::new(Vec::new());

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
        crate::config::Persona::Reserved => 0.04,
        crate::config::Persona::Occasional => 0.06,
        crate::config::Persona::Chatty => 0.15,
    };
    roll < threshold
}

/// 主人是否正忙（宠物应留守陪伴，不出门）。
///
/// 专注产出的任何节奏都算忙 —— 盯屏幕思考也一样；
/// 上网闲逛/人不在 → 宠物自由活动。
pub fn owner_busy(doing: crate::state::Doing) -> bool {
    doing.is_producing()
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
        if let Err(e) = crate::syncclient::post_authed("/home", &body).await {
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
        // 心跳连续失败时的退避基数，成功一次即复位
        let mut backoff_secs: u64 = 60;

        loop {
            std::thread::sleep(interval);

            let cfg = configcmd::current();
            if cfg.social.token.is_empty() {
                // account 非空 = 用户主动退出过。别跟用户拧着来：
                // 退了就不再自动开户，只低频待命，等用户自己点回来。
                if !cfg.social.account.is_empty() {
                    interval = Duration::from_secs(300);
                    continue;
                }
                // 还没开户 → 静默注册一个（服务地址内置，不需要用户填任何东西）。
                // 失败就退避重试，绝不弹窗打扰：注册不上宠物照样活着。
                let app2 = app.clone();
                let ok = rt.block_on(async {
                    crate::socialcmd::ensure_account(&app2).await.is_ok()
                });
                interval = if ok {
                    Duration::from_secs(3) // 开完户立刻进入正常心跳
                } else {
                    Duration::from_secs(60)
                };
                continue;
            }

            // 共同在线时长计入好友度 + 用量计数（在线分钟）
            let elapsed_min = last_min_mark.elapsed().as_secs_f64() / 60.0;
            last_min_mark = std::time::Instant::now();
            affinity.tick_online(elapsed_min);
            crate::usage::add_online_secs(elapsed_min * 60.0);

            // 心跳状态：离家串门时为 visiting，其余按传感器（隐身在此层生效）
            let share_state = if is_away() {
                "visiting".to_string()
            } else {
                crate::sensedrive::shared_state()
                    .map(|s| share::state_str(&s, cfg.social.hidden))
                    .unwrap_or_else(|| "idle".into())
            };

            // hidden 是用户自己拨的隐私开关（不是传感器数据），
            // 上报它是为了让服务端把隐身的人从「今日在线推荐 / 打招呼 /
            // 串门」里排除掉 —— 不上报它，隐身就只在本地把状态压成 idle，
            // 陌生人照样能看见你、找你打招呼。
            let mut beat = serde_json::json!({
                "state": share_state,
                "affinity": affinity.value as u32,
                "pet_name": cfg.social.pet_name,
                "hidden": cfg.social.hidden,
            });
            // 用量上报：当日聚合计数（隐私红线：只有数字，没有内容）。
            // 未打点过（刚启动）不带 usage 字段，服务端按缺失处理。
            if let Some(u) = crate::usage::snapshot() {
                beat["usage"] = serde_json::json!({
                    "date": u.date,
                    "reminders": u.reminders,
                    "notes": u.notes,
                    "pomodoros": u.pomodoros,
                    "online_mins": u.online_mins,
                });
            }

            let mut went_visiting: Option<Visiting> = None;
            rt.block_on(async {
                match crate::syncclient::post_authed("/heartbeat", &beat).await {
                    Ok(v) => {
                        if let Some(secs) = v["next_secs"].as_u64() {
                            // 服务端可配置心跳间隔（30 秒 ~ 1 小时内的合理界）
                            interval = Duration::from_secs(secs.clamp(30, 3600));
                        }
                        backoff_secs = 60; // 打通了，退避复位

                        // 好友列表（可能为空 —— 没有好友也要能基于今日招呼串门）
                        if let Ok(friends) =
                            serde_json::from_value::<Vec<FriendView>>(v["friends"].clone())
                        {
                            if !friends.is_empty() {
                                let _ = app.emit(EVENT_FRIENDS, friends.clone());
                            }

                            // —— 串门决策（persona 自动触发，非人工）——
                            if !is_away() {
                                // 候选 = 好友 ∪ 今日打过招呼的人（按 uid 去重）
                                let mut pool: Vec<Candidate> = friends
                                    .iter()
                                    .filter(|f| f.online && f.state != "visiting")
                                    .map(|f| Candidate {
                                        uid: f.uid.clone(),
                                        nick: f.nick.clone(),
                                    })
                                    .collect();
                                for g in GREETED_TODAY.lock().map(|g| g.clone()).unwrap_or_default()
                                {
                                    if g.state == "visiting" {
                                        continue;
                                    }
                                    if pool.iter().any(|p| p.uid == g.uid) {
                                        continue;
                                    }
                                    pool.push(Candidate {
                                        uid: g.uid,
                                        nick: g.nick,
                                    });
                                }

                                let online: Vec<&Candidate> = pool.iter().collect();
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
                                    let t =
                                        online[rand::thread_rng().gen_range(0..online.len())];
                                    let body = serde_json::json!({ "target": t.uid });
                                    match crate::syncclient::post_authed("/visit", &body).await
                                    {
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

                        // 在家访客：每次都发（空列表也要发，前端据此送走已离开的）。
                        // 字段缺失按空列表处理 —— 漏发一次，访客就永远送不走了。
                        let visitors = serde_json::from_value::<Vec<VisitorView>>(
                            v["visitors"].clone(),
                        )
                        .unwrap_or_default();
                        let _ = app.emit(EVENT_VISITORS, visitors);

                        // 今日打过招呼且仍在线的人 → 存进串门候选池
                        if let Ok(g) =
                            serde_json::from_value::<Vec<GreetView>>(v["greeted_today"].clone())
                        {
                            if let Ok(mut cur) = GREETED_TODAY.lock() {
                                *cur = g;
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
                        // 指数退避：服务端故障时要减负，固定 60 秒反而
                        // 会把请求量抬到原来的 3 倍，雪上加霜
                        backoff_secs = (backoff_secs * 2).min(600);
                        interval = Duration::from_secs(backoff_secs);
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
                        if let Err(e) = crate::syncclient::post_authed("/home", &body).await {
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
    let from_uid = e["event"]["from_uid"].as_str().unwrap_or("").to_string();
    match kind {
        "visit" => {
            affinity.on_visit();
            // from_uid 必须透传：前端「打个招呼」要靠它回打，
            // 丢了它就只能显示一句没法操作的空话
            let _ = app.emit(
                EVENT_SOCIAL,
                serde_json::json!({
                    "event": {
                        "type": "visit",
                        "from_uid": from_uid,
                        "from_nick": from_nick,
                    }
                }),
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
        "greet" => {
            // line 由对方本地按 TA 自己宠物的心情挑好，我们只负责展示。
            // 服务端还有一层白名单兜底，这里直接用，不再二次校验。
            let line = e["event"]["line"].as_str().unwrap_or("").to_string();
            let pet_name = e["event"]["pet_name"].as_str().unwrap_or("").to_string();
            let from_uid = e["event"]["from_uid"].as_str().unwrap_or("").to_string();
            let _ = app.emit(
                EVENT_SOCIAL,
                serde_json::json!({
                    "event": {
                        "type": "greet",
                        "from_uid": from_uid,
                        "from_nick": from_nick,
                        "pet_name": pet_name,
                        "line": line,
                    }
                }),
            );
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Persona;
    use crate::state::Doing;

    #[test]
    fn 今日招呼候选人能反序列化() {
        // 服务端只发 4 个字段。用 FriendView（要 affinity/online）解析会
        // 整包失败、候选池永远为空 —— 这个坑卡住过串门，钉死它。
        let v = serde_json::json!([
            { "uid": "12345678", "nick": "汤圆", "pet_name": "小团子", "state": "idle" }
        ]);
        let got: Vec<GreetView> = serde_json::from_value(v).expect("应能解析");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].uid, "12345678");
    }

    #[test]
    fn 访客名单能反序列化() {
        let v = serde_json::json!([
            { "uid": "12345678", "nick": "汤圆", "pet_name": "小团子" }
        ]);
        let got: Vec<VisitorView> = serde_json::from_value(v).expect("应能解析");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].pet_name, "小团子");
    }

    #[test]
    fn 主人专注时宠物留守() {
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
    fn 专注产出算忙_其他不算() {
        for d in [Doing::Editing, Doing::Writing, Doing::Designing, Doing::Data] {
            assert!(owner_busy(d), "{d:?} 应算忙，宠物该留守");
        }
        for d in [
            Doing::Messaging,
            Doing::Browsing,
            Doing::Watching,
            Doing::Other,
            Doing::Away,
        ] {
            assert!(!owner_busy(d), "{d:?} 不算忙，宠物可自由活动");
        }
    }
}
