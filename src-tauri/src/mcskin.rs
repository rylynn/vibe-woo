// src-tauri/src/mcskin.rs
//! MC 玩家皮肤库：sha256 寻址的本地 PNG 库（纯逻辑层，命令层在下方薄包）。
//!
//! 目录结构：`app_config_dir()/skins/<sha256hex>.png` + `index.json`
//! （{ skins: [{ id, name, imported_at }] }）。index 与 png 均走
//! tmp+rename 原子写（照 plugin/store.rs 的 save_to 惯例）。
//!
//! 隐私红线：日志只记阶段、id 与错误类别，绝不记皮肤内容；皮肤字节
//! 只在本模块与命令返回值之间流动，不进任何上报/习惯记忆。
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// 皮肤库上限（规格 §2.2）。
pub const SKIN_LIMIT: usize = 16;
/// 单文件字节上限（与前端 src/mc/skin.ts 的 SKIN_MAX_BYTES 同值）。
pub const SKIN_MAX_BYTES: usize = 64 * 1024;

const PNG_SIG: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// 皮肤导入/读取失败的脱敏类别（前端映射中文文案，绝不透传底层错误）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkinError {
    TooLarge,
    NotPng,
    BadSize,
    LimitReached,
    WriteFailed,
    NotFound,
    BadId,
    InUse,
}

impl SkinError {
    pub fn as_str(self) -> &'static str {
        match self {
            SkinError::TooLarge => "too-large",
            SkinError::NotPng => "not-png",
            SkinError::BadSize => "bad-size",
            SkinError::LimitReached => "limit-reached",
            SkinError::WriteFailed => "write-failed",
            SkinError::NotFound => "not-found",
            SkinError::BadId => "bad-id",
            SkinError::InUse => "in-use",
        }
    }
}

/// 单张皮肤的元数据（index.json 条目；命令层直接序列化返回它）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SkinMeta {
    pub id: String,
    pub name: String,
    pub imported_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SkinIndex {
    pub skins: Vec<SkinMeta>,
}

/// 解析 PNG IHDR 宽高（镜像前端 skin.ts 的 parsePngSize，独立最小实现：
/// 签名 0..8、首块长度恒 13、类型 IHDR、宽 16..19 / 高 20..23 大端 u32）。
pub fn parse_png_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 24 || b[..8] != PNG_SIG {
        return None;
    }
    if b[8..12] != [0, 0, 0, 13] || &b[12..16] != b"IHDR" {
        return None;
    }
    Some((
        u32::from_be_bytes([b[16], b[17], b[18], b[19]]),
        u32::from_be_bytes([b[20], b[21], b[22], b[23]]),
    ))
}

/// 校验皮肤字节：PNG 魔数、大小上限、尺寸白名单（64×64 / 64×32 旧格式）。
pub fn validate_skin(bytes: &[u8]) -> Result<(), SkinError> {
    if bytes.len() > SKIN_MAX_BYTES {
        return Err(SkinError::TooLarge);
    }
    match parse_png_size(bytes) {
        None => Err(SkinError::NotPng),
        Some((64, 64)) | Some((64, 32)) => Ok(()),
        Some(_) => Err(SkinError::BadSize),
    }
}

/// 内容寻址 id：sha256 hex（64 个小写十六进制字符）。
pub fn skin_id_of(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// id 合法性：`[a-f0-9]{64}`。兼作路径穿越守卫（`..`、分隔符、大写都不匹配）。
pub fn is_valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 当前皮肤是否正被配置使用（删除守卫，规格 §2.2）。
pub fn skin_in_use(avatar: &Option<crate::config::AvatarConfig>, id: &str) -> bool {
    match avatar {
        Some(crate::config::AvatarConfig::Minecraft(mc)) => mc.skin_id == id,
        _ => false,
    }
}

/// 读 index：缺失 → 空；损坏 → 扫描目录重建（文件名即 id，恢复可恢复项）。
pub fn load_index(dir: &Path) -> SkinIndex {
    match fs::read_to_string(dir.join("index.json")) {
        Ok(text) => match serde_json::from_str::<SkinIndex>(&text) {
            Ok(idx) => idx,
            Err(_) => rebuild_index(dir),
        },
        Err(_) => SkinIndex::default(),
    }
}

/// 按目录现有 png 重建 index（名字取 id 前 8 位，时间取文件修改时间）。
fn rebuild_index(dir: &Path) -> SkinIndex {
    let mut skins = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".png") else {
                continue;
            };
            if !is_valid_id(id) {
                continue;
            }
            let imported_at = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            skins.push(SkinMeta {
                id: id.to_string(),
                name: id[..8].to_string(),
                imported_at,
            });
        }
    }
    skins.sort_by(|a, b| a.id.cmp(&b.id));
    SkinIndex { skins }
}

