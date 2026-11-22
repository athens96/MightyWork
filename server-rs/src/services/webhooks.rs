use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use hmac::{Hmac, Mac};
use reqwest::redirect::Policy;
use serde_json::{json, Value};
use sha2::Sha256;

use crate::db::Database;
use crate::models::{new_id, utcnow, Project, ProjectWebhook, WebhookDelivery};

type HmacSha256 = Hmac<Sha256>;

pub type WebhookSenderFn =
    Arc<dyn Fn(&str, &[u8], &HashMap<String, String>) -> Result<u16, String> + Send + Sync>;

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(Policy::none())
            .build()
            .expect("webhook reqwest client")
    })
}

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !v4.is_private()
                && !v4.is_loopback()
                && !v4.is_link_local()
                && !v4.is_broadcast()
                && !v4.is_documentation()
                && !v4.is_unspecified()
                && !v4.is_multicast()
                && !(v4.octets()[0] == 100 && (v4.octets()[1] & 0b1100_0000) == 64) // CGNAT 100.64.0.0/10
        }
        IpAddr::V6(v6) => {
            !v6.is_loopback()
                && !v6.is_unspecified()
                && !v6.is_multicast()
                && (v6.segments()[0] & 0xfe00) != 0xfc00 // unique local fc00::/7
                && (v6.segments()[0] & 0xffc0) != 0xfe80 // link-local fe80::/10
        }
    }
}

pub fn validate_webhook_url(raw_url: &str, skip_dns: bool) -> Result<String, String> {
    let clean = raw_url.trim().to_string();
    let parsed = reqwest::Url::parse(&clean)
        .map_err(|_| "Webhook URL 은 https:// 주소여야 합니다".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Webhook URL 은 https:// 주소여야 합니다".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Webhook URL 은 https:// 주소여야 합니다".to_string())?;

    let host_unbracketed = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host_unbracketed.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            return Err("사설/루프백 IP 는 Webhook 대상으로 허용되지 않습니다".into());
        }
        return Ok(clean);
    }

    if !skip_dns {
        let port = parsed.port().unwrap_or(443);
        let addrs: Vec<_> = (host, port)
            .to_socket_addrs()
            .map_err(|_| format!("호스트를 찾을 수 없습니다: {host}"))?
            .collect();
        if addrs.is_empty() {
            return Err(format!("호스트를 찾을 수 없습니다: {host}"));
        }
        for addr in addrs {
            if !is_public_ip(addr.ip()) {
                return Err(format!("공개 IP 가 아닌 대상은 허용되지 않습니다: {host}"));
            }
        }
    }
    Ok(clean)
}

pub fn format_webhook_payload(
    preset: &str,
    event: &str,
    project_key: &str,
    title: &str,
    body: &str,
    link: &str,
    extra: Option<&Value>,
) -> Value {
    let summary = format!("[{project_key}] {title}");
    if preset == "slack" {
        let mut text = format!("*{summary}*");
        if !body.is_empty() {
            text.push('\n');
            text.push_str(body);
        }
        if !link.is_empty() {
            text.push_str(&format!("\n<{link}|열기>"));
        }
        return json!({ "text": text });
    }
    if preset == "discord" {
        let mut content = format!("**{summary}**");
        if !body.is_empty() {
            content.push('\n');
            content.push_str(body);
        }
        if !link.is_empty() {
            content.push('\n');
            content.push_str(link);
        }
        let clipped: String = content.chars().take(1900).collect();
        return json!({ "content": clipped });
    }
    json!({
        "event": event,
        "project_key": project_key,
        "title": title,
        "body": body,
        "url": link,
        "data": extra.cloned().unwrap_or_else(|| json!({})),
    })
}

