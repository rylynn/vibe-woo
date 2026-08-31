//! 前台应用分类。
//!
//! 把 bundle id 映射到「正在做哪一类**事**」。规则可由用户覆盖 ——
//! 每个人的工具链都不同，硬编码列表必然不全。
//!
//! 分类的是**事**不是**人**：同样的 Figma，给设计师和给产品经理用的
//! 都是「在做设计」；至于主人是不是设计师，只有他自己填了才知道。

use crate::state::AppKind;

/// 编辑器 / IDE / 终端。
const EDITING_PREFIXES: &[&str] = &[
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
    "com.google.android.studio", // Android Studio
    "com.codeium.",   // Windsurf
    "org.gnu.emacs",  // Emacs
    "org.netbeans.",  // NetBeans
    "com.neovide.",   // Neovide（Neovim GUI）
    "com.mitchellh.ghostty",
    "com.codebuddy.",
    "com.tencent.codebuddy",
];

/// 文档、笔记、写作。
const WRITING_PREFIXES: &[&str] = &[
    "md.obsidian",
    "notion.id",
    "com.apple.notes",
    "com.apple.textedit",
    "com.apple.iwork.pages",
    "com.apple.iwork.keynote", // Keynote 演示文稿
    "com.apple.freeform",      // 无边记白板
    "com.microsoft.word",
    "com.microsoft.onenote",
    "com.ulyssesapp.",
    "com.bear-writer.",
    "abnerworks.typora",
    "com.typora.",
    "com.wps.",
    "com.kingsoft.",
    "org.libreoffice.",
    "org.openoffice.",
];

/// 设计、绘图、剪辑。
const DESIGNING_PREFIXES: &[&str] = &[
    "com.figma.",
    "io.figma.",
    "com.bohemiancoding.sketch",
    "com.sketchapp.",
    "com.adobe.photoshop",
    "com.adobe.illustrator",
    "com.adobe.indesign",
    "com.adobe.xd",
    "com.adobe.premiere",
    "com.adobe.aftereffects",
    "com.adobe.lightroom",
    "com.adobe.audition",
    "com.apple.finalcut",
    "com.apple.imovie",
    "com.blackmagic-design.",
    "com.affinity.",
    "org.inkscape.",
    "org.blenderfoundation.blender",
    "com.maxon.cinema4d",
    "com.pixelmator.",
    "com.linearity.", // Vectornator / Curve
    "com.sketchbook.",
    "com.canva.",
];

/// 表格、数据。
const DATA_PREFIXES: &[&str] = &[
    "com.microsoft.excel",
    "com.apple.iwork.numbers",
    "com.apple.numbers",
    "io.dbeaver.",
    "com.tableplus.",
    "com.tinyapp.tableplus",
    "com.sequelpro.",
    "com.navicat.",
    "com.postgresapp.",
    "org.sqlitebrowser.",
    "com.mysql.workbench",
    "com.airtable.",
];

/// 沟通协作：聊天、邮件、会议。
const MESSAGING_PREFIXES: &[&str] = &[
    "com.tencent.xinwechat", // 微信
    "com.tencent.weworkmac", // 企业微信
    "com.tencent.qq",        // QQ
    "com.tencent.meeting",   // 腾讯会议
    "com.alibaba.dingtalk",  // 钉钉（macOS 实际 bundle 前缀）
    "com.dingtalk.",
    "com.feishu.",
    "com.bytedance.",
    "org.lark.",
    "com.slack.",
    "com.discord.",
    "org.telegram.",
    "ru.keepcoder.telegram",
    "net.whatsapp.",           // WhatsApp
    "jp.naver.line",           // LINE
    "com.readdle.smartemail",  // Spark 邮件
    "com.apple.mobilesms",
    "com.apple.mail",
    "com.apple.facetime",
    "com.microsoft.outlook",
    "org.mozilla.thunderbird",
    "com.microsoft.teams",
    "us.zoom.xos",
    "com.zoom.",
];

/// 影音娱乐：音乐、视频。
const WATCHING_PREFIXES: &[&str] = &[
    "com.apple.music",
    "com.apple.podcasts",
    "com.apple.itunes",
    "com.apple.tv",
    "com.apple.quicktimeplayer",
    "com.spotify.client",
    "com.netease.163music",
    "com.tencent.qqmusic",
    "com.tencent.tenvideo",
    "com.bilibili.",
    "com.iqiyi.",
    "com.youku.",
    "tv.kugou.",
    "org.videolan.vlc",
    "com.colliderli.iina",
    "com.firecore.infuse",
    "com.sibtips.radium",
];

