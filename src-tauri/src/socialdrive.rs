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

/// 出门类型：串门（8 分钟）或碰一碰（45 秒快闪）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VisitKind {
    Visit,
    Bump,
}

/// 碰一碰出门时长：到点自动回家。
const BUMP_DURATION_SECS: u64 = 45;

#[derive(Serialize, Deserialize, Clone)]
pub struct FriendView {
    pub uid: String,
    pub nick: String,
    pub pet_name: String,
    pub state: String,
    pub affinity: f64,
    pub online: bool,
}

/// 待处理的好友申请（心跳随好友列表一起下发）。
#[derive(Serialize, Deserialize, Clone)]
pub struct FriendRequestView {
    pub uid: String,
    pub nick: String,
    pub pet_name: String,
}

/// 好友列表刷新事件载荷（含待处理申请）。
#[derive(Serialize, Clone)]
pub struct FriendsNotice {
    pub friends: Vec<FriendView>,
    pub requests: Vec<FriendRequestView>,
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
    /// 加权随机权重：好友带关系亲密度，仅打过招呼的用基础权重。
    weight: f64,
}

/// 离家/回家事件载荷。
#[derive(Serialize, Clone)]
pub struct AwayNotice {
    /// true = 出门了，false = 回家了。
    pub away: bool,
    /// 去谁家（出门时）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_nick: Option<String>,
    /// 出门类型：visit / bump。回家事件不带。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<VisitKind>,
    /// 本次出门总时长（秒），前端倒计时用。回家事件不带。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<u64>,
}

#[derive(Clone)]
struct Visiting {
    target_uid: String,
    target_nick: String,
    kind: VisitKind,
    /// 到点自动回家的时刻（存这里而不是局部变量，碰一碰与串门共用一条回家路径）。
    until: std::time::Instant,
}

/// 串门候选权重下限：亲密度 0 的新好友也要有机会被选中。
const CANDIDATE_BASE_WEIGHT: f64 = 10.0;

/// 碰一碰本地限流记录：uid → 冷却截止时刻。进程内存即可
///（重启丢一次无害，服务端有同款校验兜底）。
static BUMP_LAST: std::sync::OnceLock<Mutex<std::collections::HashMap<String, std::time::Instant>>> =
    std::sync::OnceLock::new();

fn bump_last() -> &'static Mutex<std::collections::HashMap<String, std::time::Instant>> {
    BUMP_LAST.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
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

/// 碰一碰冷却（秒）：与服务端 BUMP_COOLDOWN_MS 同值，客户端先拦省一次请求。
pub const BUMP_COOLDOWN_SECS: u64 = 60;

/// 碰一碰本地限流（纯函数）：距冷却截止还需等多少秒（0 = 可碰）。
/// 存「截止时刻」而不是「上次时刻」—— 服务端限流返回的剩余秒数
/// 可以直接换算成截止时刻写回来，两端倒计时天然对齐。
pub fn bump_cooldown_left(
    blocked_until: Option<std::time::Instant>,
    now: std::time::Instant,
) -> u64 {
    blocked_until
        .map(|until| until.saturating_duration_since(now).as_secs())
        .unwrap_or(0)
}

/// 碰一碰被拒分类（纯函数）：带 retry_after 的限流返回剩余秒数（>0），
/// 其他业务失败（非好友等）返回 0 —— 两类对本地冷却的处理不同。
fn bump_deny(v: &serde_json::Value) -> u64 {
    v["retry_after"].as_u64().unwrap_or(0)
}

/// 串门目标选择（纯函数）：权重加权随机。roll 为 0..1 均匀随机，
/// 返回选中的候选下标；池空或总权重非正返回 None。
pub fn pick_visit_target(weights: &[f64], roll: f64) -> Option<usize> {
    if weights.is_empty() {
        return None;
    }
    let total: f64 = weights.iter().sum();
    if !(total > 0.0) {
        return None;
    }
    let hit = roll * total;
    let mut acc = 0.0;
    for (i, w) in weights.iter().enumerate() {
        acc += w;
        if hit < acc {
            return Some(i);
        }
    }
    Some(weights.len() - 1) // 浮点舍入兜底：roll 恰落在最后一段边界上
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
        kind: v.as_ref().map(|x| x.kind),
        duration_secs: v
            .as_ref()
            .map(|x| x.until.saturating_duration_since(std::time::Instant::now()).as_secs()),
    };
    if let Ok(mut g) = VISITING.lock() {
        *g = v;
    }
    let _ = app.emit(EVENT_AWAY, notice);
}