/// 原子写 index（tmp + rename，照 plugin/store.rs 的 save_to 惯例）。
pub fn save_index(dir: &Path, index: &SkinIndex) -> Result<(), SkinError> {
    fs::create_dir_all(dir).map_err(|_| SkinError::WriteFailed)?;
    let tmp = dir.join("index.json.tmp");
    let path = dir.join("index.json");
    let text = serde_json::to_string_pretty(index).map_err(|_| SkinError::WriteFailed)?;
    fs::write(&tmp, text).map_err(|_| SkinError::WriteFailed)?;
    fs::rename(&tmp, &path).map_err(|_| SkinError::WriteFailed)?;
    Ok(())
}

/// 导入：校验 → sha256 寻址 → 内容去重（同 id 只更新名字与时间）→
/// 上限 → tmp+rename 原子落盘 → 更新 index。返回该皮肤的元数据。
pub fn import_skin(dir: &Path, name: &str, bytes: &[u8]) -> Result<SkinMeta, SkinError> {
    validate_skin(bytes)?;
    let id = skin_id_of(bytes);
    let mut index = load_index(dir);
    if let Some(existing) = index.skins.iter_mut().find(|s| s.id == id) {
        existing.name = name.to_string();
        existing.imported_at = now_secs();
        let meta = existing.clone(); // 先克隆结束可变借用，再写 index
        save_index(dir, &index)?;
        return Ok(meta);
    }
    if index.skins.len() >= SKIN_LIMIT {
        return Err(SkinError::LimitReached);
    }
    fs::create_dir_all(dir).map_err(|_| SkinError::WriteFailed)?;
    let tmp = dir.join(format!("{id}.png.tmp"));
    let path = dir.join(format!("{id}.png"));
    fs::write(&tmp, bytes).map_err(|_| SkinError::WriteFailed)?;
    fs::rename(&tmp, &path).map_err(|_| SkinError::WriteFailed)?;
    let meta = SkinMeta {
        id,
        name: name.to_string(),
        imported_at: now_secs(),
    };
    index.skins.push(meta.clone());
    index
        .skins
        .sort_by(|a, b| a.imported_at.cmp(&b.imported_at).then(a.id.cmp(&b.id)));
    save_index(dir, &index)?;
    Ok(meta)
}

/// 删除：文件 + index 条目（顺带清掉 index 里的孤儿条目）。
pub fn delete_skin(dir: &Path, id: &str) -> Result<(), SkinError> {
    if !is_valid_id(id) {
        return Err(SkinError::BadId);
    }
    let mut index = load_index(dir);
    let path = dir.join(format!("{id}.png"));
    if !path.exists() && !index.skins.iter().any(|s| s.id == id) {
        return Err(SkinError::NotFound);
    }
    let _ = fs::remove_file(&path); // 文件不在也继续清 index
    index.skins.retain(|s| s.id != id);
    save_index(dir, &index)
}

/// 读皮肤字节。
pub fn read_skin(dir: &Path, id: &str) -> Result<Vec<u8>, SkinError> {
    if !is_valid_id(id) {
        return Err(SkinError::BadId);
    }
    fs::read(dir.join(format!("{id}.png"))).map_err(|_| SkinError::NotFound)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// —— 命令层（薄壳：目录定位 + 脱敏错误映射；逻辑全在上方纯函数） ——

use tauri::{AppHandle, Manager};

/// 皮肤库目录：app_config_dir()/skins/（与 plugin/store 的 plugins/ 同惯例）。
fn skins_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("skins"))
}

