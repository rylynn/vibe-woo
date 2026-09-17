//! 屏幕框选层（临时 NSPanel，短生命周期）。
//!
//! 独立于宠物的全屏透明窗：只在用户触发框选快捷键后短暂出现，鼠标所在
//! 显示器上拖动框选，Esc / 点击底部取消区 / 超时均可取消。松手后立即
//! 收起框选层，选区（AppKit 全局坐标）经 channel 交回工作线程，再去截图。
//!
//! 不依赖宠物的穿透锁与命中上报；关闭即释放，无全局静态引用。

use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::NSObjectProtocol;
use objc2::{define_class, msg_send, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSBackingStoreType, NSBezierPath, NSColor, NSEvent, NSPanel, NSResponder,
    NSScreen, NSScreenSaverWindowLevel, NSView, NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_core_foundation::{CGFloat, CGPoint, CGRect, CGSize};
use tauri::{AppHandle, Emitter};

use super::capture::{
    appkit_screen_to_cg, clamp_rect_to_screen, find_screen_for_point, LogicalRect, ScreenInfo,
    SelectedRegion,
};
use super::{ReadError, EVENT_SELECTION_SHOWN};

/// 取消区（底部）与提示条（顶部）高度，逻辑点。
const BAR_HEIGHT: CGFloat = 32.0;

/// 最小有效选区尺寸（逻辑点）。过小视为无效。
const MIN_SELECTION: CGFloat = 5.0;

/// 颜色常量（RGBA 0–1）。
const MINT: (CGFloat, CGFloat, CGFloat, CGFloat) = (0.486, 0.961, 0.769, 1.0);
const DARK: (CGFloat, CGFloat, CGFloat, CGFloat) = (0.063, 0.078, 0.118, 0.92);

define_class!(
    // SAFETY: AppKit UI 子类必须在主线程使用；无子类化额外要求。
    #[unsafe(super(NSPanel))]
    #[thread_kind = MainThreadOnly]
    struct CapturePanel;

    impl CapturePanel {
        /// 无边框面板默认不能成为 key window，这里放开以接收 Esc。
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool {
            true
        }
    }
);

define_class!(
    // SAFETY: 主线程 UI 子类，ivars 通过 Cell/Mutex 提供内部可变性。
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = SelectionIvars]
    struct SelectionView;

    impl SelectionView {
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            let p = event.locationInWindow();
            // 点击底部取消区 → 取消
            if p.y <= BAR_HEIGHT {
                self.finish(None);
                return;
            }
            self.ivars().start.set(Some(p));
            self.ivars().current.set(Some(p));
            self.setNeedsDisplay(true);
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            if self.ivars().start.get().is_some() {
                self.ivars().current.set(Some(event.locationInWindow()));
                self.setNeedsDisplay(true);
            }
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) {
            let start = self.ivars().start.get();
            let current = self.ivars().current.get();
            self.ivars().start.set(None);
            self.ivars().current.set(None);
            if start.is_none() || current.is_none() {
                self.finish(None);
                return;
            }
            let (a, b) = (start.unwrap(), event.locationInWindow());
            let rect = normalize(a, b);
            if rect.w < MIN_SELECTION || rect.h < MIN_SELECTION {
                // 过小区域：视为无效，不启动识别
                self.finish(None);
                return;
            }
            let Some(window) = self.window() else {
                self.finish(None);
                return;
            };
            // 窗口坐标 → AppKit 全局坐标（原点主屏左下）
            let origin = window.convertPointToScreen(CGPoint::new(rect.x, rect.y));
            let global = LogicalRect {
                x: origin.x,
                y: origin.y,
                w: rect.w,
                h: rect.h,
            };
            let screen = self.ivars().screen.get();
            let Some(screen) = screen else {
                self.finish(None);
                return;
            };
            let rect = clamp_rect_to_screen(global, screen.frame);
            self.finish(Some(SelectedRegion { rect, screen }));
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            // 53 = Esc
            if event.keyCode() == 53 {
                self.finish(None);
                return;
            }
            // 其他按键交回超类
            let _: () = unsafe { msg_send![super(self, NSView::class()), keyDown: event] };
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty_rect: CGRect) {
            let frame = self.bounds();
            draw_hint_bars(frame);
            if let (Some(a), Some(b)) = (self.ivars().start.get(), self.ivars().current.get()) {
                draw_selection(normalize(a, b));
            }
        }
    }
);

