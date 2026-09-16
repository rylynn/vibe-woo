//! macOS 原生取词（辅助功能 API）。
//!
//! 全部走 C FFI（ApplicationServices / HIServices），不引入额外 crate。
//! 隐私边界（与 sensor.rs 的零授权采集刻意区分开）：
//!   - 只在用户触发后读取**前台应用焦点控件的选区文本**；
//!   - 优先 `AXSelectedText`，控件不支持时用选区范围回退取串，
//!     **绝不读取整个控件值，不递归扫描应用内容**；
//!   - 不模拟按键复制、不写剪贴板（复制是显式命令，见 copy_to_clipboard）。

use std::ffi::{c_char, CStr, CString};

use super::ReadError;

#[allow(non_camel_case_types)]
type AXUIElementRef = *mut std::ffi::c_void;
#[allow(non_camel_case_types)]
type AXValueRef = *mut std::ffi::c_void;
#[allow(non_camel_case_types)]
type CFStringRef = *mut std::ffi::c_void;
#[allow(non_camel_case_types)]
type CFTypeRef = *mut std::ffi::c_void;
#[allow(non_camel_case_types)]
type CFDictionaryRef = *mut std::ffi::c_void;
#[allow(non_camel_case_types)]
type CFIndex = isize;
#[allow(non_camel_case_types)]
type AXError = i32;

// AXError 枚举值（HIServices/AXUIElement.h）
const AX_SUCCESS: AXError = 0;
const AX_ATTRIBUTE_UNSUPPORTED: AXError = -25205;
const AX_CANNOT_COMPLETE: AXError = -25204;

// kCFStringEncodingUTF8
const UTF8: u32 = 0x0800_0100;

// AXValueType：kAXValueCFRangeType
const AX_VALUE_CF_RANGE: i32 = 4;

/// 单次 AX 消息超时（秒）。无响应应用不至于挂住工作线程。
const MESSAGING_TIMEOUT: f64 = 1.5;

#[repr(C)]
#[derive(Clone, Copy)]
struct CFRange {
    location: CFIndex,
    length: CFIndex,
}

#[repr(C)]
struct CFDictionaryKeyCallBacks {
    version: isize,
    retain: *const std::ffi::c_void,
    release: *const std::ffi::c_void,
    copy_description: *const std::ffi::c_void,
    equal: *const std::ffi::c_void,
    hash: *const std::ffi::c_void,
}

#[repr(C)]
struct CFDictionaryValueCallBacks {
    version: isize,
    retain: *const std::ffi::c_void,
    release: *const std::ffi::c_void,
    copy_description: *const std::ffi::c_void,
    equal: *const std::ffi::c_void,
}

// CFRelease / CFStringCreateWithCString 与 envsense.rs 的声明保持一致
//（同符号在同 crate 内多次声明必须签名一致）。
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementCopyParameterizedAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        parameter: CFTypeRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f64) -> AXError;
    fn AXValueCreate(value_type: i32, value: *const std::ffi::c_void) -> AXValueRef;
    fn AXValueGetValue(
        value: AXValueRef,
        value_type: i32,
        value: *mut std::ffi::c_void,
    ) -> u8;

    fn CFStringCreateWithCString(
        alloc: *const std::ffi::c_void,
        c_str: *const c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFStringGetCString(
        the_string: CFStringRef,
        buffer: *mut c_char,
        buffer_size: CFIndex,
        encoding: u32,
    ) -> u8;
    fn CFDictionaryCreate(
        allocator: *mut std::ffi::c_void,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        num_values: CFIndex,
        key_callbacks: *const CFDictionaryKeyCallBacks,
        value_callbacks: *const CFDictionaryValueCallBacks,
    ) -> CFDictionaryRef;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFRelease(cf: *const std::ffi::c_void);

    static kCFBooleanTrue: CFTypeRef;
    static kCFTypeDictionaryKeyCallBacks: CFDictionaryKeyCallBacks;
    static kCFTypeDictionaryValueCallBacks: CFDictionaryValueCallBacks;
}

/// 触发时刻的来源应用快照（pid + bundle id）。
pub struct SourceApp {
    pub pid: i32,
    pub bundle_id: Option<String>,
}

/// 当前前台应用（跳过宠物自己 —— nonactivating 面板没有可读选区）。
pub fn frontmost_source() -> Option<SourceApp> {
    use objc2_app_kit::NSWorkspace;

    let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
    let pid: i32 = app.processIdentifier();
    if pid == std::process::id() as i32 {
        return None;
    }
    Some(SourceApp {
        pid,
        bundle_id: app.bundleIdentifier().map(|b| b.to_string()),
    })
}

/// 前台应用是否仍为指定 pid（读取前后各查一次，防来源切换）。
pub fn frontmost_is(pid: i32) -> bool {
    use objc2_app_kit::NSWorkspace;

    match NSWorkspace::sharedWorkspace().frontmostApplication() {
        Some(app) => app.processIdentifier() == pid,
        None => false,
    }
}

/// 前台应用是否是宠物自己。
///
/// 用途：取词期间若宠物因故短暂成为前台（例如前端请求输入焦点），
/// 那是**我们自己抢的**，不是用户切换了应用 —— 不应判为来源切换而丢弃结果。
pub fn frontmost_is_self() -> bool {
    frontmost_is(std::process::id() as i32)
}

