use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewWindow};

/// 一块需要接收鼠标的区域，CSS 像素坐标系，由前端上报。
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct PetBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl PetBox {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

/// 前端指针事件计数，仅用于诊断事件是否完整到达 webview。
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct EventCounters {
    pub down: u64,
    /// move 是 Rust 关键字，故字段名加下划线并显式映射。
    #[serde(rename = "move")]
    pub move_: u64,
    pub up: u64,
    pub cancel: u64,
    #[serde(rename = "orphanDrag")]
    pub orphan_drag: u64,
}

struct HitState {
    boxes: Vec<PetBox>,
    /// 拖动中或菜单打开：请求 Rust 保持鼠标接管。
    /// 注意这只是前端的「请求」，会被系统鼠标状态与超时否决。
    lock: bool,
    /// lock 首次置为 true 的时刻，用于超时否决。
    lock_since: Option<Instant>,
    counters: EventCounters,
    /// 上次收到前端上报的时刻，用于判断前端是否已失联。
    updated_at: Instant,
    /// 当前是否处于穿透状态，避免每轮都重复调用系统 API。
    ignoring: bool,
    /// 是否已收到过任何上报，用于诊断 IPC 是否连通。
    ever_reported: bool,
    /// 前端上报的当前动作与范围，仅用于诊断配置是否生效。
    motion: String,
    scope: String,
}

impl Default for HitState {
    fn default() -> Self {
        Self {
            boxes: Vec::new(),
            lock: false,
            lock_since: None,
            counters: EventCounters::default(),
            updated_at: Instant::now(),
            ignoring: true,
            ever_reported: false,
            motion: String::new(),
            scope: String::new(),
        }
    }
}

static STATE: Mutex<Option<HitState>> = Mutex::new(None);

/// 前端上报可点击区域，同时充当心跳。
#[tauri::command]
pub fn report_pet_box(
    boxes: Vec<PetBox>,
    lock: bool,
    counters: EventCounters,
    motion: Option<String>,
    scope: Option<String>,
) {
    if let Ok(mut guard) = STATE.lock() {
        let st = guard.get_or_insert_with(HitState::default);
        if !st.ever_reported {
            eprintln!("[pet] IPC ok: first report received, {} box(es)", boxes.len());
        }
        // 记录 lock 的起始时刻，用于超时否决
        if lock && !st.lock {
            st.lock_since = Some(Instant::now());
        } else if !lock {
            st.lock_since = None;
        }
        st.boxes = boxes;
        st.lock = lock;
        st.counters = counters;
        st.motion = motion.unwrap_or_default();
        st.scope = scope.unwrap_or_default();
        st.updated_at = Instant::now();
        st.ever_reported = true;
    }
}

/// 由宠物右键菜单调用退出。
///
/// 存在理由：托盘图标可能不可见，全局快捷键可能被系统占用或未获权限。
/// 宠物本体的右键菜单是用户最直觉、最可靠的退出入口。
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    eprintln!("[pet] quit via pet context menu");
    app.exit(0);
}

/// 前端失联判定阈值。超过此时长没有上报就强制穿透，
/// 确保前端崩溃/白屏时不会把整个桌面点击锁死。
const STALE_AFTER: Duration = Duration::from_millis(1500);

/// 轮询间隔。60ms 对鼠标跟随足够灵敏，CPU 开销可忽略。
const POLL_INTERVAL: Duration = Duration::from_millis(60);

/// 诊断摘要打印间隔。
const DIAG_INTERVAL: Duration = Duration::from_secs(2);

