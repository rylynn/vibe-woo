//! 构建期注入版本指纹，供「关于」面板展示。
//!
//! 只注入两个值：编译时间（UTC）与 git 短哈希。二者都拿不到时回落
//! "unknown" —— 读不到 git 不该让构建失败。
//!
//! 刻意不写 `cargo:rerun-if-changed`：一旦写了，cargo 就只监听列出的文件，
//! 构建时间会停在上一次重建的时刻。保持默认（包内任意文件变动即重跑）才能
//! 让每次产物的构建时间都是真的。

fn main() {
    println!("cargo:rustc-env=PET_BUILD_TIME={}", now_utc());
    println!("cargo:rustc-env=PET_GIT_HASH={}", git_hash());
    tauri_build::build()
}

/// 当前 UTC 时间，形如 "2026-09-01 12:34:56Z"。
fn now_utc() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let tod = secs % 86_400;
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// 距 1970-01-01 的天数转年月日（Hinnant 的 civil_from_days）。
///
/// 为这几行引入 chrono 不值得 —— 这里只在构建期跑一次，且只在非负数域
/// （1970 年之后）用，除法语义差异影响不到。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 构建时的 git 短哈希。不在 git 仓库里（比如发布产物）时为 "unknown"。
fn git_hash() -> String {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--short=7", "HEAD"])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                "unknown".to_string()
            } else {
                s
            }
        }
        _ => "unknown".to_string(),
    }
}
