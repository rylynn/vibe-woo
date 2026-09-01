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

/// 窗口几何缓存：缩放系数与窗口位置（统一换算到逻辑坐标）。
///
/// 宠物窗口是铺满屏幕的固定 panel，不移动不改尺寸 —— 但每 60ms 轮询
/// 一次 `scale_factor()`/`outer_position()` 是纯粹的浪费（同步窗口调用）。
/// 缓存后由窗口事件（移动/缩放/显示器变更）失效。
#[derive(Debug, Clone, Copy)]
struct Geo {
    scale: f64,
    /// 窗口左上角，逻辑坐标（CSS 像素）。
    x: f64,
    y: f64,
}

static GEO: Mutex<Option<Geo>> = Mutex::new(None);

fn geo_cached(win: &WebviewWindow) -> Option<Geo> {
    if let Ok(g) = GEO.lock() {
        if let Some(geo) = *g {
            return Some(geo);
        }
    }
    let scale = win.scale_factor().ok()?;
    let pos = win.outer_position().ok()?;
    // 上报区域与光标都用逻辑坐标，这里把物理窗口位置一次换算到位
    let geo = Geo {
        scale,
        x: pos.x as f64 / scale,
        y: pos.y as f64 / scale,
    };
    if let Ok(mut g) = GEO.lock() {
        *g = Some(geo);
    }
    Some(geo)
}

fn invalidate_geo() {
    if let Ok(mut g) = GEO.lock() {
        *g = None;
    }
}

#[cfg(target_os = "macos")]
mod cursor {
    use std::sync::Mutex;

    use objc2_app_kit::NSEvent;

    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayBounds(display: u32) -> CGRect;
    }

    /// 主屏高度（逻辑点），与几何缓存同生命周期：只在显示器配置变化时变。
    static MAIN_HEIGHT: Mutex<Option<f64>> = Mutex::new(None);

    fn main_height() -> Option<f64> {
        if let Ok(g) = MAIN_HEIGHT.lock() {
            if let Some(h) = *g {
                return Some(h);
            }
        }
        let h = unsafe { CGDisplayBounds(CGMainDisplayID()).size.height };
        if let Ok(mut g) = MAIN_HEIGHT.lock() {
            *g = Some(h);
        }
        Some(h)
    }

    /// 光标位置（主屏逻辑坐标，左上原点）。
    ///
    /// 与 tauri `AppHandle::cursor_position()` 等价（NSEvent.mouseLocation
    /// + 主屏高度翻转），但无需向主线程发消息等待回传 —— 命中轮询 60ms
    /// 一轮，主线程往返是纯浪费。mouseLocation 读全局硬件指针位置，
    /// 与 sensor.rs 线程里调用 NSWorkspace 同类的非主线程用法。
    pub fn position() -> Option<(f64, f64)> {
        // objc2 0.6 中该类方法为安全接口
        let p = NSEvent::mouseLocation();
        let h = main_height()?;
        Some((p.x, h - p.y))
    }
}

#[cfg(not(target_os = "macos"))]
mod cursor {
    /// 非 macOS 平台由调用方退化处理（保持穿透）。
    pub fn position() -> Option<(f64, f64)> {
        None
    }
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

        // 窗口几何缓存失效：移动 / 缩放 / 显示器变更时重取。
        // 窗口事件在主线程触发，这里只是置脏标记，轮询线程按需重取。
        win.on_window_event(|event| match event {
            tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. } => invalidate_geo(),
            _ => {}
        });

        let mut last_diag = Instant::now();

        loop {
            std::thread::sleep(POLL_INTERVAL);

            // 诊断信息只在要打印的那一轮才构造，普通轮询零分配
            let diag_due = last_diag.elapsed() >= DIAG_INTERVAL;

            let probe = probe(&win);
            let want_ignore = probe.as_ref().map(|p| p.want_ignore).unwrap_or(true);

            let (changed, diag_info) = {
                let mut guard = match STATE.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                let st = guard.get_or_insert_with(HitState::default);
                let changed = st.ignoring != want_ignore;
                if changed {
                    st.ignoring = want_ignore;
                }
                let diag_info = if diag_due {
                    Some((
                        st.ever_reported,
                        st.boxes.len(),
                        st.lock,
                        st.counters,
                        st.motion.clone(),
                        st.scope.clone(),
                    ))
                } else {
                    None
                };
                (changed, diag_info)
            };

            if changed {
                apply_ignore(&win, want_ignore);
                eprintln!(
                    "[pet] cursor_events: {}",
                    if want_ignore { "PASS-THROUGH" } else { "CAPTURED" }
                );
            }

            if diag_due {
                last_diag = Instant::now();
                let (reported, nboxes, lock, c, motion, scope) =
                    diag_info.unwrap_or((false, 0, false, EventCounters::default(), String::new(), String::new()));
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
fn probe(win: &WebviewWindow) -> Option<Probe> {
    // 光标与窗口位置统一在逻辑坐标（CSS 像素）比较：
    // 上报区域是 CSS 像素，光标取 mouseLocation（逻辑点），窗口位置
    // 在缓存时已从物理像素换算。每轮一次轻量 ObjC 调用，无主线程往返。
    let (cx, cy) = cursor::position()?;
    let geo = geo_cached(win)?;

    let local_x = cx - geo.x;
    let local_y = cy - geo.y;
    // 命中判定在锁内完成 —— boxes 是前端的最新上报，clone 出来再判
    // 既多一次分配还可能用到过期数据。
    let (inside, raw_lock, fresh, lock_age) = {
        let guard = STATE.lock().ok()?;
        let st = guard.as_ref()?;
        (
            st.boxes.iter().any(|b| b.contains(local_x, local_y)),
            st.lock,
            st.updated_at.elapsed() < STALE_AFTER,
            st.lock_since.map(|t| t.elapsed()),
        )
    };

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
        cursor: (cx, cy),
        scale: geo.scale,
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
