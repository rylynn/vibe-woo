//! Tier-0 环境信号采集。
//!
//! 隐私原则（与 sensor.rs 同一条红线）：只采集「结构性事实」——
//! 某设备是否被占用、屏幕是否锁定、某进程是否存在 ——
//! **绝不接触音频数据、窗口标题、文件名、命令行参数、任何内容**。
//! 因此全部信号都无需任何系统授权（无麦克风、无辅助功能、无录屏弹窗）。
//!
//! 采集成本控制：主循环快层只做击键检测，这里内部按信号轻重分档节流：
//!   - 锁屏 / 麦克风（CGSession 走 WindowServer XPC / CoreAudio 查询）：2 秒
//!   - 显示休眠断言（CF 对象分配）/ 进程扫描（子树 + rusage）：4 秒
//!   - 专注模式（读文件，先比 mtime）：5 秒
//! 取不到一律静默降级为 false，绝不影响主流程。
//! 各档间隔放宽的依据：消费方（行为反应）的冷却都是分钟级，秒级检测
//! 延迟无感知；而 CGSessionCopyCurrentDictionary 等调用有真实的
//! 跨进程往返成本。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// 一次采集得到的环境信号全集。全 bool —— Snapshot 保持 Copy 的前提。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EnvSignals {
    /// 麦克风被某进程占用 → 在开会 / 语音通话。
    pub mic_in_use: bool,
    /// 屏幕已锁定 → 人一定不在。
    pub screen_locked: bool,
    /// 显示休眠被阻止 → 大概率在全屏播视频。
    pub display_video: bool,
    /// 前台进程树下有构建 / AI 会话在跑 → 在等编译 / 等 AI。
    pub build_running: bool,
    /// 系统专注模式 / 勿扰开启 → 抑制说话。
    pub dnd_on: bool,
}

/// 锁屏 / 麦克风采样间隔。
const LIGHT_INTERVAL: Duration = Duration::from_secs(2);
/// 断言 / 进程扫描间隔。
const HEAVY_INTERVAL: Duration = Duration::from_secs(4);
/// 专注模式文件读取间隔。
const DND_INTERVAL: Duration = Duration::from_secs(5);

struct EnvCache {
    signals: EnvSignals,
    next_light: Instant,
    next_heavy: Instant,
    next_dnd: Instant,
    /// 上一次进程扫描时刻（CPU 速率的分母）。
    heavy_at: Instant,
    /// 上一次扫描时各构建进程的累计 CPU 纳秒（速率的分子基线）。
    cpu_base: HashMap<i32, u64>,
    /// 最近一次有效的前台 pid（前台恰好是宠物自己时沿用，避免信号闪烁）。
    front_pid: i32,
    /// DND 文件的 mtime 与上次判定。mtime 没变就不重读不重判。
    dnd_cache: Option<(SystemTime, bool)>,
}

static CACHE: Mutex<Option<EnvCache>> = Mutex::new(None);

/// 主循环每轮调用。返回当前缓存的环境信号，内部按各自节奏刷新。
///
/// `front_pid` 为 None 表示这轮取不到前台应用（例如前台恰好是宠物自己），
/// 此时沿用上次的前台 pid，避免信号在宠物被点了一下时闪烁。
pub fn poll(front_pid: Option<i32>) -> EnvSignals {
    let mut g = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    let c = g.get_or_insert_with(|| EnvCache {
        signals: EnvSignals::default(),
        next_light: now,
        next_heavy: now,
        next_dnd: now,
        heavy_at: now,
        cpu_base: HashMap::new(),
        front_pid: 0,
        dnd_cache: None,
    });

    if let Some(pid) = front_pid {
        if pid > 0 {
            c.front_pid = pid;
        }
    }

    if now >= c.next_light {
        c.next_light = now + LIGHT_INTERVAL;
        c.signals.screen_locked = platform::screen_locked();
        c.signals.mic_in_use = platform::mic_in_use();
    }
    if now >= c.next_heavy {
        let elapsed = now - c.heavy_at;
        c.heavy_at = now;
        c.next_heavy = now + HEAVY_INTERVAL;
        c.signals.display_video = platform::display_video_active();
        c.signals.build_running = platform::scan_build(c.front_pid, &mut c.cpu_base, elapsed);
    }
    if now >= c.next_dnd {
        c.next_dnd = now + DND_INTERVAL;
        c.signals.dnd_on = platform::dnd_enabled(&mut c.dnd_cache);
    }
    c.signals
}

