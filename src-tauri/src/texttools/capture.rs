//! 屏幕框选截图与本地文字识别。
//!
//! 隐私边界：截图只发生在用户框选完成后（单帧），图像只在内存中交给
//! Vision 本地识别（中英文），不写临时文件、不上传。截取区域排除本
//! 应用窗口，识别完成即释放流与图像缓冲。
//!
//! 坐标体系（三套，全部显式转换）：
//!   - AppKit 全局坐标：原点在主屏左下，y 向上（NSScreen/NSEvent）
//!   - 屏幕 sourceRect：原点在该屏左上，y 向下（SCStreamConfiguration）
//!   - 像素坐标：逻辑点 × backingScale，超上限等比降采样

/// 截图像素上限（1200 万像素）。超限等比降采样，防止极端跨屏选区撑爆内存。
pub const MAX_CAPTURE_PIXELS: u64 = 12_000_000;

/// 逻辑点矩形。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 显示器信息（来自 NSScreen）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenInfo {
    /// AppKit 全局 frame（原点主屏左下，y 向上）。
    pub frame: LogicalRect,
    /// CG 全局 frame（原点主屏左上，y 向下），用于与 SCDisplay.frame 匹配。
    pub cg_frame: LogicalRect,
    /// backing scale（Retina 为 2.0）。
    pub scale: f64,
}

/// NSScreen 的 AppKit 全局 frame → CG 全局 frame（原点主屏左上，y 向下）。
///
/// 主屏 AppKit 原点在 (0,0) 左下，高度为 primary_height；
/// 某屏 AppKit frame 为 (x, y, w, h)，其 CG 坐标为 (x, primary_height - y - h, w, h)。
pub fn appkit_screen_to_cg(frame: LogicalRect, primary_height: f64) -> LogicalRect {
    LogicalRect {
        x: frame.x,
        y: primary_height - frame.y - frame.h,
        w: frame.w,
        h: frame.h,
    }
}

/// 框选结果：选区 + 所在显示器。
#[derive(Debug, Clone, Copy)]
pub struct SelectedRegion {
    /// AppKit 全局坐标（已 clamp 到屏幕内）。
    pub rect: LogicalRect,
    pub screen: ScreenInfo,
}

/// AppKit 全局选区 → SCStreamConfiguration 的 sourceRect（原点该屏左上，y 向下）。
pub fn appkit_rect_to_source(rect: LogicalRect, screen: LogicalRect) -> LogicalRect {
    LogicalRect {
        x: rect.x - screen.x,
        y: (screen.y + screen.h) - (rect.y + rect.h),
        w: rect.w,
        h: rect.h,
    }
}

/// 把选区 clamp 到屏幕内（负坐标外接屏、贴边拖拽时防越界）。
pub fn clamp_rect_to_screen(rect: LogicalRect, screen: LogicalRect) -> LogicalRect {
    let x = rect.x.clamp(screen.x, screen.x + screen.w);
    let y = rect.y.clamp(screen.y, screen.y + screen.h);
    // clamp 后扣除左/下被裁掉的部分，再限制不越过右/上边界
    let w = (rect.w - (x - rect.x))
        .min(screen.x + screen.w - x)
        .max(0.0);
    let h = (rect.h - (y - rect.y))
        .min(screen.y + screen.h - y)
        .max(0.0);
    LogicalRect { x, y, w, h }
}

/// 找包含指定点（AppKit 全局坐标）的显示器。
pub fn find_screen_for_point<'a>(
    screens: &'a [ScreenInfo],
    x: f64,
    y: f64,
) -> Option<&'a ScreenInfo> {
    screens.iter().find(|s| {
        x >= s.frame.x && x < s.frame.x + s.frame.w && y >= s.frame.y && y < s.frame.y + s.frame.h
    })
}

/// 截图像素尺寸：逻辑点 × 缩放，超上限等比降采样，最小 1×1。
pub fn pixel_size(w_pt: f64, h_pt: f64, scale: f64, max_pixels: u64) -> (u32, u32) {
    let mut w = ((w_pt * scale).round() as i64).max(1) as u64;
    let mut h = ((h_pt * scale).round() as i64).max(1) as u64;
    let pixels = w.saturating_mul(h);
    if pixels > max_pixels {
        let factor = (max_pixels as f64 / pixels as f64).sqrt();
        w = (((w as f64) * factor).round() as i64).max(1) as u64;
        h = (((h as f64) * factor).round() as i64).max(1) as u64;
    }
    (w as u32, h as u32)
}