/// 启动鼠标命中判定循环。
///
/// 为什么必须由 Rust 显式控制（而非依赖「alpha=0 自动穿透」）：
/// WKWebView 铺满整个窗口，它的 hit-test 只看 DOM 元素矩形，不看绘制内容
/// 的 alpha。因此必须在窗口层面用 set_ignore_cursor_events 控制。
///
/// fail-safe 设计（三重保障，绝不允许锁死桌面）：
///   1. 初始状态为穿透，任何未知情况下都倾向于「不拦截」
///   2. 前端上报超时即强制回到穿透（优先于 lock）
///   3. 只有明确判定光标落在某个上报区域内，才关闭穿透
pub fn spawn_hit_test_loop(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(win) = app.get_webview_window("pet") else {
            eprintln!("[pet] hit-test loop: window 'pet' missing, aborting");
            return;
        };

        // 起始即穿透，避免窗口显示后到第一次上报之间的窗口期拦截点击
        apply_ignore(&win, true);

        let mut last_diag = Instant::now();

        loop {
            std::thread::sleep(POLL_INTERVAL);

            let probe = probe(&app, &win);
            let want_ignore = probe.as_ref().map(|p| p.want_ignore).unwrap_or(true);

            let mut guard = match STATE.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            let st = guard.get_or_insert_with(HitState::default);
            let changed = st.ignoring != want_ignore;
            if changed {
                st.ignoring = want_ignore;
            }
            let snapshot = (
                st.ever_reported,
                st.boxes.len(),
                st.lock,
                st.counters,
                st.motion.clone(),
                st.scope.clone(),
            );
            drop(guard);

            if changed {
                apply_ignore(&win, want_ignore);
                eprintln!(
                    "[pet] cursor_events: {}",
                    if want_ignore { "PASS-THROUGH" } else { "CAPTURED" }
                );
            }

            if last_diag.elapsed() >= DIAG_INTERVAL {
                last_diag = Instant::now();
                let (reported, nboxes, lock, c, motion, scope) = snapshot;
                match probe {
                    Some(p) => eprintln!(
                        "[diag] scope={scope} motion={motion} boxes={nboxes} lock={lock} vetoed={} \
                         cursor=({:.0},{:.0}) scale={:.1} local=({:.0},{:.0}) \
                         inside={} ignore={} | events down={} move={} up={} cancel={} orphan={}",
                        p.lock_vetoed,
                        p.cursor.0,
                        p.cursor.1,
                        p.scale,
                        p.local.0,
                        p.local.1,
                        p.inside,
                        p.want_ignore,
                        c.down,
                        c.move_,
                        c.up,
                        c.cancel,
                        c.orphan_drag,
                    ),
                    None => eprintln!(
                        "[diag] probe unavailable (reported={reported} boxes={nboxes} lock={lock}) \
                         -> forcing pass-through"
                    ),
                }
            }
        }
    });
}

struct Probe {
    cursor: (f64, f64),
    scale: f64,
    local: (f64, f64),
    inside: bool,
    want_ignore: bool,
    /// lock 被系统鼠标状态或超时否决时为 true，用于诊断。
    lock_vetoed: bool,
}

/// 计算是否应穿透，并附带全部中间量以便诊断。
/// 返回 None 表示信息不足，调用方按穿透处理。
fn probe(app: &AppHandle, win: &WebviewWindow) -> Option<Probe> {
    let (boxes, raw_lock, fresh, lock_age) = {
        let guard = STATE.lock().ok()?;
        let st = guard.as_ref()?;
        (
            st.boxes.clone(),
            st.lock,
            st.updated_at.elapsed() < STALE_AFTER,
            st.lock_since.map(|t| t.elapsed()),
        )
    };

    let cursor = app.cursor_position().ok()?;
    let scale = win.scale_factor().ok()?;
    let win_pos = win.outer_position().ok()?;

    // 光标与窗口位置是物理像素，上报的区域是 CSS 像素，统一到 CSS 像素比较
    let local_x = (cursor.x - win_pos.x as f64) / scale;
    let local_y = (cursor.y - win_pos.y as f64) / scale;
    let inside = boxes.iter().any(|b| b.contains(local_x, local_y));

    // 决策逻辑在 passthrough 模块，有完整单元测试覆盖 —— 它决定桌面
    // 点击会不会被锁死，不能内联在这里靠肉眼保证正确。
    let outcome = crate::passthrough::decide(crate::passthrough::Decision {
        fresh,
        lock_requested: raw_lock,
        inside,
        buttons_pressed: crate::mouse::any_button_pressed(),
        lock_age,
    });

    Some(Probe {
        cursor: (cursor.x, cursor.y),
        scale,
        local: (local_x, local_y),
        inside,
        want_ignore: outcome.ignore,
        lock_vetoed: outcome.lock_vetoed,
    })
}

fn apply_ignore(win: &WebviewWindow, ignore: bool) {
    if let Err(e) = win.set_ignore_cursor_events(ignore) {
        eprintln!("[pet] set_ignore_cursor_events({ignore}) failed: {e:?}");
    }
}