struct SelectionIvars {
    sender: Mutex<Option<mpsc::Sender<Option<SelectedRegion>>>>,
    screen: Cell<Option<ScreenInfo>>,
    start: Cell<Option<CGPoint>>,
    current: Cell<Option<CGPoint>>,
    /// 本次框选的分代号：只关闭「自己及更早」的面板，绝不误关新会话的面板。
    generation: Cell<u64>,
}

/// 框选分代号（单调递增）。新会话只关闭比自己更早的框选层。
static GENERATION: AtomicU64 = AtomicU64::new(0);

impl SelectionView {
    fn new(
        sender: mpsc::Sender<Option<SelectedRegion>>,
        screen: ScreenInfo,
        generation: u64,
    ) -> Retained<Self> {
        let mtm = MainThreadMarker::new().unwrap();
        let this = Self::alloc(mtm).set_ivars(SelectionIvars {
            sender: Mutex::new(Some(sender)),
            screen: Cell::new(Some(screen)),
            start: Cell::new(None),
            current: Cell::new(None),
            generation: Cell::new(generation),
        });
        unsafe { msg_send![super(this, NSView::class()), init] }
    }

    /// 结束本次框选并关闭窗口。region=Some 交付选区，None 视为取消。
    fn finish(&self, region: Option<SelectedRegion>) {
        if let Ok(mut guard) = self.ivars().sender.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(region);
            }
        }
        if let Some(window) = self.window() {
            window.close();
        }
    }
}

/// 归一化两点为矩形（x/y 取较小值，宽高取绝对值）。
fn normalize(a: CGPoint, b: CGPoint) -> LogicalRect {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    let w = (a.x - b.x).abs();
    let h = (a.y - b.y).abs();
    LogicalRect { x, y, w, h }
}

/// 颜色构造。
fn srgb(c: (CGFloat, CGFloat, CGFloat, CGFloat)) -> Retained<NSColor> {
    NSColor::colorWithSRGBRed_green_blue_alpha(c.0, c.1, c.2, c.3)
}

/// 绘制顶部提示条与底部取消区（实色，无文字，避免半透明）。
fn draw_hint_bars(frame: CGRect) {
    let w = frame.size.width;
    let h = frame.size.height;
    // 顶部提示条
    srgb(DARK).setFill();
    NSBezierPath::fillRect(CGRect::new(
        CGPoint::new(0.0, h - BAR_HEIGHT),
        CGSize::new(w, BAR_HEIGHT),
    ));
    // 顶部条下方一条薄荷绿细线
    srgb(MINT).setFill();
    NSBezierPath::fillRect(CGRect::new(
        CGPoint::new(0.0, h - BAR_HEIGHT - 2.0),
        CGSize::new(w, 2.0),
    ));
    // 底部取消区（居中一段）
    let cancel_w = 160.0;
    let cancel_x = (w - cancel_w) / 2.0;
    srgb(DARK).setFill();
    NSBezierPath::fillRect(CGRect::new(
        CGPoint::new(cancel_x, 0.0),
        CGSize::new(cancel_w, BAR_HEIGHT),
    ));
}

