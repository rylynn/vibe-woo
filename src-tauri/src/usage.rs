//! 当日用量计数 —— 只聚合计数，不含任何内容（隐私红线）。
//!
//! 计数在进程内存中维护（跨日自动归零），由 socialdrive 心跳捎带上报，
//! 服务端按差值累加成按日统计。宠物重启后计数从 0 开始，
//! 服务端的差值策略会把新值当作当日增量，最多低估不重复计。

use std::sync::Mutex;

/// 计数种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// 提醒触发（含稍后再响）。
    Reminder,
    /// 速记创建成功。
    Note,
    /// 完成一个番茄工作期（工作段跑完进入休息）。
    Pomodoro,
}

#[derive(Debug)]
struct UsageDay {
    date: String,
    reminders: u32,
    notes: u32,
    pomodoros: u32,
    /// 在线秒数（浮点累计，上报时折算分钟，保证当日单调不减）。
    online_secs: f64,
}

impl UsageDay {
    fn new(date: &str) -> Self {
        Self {
            date: date.to_string(),
            reminders: 0,
            notes: 0,
            pomodoros: 0,
            online_secs: 0.0,
        }
    }
}

static DAY: Mutex<Option<UsageDay>> = Mutex::new(None);

/// 本地日期（YYYY-MM-DD）。取不到（极端平台）时返回空串，计数跳过。
fn today() -> String {
    crate::reminddrive::local_now()
        .map(|c| c.date)
        .unwrap_or_default()
}

/// 在指定日期的计数卡上执行操作：跨日先归零。
fn with_day<R>(date: &str, f: impl FnOnce(&mut UsageDay) -> R) -> R {
    let mut g = DAY.lock().unwrap_or_else(|e| e.into_inner());
    let day = g.get_or_insert_with(|| UsageDay::new(date));
    if day.date != date {
        *day = UsageDay::new(date);
    }
    f(day)
}

/// 打点：某类事件 +1。
pub fn bump(kind: Kind) {
    let date = today();
    if date.is_empty() {
        return;
    }
    with_day(&date, |d| match kind {
        Kind::Reminder => d.reminders += 1,
        Kind::Note => d.notes += 1,
        Kind::Pomodoro => d.pomodoros += 1,
    });
}

/// 打点：在线时长累计（秒，可为小数 —— 心跳间隔不是整分钟）。
pub fn add_online_secs(secs: f64) {
    if secs <= 0.0 {
        return;
    }
    let date = today();
    if date.is_empty() {
        return;
    }
    with_day(&date, |d| d.online_secs += secs);
}

/// 心跳上报用的当日快照。尚未打点过时返回 None（心跳不带 usage 字段）。
pub fn snapshot() -> Option<Snapshot> {
    let g = DAY.lock().unwrap_or_else(|e| e.into_inner());
    let d = g.as_ref()?;
    Some(Snapshot {
        date: d.date.clone(),
        reminders: d.reminders,
        notes: d.notes,
        pomodoros: d.pomodoros,
        online_mins: (d.online_secs / 60.0).floor() as u32,
    })
}

/// 当日计数快照（心跳 body 的 usage 字段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub date: String,
    pub reminders: u32,
    pub notes: u32,
    pub pomodoros: u32,
    pub online_mins: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 直接按指定日期打点，绕过 local_now（测试注入日期）。
    fn bump_at(kind: Kind, date: &str) {
        with_day(date, |d| match kind {
            Kind::Reminder => d.reminders += 1,
            Kind::Note => d.notes += 1,
            Kind::Pomodoro => d.pomodoros += 1,
        });
    }

    /// 全局状态单测：共享 static，合并为一个顺序执行的测试。
    #[test]
    fn 打点_快照_跨日归零_分钟取整() {
        // 1. 当日打点精确累计
        with_day("2026-08-30", |d| {
            d.reminders = 0;
            d.notes = 0;
            d.pomodoros = 0;
            d.online_secs = 0.0;
        });
        bump_at(Kind::Reminder, "2026-08-30");
        bump_at(Kind::Reminder, "2026-08-30");
        bump_at(Kind::Note, "2026-08-30");
        bump_at(Kind::Pomodoro, "2026-08-30");
        let s = snapshot().unwrap();
        assert_eq!(
            (s.date.as_str(), s.reminders, s.notes, s.pomodoros),
            ("2026-08-30", 2, 1, 1)
        );

        // 2. 在线分钟向下取整且随秒数单调不减
        assert_eq!(s.online_mins, 0, "0 秒 = 0 分钟");
        with_day("2026-08-30", |d| d.online_secs = 59.0);
        assert_eq!(snapshot().unwrap().online_mins, 0, "59 秒不足 1 分钟");
        with_day("2026-08-30", |d| d.online_secs = 121.0);
        assert_eq!(snapshot().unwrap().online_mins, 2, "121 秒 = 2 分钟");

        // 3. 跨日归零
        bump_at(Kind::Note, "2026-09-01");
        let s = snapshot().unwrap();
        assert_eq!((s.date.as_str(), s.notes, s.reminders), ("2026-09-01", 1, 0));
    }
}