pub async fn deliver_now(
    db: &Database,
    hook: &ProjectWebhook,
    sender: Option<&WebhookSenderFn>,
    event: &str,
    project_key: &str,
    title: &str,
    body: &str,
    link: &str,
    extra: Option<&Value>,
) -> WebhookDelivery {
    let payload = format_webhook_payload(&hook.preset, event, project_key, title, body, link, extra);
    let raw = serde_json::to_vec(&payload).unwrap_or_default();
    let mut headers = HashMap::new();
    headers.insert("Content-Type".into(), "application/json".into());
    headers.insert("User-Agent".into(), "MightyWork-Webhook/1.0".into());
    headers.insert("X-MightyWork-Event".into(), event.to_string());
    if !hook.secret.is_empty() {
        let mut mac = HmacSha256::new_from_slice(hook.secret.as_bytes()).expect("hmac");
        mac.update(&raw);
        let sig = hex::encode(mac.finalize().into_bytes());
        headers.insert("X-MightyWork-Signature-256".into(), format!("sha256={sig}"));
    }

    let mut status_code: Option<i64> = None;
    let mut ok = false;
    let mut err_msg = String::new();
    let mut attempts = 0i64;
    let max_attempts = 2;

    for attempt in 1..=max_attempts {
        attempts = attempt;
        let res = if let Some(custom) = sender {
            custom(&hook.url, &raw, &headers)
        } else {
            match validate_webhook_url(&hook.url, false) {
                Err(e) => Err(e),
                Ok(_) => {
                    let mut req = http_client().post(&hook.url).body(raw.clone());
                    for (k, v) in &headers {
                        req = req.header(k.as_str(), v.as_str());
                    }
                    match req.send().await {
                        Ok(resp) => Ok(resp.status().as_u16()),
                        Err(e) => Err(e.to_string()),
                    }
                }
            }
        };
        match res {
            Ok(code) => {
                status_code = Some(code as i64);
                if (200..300).contains(&code) {
                    ok = true;
                    err_msg.clear();
                    break;
                }
                err_msg = format!("HTTP {code}");
            }
            Err(e) => {
                err_msg = e.chars().take(200).collect();
            }
        }
        if attempt < max_attempts && sender.is_none() {
            tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await;
        }
    }

    let now = utcnow();
    let delivery = WebhookDelivery {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: hook.project_id.clone(),
        webhook_id: hook.id.clone(),
        event: event.to_string(),
        status_code,
        ok,
        attempts,
        error: err_msg,
    };
    let _ = db.webhook_deliveries.create(&delivery);

    if let Ok(mut logs) = db.webhook_deliveries.list_by_project(&hook.project_id) {
        logs.retain(|d| d.webhook_id == hook.id);
        logs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        for stale in logs.into_iter().skip(50) {
            let _ = db.webhook_deliveries.delete(&stale.id);
        }
    }
    delivery
}

fn matches_hook_filters(hook: &ProjectWebhook, extra: Option<&Value>) -> bool {
    if hook.trigger_tags.is_empty() && hook.trigger_stages.is_empty() {
        return true;
    }
    let data = extra.and_then(|v| v.as_object());
    if !hook.trigger_tags.is_empty() {
        let wanted: HashSet<String> = hook
            .trigger_tags
            .iter()
            .map(|t| t.trim().to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        let actual: HashSet<String> = data
            .and_then(|o| o.get("tags"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.trim().to_lowercase()))
                    .collect()
            })
            .unwrap_or_default();
        if wanted.is_disjoint(&actual) {
            return false;
        }
    }
    if !hook.trigger_stages.is_empty() {
        let wanted: HashSet<String> = hook
            .trigger_stages
            .iter()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        let actual = data
            .and_then(|o| o.get("stage"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_lowercase();
        if !wanted.contains(&actual) {
            return false;
        }
    }
    true
}

pub fn dispatch_project_webhooks(
    db: &Database,
    sender: Option<WebhookSenderFn>,
    project: &Project,
    event: &str,
    title: String,
    body: String,
    link: String,
    extra: Option<Value>,
) -> usize {
    let hooks: Vec<ProjectWebhook> = db
        .project_webhooks
        .list_by_project(&project.id)
        .unwrap_or_default()
        .into_iter()
        .filter(|h| {
            h.enabled
                && h.events.iter().any(|e| e == event)
                && matches_hook_filters(h, extra.as_ref())
        })
        .collect();
    let count = hooks.len();
    for h in hooks {
        let db_c = db.clone();
        let sender_c = sender.clone();
        let event_s = event.to_string();
        let pkey = project.key.clone();
        let title_c = title.clone();
        let body_c = body.clone();
        let link_c = link.clone();
        let extra_c = extra.clone();
        tokio::spawn(async move {
            deliver_now(
                &db_c,
                &h,
                sender_c.as_ref(),
                &event_s,
                &pkey,
                &title_c,
                &body_c,
                &link_c,
                extra_c.as_ref(),
            )
            .await;
        });
    }
    count
}