/// 导入皮肤：校验 → sha256 落盘 → 返回元数据。错误只回脱敏枚举，
/// 日志只记错误类别（隐私红线：不记皮肤内容与用户命名）。
#[tauri::command]
pub fn mc_import_skin(app: AppHandle, name: String, bytes: Vec<u8>) -> Result<SkinMeta, String> {
    let Some(dir) = skins_dir(&app) else {
        return Err(SkinError::WriteFailed.as_str().to_string());
    };
    let r = import_skin(&dir, &name, &bytes);
    if let Err(e) = &r {
        eprintln!("[mcskin] 导入失败：{}", e.as_str());
    }
    r.map_err(|e| e.as_str().to_string())
}

/// 皮肤列表（index 缺失/损坏时纯函数层已兜底，命令不失败）。
#[tauri::command]
pub fn mc_list_skins(app: AppHandle) -> Vec<SkinMeta> {
    match skins_dir(&app) {
        Some(dir) => load_index(&dir).skins,
        None => Vec::new(),
    }
}

/// 删除皮肤。当前配置正用它时拒绝（in-use）。
#[tauri::command]
pub fn mc_delete_skin(app: AppHandle, id: String) -> Result<(), String> {
    if skin_in_use(&crate::configcmd::current().avatar, &id) {
        return Err(SkinError::InUse.as_str().to_string());
    }
    let Some(dir) = skins_dir(&app) else {
        return Err(SkinError::NotFound.as_str().to_string());
    };
    delete_skin(&dir, &id).map_err(|e| e.as_str().to_string())
}

