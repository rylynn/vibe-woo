//! 前台应用分类。
//!
//! 把 bundle id 映射到「在写代码 / 在浏览 / 其他」。规则可由用户覆盖 ——
//! 每个人的工具链都不同，硬编码列表必然不全。

use crate::state::AppKind;

/// 默认判定为「写代码」的 bundle id 前缀。
///
/// 用前缀匹配而非精确匹配：JetBrains 系（com.jetbrains.IntelliJ-IDEA、
/// com.jetbrains.pycharm……）和各类终端都有大量变体，逐个枚举维护不动。
const CODING_PREFIXES: &[&str] = &[
    "com.microsoft.vscode",
    "com.visualstudio.code",
    "com.todesktop.", // Cursor 及同类 Electron 壳
    "com.jetbrains.",
    "com.sublimetext.",
    "com.panic.nova",
    "dev.zed.",
    "com.apple.terminal",
    "com.googlecode.iterm2",
    "dev.warp.",
    "net.kovidgoyal.kitty",
    "io.alacritty",
    "com.github.wez.wezterm",
    "com.apple.dt.xcode",
    "com.codebuddy.",
    "com.tencent.codebuddy",
];

/// 默认判定为「浏览」的 bundle id 前缀。
const BROWSING_PREFIXES: &[&str] = &[
    "com.apple.safari",
    "com.google.chrome",
    "com.microsoft.edgemac",
    "org.mozilla.firefox",
    "company.thebrowser.", // Arc
    "com.brave.browser",
    "com.operasoftware.opera",
    "com.apple.preview",
    "md.obsidian",
    "notion.id",
];

/// 用户自定义覆盖规则，优先于默认列表。
#[derive(Debug, Default, Clone)]
pub struct Overrides {
    pub coding: Vec<String>,
    pub browsing: Vec<String>,
    pub other: Vec<String>,
}

/// 对 bundle id 分类。大小写不敏感 —— 各家写法不统一。
pub fn classify(bundle_id: &str, ov: &Overrides) -> AppKind {
    let id = bundle_id.to_ascii_lowercase();

    // 用户规则优先。other 也放在前面，让用户能把某个默认算「写代码」
    // 的应用显式排除掉。
    if matches_any(&id, &ov.other) {
        return AppKind::Other;
    }
    if matches_any(&id, &ov.coding) {
        return AppKind::Coding;
    }
    if matches_any(&id, &ov.browsing) {
        return AppKind::Browsing;
    }

    if starts_with_any(&id, CODING_PREFIXES) {
        return AppKind::Coding;
    }
    if starts_with_any(&id, BROWSING_PREFIXES) {
        return AppKind::Browsing;
    }
    AppKind::Other
}

fn matches_any(id: &str, rules: &[String]) -> bool {
    rules
        .iter()
        .any(|r| !r.is_empty() && id.starts_with(&r.to_ascii_lowercase()))
}

fn starts_with_any(id: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|p| id.starts_with(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none() -> Overrides {
        Overrides::default()
    }

    #[test]
    fn 识别常见编辑器与终端() {
        for id in [
            "com.microsoft.VSCode",
            "com.todesktop.230313mzl4w4u92", // Cursor
            "com.jetbrains.IntelliJ-IDEA",
            "com.apple.Terminal",
            "dev.warp.Warp-Stable",
            "com.apple.dt.Xcode",
        ] {
            assert_eq!(classify(id, &none()), AppKind::Coding, "{id}");
        }
    }

    #[test]
    fn 识别浏览器与文档工具() {
        for id in [
            "com.apple.Safari",
            "com.google.Chrome",
            "company.thebrowser.Browser",
            "md.obsidian",
        ] {
            assert_eq!(classify(id, &none()), AppKind::Browsing, "{id}");
        }
    }

    #[test]
    fn 未知应用归为其他() {
        assert_eq!(classify("com.spotify.client", &none()), AppKind::Other);
        assert_eq!(classify("", &none()), AppKind::Other);
    }

    #[test]
    fn 大小写不敏感() {
        assert_eq!(classify("COM.APPLE.TERMINAL", &none()), AppKind::Coding);
        assert_eq!(classify("com.apple.terminal", &none()), AppKind::Coding);
    }

    #[test]
    fn 用户规则可新增未收录的应用() {
        let ov = Overrides {
            coding: vec!["com.mycompany.editor".into()],
            ..Default::default()
        };
        assert_eq!(classify("com.mycompany.Editor", &ov), AppKind::Coding);
    }

    #[test]
    fn 用户规则可排除默认收录的应用() {
        // 有人用 Obsidian 写代码笔记，也有人只当阅读器 —— 必须能改
        let ov = Overrides {
            other: vec!["md.obsidian".into()],
            ..Default::default()
        };
        assert_eq!(
            classify("md.obsidian", &ov),
            AppKind::Other,
            "用户显式排除应优先于默认列表"
        );
    }

    #[test]
    fn 用户规则可改变默认分类() {
        let ov = Overrides {
            coding: vec!["md.obsidian".into()],
            ..Default::default()
        };
        assert_eq!(classify("md.obsidian", &ov), AppKind::Coding);
    }

    #[test]
    fn 空规则不匹配一切() {
        let ov = Overrides {
            coding: vec!["".into()],
            ..Default::default()
        };
        assert_eq!(
            classify("com.spotify.client", &ov),
            AppKind::Other,
            "空字符串规则不能变成通配符"
        );
    }
}
