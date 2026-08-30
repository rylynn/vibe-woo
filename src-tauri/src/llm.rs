//! LLM 接入：支持三种协议 —— openai-completions / openai-response / anthropic-messages。
//!
//! 全部走 SSE 流式请求：部分网关（如 code 11101 "Non-stream chat request
//! is currently not supported"）只接受 stream 请求，而官方 OpenAI /
//! Anthropic API 均完整支持流式 —— 统一流式是兼容面最广的形态。
//! 输出在客户端增量拼接，对外行为与非流式无差别。
//!
//! 原则：LLM 是异步增强，绝不是必需品。未配置 key 时静默跳过，
//! speak/enrich 失败时静默落回本地语料 —— 宠物不会因为这个来烦你。
//! 只有 test_llm（用户主动点「测试连接」）把失败原因原样带回前端。

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::config::{LlmConfig, LlmProtocol};
use crate::configcmd;

/// 速记整理完成事件名。
pub const EVENT_NOTE_ENRICHED: &str = "pet://note-enriched";

#[derive(Debug, Serialize)]
pub struct Enriched {
    pub text: String,
    pub tags: Vec<String>,
    pub kind: String,
}

// ---------- OpenAI Chat Completions ----------

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<Message<'a>>,
    temperature: f32,
    stream: bool,
    /// 深度思考（opt-in）：Qwen/DashScope/Ollama 风格网关支持；
    /// 官方 OpenAI 会拒绝未知字段 —— 只在用户显式开启时携带。
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_thinking: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat>,
}

#[derive(Debug, Serialize)]
struct Message<'a> {
    role: &'a str,
    content: String,
}

#[derive(Debug, Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    kind: &'static str,
}

// ---------- OpenAI Responses ----------

#[derive(Debug, Serialize)]
struct ResponsesRequest<'a> {
    model: &'a str,
    instructions: &'a str,
    input: &'a str,
    max_output_tokens: u32,
    stream: bool,
    /// 深度思考（opt-in）：Responses API 的标准推理力度参数。
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<Reasoning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<ResponsesText>,
}

#[derive(Debug, Serialize)]
struct Reasoning {
    effort: &'static str,
}

#[derive(Debug, Serialize)]
struct ResponsesText {
    format: ResponseFormat,
}

// ---------- Anthropic Messages ----------

#[derive(Debug, Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: &'a str,
    stream: bool,
    /// 深度思考（opt-in）：Anthropic 标准扩展思考。
    /// 开启时 max_tokens 必须大于 budget_tokens，故同步抬高。
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<AnthropicThinking>,
    messages: Vec<Message<'a>>,
}

#[derive(Debug, Serialize)]
struct AnthropicThinking {
    #[serde(rename = "type")]
    kind: &'static str,
    budget_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct EnrichOutput {
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default = "default_kind")]
    kind: String,
}

fn default_kind() -> String {
    "note".into()
}

/// 单轮对话统一入口：发 system+user，流式收完，返回完整输出文本。
///
/// Err 携带可读的失败原因（供「测试连接」直接展示给用户）：
/// 网络错误、HTTP 状态码 + 响应体片段、或流中无有效文本。
pub async fn complete(
    llm: &LlmConfig,
    system: &str,
    user: &str,
    json_mode: bool,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        // 推理模型（如 hy4-preview）会先生成大量 reasoning token，实测单轮
        // 可超过 30 秒，20s 会让「测试连接」在正常情况下误报失败
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    match llm.protocol {
        LlmProtocol::OpenaiCompletions => {
            openai_completions(&client, llm, system, user, json_mode).await
        }
        LlmProtocol::OpenaiResponse => {
            openai_response(&client, llm, system, user, json_mode).await
        }
        LlmProtocol::AnthropicMessages => {
            anthropic_messages(&client, llm, system, user).await
        }
    }
}

/// 非 2xx 时读回响应体片段，让用户看到真实原因（401 key 错、404 路径错…）。
async fn err_from_response(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let snippet: String = body.chars().take(200).collect();
    if snippet.is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}：{snippet}")
    }
}

