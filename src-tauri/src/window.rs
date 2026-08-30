use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

/// 把宠物窗口铺满主显示器，并做平台特化处理。
///
/// 窗口在 tauri.conf.json 中配置为 visible: false，由本函数在平台特化
/// 完成后再显示 —— 否则会先闪一下普通窗口再变成 panel。
pub fn setup_pet_window(app: &AppHandle) -> tauri::Result<()> {
    let win = app
        .get_webview_window("pet")
        .expect("window with label 'pet' must exist in tauri.conf.json");

    if let Some(monitor) = win.primary_monitor()? {
        let size = monitor.size();
        let pos = monitor.position();
        win.set_size(PhysicalSize::new(size.width, size.height))?;
        win.set_position(PhysicalPosition::new(pos.x, pos.y))?;
    }

    // 先设为穿透再显示，避免显示瞬间拦截桌面点击
    win.set_ignore_cursor_events(true)?;

    #[cfg(target_os = "macos")]
    macos::convert_to_pet_panel(&win);

    win.show()?;
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos {
    // Manager 看似未使用，实则必需：tauri_panel! 宏展开后会调用
    // app_handle()，该方法来自 Manager trait。删掉会编译失败。
    use tauri::{Manager, WebviewWindow};
    use tauri_nspanel::{
        tauri_panel, CollectionBehavior, PanelLevel, StyleMask, WebviewWindowExt,
    };

    tauri_panel! {
        panel!(PetPanel {
            config: {
                is_floating_panel: true,
                // true + becomes_key_only_if_needed（下方设置）是解「不抢焦点
                // 但输入框要能打字」这对矛盾的关键：
                //   - 点宠物身体（canvas，非可编辑元素）→ 不成为 key window，
                //     键盘留在编辑器（验证①仍然成立）
                //   - 点速记/设置的输入框（可编辑元素）→ 需要焦点 → 成为
                //     key window → 能打字
                // 见 inputfocus.rs。
                can_become_key_window: true,
                can_become_main_window: false
            }
        })
    }

    /// 逐步执行并单独兜底，失败时能指出具体是哪一步。
    ///
    /// 用一个大 catch 包住全部配置会掩盖故障点：只知道「panel 配置失败」，
    /// 不知道是 to_panel、style mask 还是 Touch Bar 那步的问题。
    fn step(name: &str, f: impl FnOnce()) -> bool {
        use std::panic::AssertUnwindSafe;
        match tauri_nspanel::objc2::exception::catch(AssertUnwindSafe(f)) {
            Ok(()) => true,
            Err(e) => {
                eprintln!("[pet] panel step '{name}' raised Obj-C exception: {e:?}");
                false
            }
        }
    }

    /// 关键配方，详见 docs/plans/2026-08-29-vibe-pet-design.md 3.3。
    ///
    /// msg_send! 遇 Obj-C 异常会 panic，故每步都用 objc2::exception::catch
    /// 兜底；最坏情况只是某项配置未生效，不会 SIGABRT。
    pub fn convert_to_pet_panel(win: &WebviewWindow) {
        let panel = match win.to_panel::<PetPanel>() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[pet] to_panel failed: {e:?}");
                return;
            }
        };

        // Dock level + nonactivating 才会被 AppKit 路由进全屏辅助层
        step("set_level", || panel.set_level(PanelLevel::Dock.value()));

        // 生死线：点宠物不抢走编辑器焦点
        step("set_style_mask", || {
            panel.set_style_mask(StyleMask::empty().nonactivating_panel().into())
        });

        // 只在需要时（点了可编辑元素）才成为 key window。
        // 没有这行，点宠物身体也会抢键盘 —— 验证①会挂。
        step("becomes_key_only_if_needed", || {
            panel.set_becomes_key_only_if_needed(true)
        });

        // 跟随所有 Space，可浮在全屏应用之上
        step("set_collection_behavior", || {
            panel.set_collection_behavior(
                CollectionBehavior::new()
                    .stationary()
                    .can_join_all_spaces()
                    .full_screen_auxiliary()
                    .into(),
            )
        });

        // nonactivating 只管焦点，不管 resign-active 时的自动隐藏。
        // 不设这行会出现「要点一下宠物它才回来」的延迟。
        step("set_hides_on_deactivate", || {
            panel.set_hides_on_deactivate(false)
        });

        // 防 Touch Bar KVO 崩溃：to_panel 换类发生在 Touch Bar finder
        // 已对原 NSWindow 注册观察者之后，注销时可能抛 NSRangeException。
        //
        // 但 setAutorecalculatesTouchBar: 属于 NSTouchBarProvider，在没有
        // Touch Bar 的机器上该选择器不存在（实测 M 系列 Mac 会抛
        // NSInvalidArgumentException: unrecognized selector）。
        // 因此先探测再调用 —— 无此选择器意味着本机没有 Touch Bar，
        // 那个 KVO 崩溃路径本身也就不存在，跳过是安全的。
        let responds: bool = unsafe {
            tauri_nspanel::objc2::msg_send![
                panel.as_panel(),
                respondsToSelector: tauri_nspanel::objc2::sel!(setAutorecalculatesTouchBar:)
            ]
        };
        if responds {
            step("setAutorecalculatesTouchBar", || {
                let _: () = unsafe {
                    tauri_nspanel::objc2::msg_send![
                        panel.as_panel(),
                        setAutorecalculatesTouchBar: false
                    ]
                };
            });
        }

        eprintln!("[pet] panel setup finished (touch bar guard: {responds})");
    }
}
