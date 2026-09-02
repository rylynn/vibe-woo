//! 打扰仲裁器。
//!
//! 管两件事：插件卡片之间的间隔（全局 90s，与 react.rs 的 GLOBAL_GAP 对齐），
//! 以及插件卡片对常规互动（talk / react）的优先让位。
//!
//! 对设计文档（2026-09-02 第 5 节）的两处实现细化，效果一致、机制更干净：
//! 1. 「番茄阶段切换卡直通」泛化为 `Priority::High` 直通所有闸门 ——
//!    仲裁器不硬编码任何插件 id；
//! 2. 「每插件最小间隔」由插件自己的 next_tick 节奏保证（插件最清楚自己
//!    该多久出一张卡），仲裁器只管全局间隔。
//!
//! 延迟队列的出队时机有两个：番茄进入休息期（drain，设计文档 5.2），
//! 以及宿主每轮醒来时的 retry —— 不开番茄的用户，被全局间隔拦下的卡
//! 不会永远积压。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use super::{CardEvent, PluginCard, Priority, EVENT_PLUGIN_CARD};

/// 全局最小间隔：两张插件卡片之间的强制间隔。
pub const GLOBAL_CARD_GAP: Duration = Duration::from_secs(90);

/// 判定结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Emit,
    Defer,
}

/// 纯函数判定。
///
/// High 直通：番茄阶段切换这类「必须立刻送达」的时刻，插件把卡标 High 即可。
pub fn judge(card: &PluginCard, working: bool, last_card_elapsed: Option<Duration>) -> Verdict {
    if card.priority == Priority::High {
        return Verdict::Emit;
    }
    if working {
        return Verdict::Defer;
    }
    match last_card_elapsed {
        Some(e) if e < GLOBAL_CARD_GAP => Verdict::Defer,
        _ => Verdict::Emit,
    }
}

/// 延迟队列条目：同插件只留最新一张 + 被合并的张数。
#[derive(Debug, Clone)]
struct DeferredEntry {
    card: PluginCard,
    count: u32,
}

#[derive(Default)]
struct State {
    pomodoro_working: bool,
    last_card_at: Option<Instant>,
    deferred: HashMap<String, DeferredEntry>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut g = STATE.lock().expect("arbiter state poisoned");
    let s = g.get_or_insert_with(State::default);
    f(s)
}

/// 判定一批卡片：通过的返回待发出（并推进全局间隔），被拦的按插件
/// 合并入延迟队列（同插件只留最新一张）。
fn judge_batch(s: &mut State, cards: Vec<PluginCard>) -> Vec<CardEvent> {
    let mut out = Vec::new();
    for card in cards {
        let last = s.last_card_at.map(|t| t.elapsed());
        match judge(&card, s.pomodoro_working, last) {
            Verdict::Emit => {
                s.last_card_at = Some(Instant::now());
                out.push(CardEvent {
                    card,
                    deferred_count: 0,
                });
            }
            Verdict::Defer => {
                let e = s
                    .deferred
                    .entry(card.plugin_id.clone())
                    .or_insert(DeferredEntry {
                        card: card.clone(),
                        count: 0,
                    });
                e.card = card;
                e.count += 1;
            }
        }
    }
    out
}

/// 重试延迟队列：全局间隔已过且不在番茄工作期的卡出队。
fn retry_batch(s: &mut State) -> Vec<CardEvent> {
    let last = s.last_card_at.map(|t| t.elapsed());
    let ids: Vec<String> = s.deferred.keys().cloned().collect();
    let mut out = Vec::new();
    for id in ids {
        let pass = s
            .deferred
            .get(&id)
            .map(|e| judge(&e.card, s.pomodoro_working, last) == Verdict::Emit)
            .unwrap_or(false);
        if pass {
            if let Some(e) = s.deferred.remove(&id) {
                out.push(CardEvent {
                    card: e.card,
                    deferred_count: e.count,
                });
            }
        }
    }
    out
}

/// 清空延迟队列（番茄进入休息期）。带被合并的张数。
fn drain_batch(s: &mut State) -> Vec<CardEvent> {
    std::mem::take(&mut s.deferred)
        .into_values()
        .map(|e| CardEvent {
            card: e.card,
            deferred_count: e.count,
        })
        .collect()
}

fn emit_all(app: &AppHandle, events: Vec<CardEvent>) {
    for ev in events {
        let _ = app.emit(EVENT_PLUGIN_CARD, &ev);
    }
}

/// 插件卡片入口（宿主在 tick 后调用）。
pub fn offer(app: &AppHandle, cards: Vec<PluginCard>) {
    let out = with_state(|s| judge_batch(s, cards));
    emit_all(app, out);
}

/// 重试延迟队列（宿主每轮醒来调用）。
pub fn retry(app: &AppHandle) {
    let out = with_state(retry_batch);
    emit_all(app, out);
}

/// 常规互动（talkdrive / react）弹话前问一句：
/// 番茄工作期，或刚展示过插件卡片（优先级让位）时返回 false。
pub fn allow_ambient() -> bool {
    with_state(|s| {
        if s.pomodoro_working {
            return false;
        }
        match s.last_card_at {
            Some(t) => t.elapsed() >= GLOBAL_CARD_GAP,
            None => true,
        }
    })
}

