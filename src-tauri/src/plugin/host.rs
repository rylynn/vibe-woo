//! 插件宿主：一条线程调度所有插件。
//!
//! 睡到最近的 next_tick；没有任何插件参与时按 IDLE_POLL 兜底轮询
//!（配置开关随时可能被打开）。单次睡眠也以 IDLE_POLL 为上限 ——
//! 仲裁器延迟队列的重试不能睡过头。

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::arbiter;
use super::{Plugin, PluginCard, ScheduleCtx, TickCtx};

/// 空闲轮询间隔：注册表为空 / 全部禁用时的兜底，也是单次睡眠的上限。
const IDLE_POLL: Duration = Duration::from_secs(60);

/// 同一插件连续 panic 这么多次后，本进程内禁用。
const MAX_CONSECUTIVE_PANICS: u32 = 3;

/// 构建注册表（注册点：加插件在此与 mod::installed 各加一行）。
fn registry(app: &AppHandle) -> Vec<Box<dyn Plugin>> {
    vec![
        Box::new(super::pomodoro::PomodoroPlugin::new(app)),
        Box::new(super::words::WordsPlugin::new(app)),
        Box::new(super::news::NewsPlugin::new(app)),
        Box::new(super::stocks::StocksPlugin::new(app)),
    ]
}

/// 启动宿主线程。
pub fn spawn(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut plugins = registry(&app);
        let mut panics: HashMap<String, u32> = HashMap::new();
        // 每插件的下次到期时刻（next_tick 语义：距「需要被 tick」的时长）。
        // 必须由宿主记账 —— 轮询型插件每次都返回固定间隔，若每次都
        // 重新询问会无限顺延，插件永远不会被 tick（0.3.0 之前的致命 bug）。
        let mut deadlines: Vec<Option<Instant>> = plugins.iter().map(|_| None).collect();
        loop {
            let sleep_for = run_once(&mut plugins, &mut deadlines, &mut panics, &app);
            std::thread::sleep(sleep_for);
        }
    });
}

/// 一轮调度：先重试仲裁队列，再收集到期插件逐个 tick。
/// 返回本轮应睡眠的时长；有插件刚被 tick 过则返回零（立刻下轮 ——
/// tick 可能有副作用，deadline 旧值不能再用）。
fn run_once(
    plugins: &mut [Box<dyn Plugin>],
    deadlines: &mut [Option<Instant>],
    panics: &mut HashMap<String, u32>,
    app: &AppHandle,
) -> Duration {
    arbiter::retry(app);

    let Plan { due, sleep: sleep_for } = plan_schedule(plugins, deadlines, panics);

    if due.is_empty() {
        return sleep_for;
    }

    for i in due {
        let Some(p) = plugins.get_mut(i) else { continue };
        let id = p.id().to_string();
        let mut tctx = TickCtx { app };
        // panic 隔离：一个插件炸了不能拖死共享这条线程的其他插件
        let result = catch_unwind(AssertUnwindSafe(|| p.tick(&mut tctx)));
        let cards = record_result(&id, result, panics);
        arbiter::offer(app, cards);
    }
    Duration::ZERO
}

/// 一轮的调度决策（纯查询，单测入口）：哪些插件到期、本轮睡多久。
struct Plan {
    due: Vec<usize>,
    sleep: Duration,
}

/// deadline 语义见 `spawn` 的注释：next_tick 返回 d>0 只记一次账，
/// 到期直接 tick 不再询问 —— 轮询型插件恒返回固定间隔，重问会无限顺延。
fn plan_schedule(
    plugins: &[Box<dyn Plugin>],
    deadlines: &mut [Option<Instant>],
    panics: &HashMap<String, u32>,
) -> Plan {
    let now = Instant::now();
    let ctx = ScheduleCtx { now };
    let mut sleep = IDLE_POLL;
    let mut due = Vec::new();
    for (i, p) in plugins.iter().enumerate() {
        if panics.get(p.id()).copied().unwrap_or(0) >= MAX_CONSECUTIVE_PANICS {
            continue; // 连续 panic 达上限，本进程内禁用
        }
        if let Some(d) = deadlines[i] {
            if now < d {
                sleep = sleep.min(d - now);
                continue;
            }
            deadlines[i] = None;
            due.push(i);
            continue;
        }
        match p.next_tick(&ctx) {
            None => {}
            Some(d) if d == Duration::ZERO => due.push(i),
            Some(d) => {
                deadlines[i] = Some(now + d);
                sleep = sleep.min(d);
            }
        }
    }
    Plan { due, sleep }
}

