#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity;
mod account;
mod appinfo;
mod appclass;
mod config;
mod configcmd;
mod envsense;
mod habitdrive;
mod habitmemory;
mod hittest;
mod inputfocus;
mod llm;
mod memory;
mod mood;
mod mouse;
mod note;
mod notecmd;
mod passthrough;
mod persona;
mod pomodorodrive;
mod react;
mod reminder;
mod reminddrive;
mod rewards;
mod sensedrive;
mod socialdrive;
mod share;
mod social;
mod socialcmd;
mod talkdrive;
mod shortcut;
mod sensor;
mod state;
mod tray;
mod usage;
mod window;

use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 不依赖任何 UI 的强制退出快捷键：Ctrl+Alt+Cmd+Q。
///
/// 存在理由：宠物是全屏透明置顶窗口，一旦穿透逻辑出问题就可能拦截整个桌面
/// 的点击，此时托盘也点不到。必须有一条纯键盘的逃生通道。
fn kill_switch() -> Shortcut {
    Shortcut::new(
        Some(
            Modifiers::CONTROL
                .union(Modifiers::ALT)
                .union(Modifiers::SUPER),
        ),
        Code::KeyQ,
    )
}

fn main() {
    let builder = tauri::Builder::default()
        // 单实例锁：多开会叠加多层全屏透明窗，点击行为将无法预测
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            eprintln!("[pet] another instance attempted to launch; focusing existing one");
            if let Some(win) = app.get_webview_window("pet") {
                let _ = win.show();
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if shortcut == &kill_switch() && event.state() == ShortcutState::Pressed {
                        eprintln!("[pet] kill switch pressed, exiting");
                        app.exit(0);
                        return;
                    }
                    shortcut::handle(app, shortcut, event.state());
                })
                .build(),
        );

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    builder
        .invoke_handler(tauri::generate_handler![
            hittest::report_pet_box,
            hittest::quit_app,
            notecmd::add_note,
            notecmd::list_today_notes,
            inputfocus::begin_text_input,
            inputfocus::end_text_input,
            socialcmd::register,
            socialcmd::login,
            socialcmd::logout,
            socialcmd::add_friend,
            socialcmd::remove_friend,
            socialcmd::set_pet_name,
            socialcmd::return_home,
            llm::test_llm,
            configcmd::get_config,
            configcmd::update_config,
            appinfo::get_app_info,
            reminddrive::snooze_reminder
        ])
        .setup(|app| {
            // 不出现在 Dock 与 Cmd+Tab。等价于 LSUIElement，
            // 但 dev 与 prod 都生效（Info.plist 方案在 dev 下不可靠）。
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // 先注册逃生快捷键，再显示窗口 —— 顺序很重要：
            // 万一窗口逻辑有问题，用户至少已经能退出了。
            app.global_shortcut().register(kill_switch())?;
            shortcut::register_note_shortcut(app.handle());
            shortcut::register_reminder_shortcut(app.handle());
            tray::setup_tray(app)?;

            let cfg = configcmd::init(app.handle());
            rewards::init(app.handle());
            eprintln!(
                "[config] 已载入：尺寸档位={} 范围={:?} 人格={:?}",
                cfg.size_index, cfg.roam_scope, cfg.persona
            );

            window::setup_pet_window(app.handle())?;
            hittest::spawn_hit_test_loop(app.handle());
            // 先于感知循环：习惯日志的目录与缓存要在第一次采样前就位
            habitdrive::spawn(app.handle());
            sensedrive::spawn(app.handle());
            reminddrive::spawn(app.handle());
            talkdrive::spawn(app.handle());
            socialdrive::spawn(app.handle());
            pomodorodrive::spawn(app.handle());
            pomodorodrive::push_initial_rewards(app.handle());

            eprintln!("[pet] ready. kill switch: Ctrl+Alt+Cmd+Q");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running vibe-pet");
}