/// 从 SSE 流的每个 data 事件 JSON 中抽取增量文本。
type DeltaExtractor = fn(&serde_json::Value) -> Option<String>;

fn extract_completions(v: &serde_json::Value) -> Option<String> {
    // data: {"choices":[{"delta":{"content":"增量"}}]}
    v["choices"]
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
        .map(str::to_string)
}

fn extract_responses(v: &serde_json::Value) -> Option<String> {
    // data: {"type":"response.output_text.delta","delta":"增量"}
    if v["type"].as_str()? == "response.output_text.delta" {
        v.get("delta")?.as_str().map(str::to_string)
    } else {
        None
    }
}

fn extract_anthropic(v: &serde_json::Value) -> Option<String> {
    // data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"增量"}}
    if v["type"].as_str()? == "content_block_delta" {
        v.get("delta")?.get("text")?.as_str().map(str::to_string)
    } else {
        None
    }
}

/// 逐行读 SSE：按换行切事件，`data: [DONE]` 终止，其余事件交给
/// extractor 抽增量文本拼接。非增量事件（role、usage、心跳、结束标记）
/// 会被 extractor 自然忽略。
async fn sse_collect(
    resp: reqwest::Response,
    extract: DeltaExtractor,
) -> Result<String, String> {
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut text = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("流读取失败：{e}"))?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line).trim().to_string();
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue; // event:/注释/空行
            };
            if data == "[DONE]" {
                return Ok(text);
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                continue; // 无法解析的事件跳过，不中断整条流
            };
            if let Some(delta) = extract(&v) {
                text.push_str(&delta);
            }
        }
    }
    // Responses / Anthropic 不发 [DONE]，直接关流 —— 落到这里
    Ok(text)
}

async fn openai_completions(
    client: &reqwest::Client,
    llm: &LlmConfig,
    system: &str,
    user: &str,
    json_mode: bool,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", llm.base_url.trim_end_matches('/'));
    let body = ChatRequest {
        model: &llm.model,
        messages: vec![
            Message {
                role: "system",
                content: system.to_string(),
            },
            Message {
                role: "user",
                content: user.to_string(),
            },
        ],
        temperature: 0.9,
        stream: true,
        enable_thinking: llm.thinking.then_some(true),
        response_format: json_mode.then_some(ResponseFormat {
            kind: "json_object",
        }),
    };

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", llm.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络错误：{e}"))?;

    if !resp.status().is_success() {
        return Err(err_from_response(resp).await);
    }

    let text = sse_collect(resp, extract_completions).await?;
    if text.trim().is_empty() {
        return Err("流中无文本增量".into());
    }
    Ok(text.trim().to_string())
}

async fn openai_response(
    client: &reqwest::Client,
    llm: &LlmConfig,
    system: &str,
    user: &str,
    json_mode: bool,
) -> Result<String, String> {
    let url = format!("{}/responses", llm.base_url.trim_end_matches('/'));
    let body = ResponsesRequest {
        model: &llm.model,
        instructions: system,
        input: user,
        max_output_tokens: 1024,
        stream: true,
        reasoning: llm.thinking.then_some(Reasoning { effort: "medium" }),
        text: json_mode.then_some(ResponsesText {
            format: ResponseFormat {
                kind: "json_object",
            },
        }),
    };

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", llm.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络错误：{e}"))?;

    if !resp.status().is_success() {
        return Err(err_from_response(resp).await);
    }

    let text = sse_collect(resp, extract_responses).await?;
    if text.trim().is_empty() {
        return Err("流中无 output_text 增量".into());
    }
    Ok(text.trim().to_string())
}