/// OCR 观察结果（归一化坐标，原点左下）。
#[derive(Debug, Clone, PartialEq)]
pub struct ObsLine {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 按阅读顺序整理观察结果：y 降序分组成行（相邻高度重叠视为同排），
/// 行内 x 升序。
pub fn reading_order(items: Vec<ObsLine>) -> Vec<Vec<ObsLine>> {
    let mut items = items;
    // y 降序（屏幕上方在前），y 相同按 x 升序兜底
    items.sort_by(|a, b| {
        b.y
            .partial_cmp(&a.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });

    let mut lines: Vec<Vec<ObsLine>> = Vec::new();
    for item in items {
        match lines.last_mut() {
            Some(line) => {
                let anchor = &line[0];
                // 与当前行锚点垂直距离小于较大行高的 60% → 同一行
                let tolerance = item.h.max(anchor.h) * 0.6;
                if (item.y - anchor.y).abs() <= tolerance {
                    line.push(item);
                } else {
                    lines.push(vec![item]);
                }
            }
            None => lines.push(vec![item]),
        }
    }
    for line in &mut lines {
        line.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
    }
    lines
}

/// 行内片段拼接：两侧都是 CJK 时不加空格，其余加空格。
pub fn join_line(segments: &[&str]) -> String {
    let mut out = String::new();
    for seg in segments {
        if out.is_empty() {
            out.push_str(seg);
            continue;
        }
        let prev_cjk = out.chars().last().is_some_and(is_cjk);
        let next_cjk = seg.chars().next().is_some_and(is_cjk);
        // CJK-CJK 之间不加空格；拉丁与 CJK 混排之间加空格（盘古之白）
        if !(prev_cjk && next_cjk) {
            out.push(' ');
        }
        out.push_str(seg);
    }
    out
}

/// 观察结果 → 最终文本（行间换行）。
pub fn lines_to_text(lines: Vec<Vec<ObsLine>>) -> String {
    lines
        .into_iter()
        .map(|line| {
            let segs: Vec<&str> = line.iter().map(|i| i.text.as_str()).collect();
            join_line(&segs)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// CJK 字符判定（含中文标点与全角形式）。
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F   // CJK 符号与标点 ，。、
        | 0x3400..=0x4DBF // 扩展 A
        | 0x4E00..=0x9FFF // CJK 统一表意
        | 0xF900..=0xFAFF // 兼容表意
        | 0xFF00..=0xFFEF // 全角形式 ！？
    )
}

#[cfg(target_os = "macos")]
mod native {
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol};
    use objc2::{define_class, msg_send, AnyThread, ClassType, DefinedClass};
    use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
    use objc2_core_media::CMSampleBuffer;
    use objc2_core_video::CVPixelBuffer;
    use objc2_foundation::{NSArray, NSDictionary, NSError, NSString};
    use objc2_screen_capture_kit::{
        SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamOutput,
        SCStreamOutputType,
    };
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };

    use super::super::ReadError;
    use super::{
        appkit_rect_to_source, lines_to_text, pixel_size, reading_order, ObsLine, SelectedRegion,
        MAX_CAPTURE_PIXELS,
    };

    // ---- 屏幕录制权限（CoreGraphics C API）----

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C-unwind" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    /// 查询屏幕录制授权（不弹提示）。
    pub fn screen_capture_permission() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    /// 触发系统屏幕录制请求：把本应用加入「屏幕录制」列表（未勾选），
    /// 系统可能附带弹一次确认。仅在 mod.rs 先清掉陈旧 TCC 条目后调用 ——
    /// 陈旧条目（重装/重签名后 cdhash 不匹配）下它会静默不弹。
    pub fn request_screen_capture_access() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }

    // ---- 单帧截图 ----

    /// 帧存储槽：跨线程传递像素缓冲（IOSurface 支持跨线程访问）。
    type FrameSlot = Arc<Mutex<Option<SendBuffer>>>;