/// 绘制选区：白色粗描边 + 薄荷绿内描边 + 四角标记。
fn draw_selection(rect: LogicalRect) {
    let outer = CGRect::new(
        CGPoint::new(rect.x, rect.y),
        CGSize::new(rect.w, rect.h),
    );
    // 外描边（白）
    NSColor::whiteColor().setStroke();
    let path = NSBezierPath::bezierPathWithRect(outer);
    path.setLineWidth(3.0);
    path.stroke();
    // 内描边（薄荷绿）
    srgb(MINT).setStroke();
    let inner = CGRect::new(
        CGPoint::new(rect.x + 2.0, rect.y + 2.0),
        CGSize::new((rect.w - 4.0).max(0.0), (rect.h - 4.0).max(0.0)),
    );
    NSBezierPath::strokeRect(inner);

    // 四角标记（实色小方块）
    srgb(MINT).setFill();
    let mark = 10.0;
    let corners = [
        CGPoint::new(rect.x - mark / 2.0, rect.y - mark / 2.0),
        CGPoint::new(rect.x + rect.w - mark / 2.0, rect.y - mark / 2.0),
        CGPoint::new(rect.x - mark / 2.0, rect.y + rect.h - mark / 2.0),
        CGPoint::new(rect.x + rect.w - mark / 2.0, rect.y + rect.h - mark / 2.0),
    ];
    for c in corners {
        NSBezierPath::fillRect(CGRect::new(c, CGSize::new(mark, mark)));
    }
}

/// 关闭分代号 ≤ upto 的框选面板。
///
/// 分代是必须的：会话 1 的等待线程若在自己超时后才退出（或旧 sender 迟迟
/// 未析构），无差别关闭会把会话 2 刚建好的框选层一起关掉 ——
/// 用户正拖到一半，层没了，会话 2 又要空等到超时。
fn close_panels_up_to(upto: u64) {
    dispatch2::DispatchQueue::main().exec_async(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        for window in app.windows() {
            if !window.isKindOfClass(CapturePanel::class()) {
                continue;
            }
            let Some(content) = window.contentView() else {
                continue;
            };
            // contentView 是我们自己的 SelectionView 时才读分代号
            if let Some(view) = content.downcast_ref::<SelectionView>() {
                if view.ivars().generation.get() > upto {
                    continue; // 更新的会话，不碰
                }
            }
            window.close();
        }
    });
}

/// 关闭全部框选面板（用户取消 / 会话结束时调用）。
pub fn close_all() {
    close_panels_up_to(GENERATION.load(Ordering::SeqCst));
}

/// 显示框选面板并阻塞等待选区（在工作线程调用）。
///
/// 返回 Ok(region) 表示用户框选了有效区域；Err(Cancelled) 表示
/// 取消 / 超时（前端应静默关闭，不弹错误）。抬窗成功会发
/// EVENT_SELECTION_SHOWN 事件（前端据此判断框选层是否真的出现）。
pub fn capture_region(app: &AppHandle, timeout: Duration) -> Result<SelectedRegion, ReadError> {
    let (tx, rx) = mpsc::channel::<Option<SelectedRegion>>();
    // 分代号：先关掉更早的残留面板，再建自己的
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst);
    close_panels_up_to(generation.saturating_sub(1));
    let app = app.clone();
    dispatch2::DispatchQueue::main().exec_async(move || {
        setup_panel(&app, tx, generation);
    });
    match rx.recv_timeout(timeout) {
        Ok(Some(region)) => Ok(region),
        _ => {
            // 只收起自己这一代，别动更新的会话
            close_panels_up_to(generation);
            Err(ReadError::Cancelled)
        }
    }
}

