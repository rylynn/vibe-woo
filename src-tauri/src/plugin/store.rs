//! 每插件一份配置文件：`plugins/<id>.json`。
//!
//! 规则沿用 rewards.rs：损坏即默认值，配置问题绝不能让宠物起不来。
//! 写入统一 tmp+rename 原子替换 —— 写一半崩溃不会留下半截 JSON。

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// 配置目录：与 config.json 同级的 plugins/ 子目录。
fn plugin_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("plugins"))
}

/// 从指定目录读插件配置。任何失败都回退默认值。
pub fn load_from<T: DeserializeOwned + Default>(dir: &Path, id: &str) -> T {
    let path = dir.join(format!("{id}.json"));
    let Ok(text) = fs::read_to_string(&path) else {
        return T::default();
    };
    match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[plugin:{id}] 配置解析失败，使用默认值：{e}");
            T::default()
        }
    }
}

/// 原子写入插件配置：先写 `<id>.json.tmp` 再 rename，并自动创建目录。
pub fn save_to<T: Serialize>(dir: &Path, id: &str, cfg: &T) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建插件目录失败：{e}"))?;
    let tmp = dir.join(format!("{id}.json.tmp"));
    let path = dir.join(format!("{id}.json"));
    let text = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败：{e}"))?;
    fs::write(&tmp, text).map_err(|e| format!("写入失败：{e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换失败：{e}"))?;
    Ok(())
}

/// 读当前用户的插件配置。
pub fn load<T: DeserializeOwned + Default>(app: &AppHandle, id: &str) -> T {
    match plugin_dir(app) {
        Some(dir) => load_from(&dir, id),
        None => T::default(),
    }
}

/// 写当前用户的插件配置。
pub fn save<T: Serialize>(app: &AppHandle, id: &str, cfg: &T) -> Result<(), String> {
    let dir = plugin_dir(app).ok_or("无法确定配置目录")?;
    save_to(&dir, id, cfg)
}

/// 该插件是否已有配置文件（番茄迁移等「只在首次搬一次」的场景用）。
pub fn exists(app: &AppHandle, id: &str) -> bool {
    plugin_dir(app)
        .map(|d| d.join(format!("{id}.json")).exists())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Default, serde::Serialize, serde::Deserialize)]
    struct Cfg {
        enabled: bool,
        n: u32,
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "vibepet-plugin-store-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn 损坏配置回退默认值而非报错() {
        let dir = temp_dir("corrupt");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("x.json"), "{not json").unwrap();
        let c: Cfg = load_from(&dir, "x");
        assert_eq!(c, Cfg::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 配置可往返() {
        let dir = temp_dir("roundtrip");
        let cfg = Cfg { enabled: true, n: 7 };
        save_to(&dir, "x", &cfg).unwrap();
        let back: Cfg = load_from(&dir, "x");
        assert_eq!(back, cfg);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 原子写不残留tmp文件() {
        let dir = temp_dir("atomic");
        save_to(&dir, "x", &Cfg::default()).unwrap();
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["x.json".to_string()], "只应有最终文件");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 目录不存在时保存自动创建() {
        let dir = temp_dir("mkdir").join("nested");
        save_to(&dir, "x", &Cfg { enabled: true, n: 1 }).unwrap();
        assert!(dir.join("x.json").exists());
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }
}