    struct SendBuffer(Retained<CVPixelBuffer>);
    // CVPixelBuffer 由 IOSurface 支持，跨线程只读访问是安全的
    unsafe impl Send for SendBuffer {}

    define_class!(
        // SAFETY:
        // - 超类 NSObject 无子类化要求。
        // - FrameOutput 不实现 Drop。
        // - ivars 通过 Mutex 跨线程访问。
        #[unsafe(super(NSObject))]
        #[ivars = FrameIvars]
        #[name = "VibeFrameOutput"]
        struct FrameOutput;

        unsafe impl NSObjectProtocol for FrameOutput {}

        unsafe impl SCStreamOutput for FrameOutput {
            #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
            unsafe fn stream_did_output_sample_buffer_of_type(
                &self,
                _stream: &SCStream,
                sample_buffer: &CMSampleBuffer,
                _ty: SCStreamOutputType,
            ) {
                let mut slot = self.ivars().slot.lock().unwrap_or_else(|p| p.into_inner());
                // 已有画面：后续帧一律丢弃（单帧截图）
                if slot.is_some() {
                    return;
                }
                // image_buffer 返回 retained（CFRetained<CVImageBuffer>）
                if let Some(image) = unsafe { sample_buffer.image_buffer() } {
                    // CVImageBuffer 与 CVPixelBuffer 免桥接：直接 cast
                    let pixel: CFRetained<CVPixelBuffer> =
                        unsafe { CFRetained::cast_unchecked(image) };
                    *slot = Some(SendBuffer(Retained::from(pixel)));
                }
            }
        }
    );

    struct FrameIvars {
        slot: FrameSlot,
    }

    impl FrameOutput {
        fn new(slot: FrameSlot) -> Retained<Self> {
            let this = Self::alloc().set_ivars(FrameIvars { slot });
            unsafe { msg_send![super(this, NSObject::class()), init] }
        }
    }

    /// 取目标显示器（异步 API，channel 同步等待）。
    fn load_shareable_content(timeout: Duration) -> Result<Retained<SCShareableContent>, ReadError> {
        let (tx, rx) = mpsc::channel::<Result<Retained<SCShareableContent>, ()>>();
        let block = RcBlock::new(
            move |content: *mut SCShareableContent, error: *mut NSError| {
                let result = if !error.is_null() || content.is_null() {
                    Err(())
                } else {
                    unsafe { Retained::retain(content) }.ok_or(())
                };
                let _ = tx.send(result);
            },
        );
        unsafe {
            SCShareableContent::getShareableContentWithCompletionHandler(&block);
        }
        rx.recv_timeout(timeout)
            .map_err(|_| ReadError::Timeout)?
            .map_err(|()| ReadError::Failed)
    }

