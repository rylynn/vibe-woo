//! 提醒驱动循环：到点触发并推送事件给前端。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::configcmd;
use crate::reminder::{should_fire, TimeCtx};

/// 提醒触发事件名。
pub const EVENT_REMINDER: &str = "pet://reminder";

#[derive(serde::Serialize, Clone)]
pub struct ReminderFired {
    /// 提醒在配置列表中的下标。前端据此执行删除/改时间等操作。
    ///
    /// 注意：列表变更后下标会漂移，操作前应以最新配置为准（前端会重拉）。
    pub index: usize,
    pub text: String,
    /// 重要提醒用右上角弹窗，普通提醒用宠物气泡。
    pub important: bool,
    /// 触发时刻的 HH:MM，供显示。
    pub time: String,
}

/// 检查间隔。提醒精度到分钟即可，30 秒足够。
const CHECK_INTERVAL: Duration = Duration::from_secs(30);

/// 稍后再响计划：提醒下标 → 到期时刻。
static SNOOZES: Mutex<Option<HashMap<usize, std::time::Instant>>> = Mutex::new(None);

/// 稍后重响：过 minutes 分钟把该提醒再推一次。
#[tauri::command]
pub fn snooze_reminder(index: usize, mins: u64) -> Result<(), String> {
    let at = std::time::Instant::now()
        .checked_add(Duration::from_secs(mins * 60))
        .ok_or("时间溢出")?;
    if let Ok(mut g) = SNOOZES.lock() {
        g.get_or_insert_with(HashMap::new).insert(index, at);
        Ok(())
    } else {
        Err("内部状态被锁".into())
    }
}

pub fn spawn(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // 已触发的 (提醒下标, 日期)，防止同一天重复响
        let mut fired: HashMap<(usize, String), ()> = HashMap::new();

        loop {
            std::thread::sleep(CHECK_INTERVAL);

            let now = local_now();
            let Some(ctx) = now else { continue };
            let cfg = configcmd::current();

            for (i, r) in cfg.reminders.iter().enumerate() {
                let key = (i, ctx.date.to_string());
                if fired.contains_key(&key) {
                    continue;
                }
                if should_fire(r, &ctx, "") {
                    fired.insert(key, ());
                    crate::usage::bump(crate::usage::Kind::Reminder);
                    eprintln!("[reminder] 触发：{}（{}）", r.text, r.time);
                    let _ = app.emit(
                        EVENT_REMINDER,
                        ReminderFired {
                            index: i,
                            text: r.text.clone(),
                            important: r.important,
                            time: r.time.clone(),
                        },
                    );
                }
            }

            // 稍后再响到期：重推一次（用户可再次稍后）
            let due: Vec<usize> = {
                let mut due = Vec::new();
                if let Ok(mut g) = SNOOZES.lock() {
                    if let Some(map) = g.as_mut() {
                        let now = std::time::Instant::now();
                        due = map
                            .iter()
                            .filter(|(_, at)| **at <= now)
                            .map(|(i, _)| *i)
                            .collect();
                        for i in &due {
                            map.remove(i);
                        }
                    }
                }
                due
            };
            for i in due {
                if let Some(r) = cfg.reminders.get(i) {
                    crate::usage::bump(crate::usage::Kind::Reminder);
                    eprintln!("[reminder] 稍后重响：{}（{}）", r.text, r.time);
                    let _ = app.emit(
                        EVENT_REMINDER,
                        ReminderFired {
                            index: i,
                            text: r.text.clone(),
                            important: r.important,
                            time: r.time.clone(),
                        },
                    );
                }
            }

            // 防止无限增长：清掉非今天的记录
            fired.retain(|(_, d), _| *d == ctx.date);
        }
    });
}

/// 取当前本地日期与分钟数。pub 供番茄驱动复用。
pub fn local_now() -> Option<TimeCtx> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;

    #[cfg(unix)]
    unsafe {
        let secs = (ms / 1000) as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&secs, &mut tm).is_null() {
            return None;
        }
        let y = 1900 + tm.tm_year;
        let date = format!("{y:04}-{:02}-{:02}", tm.tm_mon + 1, tm.tm_mday);
        return Some(TimeCtx::new(date, tm.tm_hour as u32 * 60 + tm.tm_min as u32));
    }
    #[cfg(not(unix))]
    {
        None
    }
}
