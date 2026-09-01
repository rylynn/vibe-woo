//! 速记相关的前后端命令。

use serde::Serialize;
use tauri::AppHandle;

use crate::note::{self, Note};

/// 速记已落盘事件名。前端用它做「收进包裹」的确认动画。
pub const EVENT_SAVED: &str = "pet://note-saved";

#[derive(Debug, Serialize)]
pub struct NoteSaved {
    pub text: String,
    /// 实际写入的位置，供调试。空数组意味着两个落点都失败了。
    pub written_to: Vec<String>,
}

/**
 * 新增一条速记。
 *
 * 无条件先落盘。LLM 整理在 spawn 出的任务里异步做，绝不阻塞返回 ——
 * 慢或失败都不能让你记不下这一条。
 */
#[tauri::command]
pub fn add_note(app: AppHandle, text: String) -> NoteSaved {
    let note = Note::new(&text, now_ms());
    if note.text.is_empty() {
        return NoteSaved {
            text: String::new(),
            written_to: Vec::new(),
        };
    }

    let written_to = note::persist(&app, &note);
    // 当日记忆 +1（供疲劳叙述与 system prompt 的「今天」段使用）
    crate::memory::note_added();
    // 习惯记忆 +1（记速记本身也是一种习惯信号）
    crate::habitmemory::note_added();
    // 用量计数：至少一个落点写成功才算一条速记
    if !written_to.is_empty() {
        crate::usage::bump(crate::usage::Kind::Note);
    }
    use tauri::Emitter;
    let _ = app.emit(EVENT_SAVED, &note.text);
    eprintln!(
        "[note] 已落盘（{}）：{}",
        if written_to.is_empty() {
            "失败!"
        } else {
            "成功"
        },
        note.text
    );

    // LLM 异步整理：可关、失败静默。占位 —— M4-4 接入。
    let app2 = app.clone();
    let text2 = note.text.clone();
    std::thread::spawn(move || {
        crate::llm::enrich(&app2, text2);
    });

    NoteSaved {
        text: note.text,
        written_to,
    }
}

/// 今日速记列表，供回看。
#[tauri::command]
pub fn list_today_notes(app: AppHandle) -> Vec<Note> {
    note::list_today(&app)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