    /// 对选区截图（单帧）：排除本应用窗口，收首帧即停流并释放资源。
    unsafe fn capture_single_frame(
        region: &SelectedRegion,
    ) -> Result<Retained<CVPixelBuffer>, ReadError> {
        // 权限预检：未授权时 ScreenCaptureKit 只会给出空帧或报错
        if !screen_capture_permission() {
            return Err(ReadError::NotTrusted);
        }

        let content = load_shareable_content(Duration::from_secs(5))?;
        let displays = content.displays();
        // 用 CG 全局 frame 匹配 SCDisplay（容忍 1pt 误差）
        let target = region.screen.cg_frame;
        let display = displays
            .iter()
            .find(|d| {
                let f = unsafe { d.frame() };
                (f.origin.x - target.x).abs() < 1.0 && (f.origin.y - target.y).abs() < 1.0
            })
            .ok_or(ReadError::Failed)?;

        // 排除本应用：截图里不该出现框选层与宠物
        let own_pid = std::process::id() as i32;
        let empty_windows = NSArray::<objc2_screen_capture_kit::SCWindow>::new();
        let own_apps: Vec<Retained<objc2_screen_capture_kit::SCRunningApplication>> = content
            .applications()
            .iter()
            .filter(|a| unsafe { a.processID() } == own_pid)
            .collect();
        let apps = NSArray::from_retained_slice(&own_apps);
        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                SCContentFilter::alloc(),
                &display,
                &apps,
                &empty_windows,
            )
        };

        // 流配置：sourceRect 用该屏左上原点的逻辑点坐标，输出像素尺寸
        let source = appkit_rect_to_source(region.rect, region.screen.frame);
        let (pw, ph) = pixel_size(source.w, source.h, region.screen.scale, MAX_CAPTURE_PIXELS);
        let config = SCStreamConfiguration::new();
        unsafe {
            config.setSourceRect(CGRect::new(
                CGPoint::new(source.x, source.y),
                CGSize::new(source.w, source.h),
            ));
            config.setWidth(pw as usize);
            config.setHeight(ph as usize);
            config.setShowsCursor(false);
        }

        // 流 + 输出
        let slot: FrameSlot = Arc::new(Mutex::new(None));
        let output = FrameOutput::new(slot.clone());
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &config,
                None,
            )
        };
        let output_obj: Retained<objc2::runtime::ProtocolObject<dyn SCStreamOutput>> =
            objc2::runtime::ProtocolObject::from_retained(output);
        unsafe {
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    &output_obj,
                    SCStreamOutputType::Screen,
                    None,
                )
                .map_err(|e| {
                    eprintln!("[text-tools] 添加流输出失败：{}", e.localizedDescription().to_string());
                    ReadError::Failed
                })?;
        }

        // 启动并等首帧
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let start_block = RcBlock::new(move |error: *mut NSError| {
            let result = if error.is_null() {
                Ok(())
            } else {
                unsafe { Err((&*error).localizedDescription().to_string()) }
            };
            let _ = tx.send(result);
        });
        unsafe { stream.startCaptureWithCompletionHandler(Some(&start_block)) };
        match rx.recv_timeout(Duration::from_secs(5)) {
            Err(_) => {
                stop_stream(&stream, &output_obj);
                return Err(ReadError::Timeout);
            }
            Ok(Err(_msg)) => {
                stop_stream(&stream, &output_obj);
                return Err(ReadError::Failed);
            }
            Ok(Ok(())) => {}
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            {
                let guard = slot.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(buf) = guard.as_ref() {
                    stop_stream(&stream, &output_obj);
                    return Ok(buf.0.clone());
                }
            }
            if Instant::now() > deadline {
                stop_stream(&stream, &output_obj);
                return Err(ReadError::Timeout);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// 停流并移除输出（任何路径退出前都要走到这里，释放原生资源）。
    unsafe fn stop_stream(
        stream: &SCStream,
        output: &objc2::runtime::ProtocolObject<dyn SCStreamOutput>,
    ) {
        let (tx, rx) = mpsc::channel::<()>();
        let block = RcBlock::new(move |_error: *mut NSError| {
            let _ = tx.send(());
        });
        unsafe {
            let _ = stream.stopCaptureWithCompletionHandler(Some(&block));
            let _ = rx.recv_timeout(Duration::from_secs(3));
            let _ = stream.removeStreamOutput_type_error(output, SCStreamOutputType::Screen);
        }
    }

    // ---- Vision 本地识别 ----

    /// 本地识别中英文（优先简中，识别纠错开）。
    unsafe fn recognize_text(buffer: &CVPixelBuffer) -> Result<String, ReadError> {
        let request = VNRecognizeTextRequest::new();
        let zh = NSString::from_str("zh-Hans");
        let en = NSString::from_str("en-US");
        let langs = NSArray::from_slice(&[&*zh, &*en]);
        request.setRecognitionLanguages(&langs);
        request.setUsesLanguageCorrection(true);
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);

        let options = NSDictionary::new();
        let handler = unsafe {
            VNImageRequestHandler::initWithCVPixelBuffer_options(
                VNImageRequestHandler::alloc(),
                buffer,
                &options,
            )
        };
        // VNRecognizeTextRequest 上转为 VNRequest，构成请求数组（clone 保留原引用供读结果）
        let upcast: Retained<VNRequest> = unsafe { Retained::cast_unchecked(request.clone()) };
        let requests = NSArray::from_retained_slice(&[upcast]);
        if let Err(e) = handler.performRequests_error(&requests) {
            eprintln!(
                "[text-tools] 文字识别调度失败：{}",
                e.localizedDescription().to_string()
            );
            return Err(ReadError::Failed);
        }

        let observations = request.results().unwrap_or_default();
        let items: Vec<ObsLine> = observations
            .iter()
            .filter_map(|obs| {
                let candidates = obs.topCandidates(1);
                let top = candidates.iter().next()?;
                let bbox = unsafe { obs.boundingBox() };
                Some(ObsLine {
                    text: top.string().to_string(),
                    x: bbox.origin.x,
                    y: bbox.origin.y,
                    w: bbox.size.width,
                    h: bbox.size.height,
                })
            })
            .collect();
        if items.is_empty() {
            return Err(ReadError::NoSelection);
        }
        Ok(lines_to_text(reading_order(items)))
    }

    /// 截图 + 本地识别的统一入口（阻塞线程内执行）。
    pub fn capture_and_recognize(region: &SelectedRegion) -> Result<String, ReadError> {
        unsafe {
            let started = Instant::now();
            let result = capture_single_frame(region).and_then(|buffer| {
                let text = recognize_text(&buffer);
                eprintln!(
                    "[text-tools] 截图识别完成 耗时={:?} 结果={}",
                    started.elapsed(),
                    match &text {
                        Ok(_) => "ok",
                        Err(ReadError::NoSelection) => "no_text",
                        Err(_) => "error",
                    }
                );
                text
            });
            result
        }
    }
}