/// 阅读浏览：浏览器、PDF、电子书。
const BROWSING_PREFIXES: &[&str] = &[
    "com.apple.safari",
    "com.google.chrome",
    "com.microsoft.edgemac",
    "org.mozilla.firefox",
    "company.thebrowser.", // Arc
    "com.brave.browser",
    "com.operasoftware.opera",
    "com.vivaldi.",
    "com.apple.preview", // 预览：看 PDF / 图片
    "com.apple.ibooks",
    "com.amazon.kindle",
    "com.tencent.weread",     // 微信读书
    "com.readdle.pdfexpert",  // PDF Expert
    "net.kovidgoyal.calibre", // Calibre 电子书管理
    "org.zotero.",
];

/// 用户自定义覆盖规则，优先于默认列表。
///
/// 只覆盖「专注产出」与「阅读浏览」两类 —— 更细的子类无法从 bundle id
/// 推断，硬加配置只会让用户配不明白。（`coding_apps` 的字段名保留旧名
/// 以兼容已有配置，实际语义已泛化为「专注产出类」。）
#[derive(Debug, Default, Clone)]
pub struct Overrides {
    pub coding: Vec<String>,
    pub browsing: Vec<String>,
    pub other: Vec<String>,
}

/// 对 bundle id 分类。大小写不敏感 —— 各家写法不统一。
///
/// 顺序：用户规则 → 产出型（编辑/写作/设计/数据）→ 消遣型（影音 → 沟通 → 浏览）。
/// 产出型排在前面：同属两类的应用（如既是编辑器又能预览）宁可按产出算，
/// 误判成摸鱼会让宠物在该陪着的时候自娱自乐。
///
/// 影音必须在沟通之前：`com.tencent.qq`（QQ）与 `com.tencent.qqmusic`
/// （QQ音乐）共享前缀，只能靠先查更具体的音乐条目把它们分开。
pub fn classify(bundle_id: &str, ov: &Overrides) -> AppKind {
    let id = bundle_id.to_ascii_lowercase();

    // 用户规则优先。other 也放在前面，让用户能把某个默认算「专注产出」
    // 的应用显式排除掉。
    if matches_any(&id, &ov.other) {
        return AppKind::Other;
    }
    if matches_any(&id, &ov.coding) {
        return AppKind::Editing;
    }
    if matches_any(&id, &ov.browsing) {
        return AppKind::Browsing;
    }

    if starts_with_any(&id, EDITING_PREFIXES) {
        return AppKind::Editing;
    }
    if starts_with_any(&id, WRITING_PREFIXES) {
        return AppKind::Writing;
    }
    if starts_with_any(&id, DESIGNING_PREFIXES) {
        return AppKind::Designing;
    }
    if starts_with_any(&id, DATA_PREFIXES) {
        return AppKind::Data;
    }
    if starts_with_any(&id, WATCHING_PREFIXES) {
        return AppKind::Watching;
    }
    if starts_with_any(&id, MESSAGING_PREFIXES) {
        return AppKind::Messaging;
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
    fn 识别编辑器与终端() {
        for id in [
            "com.microsoft.VSCode",
            "com.todesktop.230313mzl4w4u92", // Cursor
            "com.jetbrains.IntelliJ-IDEA",
            "com.apple.Terminal",
            "dev.warp.Warp-Stable",
            "com.apple.dt.Xcode",
            "com.google.android.studio",
            "com.codeium.windsurf",
            "com.mitchellh.ghostty",
        ] {
            assert_eq!(classify(id, &none()), AppKind::Editing, "{id}");
            assert!(classify(id, &none()).is_producing(), "{id} 应算专注产出");
        }
    }

    #[test]
    fn 识别文档与笔记工具() {
        for id in ["md.obsidian", "notion.id", "com.microsoft.Word"] {
            assert_eq!(classify(id, &none()), AppKind::Writing, "{id}");
            assert!(classify(id, &none()).is_producing(), "{id} 应算专注产出");
        }
    }

    #[test]
    fn 识别设计与剪辑工具() {
        for id in [
            "com.figma.Desktop",
            "com.bohemiancoding.sketch3",
            "com.adobe.Photoshop",
            "com.adobe.LightroomClassic",
            "com.apple.FinalCut",
            "org.blenderfoundation.blender",
            "com.canva.desktop",
        ] {
            assert_eq!(classify(id, &none()), AppKind::Designing, "{id}");
            assert!(classify(id, &none()).is_producing(), "{id} 应算专注产出");
        }
    }

    #[test]
    fn 识别表格与数据工具() {
        for id in [
            "com.microsoft.Excel",
            "com.apple.iWork.Numbers",
            "io.dbeaver.DBeaver",
        ] {
            assert_eq!(classify(id, &none()), AppKind::Data, "{id}");
            assert!(classify(id, &none()).is_producing(), "{id} 应算专注产出");
        }
    }

    #[test]
    fn 识别沟通协作工具() {
        for id in [
            "com.tencent.xinWeChat",
            "com.tencent.QQ",
            "com.alibaba.DingTalk",
            "net.whatsapp.WhatsApp",
            "com.apple.MobileSMS",
            "us.zoom.xos",
            "com.slack.Slack",
        ] {
            assert_eq!(classify(id, &none()), AppKind::Messaging, "{id}");
            assert!(!classify(id, &none()).is_producing(), "{id} 不算专注产出");
        }
    }

    #[test]
    fn qq与QQ音乐靠检查顺序区分() {
        // 两者共享 com.tencent.qq 前缀，只能先查音乐条目把它们分开。
        // 这个顺序被挪动时此测试会立刻报警。
        assert_eq!(classify("com.tencent.qq", &none()), AppKind::Messaging);
        assert_eq!(classify("com.tencent.qqmusic", &none()), AppKind::Watching);
    }

    #[test]
    fn 识别影音娱乐() {
        for id in [
            "com.apple.Music",
            "com.spotify.client",
            "org.videolan.vlc",
            "com.colliderli.iina",
        ] {
            assert_eq!(classify(id, &none()), AppKind::Watching, "{id}");
        }
    }

    #[test]
    fn 识别浏览器与阅读器() {
        for id in [
            "com.apple.Safari",
            "com.google.Chrome",
            "company.thebrowser.Browser",
            "com.apple.Preview",
            "com.tencent.weread",
            "net.kovidgoyal.calibre",
        ] {
            assert_eq!(classify(id, &none()), AppKind::Browsing, "{id}");
            assert!(!classify(id, &none()).is_producing(), "{id} 不算专注产出");
        }
    }

    #[test]
    fn 前缀表必须全小写否则永不匹配() {
        // classify 会先把 bundle id 转小写再比；前缀里混大写会静默失效。
        // 这个坑踩过一次（com.apple.mobileSMS 永远匹配不上），钉死它。
        for list in [
            EDITING_PREFIXES,
            WRITING_PREFIXES,
            DESIGNING_PREFIXES,
            DATA_PREFIXES,
            MESSAGING_PREFIXES,
            WATCHING_PREFIXES,
            BROWSING_PREFIXES,
        ] {
            for p in list {
                assert_eq!(*p, p.to_ascii_lowercase(), "前缀含大写，永远匹配不上：{p}");
            }
        }
    }

    #[test]
    fn 未知应用归为其他() {
        assert_eq!(classify("com.spotify.client", &none()), AppKind::Watching);
        assert_eq!(classify("com.foo.bar", &none()), AppKind::Other);
        assert_eq!(classify("", &none()), AppKind::Other);
    }

    #[test]
    fn 大小写不敏感() {
        assert_eq!(classify("COM.APPLE.TERMINAL", &none()), AppKind::Editing);
        assert_eq!(classify("com.apple.terminal", &none()), AppKind::Editing);
        assert_eq!(classify("MD.OBSIDIAN", &none()), AppKind::Writing);
    }

    #[test]
    fn 用户规则可新增未收录的应用() {
        let ov = Overrides {
            coding: vec!["com.mycompany.editor".into()],
            ..Default::default()
        };
        assert_eq!(classify("com.mycompany.Editor", &ov), AppKind::Editing);
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
        // 默认算阅读的 Obsidian，用户可显式指定为专注产出
        let ov = Overrides {
            coding: vec!["md.obsidian".into()],
            ..Default::default()
        };
        assert_eq!(classify("md.obsidian", &ov), AppKind::Editing);
    }

    #[test]
    fn 空规则不匹配一切() {
        let ov = Overrides {
            coding: vec!["".into()],
            ..Default::default()
        };
        assert_eq!(
            classify("com.spotify.client", &ov),
            AppKind::Watching,
            "空字符串规则不能变成通配符"
        );
    }
}