#[cfg(target_os = "macos")]
mod platform {
    use std::collections::HashMap;
    use std::collections::HashSet;
    use std::collections::VecDeque;
    use std::ffi::c_void;
    use std::ffi::CString;
    use std::time::{Duration, SystemTime};

    // ——————————————————————————————————————————————
    // CoreFoundation 基础设施（多个信号共用）
    // ——————————————————————————————————————————————

    // kCFStringEncodingUTF8
    const KCF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const std::os::raw::c_char,
            encoding: u32,
        ) -> *mut c_void;
        fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
        fn CFNumberGetValue(
            number: *const c_void,
            the_type: isize,
            value_ptr: *mut c_void,
        ) -> bool;
        fn CFRelease(cf: *const c_void);
        static kCFBooleanTrue: *const c_void;
    }

    /// 由 UTF-8 字符串创建 CFString。调用方负责 CFRelease。
    fn cf_string(s: &str) -> *mut c_void {
        let Ok(c) = CString::new(s) else {
            return std::ptr::null_mut();
        };
        unsafe {
            CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), KCF_STRING_ENCODING_UTF8)
        }
    }

    // ——————————————————————————————————————————————
    // 锁屏
    // ——————————————————————————————————————————————

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> *mut c_void;
    }

    /// 屏幕是否已锁定。
    ///
    /// 会话字典里的 "CGSSessionScreenIsLocked" 是 kCFBooleanTrue 即锁定。
    /// 无 GUI 会话（SSH 等）取不到字典 → 按未锁处理（宁可少判不误判）。
    pub fn screen_locked() -> bool {
        let dict = unsafe { CGSessionCopyCurrentDictionary() };
        if dict.is_null() {
            return false;
        }
        let key = cf_string("CGSSessionScreenIsLocked");
        let mut locked = false;
        if !key.is_null() {
            let v = unsafe { CFDictionaryGetValue(dict, key) };
            if v == unsafe { kCFBooleanTrue } {
                locked = true;
            }
            unsafe { CFRelease(key) };
        }
        unsafe { CFRelease(dict) };
        locked
    }

    // ——————————————————————————————————————————————
    // 麦克风占用
    // ——————————————————————————————————————————————

    #[repr(C)]
    #[allow(non_snake_case)] // 字段名须与 CoreAudio 的结构体一致
    struct AudioObjectPropertyAddress {
        mSelector: u32,
        mScope: u32,
        mElement: u32,
    }

    // fourcc 常量（CoreAudio 的高位在前的四字符码）
    const K_AUDIO_OBJECT_SYSTEM: u32 = 1;
    const SCOPE_GLOBAL: u32 = 0x676C_6F62; // 'glob'
    // kAudioHardwarePropertyDefaultInputDevice = 'dIn '
    const K_DEFAULT_INPUT_DEVICE: u32 = 0x6449_6E20;
    // kAudioDevicePropertyDeviceIsRunningSomewhere = 'go  '
    const K_RUNNING_SOMEWHERE: u32 = 0x676F_2020;

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            object_id: u32,
            address: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            io_data_size: *mut u32,
            out_data: *mut c_void,
        ) -> i32; // OSStatus，0 = noErr
    }

    /// 麦克风是否被任何进程占用。
    ///
    /// 只查默认输入设备的「正在运行（任意进程）」布尔 —— 不知道是谁在用、
    /// 更碰不到音频数据本身，因此无需麦克风权限。
    pub fn mic_in_use() -> bool {
        let mut dev: u32 = 0;
        let mut size: u32 = std::mem::size_of::<u32>() as u32;
        let addr = AudioObjectPropertyAddress {
            mSelector: K_DEFAULT_INPUT_DEVICE,
            mScope: SCOPE_GLOBAL,
            mElement: 0,
        };
        let st = unsafe {
            AudioObjectGetPropertyData(
                K_AUDIO_OBJECT_SYSTEM,
                &addr,
                0,
                std::ptr::null(),
                &mut size,
                &mut dev as *mut u32 as *mut c_void,
            )
        };
        // 0 = kAudioDeviceUnknown：没有输入设备（罕见）→ 不算占用
        if st != 0 || dev == 0 {
            return false;
        }

        let mut running: u32 = 0;
        let mut size: u32 = std::mem::size_of::<u32>() as u32;
        let addr = AudioObjectPropertyAddress {
            mSelector: K_RUNNING_SOMEWHERE,
            mScope: SCOPE_GLOBAL,
            mElement: 0,
        };
        let st = unsafe {
            AudioObjectGetPropertyData(
                dev,
                &addr,
                0,
                std::ptr::null(),
                &mut size,
                &mut running as *mut u32 as *mut c_void,
            )
        };
        st == 0 && running == 1
    }

    // ——————————————————————————————————————————————
    // 显示休眠断言
    // ——————————————————————————————————————————————

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMCopyAssertionsStatus(assertions: *mut *mut c_void) -> i32;
    }

    // kCFNumberSInt32Type
    const K_CF_NUMBER_SINT32: isize = 3;

    /// 是否有进程在阻止显示休眠。
    ///
    /// 全屏播视频的播放器会持有 PreventUserIdleDisplaySleep 断言 ——
    /// 这是「在看视频」的最强系统级证据，且不含任何内容。
    /// 刻意不看 PreventUserIdleSystemSleep（听歌后台播放也持有，不代表在看）。
    pub fn display_video_active() -> bool {
        let mut dict: *mut c_void = std::ptr::null_mut();
        let kr = unsafe { IOPMCopyAssertionsStatus(&mut dict) };
        if kr != 0 || dict.is_null() {
            return false;
        }
        let mut out = false;
        // 现代类型名 + 遗留类型名都查，容错系统版本差异
        for key in ["PreventUserIdleDisplaySleep", "NoDisplayPowerAssertion"] {
            let k = cf_string(key);
            if k.is_null() {
                continue;
            }
            let v = unsafe { CFDictionaryGetValue(dict, k) };
            unsafe { CFRelease(k) };
            if v.is_null() {
                continue;
            }
            let mut count: i32 = 0;
            if unsafe {
                CFNumberGetValue(v, K_CF_NUMBER_SINT32, &mut count as *mut i32 as *mut c_void)
            } && count > 0
            {
                out = true;
                break;
            }
        }
        unsafe { CFRelease(dict) };
        out
    }

    // ——————————————————————————————————————————————
    // 前台进程树扫描（编译 / AI 会话检测）
    // ——————————————————————————————————————————————

    extern "C" {
        fn proc_listchildpids(ppid: i32, buffer: *mut c_void, buffersize: i32) -> i32;
        // PROC_PIDPATHINFO_MAXSIZE = 4096
        fn proc_pidpath(pid: i32, buffer: *mut c_void, buffersize: u32) -> i32;
        fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut c_void) -> i32;
    }

    // RUSAGE_INFO_V2 = 2
    const RUSAGE_INFO_V2: i32 = 2;

    /// rusage_info_v2（只用到前两个字段之后的 CPU 时间，但缓冲必须给足）。
    #[repr(C)]
    #[derive(Default)]
    struct RUsageInfoV2 {
        ri_uuid: [u8; 16],
        ri_user_time: u64,
        ri_system_time: u64,
        ri_pkg_idle_wkups: u64,
        ri_interrupt_wkups: u64,
        ri_pageins: u64,
        ri_wired_size: u64,
        ri_resident_size: u64,
        ri_phys_footprint: u64,
        ri_proc_start_abstime: u64,
        ri_proc_exit_abstime: u64,
    }

    /// 构建 / 测试工具的可执行名。**只匹配名字，不看参数** ——
    /// 跑 `cargo test foo::bar` 和跑 `cargo build` 对宠物没有区别。
    ///
    /// 名单刻意保守：node / python 这类万金油不在其内
    /// （Electron 编辑器的常驻扩展进程全是 node，光看名字必误报）。
    pub const BUILD_TOOLS: &[&str] = &[
        "cargo", "rustc", "cc", "clang", "ld", "swift", "swiftc", "swift-frontend", "make",
        "cmake", "ninja", "tsc", "vite", "webpack", "rollup", "esbuild", "vitest", "jest", "go",
        "gradle", "mvn", "bazel",
    ];

    /// AI 编码代理的可执行名。存在即算 —— 它们生成时主要在等网络，
    /// 本地 CPU 看不出忙闲，宁可陪着等，不靠 CPU 过滤。
    const AGENT_TOOLS: &[&str] = &["claude", "codex", "aider", "gemini", "cursor-agent"];

    /// 构建进程的 CPU 速率阈值（占单核的比值）。
    ///
    /// 编译期的单进程轻松吃满一核；Electron 常驻的 node 扩展进程
    /// 平时 < 2%。0.25 足以把两者分开，又不会被多核编译的波动误伤。
    const BUILD_CPU_RATE: f64 = 0.25;

    /// 子树扫描的深度与广度上限。编辑器 → pty 宿主 → shell → 构建工具
    /// 已经 4 层，6 层够用；上限防止极端情况下扫穿整张进程表。
    const MAX_DEPTH: usize = 6;
    const MAX_PROCS: usize = 64;

    /// 扫描前台进程树，判断是否在编译 / 跑测试 / 等 AI。
    ///
    /// `cpu_base` 是跨调用共享的基线（pid → 上次累计 CPU 纳秒）。
    pub fn scan_build(
        front_pid: i32,
        cpu_base: &mut HashMap<i32, u64>,
        elapsed: Duration,
    ) -> bool {
        if front_pid <= 0 {
            return false;
        }
        let subtree = collect_subtree(front_pid);
        let mut now_map: HashMap<i32, u64> = HashMap::new();
        let mut running = false;

        for pid in subtree {
            let Some(name) = exec_name(pid) else { continue };
            if AGENT_TOOLS.contains(&name.as_str()) {
                running = true;
                continue;
            }
            if !BUILD_TOOLS.contains(&name.as_str()) {
                continue;
            }
            let Some(cpu) = total_cpu_ns(pid) else { continue };
            if let Some(&prev) = cpu_base.get(&pid) {
                let rate = cpu_rate(prev, cpu, elapsed);
                if rate > BUILD_CPU_RATE {
                    running = true;
                }
            }
            now_map.insert(pid, cpu);
        }

        // 只保留本轮见过的进程，死进程的基线自然淘汰
        *cpu_base = now_map;
        running
    }

    /// 两次采样之间的 CPU 速率（占单核比值）。无增量或间隔为零时返回 0
    /// （首次扫描只建基线，不判定）。
    pub fn cpu_rate(prev_ns: u64, cur_ns: u64, elapsed: Duration) -> f64 {
        if elapsed.is_zero() || cur_ns <= prev_ns {
            return 0.0;
        }
        (cur_ns - prev_ns) as f64 / elapsed.as_nanos() as f64
    }

    /// BFS 收集 pid 的子树（含自身）。
    fn collect_subtree(root: i32) -> Vec<i32> {
        let mut out = vec![root];
        let mut seen = HashSet::from([root]);
        let mut queue = VecDeque::from([(root, 0usize)]);
        while let Some((pid, depth)) = queue.pop_front() {
            if depth >= MAX_DEPTH {
                continue;
            }
            for child in child_pids(pid) {
                if out.len() >= MAX_PROCS {
                    return out;
                }
                if seen.insert(child) {
                    out.push(child);
                    queue.push_back((child, depth + 1));
                }
            }
        }
        out
    }

    /// 直接子进程列表。取不到时返回空（按没有子进程处理）。
    fn child_pids(ppid: i32) -> Vec<i32> {
        unsafe {
            // 返回值语义（字节数还是 pid 数）没有文档保证，
            // 分配「r + 16 个 pid」的缓冲对两种语义都够
            let r = proc_listchildpids(ppid, std::ptr::null_mut(), 0);
            if r <= 0 {
                return Vec::new();
            }
            let cap = r as usize + 16;
            let mut buf: Vec<i32> = vec![0; cap];
            let got =
                proc_listchildpids(ppid, buf.as_mut_ptr() as *mut c_void, (cap * 4) as i32);
            if got <= 0 {
                return Vec::new();
            }
            pids_until_first_zero(&mut buf)
        }
    }

    /// 截到第一个 0 —— 未写入区域是零，写过的 pid 皆非零，
    /// 与返回值语义（字节数 / 个数）无关。
    pub fn pids_until_first_zero(buf: &mut [i32]) -> Vec<i32> {
        let n = buf.iter().position(|&p| p == 0).unwrap_or(buf.len());
        buf[..n].to_vec()
    }

    /// 进程可执行名（路径最后一段）。取不到返回 None。
    ///
    /// **只取名字**：路径其余部分含用户名与项目位置，不存不传。
    fn exec_name(pid: i32) -> Option<String> {
        let mut buf = vec![0u8; 4096];
        let n = unsafe { proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, 4096) };
        if n <= 0 {
            return None;
        }
        exec_basename(std::str::from_utf8(&buf[..n as usize]).ok()?)
    }

    /// 路径的可执行名（最后一段）。
    pub fn exec_basename(path: &str) -> Option<String> {
        let base = path.rsplit('/').next()?;
        if base.is_empty() {
            None
        } else {
            Some(base.to_string())
        }
    }

    /// 进程累计 CPU 时间（用户 + 内核，纳秒）。取不到返回 None。
    fn total_cpu_ns(pid: i32) -> Option<u64> {
        let mut info = RUsageInfoV2::default();
        let r =
            unsafe { proc_pid_rusage(pid, RUSAGE_INFO_V2, &mut info as *mut _ as *mut c_void) };
        if r != 0 {
            return None;
        }
        Some(info.ri_user_time.saturating_add(info.ri_system_time))
    }

    // ——————————————————————————————————————————————
    // 专注模式 / 勿扰
    // ——————————————————————————————————————————————

    /// 专注模式是否开启。读不到（旧系统 / 路径变更）按未开启。
    ///
    /// `cache` 存 (mtime, 判定)：文件没变就不重读不重判。
    pub fn dnd_enabled(cache: &mut Option<(SystemTime, bool)>) -> bool {
        let Some(home) = std::env::var_os("HOME") else {
            return false;
        };
        let path =
            std::path::Path::new(&home).join("Library/DoNotDisturb/DB/Assertions.json");

        let Ok(meta) = std::fs::metadata(&path) else {
            *cache = None;
            return false;
        };
        let Ok(mtime) = meta.modified() else {
            return false;
        };
        if let Some((t, v)) = *cache {
            if t == mtime {
                return v;
            }
        }

        let on = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .map(|v| dnd_records_active(&v))
            .unwrap_or(false);
        *cache = Some((mtime, on));
        on
    }

    /// Assertions.json 是否存在活跃的专注模式断言。
    ///
    /// 两种 schema 都兼容：顶层 `storeAssertionRecords`（新）
    /// 与 `data[].storeAssertionRecords`（旧）—— 数组非空即开启。
    /// schema 由 Apple 私有，随时可能变，解析失败按未开启。
    pub fn dnd_records_active(v: &serde_json::Value) -> bool {
        if let Some(arr) = v.get("storeAssertionRecords").and_then(|x| x.as_array()) {
            return !arr.is_empty();
        }
        if let Some(data) = v.get("data").and_then(|x| x.as_array()) {
            return data.iter().any(|d| {
                d.get("storeAssertionRecords")
                    .and_then(|x| x.as_array())
                    .is_some_and(|a| !a.is_empty())
            });
        }
        false
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use std::collections::HashMap;
    use std::time::{Duration, SystemTime};

    pub fn screen_locked() -> bool {
        false
    }
    pub fn mic_in_use() -> bool {
        false
    }
    pub fn display_video_active() -> bool {
        false
    }
    pub fn scan_build(
        _front_pid: i32,
        _base: &mut HashMap<i32, u64>,
        _elapsed: Duration,
    ) -> bool {
        false
    }
    pub fn dnd_enabled(_cache: &mut Option<(SystemTime, bool)>) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_signals默认全关() {
        // 新信号默认全 false —— 采集失败时的静默降级与默认值一致
        let s = EnvSignals::default();
        assert!(!s.mic_in_use && !s.screen_locked && !s.display_video && !s.build_running && !s.dnd_on);
    }

    #[cfg(target_os = "macos")]
    mod mac_tests {
        use super::super::platform;

        #[test]
        fn dnd顶层schema数组非空即开启() {
            let v: serde_json::Value = serde_json::from_str(
                r#"{"storeAssertionRecords":[{"assertionUUID":"u1","modeIdentifier":"com.apple.donotdisturb.mode.default"}],"storeInvalidationRecords":[]}"#,
            )
            .unwrap();
            assert!(platform::dnd_records_active(&v));
        }

        #[test]
        fn dnd顶层schema空数组为关闭() {
            let v: serde_json::Value = serde_json::from_str(
                r#"{"storeAssertionRecords":[],"storeInvalidationRecords":[]}"#,
            )
            .unwrap();
            assert!(!platform::dnd_records_active(&v));
        }

        #[test]
        fn dnd旧版嵌套schema_data内数组非空即开启() {
            let v: serde_json::Value = serde_json::from_str(
                r#"{"data":[{"storeAssertionRecords":[{"assertionUUID":"u1"}]}]}"#,
            )
            .unwrap();
            assert!(platform::dnd_records_active(&v));
        }

        #[test]
        fn dnd旧版嵌套schema空数组为关闭() {
            let v: serde_json::Value =
                serde_json::from_str(r#"{"data":[{"storeAssertionRecords":[]}]}"#).unwrap();
            assert!(!platform::dnd_records_active(&v));
        }

        #[test]
        fn dnd无法识别的schema按关闭处理() {
            // Apple 私有格式，随时可能变 —— 解析不出就当没开，绝不误闭嘴失败
            for s in ["{}", r#"{"data":[]}"#, r#"{"something":"else"}"#] {
                let v = serde_json::from_str::<serde_json::Value>(s).unwrap();
                assert!(!platform::dnd_records_active(&v), "{s}");
            }
        }

        #[test]
        fn cpu速率按间隔归一化() {
            use std::time::Duration;
            // 2 秒内消耗 1 秒 CPU → 单核的 50%
            let r = platform::cpu_rate(0, 1_000_000_000, Duration::from_secs(2));
            assert!((r - 0.5).abs() < 1e-9, "{r}");
            // 无增量或间隔为零 → 0（首次扫描只建基线不判定）
            assert_eq!(platform::cpu_rate(5, 5, Duration::from_secs(2)), 0.0);
            assert_eq!(platform::cpu_rate(0, 1, Duration::ZERO), 0.0);
        }

        #[test]
        fn 子进程缓冲截到第一个零() {
            let mut buf = [12, 34, 0, 0, 56];
            assert_eq!(platform::pids_until_first_zero(&mut buf), vec![12, 34]);
            let mut full = [1, 2, 3];
            assert_eq!(platform::pids_until_first_zero(&mut full), vec![1, 2, 3]);
        }

        #[test]
        fn 可执行名只取路径最后一段() {
            assert_eq!(
                platform::exec_basename("/Users/x/.cargo/bin/cargo"),
                Some("cargo".to_string())
            );
            assert_eq!(
                platform::exec_basename("vite"),
                Some("vite".to_string())
            );
            assert_eq!(platform::exec_basename("/a/b/"), None);
        }

        #[test]
        fn 构建工具名单不含万金油进程名() {
            // node/python 是 Electron 扩展宿主与各种脚本的常驻进程，
            // 光看名字必误报 —— 钉死名单里永远不该出现它们
            for bad in ["node", "python", "python3", "ruby", "perl"] {
                assert!(
                    !platform::BUILD_TOOLS.contains(&bad),
                    "名单里出现了万金油进程名：{bad}"
                );
            }
        }
    }
}