/// 番茄插件切换阶段时调用。进入休息（working=false）时自动补发延迟队列。
pub fn on_pomodoro_phase(app: &AppHandle, working: bool) {
    let drained = with_state(|s| {
        s.pomodoro_working = working;
        if working {
            Vec::new()
        } else {
            drain_batch(s)
        }
    });
    emit_all(app, drained);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn card(id: &str, priority: Priority) -> PluginCard {
        PluginCard {
            plugin_id: id.into(),
            kind: id.into(),
            priority,
            ttl_secs: 10,
            payload: json!({}),
        }
    }

    /// 构造「d 之前」的时刻（开机不足 d 时退化为 now，测试不炸）。
    fn backdate(d: Duration) -> Instant {
        Instant::now().checked_sub(d).unwrap_or_else(Instant::now)
    }

    #[test]
    fn 高优先级直通所有闸门() {
        let c = card("pomodoro", Priority::High);
        assert_eq!(judge(&c, true, Some(Duration::ZERO)), Verdict::Emit);
        assert_eq!(judge(&c, false, Some(Duration::ZERO)), Verdict::Emit);
    }

    #[test]
    fn 番茄工作期延迟普通卡() {
        assert_eq!(
            judge(&card("news", Priority::Normal), true, None),
            Verdict::Defer
        );
        assert_eq!(judge(&card("word", Priority::Low), true, None), Verdict::Defer);
    }

    #[test]
    fn 全局间隔内延迟_到点放行() {
        let c = card("news", Priority::Normal);
        assert_eq!(
            judge(&c, false, Some(GLOBAL_CARD_GAP - Duration::from_millis(1))),
            Verdict::Defer
        );
        assert_eq!(judge(&c, false, Some(GLOBAL_CARD_GAP)), Verdict::Emit);
        assert_eq!(judge(&c, false, None), Verdict::Emit);
    }

    #[test]
    fn 工作期同插件多卡合并为一条计数() {
        let mut s = State {
            pomodoro_working: true,
            ..Default::default()
        };
        let out = judge_batch(
            &mut s,
            vec![card("news", Priority::Normal), card("news", Priority::Normal)],
        );
        assert!(out.is_empty(), "工作期不应有卡通过");
        let e = s.deferred.get("news").unwrap();
        assert_eq!(e.count, 2, "两张合并计数");
    }

    #[test]
    fn 放行的卡推进全局间隔_第二张被拦() {
        let mut s = State::default();
        let out = judge_batch(&mut s, vec![card("news", Priority::Normal)]);
        assert_eq!(out.len(), 1);
        assert!(s.last_card_at.is_some());
        let out2 = judge_batch(&mut s, vec![card("stocks", Priority::Normal)]);
        assert!(out2.is_empty(), "90 秒内的第二张应被拦");
        assert_eq!(s.deferred.get("stocks").unwrap().count, 1);
    }

    #[test]
    fn 间隔与工作期都解除后重试出队() {
        let mut s = State {
            pomodoro_working: true,
            ..Default::default()
        };
        judge_batch(&mut s, vec![card("news", Priority::Normal)]);
        s.pomodoro_working = false;
        s.last_card_at = Some(backdate(GLOBAL_CARD_GAP));
        let out = retry_batch(&mut s);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].deferred_count, 1);
        assert!(s.deferred.is_empty(), "出队后队列应清空");
    }

    #[test]
    fn 间隔未过重试留队() {
        let mut s = State::default();
        s.last_card_at = Some(Instant::now());
        judge_batch(&mut s, vec![card("news", Priority::Normal)]);
        let out = retry_batch(&mut s);
        assert!(out.is_empty());
        assert_eq!(s.deferred.len(), 1, "间隔未过应继续等待");
    }

    #[test]
    fn 休息期清空队列并带计数() {
        let mut s = State {
            pomodoro_working: true,
            ..Default::default()
        };
        judge_batch(
            &mut s,
            vec![
                card("news", Priority::Normal),
                card("news", Priority::Normal),
                card("stocks", Priority::Normal),
            ],
        );
        let out = drain_batch(&mut s);
        assert_eq!(out.len(), 2, "两个插件各留最新一张");
        let counts: Vec<u32> = out.iter().map(|e| e.deferred_count).collect();
        assert!(counts.contains(&2) && counts.contains(&1));
        assert!(s.deferred.is_empty());
    }

    #[test]
    fn allow_ambient_遵循番茄与让位规则() {
        reset_for_test();
        assert!(allow_ambient(), "无卡无番茄应允许");

        with_state(|s| s.pomodoro_working = true);
        assert!(!allow_ambient(), "番茄工作期应让位");

        with_state(|s| {
            s.pomodoro_working = false;
            s.last_card_at = Some(Instant::now());
        });
        assert!(!allow_ambient(), "刚出过插件卡应让位");

        with_state(|s| s.last_card_at = Some(backdate(GLOBAL_CARD_GAP)));
        assert!(allow_ambient(), "间隔过后恢复");

        reset_for_test();
    }

    fn reset_for_test() {
        *STATE.lock().unwrap() = None;
    }
}