/// 记录一次 tick 的结果：成功清零连续 panic 计数并返回产出的卡；
/// 失败计数递增，达上限禁用。
fn record_result(
    id: &str,
    result: Result<Vec<PluginCard>, Box<dyn std::any::Any + Send>>,
    panics: &mut HashMap<String, u32>,
) -> Vec<PluginCard> {
    match result {
        Ok(cards) => {
            panics.insert(id.to_string(), 0);
            cards
        }
        Err(_) => {
            let n = panics.entry(id.to_string()).or_insert(0);
            *n += 1;
            eprintln!("[plugin:{id}] tick panic（连续 {n} 次）");
            if *n >= MAX_CONSECUTIVE_PANICS {
                eprintln!("[plugin:{id}] 连续 panic 达上限，本进程内禁用");
            }
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::Priority;
    use serde_json::json;

    /// 可配置延迟、可计数的测试插件。
    struct Probe {
        delay: Option<Duration>,
        ticks: u32,
    }

    impl Plugin for Probe {
        fn id(&self) -> &'static str {
            "probe"
        }
        fn name(&self) -> &'static str {
            "探针"
        }
        fn next_tick(&self, _ctx: &ScheduleCtx) -> Option<Duration> {
            self.delay
        }
        fn tick(&mut self, _ctx: &mut TickCtx) -> Vec<PluginCard> {
            self.ticks += 1;
            vec![PluginCard {
                plugin_id: "probe".into(),
                kind: "probe".into(),
                priority: Priority::Low,
                ttl_secs: 5,
                payload: json!({}),
            }]
        }
    }

    fn probe(delay: Option<Duration>) -> Probe {
        Probe { delay, ticks: 0 }
    }

    #[test]
    fn 全部不参与时睡空闲轮询() {
        let mut plugins: Vec<Box<dyn Plugin>> = vec![Box::new(probe(None))];
        let mut deadlines = vec![None];
        let plan = plan_schedule(&plugins, &mut deadlines, &HashMap::new());
        assert_eq!(plan.sleep, IDLE_POLL);
        assert!(plan.due.is_empty());
    }

    #[test]
    fn 零延迟立即到期_正延迟记deadline() {
        let mut plugins: Vec<Box<dyn Plugin>> = vec![
            Box::new(probe(Some(Duration::from_secs(30)))),
            Box::new(probe(Some(Duration::ZERO))),
        ];
        let mut deadlines = vec![None, None];
        let plan = plan_schedule(&plugins, &mut deadlines, &HashMap::new());
        assert_eq!(plan.due, vec![1], "零延迟的插件立即到期");
        assert!(deadlines[0].is_some(), "正延迟必须记 deadline");
        assert_eq!(plan.sleep, Duration::from_secs(30));
    }

    #[test]
    fn deadline到期直接tick_不重新询问() {
        // 0.3.0 之前的致命 bug：轮询型插件恒返回 30s，旧逻辑只认 d==0
        // 为到期 → 永远不会 tick。现在 deadline 到期即 tick。
        let mut plugins: Vec<Box<dyn Plugin>> = vec![Box::new(probe(Some(Duration::from_secs(30))))];
        let mut deadlines = vec![Some(Instant::now() - Duration::from_secs(1))]; // 已到期
        let plan = plan_schedule(&plugins, &mut deadlines, &HashMap::new());
        assert_eq!(plan.due, vec![0], "deadline 过期必须 tick");
        assert!(deadlines[0].is_none(), "tick 后 deadline 清空，下轮重新询问");
    }

    #[test]
    fn deadline未到只贡献睡眠() {
        let mut plugins: Vec<Box<dyn Plugin>> = vec![Box::new(probe(Some(Duration::from_secs(30))))];
        let mut deadlines = vec![Some(Instant::now() + Duration::from_secs(7))];
        let plan = plan_schedule(&plugins, &mut deadlines, &HashMap::new());
        assert!(plan.due.is_empty(), "未到期不 tick");
        assert!(plan.sleep <= Duration::from_secs(7), "睡到 deadline（剩 7s 左右）");
        assert!(deadlines[0].is_some(), "deadline 保留");
    }

    #[test]
    fn 连续panic达上限的插件被跳过() {
        let mut plugins: Vec<Box<dyn Plugin>> =
            vec![Box::new(probe(Some(Duration::ZERO)))];
        let mut deadlines = vec![None];
        let mut panics: HashMap<String, u32> = HashMap::new();
        panics.insert("probe".into(), MAX_CONSECUTIVE_PANICS);
        let plan = plan_schedule(&plugins, &mut deadlines, &panics);
        assert!(plan.due.is_empty(), "禁用的插件即使零延迟也不 tick");
    }

    #[test]
    fn panic计数递增_成功后清零() {
        let mut panics: HashMap<String, u32> = HashMap::new();
        let cards = record_result("p", Ok(Vec::new()), &mut panics);
        assert!(cards.is_empty());
        assert_eq!(panics.get("p"), Some(&0), "成功清零");

        let boom = || -> Result<Vec<PluginCard>, Box<dyn std::any::Any + Send>> {
            Err(Box::new("boom"))
        };
        record_result("p", boom(), &mut panics);
        assert_eq!(panics.get("p"), Some(&1), "失败递增");

        record_result("p", boom(), &mut panics);
        record_result("p", boom(), &mut panics);
        assert_eq!(panics.get("p"), Some(&MAX_CONSECUTIVE_PANICS));

        // 成功一次就翻身
        record_result("p", Ok(Vec::new()), &mut panics);
        assert_eq!(panics.get("p"), Some(&0));
    }
}
