//! 同步服务客户端 —— 内置服务地址 + 唯一的请求出口。
//!
//! 服务地址内置在客户端里：用户不需要、也不该手填服务器。
//! 配置里的 `social.server` 保留为**覆盖口子** —— 留空即用内置域名，
//! 填了就走填的（本机联调，或自托管到自己的服务器 —— 见
//! `worker-edgeone/local-dev.js` 顶部的用法说明）。
//!
//! 之前 `post_authed` 在 socialcmd.rs 与 socialdrive.rs 各有一份，
//! 两份的错误文案和超时都不一样，改一处漏一处。这里收敛成一份。

use serde::Serialize;

use crate::configcmd;

/// 内置同步服务地址。请求路径直接拼在后面（/api/heartbeat、/api/greet …）。
///
/// **必须带 `/api`**：边缘函数文件在 `edge-functions/api/[[default]].js`，
/// 按 Pages 的文件路由它只挂在 `/api/*` 上；请求 `/heartbeat` 根本不会命中。
/// 自托管同理：国内云主机未备案时只能用 IP + 非标端口，见
/// `worker-edgeone/local-dev.js` 顶部的用法说明。
pub const DEFAULT_SYNC_BASE_URL: &str = "https://vibe-woo-moyzkajk.edgeone.cool/api";

/// 实际使用的服务地址：配置留空 → 内置域名。
///
/// 只放行 https 与本机 http —— 设置面板那个覆盖口子一旦被填成
/// `http://`，Bearer token 就明文上网了。不合规的地址静默回落内置域名，
/// 总好过把会话令牌送出去。
pub fn base_url() -> String {
    let cfg = configcmd::current();
    let s = cfg.social.server.trim();
    if s.is_empty() {
        return DEFAULT_SYNC_BASE_URL.to_string();
    }
    let s = s.trim_end_matches('/');
    let ok = s.starts_with("https://") || (s.starts_with("http://") && host_is_ip(s));
    if ok {
        s.to_string()
    } else {
        eprintln!("[sync] 服务地址不合规（https，或 http + IP），回落内置地址");
        DEFAULT_SYNC_BASE_URL.to_string()
    }
}

/// 取 URL 的 host（去掉协议、端口、路径）。取不到时返回空串。
fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split_once('/').map_or(rest, |(a, _)| a);
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    host.rsplit_once(':').map_or(host, |(h, _)| h)
}

/// host 是不是「没法备案、只能明文」的那类：本机，或 IPv4 字面量。
///
/// 国内云主机没备案时 80/443 会被阻断，只剩「IP + 非标端口」一条路，
/// 而 IP 无从备案 —— 只能放行明文。反过来，**有域名就必须走 https**：
/// 域名能备案、证书也免费，没有理由让 Bearer token 裸奔。
pub fn host_is_ip(url: &str) -> bool {
    let h = host_of(url);
    if h == "localhost" || h == "127.0.0.1" {
        return true;
    }
    let parts: Vec<&str> = h.split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| p.parse::<u8>().is_ok())
}

/// 复用同一个 Client：每次新建都要重建连接池与 TLS 握手，
/// 心跳是几分钟一次的长跑，没必要反复付这笔钱。
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// 把响应解成 JSON，并把服务端的 {error} 统一转成 Err（直接展示给用户）。
async fn parse(resp: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取失败：{e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "响应解析失败".to_string())?;
    if !status.is_success() || v["error"].is_string() {
        return Err(v["error"].as_str().unwrap_or("请求失败").to_string());
    }
    Ok(v)
}

/// 带鉴权的 POST。token 走 Authorization 头，绝不放 URL（避免进日志）。
pub async fn post_authed<T: Serialize>(
    path: &str,
    body: &T,
) -> Result<serde_json::Value, String> {
    let cfg = configcmd::current();
    if cfg.social.token.is_empty() {
        return Err("请先登录".into());
    }
    let url = format!("{}{path}", base_url());
    let resp = client()?
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.social.token))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("网络错误：{e}"))?;
    parse(resp).await
}

/// 免鉴权 POST（注册 / 登录）。
pub async fn post_public<T: Serialize>(
    path: &str,
    body: &T,
) -> Result<serde_json::Value, String> {
    let url = format!("{}{path}", base_url());
    let resp = client()?
        .post(&url)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("网络错误：{e}"))?;
    parse(resp).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 内置地址不带结尾斜杠() {
        // 路径是直接拼的，结尾带斜杠会拼出 //heartbeat
        assert!(!DEFAULT_SYNC_BASE_URL.ends_with('/'));
        assert!(DEFAULT_SYNC_BASE_URL.starts_with("https://"));
    }

    #[test]
    fn 有域名就必须走https() {
        // 域名能备案、证书免费 —— 没有理由让 Bearer token 走明文
        for bad in [
            "http://evil.example",
            "http://example.com:8787",
            "ftp://x",
            "javascript:alert(1)",
        ] {
            let s = bad.trim_end_matches('/');
            let ok = s.starts_with("https://") || (s.starts_with("http://") && host_is_ip(s));
            assert!(!ok, "不该放行：{bad}");
        }
    }

    #[test]
    fn 本机与纯IP可以走明文http() {
        // 国内云主机没备案时 80/443 被阻断，只剩 IP + 非标端口；
        // 而 IP 无从备案，只能放行。本机联调同理。
        for good in [
            "http://127.0.0.1:8787",
            "http://localhost:8787",
            "http://43.139.12.34:8787",
            "http://10.0.0.5",
            "https://x.example",
            "https://43.139.12.34:8787",
        ] {
            let ok = good.starts_with("https://") || (good.starts_with("http://") && host_is_ip(good));
            assert!(ok, "该放行：{good}");
        }
    }

    #[test]
    fn host提取要能剥掉端口与路径() {
        assert_eq!(host_of("http://1.2.3.4:8787"), "1.2.3.4");
        assert_eq!(host_of("http://1.2.3.4/api/status"), "1.2.3.4");
        assert_eq!(host_of("https://sync.example.com"), "sync.example.com");
        assert_eq!(host_of("http://u:p@1.2.3.4:9/x"), "1.2.3.4");
    }

    #[test]
    fn 非法IPv4不算IP() {
        // 999 不是一个字节，这种 host 不该被当成 IP 放行明文
        assert!(!host_is_ip("http://999.1.1.1:8787"));
        assert!(!host_is_ip("http://1.2.3:8787"));
        assert!(!host_is_ip("http://1.2.3.4.5:8787"));
        assert!(host_is_ip("http://1.2.3.4:8787"));
    }

    #[test]
    fn 拼路径不会出现双斜杠() {
        let base = "https://x.example".trim_end_matches('/');
        assert_eq!(format!("{base}/greet"), "https://x.example/greet");
        let base2 = "https://x.example/".trim_end_matches('/');
        assert_eq!(format!("{base2}/greet"), "https://x.example/greet");
    }
}