/// 读皮肤字节（前端 loadAndRegisterSkin 用）。
#[tauri::command]
pub fn mc_get_skin(app: AppHandle, id: String) -> Result<Vec<u8>, String> {
    let Some(dir) = skins_dir(&app) else {
        return Err(SkinError::NotFound.as_str().to_string());
    };
    read_skin(&dir, &id).map_err(|e| e.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试独立临时目录（结束后清理）。
    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir()
            .join(format!("vibe-mcskin-test-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 最小合法 PNG：签名 + IHDR + 4 字节 CRC 占位。本模块只解析头，
    /// 不解码像素，不需要完整可解码文件。
    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let mut b = PNG_SIG.to_vec();
        b.extend_from_slice(&13u32.to_be_bytes());
        b.extend_from_slice(b"IHDR");
        let mut ihdr = [0u8; 13];
        ihdr[0..4].copy_from_slice(&w.to_be_bytes());
        ihdr[4..8].copy_from_slice(&h.to_be_bytes());
        ihdr[8] = 8; // 位深
        ihdr[9] = 6; // RGBA
        b.extend_from_slice(&ihdr);
        b.extend_from_slice(&[0, 0, 0, 0]);
        b
    }

    #[test]
    fn png头解析与校验() {
        assert_eq!(parse_png_size(&png_bytes(64, 64)), Some((64, 64)));
        assert_eq!(parse_png_size(&png_bytes(64, 32)), Some((64, 32)));
        assert_eq!(parse_png_size(b"not a png"), None);
        assert!(validate_skin(&png_bytes(64, 64)).is_ok());
        assert_eq!(validate_skin(&png_bytes(63, 64)), Err(SkinError::BadSize));
        assert_eq!(validate_skin(&png_bytes(64, 48)), Err(SkinError::BadSize));
        assert_eq!(validate_skin(b"not a png"), Err(SkinError::NotPng));
        let mut big = png_bytes(64, 64);
        big.resize(SKIN_MAX_BYTES + 1, 0);
        assert_eq!(validate_skin(&big), Err(SkinError::TooLarge));
    }

    #[test]
    fn sha256寻址与id校验() {
        let id = skin_id_of(b"abc");
        assert_eq!(id.len(), 64);
        assert!(is_valid_id(&id));
        // 内置 id / 路径穿越 / 大写 hex 都不匹配（bad-id 拒绝）
        assert!(!is_valid_id("builtin:default"));
        assert!(!is_valid_id(&("..x/..x".replace('x', "").replace('/', "") + &"../".repeat(0))));
        assert!(!is_valid_id(&"../".repeat(21).chars().take(64).collect::<String>()));
        assert!(!is_valid_id(&"A".repeat(64)));
    }

    #[test]
    fn 导入去重与上限() {
        let dir = tmp_dir("import");
        let bytes = png_bytes(64, 64);
        let a = import_skin(&dir, "我的皮肤", &bytes).unwrap();
        assert_eq!(load_index(&dir).skins.len(), 1);
        // 同内容再导入：只更新名字与时间，不涨数量
        let b = import_skin(&dir, "改名", &bytes).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(b.name, "改名");
        assert_eq!(load_index(&dir).skins.len(), 1);
        // 不同内容灌满到上限（17 次导入 = 1 + 16：首张已占 1 席，循环补
        // 满 15 张，合计 16 张 = SKIN_LIMIT；随后 extra 才是真正的超限导入）
        for i in 0..SKIN_LIMIT - 1 {
            let mut other = png_bytes(64, 64);
            other.push(i as u8); // IHDR 头不变（仍合法），sha 不同
            import_skin(&dir, &format!("s{i}"), &other).unwrap();
        }
        assert_eq!(load_index(&dir).skins.len(), SKIN_LIMIT);
        let mut extra = png_bytes(64, 64);
        extra.push(0xff);
        assert_eq!(import_skin(&dir, "超限", &extra), Err(SkinError::LimitReached));
        // 校验失败在写盘前拒绝
        assert_eq!(import_skin(&dir, "x", b"nope"), Err(SkinError::NotPng));
        assert!(read_skin(&dir, &a.id).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 删除清文件与index() {
        let dir = tmp_dir("delete");
        let meta = import_skin(&dir, "a", &png_bytes(64, 64)).unwrap();
        // 非法 id 拒绝（路径穿越守卫）
        assert_eq!(delete_skin(&dir, "../../x"), Err(SkinError::BadId));
        assert!(delete_skin(&dir, &meta.id).is_ok());
        assert_eq!(read_skin(&dir, &meta.id), Err(SkinError::NotFound));
        assert!(load_index(&dir).skins.is_empty());
        assert_eq!(delete_skin(&dir, &meta.id), Err(SkinError::NotFound));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn index损坏时按目录重建() {
        let dir = tmp_dir("rebuild");
        let meta = import_skin(&dir, "a", &png_bytes(64, 64)).unwrap();
        std::fs::write(dir.join("index.json"), "{oops").unwrap();
        let idx = load_index(&dir);
        assert_eq!(idx.skins.len(), 1);
        assert_eq!(idx.skins[0].id, meta.id);
        // 非 hex 文件名的孤儿文件不进 index（契约「缺失→空」，缺失不触发
        // 重建；这里再次损坏 index.json 以走重建路径）
        std::fs::write(dir.join("garbage.png"), b"x").unwrap();
        std::fs::write(dir.join("index.json"), "{oops").unwrap();
        assert_eq!(load_index(&dir).skins.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 在用皮肤删除守卫() {
        let id = skin_id_of(b"abc");
        let mc = crate::config::AvatarConfig::Minecraft(crate::config::McAvatarConfig {
            form: crate::config::McFormConfig::Player,
            skin_id: id.clone(),
        });
        assert!(skin_in_use(&Some(mc), &id));
        let other = crate::config::AvatarConfig::Minecraft(crate::config::McAvatarConfig {
            form: crate::config::McFormConfig::Cat,
            skin_id: "builtin:default".into(),
        });
        assert!(!skin_in_use(&Some(other), &id));
        assert!(!skin_in_use(&None, &id));
    }
}
