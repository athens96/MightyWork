use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use chrono::Utc;
use hmac::{Hmac, Mac};
use jsonwebtoken::{decode, decode_header, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::config::Settings;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleIdentity {
    pub sub: String,
    pub email: String,
    pub email_verified: bool,
    pub name: String,
    pub picture: Option<String>,
}

pub type GoogleVerifierFn =
    Arc<dyn Fn(&str, &str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<GoogleIdentity, String>> + Send>> + Send + Sync>;

#[derive(Debug, Serialize, Deserialize)]
struct AccessClaims {
    sub: String,
    iat: i64,
    exp: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct RefreshClaims {
    sub: String,
    typ: String,
    iat: i64,
    exp: i64,
}

fn refresh_key(settings: &Settings) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(settings.jwt_secret.as_bytes()).expect("hmac key");
    mac.update(b"mightywork/web-refresh-token/v1");
    mac.finalize().into_bytes().to_vec()
}

pub fn create_access_token(user_id: &str, settings: &Settings) -> Result<String, String> {
    let now = Utc::now().timestamp();
    let claims = AccessClaims {
        sub: user_id.to_string(),
        iat: now,
        exp: now + settings.jwt_expire_minutes * 60,
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(settings.jwt_secret.as_bytes()),
    )
    .map_err(|e| e.to_string())
}

pub fn decode_access_token(token: &str, settings: &Settings) -> Result<String, String> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;
    let data = decode::<AccessClaims>(
        token,
        &DecodingKey::from_secret(settings.jwt_secret.as_bytes()),
        &validation,
    )
    .map_err(|e| e.to_string())?;
    Ok(data.claims.sub)
}

pub fn create_refresh_token(user_id: &str, settings: &Settings) -> Result<String, String> {
    let now = Utc::now().timestamp();
    let key = refresh_key(settings);
    let claims = RefreshClaims {
        sub: user_id.to_string(),
        typ: "web_refresh".into(),
        iat: now,
        exp: now + settings.web_refresh_token_ttl_days * 86_400,
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(&key),
    )
    .map_err(|e| e.to_string())
}

pub fn decode_refresh_token(token: &str, settings: &Settings) -> Result<String, String> {
    let key = refresh_key(settings);
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;
    let data = decode::<RefreshClaims>(token, &DecodingKey::from_secret(&key), &validation)
        .map_err(|e| e.to_string())?;
    if data.claims.typ != "web_refresh" {
        return Err("invalid token type".into());
    }
    Ok(data.claims.sub)
}

// ---------------------------------------------------------------- Google OAuth2 ID Token JWKS Verifier

#[derive(Debug, Deserialize)]
struct JwksResponse {
    keys: Vec<JwkKey>,
}

#[derive(Debug, Clone, Deserialize)]
struct JwkKey {
    kid: String,
    n: String,
    e: String,
}

#[derive(Debug, Deserialize)]
struct GoogleIdClaims {
    sub: String,
    email: String,
    #[serde(default)]
    email_verified: bool,
    #[serde(default)]
    name: String,
    #[serde(default)]
    picture: Option<String>,
    iss: String,
    aud: serde_json::Value,
    #[allow(dead_code)]
    exp: i64,
}

struct JwksCache {
    keys: HashMap<String, JwkKey>,
    fetched_at: Instant,
}

pub fn default_google_verifier() -> GoogleVerifierFn {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("reqwest client");
    let cache: Arc<RwLock<Option<JwksCache>>> = Arc::new(RwLock::new(None));

    Arc::new(move |credential: &str, client_id: &str| {
        let credential = credential.to_string();
        let client_id = client_id.to_string();
        let client = client.clone();
        let cache = cache.clone();
        Box::pin(async move {
            if client_id.is_empty() {
                return Err("GOOGLE_CLIENT_ID is not configured".into());
            }
            let header = decode_header(&credential).map_err(|e| e.to_string())?;
            let kid = header.kid.ok_or_else(|| "Missing kid in Google ID token".to_string())?;

            let mut jwk = {
                let guard = cache.read().unwrap();
                guard
                    .as_ref()
                    .filter(|c| c.fetched_at.elapsed() < Duration::from_secs(3600))
                    .and_then(|c| c.keys.get(&kid).cloned())
            };

            if jwk.is_none() {
                let resp = client
                    .get("https://www.googleapis.com/oauth2/v3/certs")
                    .send()
                    .await
                    .map_err(|e| format!("Failed to fetch Google JWKS: {e}"))?
                    .json::<JwksResponse>()
                    .await
                    .map_err(|e| format!("Invalid Google JWKS: {e}"))?;
                let map: HashMap<String, JwkKey> = resp.keys.into_iter().map(|k| (k.kid.clone(), k)).collect();
                jwk = map.get(&kid).cloned();
                let mut guard = cache.write().unwrap();
                *guard = Some(JwksCache {
                    keys: map,
                    fetched_at: Instant::now(),
                });
            }

            let key = jwk.ok_or_else(|| "Google signing key not found".to_string())?;
            let decoding_key = DecodingKey::from_rsa_components(&key.n, &key.e).map_err(|e| e.to_string())?;
            let mut validation = Validation::new(Algorithm::RS256);
            validation.validate_exp = true;
            validation.validate_aud = false; // checked explicitly below for string/array parity

            let token_data =
                decode::<GoogleIdClaims>(&credential, &decoding_key, &validation).map_err(|e| e.to_string())?;
            let claims = token_data.claims;

            if claims.iss != "accounts.google.com" && claims.iss != "https://accounts.google.com" {
                return Err("Invalid Google issuer".into());
            }
            let aud_ok = match &claims.aud {
                serde_json::Value::String(s) => s == &client_id,
                serde_json::Value::Array(arr) => arr.iter().any(|v| v.as_str() == Some(&client_id)),
                _ => false,
            };
            if !aud_ok {
                return Err("Invalid Google audience".into());
            }

            Ok(GoogleIdentity {
                sub: claims.sub,
                email: claims.email,
                email_verified: claims.email_verified,
                name: claims.name,
                picture: claims.picture,
            })
        })
    })
}
