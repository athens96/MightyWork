use std::env;
use std::path::PathBuf;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone)]
pub struct Settings {
    pub app_name: String,
    pub google_client_id: String,
    pub allowed_email_domains: Vec<String>,
    pub jwt_secret: String,
    pub jwt_expire_minutes: i64,
    pub web_refresh_token_ttl_days: i64,
    pub data_dir: PathBuf,
    pub cors_origins: Vec<String>,
    pub public_url: String,
    pub app_url: String,
    pub mcp_access_token_ttl_sec: i64,
    pub mcp_refresh_token_ttl_days: i64,
    pub oauth_allow_private_cimd: bool,
    pub oauth_dcr_max_clients: usize,
    pub oauth_dcr_rate_limit_per_min: usize,
    pub kordoc_node: String,
    pub kordoc_cli: PathBuf,
    pub kordoc_timeout_sec: u64,
    pub pandoc_bin: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_password: String,
    pub smtp_from: String,
    pub smtp_use_tls: bool,
    pub host: String,
    pub port: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            app_name: "MightyWork".into(),
            google_client_id: String::new(),
            allowed_email_domains: vec![],
            jwt_secret: "change-me".into(),
            jwt_expire_minutes: 60 * 24,
            web_refresh_token_ttl_days: 14,
            data_dir: PathBuf::from("data"),
            cors_origins: vec!["http://localhost:5174".into()],
            public_url: "http://localhost:8000".into(),
            app_url: "http://localhost:5174".into(),
            mcp_access_token_ttl_sec: 3600,
            mcp_refresh_token_ttl_days: 30,
            oauth_allow_private_cimd: false,
            oauth_dcr_max_clients: 500,
            oauth_dcr_rate_limit_per_min: 30,
            kordoc_node: "node".into(),
            kordoc_cli: PathBuf::from("tools/kordoc/node_modules/kordoc/dist/cli.js"),
            kordoc_timeout_sec: 120,
            pandoc_bin: "pandoc".into(),
            smtp_host: String::new(),
            smtp_port: 587,
            smtp_user: String::new(),
            smtp_password: String::new(),
            smtp_from: String::new(),
            smtp_use_tls: true,
            host: "127.0.0.1".into(),
            port: 8000,
        }
    }
}

fn parse_str_list(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    if trimmed.starts_with('[') {
        if let Ok(v) = serde_json::from_str::<Vec<String>>(trimmed) {
            return v;
        }
    }
    trimmed
        .split(',')
        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn parse_bool(raw: &str, default: bool) -> bool {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => default,
    }
}

impl Settings {
    pub fn from_env() -> Self {
        let _ = dotenvy::dotenv();
        let mut s = Self::default();
        if let Ok(v) = env::var("APP_NAME") {
            s.app_name = v;
        }
        if let Ok(v) = env::var("GOOGLE_CLIENT_ID") {
            s.google_client_id = v;
        }
        if let Ok(v) = env::var("ALLOWED_EMAIL_DOMAINS") {
            s.allowed_email_domains = parse_str_list(&v);
        }
        if let Ok(v) = env::var("JWT_SECRET") {
            s.jwt_secret = v;
        }
        if let Ok(v) = env::var("JWT_EXPIRE_MINUTES") {
            if let Ok(n) = v.parse() {
                s.jwt_expire_minutes = n;
            }
        }
        if let Ok(v) = env::var("WEB_REFRESH_TOKEN_TTL_DAYS") {
            if let Ok(n) = v.parse() {
                s.web_refresh_token_ttl_days = n;
            }
        }
        if let Ok(v) = env::var("DATA_DIR") {
            s.data_dir = PathBuf::from(v);
        }
        if let Ok(v) = env::var("CORS_ORIGINS") {
            s.cors_origins = parse_str_list(&v);
        }
        if let Ok(v) = env::var("PUBLIC_URL") {
            s.public_url = v;
        }
        if let Ok(v) = env::var("APP_URL") {
            s.app_url = v;
        }
        if let Ok(v) = env::var("MCP_ACCESS_TOKEN_TTL_SEC") {
            if let Ok(n) = v.parse() {
                s.mcp_access_token_ttl_sec = n;
            }
        }
        if let Ok(v) = env::var("MCP_REFRESH_TOKEN_TTL_DAYS") {
            if let Ok(n) = v.parse() {
                s.mcp_refresh_token_ttl_days = n;
            }
        }
        if let Ok(v) = env::var("OAUTH_ALLOW_PRIVATE_CIMD") {
            s.oauth_allow_private_cimd = parse_bool(&v, false);
        }
        if let Ok(v) = env::var("OAUTH_DCR_MAX_CLIENTS") {
            if let Ok(n) = v.parse() {
                s.oauth_dcr_max_clients = n;
            }
        }
        if let Ok(v) = env::var("OAUTH_DCR_RATE_LIMIT_PER_MIN") {
            if let Ok(n) = v.parse() {
                s.oauth_dcr_rate_limit_per_min = n;
            }
        }
        if let Ok(v) = env::var("KORDOC_NODE") {
            s.kordoc_node = v;
        }
        if let Ok(v) = env::var("KORDOC_CLI") {
            s.kordoc_cli = PathBuf::from(v);
        }
        if let Ok(v) = env::var("KORDOC_TIMEOUT_SEC") {
            if let Ok(n) = v.parse() {
                s.kordoc_timeout_sec = n;
            }
        }
        if let Ok(v) = env::var("PANDOC_BIN") {
            s.pandoc_bin = v;
        }
        if let Ok(v) = env::var("SMTP_HOST") {
            s.smtp_host = v;
        }
        if let Ok(v) = env::var("SMTP_PORT") {
            if let Ok(n) = v.parse() {
                s.smtp_port = n;
            }
        }
        if let Ok(v) = env::var("SMTP_USER") {
            s.smtp_user = v;
        }
        if let Ok(v) = env::var("SMTP_PASSWORD") {
            s.smtp_password = v;
        }
        if let Ok(v) = env::var("SMTP_FROM") {
            s.smtp_from = v;
        }
        if let Ok(v) = env::var("SMTP_USE_TLS") {
            s.smtp_use_tls = parse_bool(&v, true);
        }
        if let Ok(v) = env::var("HOST") {
            s.host = v;
        }
        if let Ok(v) = env::var("PORT") {
            if let Ok(n) = v.parse() {
                s.port = n;
            }
        }
        s
    }

    pub fn base_url(&self) -> String {
        self.public_url.trim_end_matches('/').to_string()
    }

    pub fn issuer(&self) -> String {
        format!("{}/", self.base_url())
    }

    pub fn resource_url(&self) -> String {
        format!("{}/mcp", self.base_url())
    }
}