#[cfg(target_os = "macos")]
pub use native::{capture_and_recognize, request_screen_capture_access, screen_capture_permission};

#[cfg(not(target_os = "macos"))]
pub fn capture_and_recognize(_region: &SelectedRegion) -> Result<String, super::ReadError> {
    Err(super::ReadError::Failed)
}

#[cfg(not(target_os = "macos"))]
pub fn screen_capture_permission() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_capture_access() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: LogicalRect = LogicalRect {
        x: 0.0,
        y: 0.0,
        w: 1920.0,
        h: 1080.0,
    };
    // 外接屏在主屏左侧：AppKit x 为负
    const SIDE: LogicalRect = LogicalRect {
        x: -1440.0,
        y: 0.0,
        w: 1440.0,
        h: 900.0,
    };

    #[test]
    fn 主屏选区换算为屏幕左上原点坐标() {
        // 选区 top = 500 + 100 = 600，距屏顶 1080 - 600 = 480
        let rect = LogicalRect { x: 100.0, y: 500.0, w: 200.0, h: 100.0 };
        let out = appkit_rect_to_source(rect, MAIN);
        assert_eq!(out, LogicalRect { x: 100.0, y: 480.0, w: 200.0, h: 100.0 });
    }

    #[test]
    fn 负坐标外接屏选区换算基于该屏原点() {
        // 外接屏原点 (-1440, 0)，尺寸 1440x900
        let rect = LogicalRect { x: -1400.0, y: 800.0, w: 100.0, h: 50.0 };
        let out = appkit_rect_to_source(rect, SIDE);
        assert_eq!(out, LogicalRect { x: 40.0, y: 50.0, w: 100.0, h: 50.0 });
    }

    #[test]
    fn 选区被夹紧到屏幕边界() {
        // 拖到屏幕左下角外：x < screen.x 且 y + h > 屏顶
        let rect = LogicalRect { x: -50.0, y: -30.0, w: 200.0, h: 1200.0 };
        let out = clamp_rect_to_screen(rect, MAIN);
        assert!(out.x >= MAIN.x && out.x + out.w <= MAIN.x + MAIN.w);
        assert!(out.y >= MAIN.y && out.y + out.h <= MAIN.y + MAIN.h);
        assert_eq!(out, LogicalRect { x: 0.0, y: 0.0, w: 150.0, h: 1080.0 });
    }

    #[test]
    fn 按点找显示器覆盖负坐标外接屏() {
        let screens = [
            ScreenInfo { frame: MAIN, cg_frame: MAIN, scale: 2.0 },
            ScreenInfo { frame: SIDE, cg_frame: SIDE, scale: 1.0 },
        ];
        assert_eq!(find_screen_for_point(&screens, -1400.0, 450.0).unwrap().frame, SIDE);
        assert_eq!(find_screen_for_point(&screens, 960.0, 540.0).unwrap().frame, MAIN);
        assert!(find_screen_for_point(&screens, 5000.0, 5000.0).is_none(), "屏幕外的点应返回 None");
    }

    #[test]
    fn 屏幕帧从appkit换算到cg坐标() {
        // 主屏 1920x1080：AppKit (0,0) → CG (0, 1080-0-1080, ...) = (0,0)
        assert_eq!(
            appkit_screen_to_cg(MAIN, 1080.0),
            LogicalRect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 }
        );
        // 左侧外接屏 1440x900（与主屏顶对齐）：AppKit (-1440,180,1440,900)
        // → CG y = 1080 - 180 - 900 = 0
        let side = LogicalRect { x: -1440.0, y: 180.0, w: 1440.0, h: 900.0 };
        assert_eq!(
            appkit_screen_to_cg(side, 1080.0),
            LogicalRect { x: -1440.0, y: 0.0, w: 1440.0, h: 900.0 }
        );
    }

    #[test]
    fn 像素尺寸按缩放倍率计算() {
        assert_eq!(pixel_size(200.0, 100.0, 2.0, MAX_CAPTURE_PIXELS), (400, 200));
        assert_eq!(pixel_size(200.0, 100.0, 1.0, MAX_CAPTURE_PIXELS), (200, 100));
    }

    #[test]
    fn 像素超上限等比降采样() {
        // 5000×4000 pt × 2 = 1e8 px > 1.2e7，降采样比例 sqrt(0.12) ≈ 0.3464
        let (w, h) = pixel_size(5000.0, 4000.0, 2.0, MAX_CAPTURE_PIXELS);
        assert!(
            (w as u64) * (h as u64) <= MAX_CAPTURE_PIXELS,
            "降采样后不得超过上限：{w}x{h}"
        );
        // 保持宽高比（误差 < 2%）
        let ratio = w as f64 / h as f64;
        assert!((ratio - 1.25).abs() / 1.25 < 0.02, "宽高比被破坏：{ratio}");
    }

    #[test]
    fn 极小选区最小为一像素() {
        assert_eq!(pixel_size(0.1, 0.1, 2.0, MAX_CAPTURE_PIXELS), (1, 1));
    }

    #[test]
    fn 观察结果按阅读顺序排列() {
        let items = vec![
            ObsLine { text: "第二行右".into(), x: 0.6, y: 0.1, w: 0.3, h: 0.05 },
            ObsLine { text: "第一行左".into(), x: 0.1, y: 0.8, w: 0.3, h: 0.05 },
            ObsLine { text: "第二行左".into(), x: 0.1, y: 0.12, w: 0.3, h: 0.05 },
            ObsLine { text: "第一行右".into(), x: 0.6, y: 0.82, w: 0.3, h: 0.05 },
        ];
        let lines = reading_order(items);
        assert_eq!(lines.len(), 2, "应分组成两行");
        assert_eq!(lines[0].iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), ["第一行左", "第一行右"]);
        assert_eq!(lines[1].iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), ["第二行左", "第二行右"]);
    }

    #[test]
    fn 垂直重叠的片段归入同一行() {
        // y 差异小于行高的一半 → 同一行
        let items = vec![
            ObsLine { text: "A".into(), x: 0.1, y: 0.50, w: 0.2, h: 0.10 },
            ObsLine { text: "B".into(), x: 0.5, y: 0.54, w: 0.2, h: 0.10 },
            ObsLine { text: "C".into(), x: 0.1, y: 0.10, w: 0.2, h: 0.10 },
        ];
        let lines = reading_order(items);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), ["A", "B"]);
        assert_eq!(lines[1][0].text, "C");
    }

    #[test]
    fn cjk_之间不加空格其余加空格() {
        assert_eq!(join_line(&["你好", "世界"]), "你好世界");
        assert_eq!(join_line(&["hello", "world"]), "hello world");
        assert_eq!(join_line(&["使用", "Vision", "识别"]), "使用 Vision 识别");
        assert_eq!(join_line(&["标题：", "正文"]), "标题：正文");
        assert_eq!(join_line(&["only"]), "only");
    }
}