/// 在主线程创建框选面板（鼠标所在显示器）。
///
/// 日志只记阶段与分代号（可观测性）—— 绝不记录屏幕内容或选区文本。
fn setup_panel(app: &AppHandle, tx: mpsc::Sender<Option<SelectedRegion>>, generation: u64) {
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("[text-tools] 框选层创建失败：无主线程标记 gen={generation}");
        let _ = tx.send(None);
        return;
    };
    // 鼠标所在显示器：先构建 ScreenInfo 列表，再按点匹配
    let mouse = NSEvent::mouseLocation();
    let screens = NSScreen::screens(mtm);
    // 主屏是 AppKit 原点 (0,0) 那块屏 —— 用它的高度做 CG 换算基准。
    // 取 max(y+h) 在外接屏位于主屏上方时会算错（此时 max 不是主屏高度），
    // 导致 CG 帧匹配 SCDisplay 失败、该机器框选彻底不可用。
    let primary_height = screens
        .iter()
        .find(|s| s.frame().origin.x == 0.0 && s.frame().origin.y == 0.0)
        .map(|s| s.frame().size.height)
        .unwrap_or_else(|| {
            screens
                .iter()
                .map(|s| s.frame().origin.y + s.frame().size.height)
                .fold(0.0f64, f64::max)
        });
    let infos: Vec<ScreenInfo> = screens
        .iter()
        .map(|s| {
            let f = s.frame();
            let frame = LogicalRect {
                x: f.origin.x,
                y: f.origin.y,
                w: f.size.width,
                h: f.size.height,
            };
            ScreenInfo {
                frame,
                cg_frame: appkit_screen_to_cg(frame, primary_height),
                scale: s.backingScaleFactor(),
            }
        })
        .collect();
    let Some(screen_info) = find_screen_for_point(&infos, mouse.x, mouse.y) else {
        eprintln!("[text-tools] 框选层创建失败：鼠标不在任何屏幕 gen={generation}");
        let _ = tx.send(None);
        return;
    };
    let frame = screen_info.frame;

    // 创建面板
    let content_rect = CGRect::new(
        CGPoint::new(frame.x, frame.y),
        CGSize::new(frame.w, frame.h),
    );
    let panel = CapturePanel::alloc(mtm);
    // NonactivatingPanel：抬窗/点击框选都不激活本应用 ——
    // 激活会让宠物变成 frontmost，黏住不放后取词（读前台选区）必失败，
    // 且应用处于「曾激活、无键窗」状态时 makeKeyAndOrderFront 会被
    // AppKit 无声吞掉（2026-09-17 二次框选不出现的根因）。
    let panel: Retained<CapturePanel> = unsafe {
        msg_send![
            panel,
            initWithContentRect: content_rect,
            styleMask: NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
            backing: NSBackingStoreType::Buffered,
            defer: false
        ]
    };
    panel.setOpaque(false);
    let clear = NSColor::clearColor();
    panel.setBackgroundColor(Some(&*clear));
    panel.setLevel(NSScreenSaverWindowLevel);
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
    panel.setIgnoresMouseEvents(false);
    panel.setAcceptsMouseMovedEvents(true);

    let view = SelectionView::new(tx, *screen_info, generation);
    view.setFrame(CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize::new(frame.w, frame.h),
    ));
    let content: &NSView = &view;
    panel.setContentView(Some(content));
    panel.makeKeyAndOrderFront(None);
    // 兜底：AppKit 在脏激活态下可能吞掉 makeKeyAndOrderFront 的抬窗，
    // orderFrontRegardless 不受激活状态影响，补一枪确保可见。
    panel.orderFrontRegardless();
    let responder: &NSResponder = &view;
    panel.makeFirstResponder(Some(responder));
    eprintln!("[text-tools] 框选层已显示 gen={generation}");
    // 通知前端框选层真的出现了（前端 1.5s 收不到即报启动失败，
    // 不再让用户干等 60s 超时）
    if let Err(e) = app.emit(EVENT_SELECTION_SHOWN, ()) {
        eprintln!("[text-tools] 框选层显示事件推送失败：{e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 两点归一化为最小原点矩形() {
        let r = normalize(CGPoint::new(100.0, 200.0), CGPoint::new(50.0, 80.0));
        assert_eq!(r, LogicalRect { x: 50.0, y: 80.0, w: 50.0, h: 120.0 });
    }

    #[test]
    fn 反向拖拽同样归一化() {
        let r = normalize(CGPoint::new(10.0, 10.0), CGPoint::new(90.0, 60.0));
        assert_eq!(r, LogicalRect { x: 10.0, y: 10.0, w: 80.0, h: 50.0 });
    }

    #[test]
    fn 最小选区阈值为正() {
        assert!(MIN_SELECTION > 0.0);
    }
}
