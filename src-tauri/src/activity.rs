//! 更细的活动识别：发呆、听歌、摸鱼。
//!
//! 这些是 Doing 之外的「场景修饰」，让宠物的反应更有针对性。

use serde::Serialize;

use crate::state::{AppKind, Snapshot};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    /// 编辑器前台但长时间无输入 —— 在思考或在等 AI。
    Thinking,
    /// 在听音乐。
    Listening,
    /// 在浏览器里且键盘几乎不动 —— 大概率在摸鱼。
    Slacking,
    /// 正常干活或其他。
    Working,
}

const MUSIC_BUNDLES: &[&str] = &[
    "com.apple.Music",
    "com.spotify.client",
    "com.netease.163music",
    "com.tencent.QQMusic",
    "tv.kugou.",
    "com.sibtips.radium",
];

const THINKING_IDLE_SECS: f64 = 45.0;
const SLACKING_IDLE_SECS: f64 = 8.0;

/// 由传感器快照 + bundle id 推导活动。
///
/// 与状态机分离：状态机回答「在干什么 / 什么节奏」，
/// 这里回答「具体是什么场景」。两者叠加才是完整的判断。
pub fn detect(s: &Snapshot, bundle_id: &str) -> Activity {
    let id = bundle_id.to_ascii_lowercase();

    if MUSIC_BUNDLES.iter().any(|p| id.starts_with(&p.to_ascii_lowercase())) {
        return Activity::Listening;
    }
    // 产出型工具前台却长时间没敲键 —— 在想事情
    if s.app.is_producing() && s.keyboard_idle_secs >= THINKING_IDLE_SECS {
        return Activity::Thinking;
    }
    // 浏览器与影音里键盘不动 = 在逛在看，不是产出
    if matches!(s.app, AppKind::Browsing | AppKind::Watching)
        && s.keyboard_idle_secs >= SLACKING_IDLE_SECS
    {
        return Activity::Slacking;
    }
    Activity::Working
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(app: AppKind, idle: f64) -> Snapshot {
        Snapshot {
            app,
            keystrokes_per_min: 0.0,
            keyboard_idle_secs: idle,
            hour: 14,
        }
    }

    #[test]
    fn 识别常见音乐应用() {
        for id in [
            "com.apple.Music",
            "com.spotify.client",
            "com.netease.163music",
            "com.tencent.QQMusicMac",
        ] {
            assert_eq!(detect(&snap(AppKind::Other, 1.0), id), Activity::Listening, "{id}");
        }
    }

    #[test]
    fn 音乐应用优先于其他判定() {
        // 即便在浏览器里听歌，前台是 Spotify 就应判为听歌
        assert_eq!(
            detect(&snap(AppKind::Other, 100.0), "com.spotify.client"),
            Activity::Listening
        );
    }

    #[test]
    fn 编辑器内长时间无输入判定为思考() {
        assert_eq!(
            detect(&snap(AppKind::Editing, 60.0), "com.microsoft.VSCode"),
            Activity::Thinking
        );
    }

    #[test]
    fn 任何产出型工具里停手都算思考() {
        // 写方案、画设计稿、对表格时停下来，同样是在想事情
        for app in [
            AppKind::Editing,
            AppKind::Writing,
            AppKind::Designing,
            AppKind::Data,
        ] {
            assert_eq!(
                detect(&snap(app, 60.0), "com.whatever.App"),
                Activity::Thinking,
                "{app:?}"
            );
        }
    }

    #[test]
    fn 短暂停顿不算思考() {
        assert_eq!(
            detect(&snap(AppKind::Editing, 10.0), "com.microsoft.VSCode"),
            Activity::Working
        );
    }

    #[test]
    fn 浏览器里键盘不动判定为摸鱼() {
        assert_eq!(
            detect(&snap(AppKind::Browsing, 30.0), "com.google.Chrome"),
            Activity::Slacking
        );
    }

    #[test]
    fn 看视频不动判定为消遣() {
        assert_eq!(
            detect(&snap(AppKind::Watching, 30.0), "com.colliderli.iina"),
            Activity::Slacking
        );
    }

    #[test]
    fn 浏览器里在打字不算摸鱼_可能在写文档() {
        assert_eq!(
            detect(&snap(AppKind::Browsing, 2.0), "com.google.Chrome"),
            Activity::Working
        );
    }

    #[test]
    fn 未知应用默认干活() {
        assert_eq!(detect(&snap(AppKind::Other, 1.0), "com.foo.Bar"), Activity::Working);
    }

    #[test]
    fn bundle_id_大小写不敏感() {
        assert_eq!(
            detect(&snap(AppKind::Other, 1.0), "COM.SPOTIFY.CLIENT"),
            Activity::Listening
        );
    }
}