/// 当前出门记录是否仍是「这一次」（同一目标 + 同一到期时刻）。
///
/// 回家上报的网络往返窗口里，用户可能已发起新一次出门 —— 旧一次的
/// 到期处理不能把新状态误清成「在家」。碰一碰对同一好友有 60 秒冷却
/// （> 45 秒出门时长），同目标的两次出门不会重叠，(uid, until) 足以唯一定位。
fn visiting_is(expect: &Visiting) -> bool {
    VISITING
        .lock()
        .map(|g| {
            g.as_ref()
                .map(|cur| cur.target_uid == expect.target_uid && cur.until == expect.until)
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

/// 到期回家的共同路径（串门循环兜底与碰一碰定时器共用）：
/// 先核身份再上报，上报完再核一次才清空 —— 两头校验把误清新出门
/// 状态的窗口压到锁粒度以内。
async fn expire_visiting(app: &AppHandle, expect: Visiting) {
    if !visiting_is(&expect) {
        return;
    }
    let body = serde_json::json!({ "target": expect.target_uid });
    if let Err(e) = crate::syncclient::post_authed("/home", &body).await {
        eprintln!("[social] 回家上报失败：{e}");
    }
    if visiting_is(&expect) {
        set_visiting(app, None);
    }
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

/// 碰一碰出门：45 秒快闪后自动回家。由 friend_bump 命令在服务端确认后调用。
pub fn go_bump(app: &AppHandle, target_uid: String, target_nick: String) {
    let v = Visiting {
        target_uid,
        target_nick,
        kind: VisitKind::Bump,
        until: std::time::Instant::now() + Duration::from_secs(BUMP_DURATION_SECS),
    };
    set_visiting(app, Some(v.clone()));
    // 到点回家挂独立定时器，不等心跳循环 —— 循环默认 180 秒一拍，
    // 会把「45 秒快闪」拖成最长 225 秒。当前在异步上下文（friend_bump
    // 命令）才挂得上；挂不上时仍有循环尾部的兜底检查。
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let app = app.clone();
        handle.spawn(async move {
            tokio::time::sleep(Duration::from_secs(BUMP_DURATION_SECS)).await;
            expire_visiting(&app, v).await;
        });
    }
}

/// 碰一碰入口（friend_bump 命令调用）：本地限流先拦（省一次网络往返），
/// 服务端确认后设置 45 秒出门状态。Err(>0) = 被冷却拦下（剩余秒数）；
/// Err(0) = 其他业务失败（非好友等），不记冷却。
/// friend_bump 命令在后续任务接入，届时删掉这条 allow。
#[allow(dead_code)]
pub async fn try_begin_bump(
    app: &AppHandle,
    target_uid: String,
    target_nick: String,
) -> Result<(), u64> {
    let now = std::time::Instant::now();
    {
        let Ok(map) = bump_last().lock() else {
            return Err(BUMP_COOLDOWN_SECS);
        };
        let left = bump_cooldown_left(map.get(&target_uid).copied(), now);
        if left > 0 {
            return Err(left);
        }
    }

    let body = serde_json::json!({ "target": target_uid });
    match crate::syncclient::post_authed_full("/friends/bump", &body).await {
        Ok(v) if v["ok"] == true => {
            if let Ok(mut map) = bump_last().lock() {
                map.insert(
                    target_uid.clone(),
                    std::time::Instant::now() + Duration::from_secs(BUMP_COOLDOWN_SECS),
                );
            }
            go_bump(app, target_uid, target_nick);
            Ok(())
        }
        Ok(v) => {
            let left = bump_deny(&v);
            if left > 0 {
                // 服务端限流（多设备/时钟差）：以服务端剩余秒数对齐本地倒计时
                if let Ok(mut map) = bump_last().lock() {
                    map.insert(
                        target_uid.clone(),
                        std::time::Instant::now() + Duration::from_secs(left),
                    );
                }
                Err(left)
            } else {
                // 其他业务错误（非好友等）：不记冷却，Err(0) 交命令层区别展示
                Err(0)
            }
        }
        Err(_) => Err(BUMP_COOLDOWN_SECS), // 网络失败按满冷却处理，防连点打爆服务端
    }
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

                        // 好友列表 + 待处理申请（可能都为空）
                        let friends = serde_json::from_value::<Vec<FriendView>>(
                            v["friends"].clone(),
                        )
                        .unwrap_or_default();
                        let requests = serde_json::from_value::<Vec<FriendRequestView>>(
                            v["requests"].clone(),
                        )
                        .unwrap_or_default();
                        if !friends.is_empty() || !requests.is_empty() {
                            let _ = app.emit(
                                EVENT_FRIENDS,
                                FriendsNotice {
                                    friends: friends.clone(),
                                    requests,
                                },
                            );
                        }

                        // —— 串门决策（persona 自动触发，非人工）——
                        if !friends.is_empty() && !is_away() {
                            // 候选 = 在线好友 ∪ 今日打过招呼的人（按 uid 去重）。
                            // 权重 = 关系亲密度 + 10 下限：越熟越常去，新朋友也有机会。
                            let mut pool: Vec<Candidate> = friends
                                .iter()
                                .filter(|f| f.online && f.state != "visiting")
                                .map(|f| Candidate {
                                    uid: f.uid.clone(),
                                    nick: f.nick.clone(),
                                    weight: f.affinity + CANDIDATE_BASE_WEIGHT,
                                })
                                .collect();
                            for g in
                                GREETED_TODAY.lock().map(|g| g.clone()).unwrap_or_default()
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
                                    weight: CANDIDATE_BASE_WEIGHT,
                                });
                            }

                            if !pool.is_empty() {
                                let busy = crate::sensedrive::shared_state()
                                    .map(|s| owner_busy(s.doing))
                                    .unwrap_or(false);
                                use rand::Rng as _;
                                let roll: f64 = rand::thread_rng().gen();
                                if decide_visit(
                                    cfg.persona,
                                    busy,
                                    affinity.can_visit(),
                                    roll,
                                ) {
                                    let weights: Vec<f64> =
                                        pool.iter().map(|c| c.weight).collect();
                                    let pick =
                                        pick_visit_target(&weights, rand::thread_rng().gen());
                                    if let Some(idx) = pick {
                                        let t = pool.remove(idx);
                                        let body =
                                            serde_json::json!({ "target": t.uid });
                                        match crate::syncclient::post_authed("/visit", &body)
                                            .await
                                        {
                                            Ok(_) => {
                                                eprintln!(
                                                    "[social] 宠物出门去 {} 家串门了",
                                                    t.nick
                                                );
                                                affinity.spend_for_visit();
                                                went_visiting = Some(Visiting {
                                                    target_uid: t.uid,
                                                    target_nick: t.nick,
                                                    kind: VisitKind::Visit,
                                                    until: std::time::Instant::now()
                                                        + Duration::from_secs(
                                                            VISIT_DURATION_SECS,
                                                        ),
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
            }

            // 出门到点自动回家（串门 8 分钟 / 碰一碰 45 秒共用）。
            // 碰一碰平时由 go_bump 挂的独立定时器负责精确到点，这里兜底。
            if let Some(v) = VISITING.lock().ok().and_then(|g| g.clone()) {
                if std::time::Instant::now() >= v.until {
                    rt.block_on(expire_visiting(&app, v));
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
        "freq" => {
            let pet_name = e["event"]["pet_name"].as_str().unwrap_or("").to_string();
            let _ = app.emit(
                EVENT_SOCIAL,
                serde_json::json!({
                    "event": {
                        "type": "freq",
                        "from_uid": from_uid,
                        "from_nick": from_nick,
                        "pet_name": pet_name,
                    }
                }),
            );
        }
        "accept" => {
            let _ = app.emit(
                EVENT_SOCIAL,
                serde_json::json!({ "event": { "type": "accept", "from_nick": from_nick } }),
            );
        }
        "bump" => {
            let pet_name = e["event"]["pet_name"].as_str().unwrap_or("").to_string();
            let _ = app.emit(
                EVENT_SOCIAL,
                serde_json::json!({
                    "event": {
                        "type": "bump",
                        "from_uid": from_uid,
                        "from_nick": from_nick,
                        "pet_name": pet_name,
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

    #[test]
    fn 碰一碰冷却窗口() {
        let now = std::time::Instant::now();
        assert_eq!(bump_cooldown_left(None, now), 0, "没记录 → 可碰");
        assert_eq!(bump_cooldown_left(Some(now), now), 0, "已到点 → 可碰");
        assert_eq!(
            bump_cooldown_left(Some(now + Duration::from_secs(1)), now),
            1
        );
        assert_eq!(
            bump_cooldown_left(Some(now + Duration::from_secs(59)), now),
            59
        );
        assert_eq!(
            bump_cooldown_left(Some(now - Duration::from_secs(5)), now),
            0,
            "过期记录 → 可碰"
        );
    }

    #[test]
    fn 目标选择_空池与非正权重() {
        assert_eq!(pick_visit_target(&[], 0.5), None);
        assert_eq!(pick_visit_target(&[0.0, 0.0], 0.5), None);
    }

    #[test]
    fn 目标选择_单候选必中() {
        assert_eq!(pick_visit_target(&[7.0], 0.0), Some(0));
        assert_eq!(pick_visit_target(&[7.0], 0.999), Some(0));
    }

    #[test]
    fn 目标选择_按权重分段命中() {
        // 权重 [90, 10]：roll < 0.9 命中 0，roll ≥ 0.9 命中 1
        assert_eq!(pick_visit_target(&[90.0, 10.0], 0.0), Some(0));
        assert_eq!(pick_visit_target(&[90.0, 10.0], 0.89), Some(0));
        assert_eq!(pick_visit_target(&[90.0, 10.0], 0.90), Some(1));
        assert_eq!(pick_visit_target(&[90.0, 10.0], 0.99), Some(1));
        // roll = 1.0 落在边界外 → 兜底最后一个
        assert_eq!(pick_visit_target(&[90.0, 10.0], 1.0), Some(1));
    }

    #[test]
    fn 目标选择_高亲密度好友统计上更常被选() {
        // 等距采样 1000 个 roll：权重 90 的命中率应 ≈ 90%
        let mut hi = 0;
        let n = 1000;
        for k in 0..n {
            if pick_visit_target(&[90.0, 10.0], (k as f64 + 0.5) / n as f64) == Some(0) {
                hi += 1;
            }
        }
        assert!(hi > 850, "高权重命中率应 ≈90%：实际 {hi}/{n}");
    }

    #[test]
    fn 好友申请列表能反序列化() {
        // 服务端带 at 字段（多余字段应被忽略，不能整包解析失败）
        let v = serde_json::json!([
            { "uid": "12345678", "nick": "汤圆", "pet_name": "小团子", "at": 1758000000000_u64 }
        ]);
        let got: Vec<FriendRequestView> = serde_json::from_value(v).expect("应能解析");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].nick, "汤圆");
    }

    #[test]
    fn 出门通知序列化_回家不带kind与时长() {
        let n = AwayNotice {
            away: false,
            at_nick: None,
            kind: None,
            duration_secs: None,
        };
        let s = serde_json::to_string(&n).unwrap();
        assert!(!s.contains("kind") && !s.contains("duration_secs"), "{s}");
    }

    #[test]
    fn 出门通知序列化_出门带kind与时长() {
        let n = AwayNotice {
            away: true,
            at_nick: Some("汤圆".into()),
            kind: Some(VisitKind::Bump),
            duration_secs: Some(45),
        };
        let v = serde_json::to_value(&n).unwrap();
        assert_eq!(v["kind"], "bump");
        assert_eq!(v["duration_secs"], 45);
    }

    #[test]
    fn 碰一碰限流与业务失败分类() {
        let limited = serde_json::json!({ "error": "碰得太快啦，歇一会儿", "retry_after": 42 });
        assert_eq!(bump_deny(&limited), 42);
        let denied = serde_json::json!({ "error": "只能碰一碰好友" });
        assert_eq!(bump_deny(&denied), 0);
    }

    #[test]
    fn 出门身份校验_换代后不再误清() {
        let v1 = Visiting {
            target_uid: "12345678".into(),
            target_nick: "甲".into(),
            kind: VisitKind::Bump,
            until: std::time::Instant::now(),
        };
        *VISITING.lock().unwrap() = Some(v1.clone());
        assert!(visiting_is(&v1), "当前就是这一次 → 命中");
        let v2 = Visiting {
            target_uid: "87654321".into(),
            ..v1.clone()
        };
        assert!(!visiting_is(&v2), "已换成新目标 → 旧的不再命中");
        *VISITING.lock().unwrap() = None;
        assert!(!visiting_is(&v1), "已回家 → 不命中");
    }
}