/// 查询辅助功能授权。prompt=true 时弹系统授权提示（仅用户主动点击后调用）。
pub fn ax_trusted(prompt: bool) -> bool {
    unsafe {
        if !prompt {
            // 纯查询，不弹任何提示
            return AXIsProcessTrustedWithOptions(std::ptr::null_mut()) == 1;
        }
        let Some(key) = cf_string("kAXTrustedCheckOptionPrompt") else {
            return false;
        };
        let keys = [key];
        let values = [kCFBooleanTrue];
        let dict = CFDictionaryCreate(
            std::ptr::null_mut(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        );
        let trusted = if dict.is_null() {
            false
        } else {
            AXIsProcessTrustedWithOptions(dict) == 1
        };
        if !dict.is_null() {
            CFRelease(dict);
        }
        CFRelease(key);
        trusted
    }
}

/// 读取指定应用焦点控件的选区文本。
pub fn read_selection(pid: i32) -> Result<String, ReadError> {
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return Err(ReadError::Failed);
        }
        // 每次消息最多等 1.5s，无响应应用不至于挂住线程
        AXUIElementSetMessagingTimeout(app, MESSAGING_TIMEOUT);
        let result = read_selection_inner(app);
        CFRelease(app);
        result
    }
}

unsafe fn read_selection_inner(app: AXUIElementRef) -> Result<String, ReadError> {
    // 1. 焦点控件（不是系统全局元素 —— 不碰其他窗口与整个应用树）
    let (err, focused) = copy_attribute_raw(app, "AXFocusedUIElement");
    if err != AX_SUCCESS || focused.is_null() {
        return Err(ReadError::Unsupported);
    }

    // 2. 优先直接读选区文本
    let mut text = copy_selected_text(focused);

    // 3. 控件不支持时用「选区范围 → 范围取串」回退，仍不读整个控件值
    if text.is_none() {
        text = read_via_range(focused);
    }
    CFRelease(focused);

    text.ok_or(ReadError::NoSelection)
}

/// 读 AXSelectedText。None 表示需要回退或无选区。
unsafe fn copy_selected_text(focused: AXUIElementRef) -> Option<String> {
    let (err, value) = copy_attribute_raw(focused, "AXSelectedText");
    if err == AX_CANNOT_COMPLETE {
        // 应用无响应：直接失败，不做回退（回退同样会卡）
        return None;
    }
    if err != AX_SUCCESS || value.is_null() {
        return None;
    }
    let s = if is_cf_string(value) {
        cf_string_to_string(value)
    } else {
        None
    };
    CFRelease(value);
    s
}

/// 回退路径：AXSelectedTextRange（CFRange）→ AXStringForParameterizedAttribute。
unsafe fn read_via_range(focused: AXUIElementRef) -> Option<String> {
    let (err, range_value) = copy_attribute_raw(focused, "AXSelectedTextRange");
    if err != AX_SUCCESS || range_value.is_null() {
        return None;
    }
    let mut range = CFRange {
        location: 0,
        length: 0,
    };
    let got = AXValueGetValue(
        range_value,
        AX_VALUE_CF_RANGE,
        &mut range as *mut CFRange as *mut std::ffi::c_void,
    );
    CFRelease(range_value);
    if got == 0 || range.length <= 0 {
        return None;
    }

    let param = AXValueCreate(
        AX_VALUE_CF_RANGE,
        &range as *const CFRange as *const std::ffi::c_void,
    );
    if param.is_null() {
        return None;
    }
    let attr = match cf_string("AXStringForRange") {
        Some(a) => a,
        None => {
            CFRelease(param);
            return None;
        }
    };
    let mut value: CFTypeRef = std::ptr::null_mut();
    let err = AXUIElementCopyParameterizedAttributeValue(focused, attr, param, &mut value);
    CFRelease(attr);
    CFRelease(param);
    if err != AX_SUCCESS || value.is_null() {
        return None;
    }
    let s = if is_cf_string(value) {
        cf_string_to_string(value)
    } else {
        None
    };
    CFRelease(value);
    s
}

/// 复制属性原始结果（returned retained，调用方负责 CFRelease）。
unsafe fn copy_attribute_raw(elem: AXUIElementRef, attr: &str) -> (AXError, CFTypeRef) {
    let Some(name) = cf_string(attr) else {
        return (AX_ATTRIBUTE_UNSUPPORTED, std::ptr::null_mut());
    };
    let mut value: CFTypeRef = std::ptr::null_mut();
    let err = AXUIElementCopyAttributeValue(elem, name, &mut value);
    CFRelease(name);
    (err, value)
}

unsafe fn is_cf_string(v: CFTypeRef) -> bool {
    !v.is_null() && CFGetTypeID(v) == CFStringGetTypeID()
}

/// Rust &str → retained CFString。
fn cf_string(s: &str) -> Option<CFStringRef> {
    let c = CString::new(s).ok()?;
    let cf = unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8) };
    if cf.is_null() {
        None
    } else {
        Some(cf)
    }
}

/// CFString → Rust String（自动扩缓冲）。
unsafe fn cf_string_to_string(cf: CFStringRef) -> Option<String> {
    let mut size: CFIndex = 1024;
    loop {
        let mut buf = vec![0u8; size as usize];
        if CFStringGetCString(cf, buf.as_mut_ptr() as *mut c_char, size, UTF8) == 1 {
            let cstr = CStr::from_ptr(buf.as_ptr() as *const c_char);
            return Some(cstr.to_string_lossy().into_owned());
        }
        if size > 16 * 1024 * 1024 {
            return None;
        }
        size *= 4;
    }
}

/// 把文本写入系统剪贴板（用户显式点击复制按钮才调用）。
pub fn copy_to_clipboard(text: &str) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    let s = NSString::from_str(text);
    let type_string = unsafe { NSPasteboardTypeString };
    if pb.setString_forType(&s, type_string) {
        Ok(())
    } else {
        Err("写入剪贴板失败".to_string())
    }
}