async fn anthropic_messages(
    client: &reqwest::Client,
    llm: &LlmConfig,
    system: &str,
    user: &str,
) -> Result<String, String> {
    // base 常见两种写法：https://api.anthropic.com 与 https://api.anthropic.com/v1。
    // 已带 /v1 就不重复拼。
    let base = llm.base_url.trim_end_matches('/');
    let url = if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    };

    let body = AnthropicRequest {
        model: &llm.model,
        // 开思考时必须 max_tokens > budget_tokens
        max_tokens: if llm.thinking { 2048 } else { 1024 },
        system,
        stream: true,
        thinking: llm.thinking.then_some(AnthropicThinking {
            kind: "enabled",
            budget_tokens: 1024,
        }),
        messages: vec![Message {
            role: "user",
            content: user.to_string(),
        }],
    };

    let resp = client
        .post(&url)
        .header("x-api-key", &llm.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络错误：{e}"))?;

    if !resp.status().is_success() {
        return Err(err_from_response(resp).await);
    }

    let text = sse_collect(resp, extract_anthropic).await?;
    if text.trim().is_empty() {
        return Err("流中无 text 增量".into());
    }
    Ok(text.trim().to_string())
}

/// 测试 LLM 连通性。返回可读的结果描述（成功含耗时）。
#[tauri::command]
pub async fn test_llm(app: tauri::AppHandle) -> Result<String, String> {
    let cfg = crate::configcmd::current();
    if !cfg.llm.enabled {
        return Err("LLM 已停用 —— 先在设置里打开「启用 AI」".into());
    }
    if cfg.llm.api_key.is_empty() {
        return Err("API key 未配置".into());
    }
    let _ = app;
    let start = std::time::Instant::now();
    let out = complete(
        &cfg.llm,
        "你是连通性测试。回复一个字：通",
        "（说一句话）",
        false,
    )
    .await;
    let ms = start.elapsed().as_millis();
    match out {
        Ok(t) => {
            let t: String = t.chars().take(20).collect();
            Ok(format!("连接成功（{ms}ms）：{t}"))
        }
        // 原样带回详细原因，前端气泡展示
        Err(e) => Err(e),
    }
}

/// 宠物说一句话（LLM 版）。失败返回 None，调用方落回本地语料。
///
/// 单独的轻请求：一次对话、限 15 字、低温。
pub async fn speak(system: &str, llm: &LlmConfig) -> Option<String> {
    if !llm.enabled {
        return None; // 用户关闭了 LLM，直接落回本地语料
    }
    let text = complete(llm, system, "（说一句话）", false).await.ok()?;
    let text = text.trim().to_string();
    if text.is_empty() || text.chars().count() > 60 {
        return None; // 模型没听话，别把长文塞进气泡
    }
    Some(text)
}

/// 异步整理一条速记。
///
/// 有意不返回任何错误：失败就静默放弃，原文早已落盘，不会有任何损失。
/// 这是设计文档 6.1 的可靠性原则。
pub fn enrich(app: &AppHandle, text: String) {
    let cfg = configcmd::current();
    if !cfg.llm.enabled || cfg.llm.api_key.is_empty() {
        return; // 未启用或未配置就跳过，不做任何事
    }

    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(_) => return,
    };

    let app2 = app.clone();
    rt.block_on(async move {
        let _ = do_enrich(&app2, &text).await;
    });
}

async fn do_enrich(app: &AppHandle, text: &str) -> Result<(), String> {
    let cfg = configcmd::current();

    let content = complete(
        &cfg.llm,
        concat!(
            "你从一条极简的桌面速记中提取信息，只输出 JSON：",
            "{\"tags\":[\"1到2个简短标签\"],\"kind\":\"todo|idea|question|note\"}。",
            "标签尽量是单个词。kind 的语义：todo=待办要做的事，",
            "idea=想法或灵感，question=待查证的问题，note=普通记录。",
            "不要输出任何 JSON 之外的内容。"
        ),
        text,
        true,
    )
    .await?;

    let out: EnrichOutput = serde_json::from_str(content.trim())
        .map_err(|e| format!("LLM 输出非 JSON：{e}"))?;

    let enriched = Enriched {
        text: text.to_string(),
        tags: out.tags,
        kind: out.kind,
    };

    eprintln!(
        "[llm] 已整理「{}」→ kind={} tags={:?}",
        text, enriched.kind, enriched.tags
    );
    app.emit(EVENT_NOTE_ENRICHED, &enriched)
        .map_err(|e| e.to_string())?;

    Ok(())
}
