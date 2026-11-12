mod config;
mod payments;
mod rate_limit;
mod security;
mod uploads;

use axum::{
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use config::Settings;
use rate_limit::RateLimiter;
use serde::Deserialize;
use serde_json::json;
use std::{net::SocketAddr, sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Settings>,
    pub http: reqwest::Client,
    pub limiter: RateLimiter,
}

#[derive(Deserialize)]
struct InspectText {
    text: String,
}

#[derive(Deserialize)]
struct ValidateUrl {
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitRequest {
    key: String,
    limit: u32,
    window_ms: u64,
}

async fn request_guard(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let request_id = Uuid::new_v4().to_string();
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(address)| *address);
    let ip = if state.settings.trust_proxy_headers {
        request
            .headers()
            .get("x-vercel-forwarded-for")
            .or_else(|| request.headers().get("cf-connecting-ip"))
            .or_else(|| request.headers().get("x-real-ip"))
            .and_then(|value| value.to_str().ok())
            .map(|value| value.split(',').next().unwrap_or("").trim().to_owned())
            .filter(|value| !value.is_empty())
            .or_else(|| peer.map(|address| address.ip().to_string()))
    } else {
        peer.map(|address| address.ip().to_string())
    }
    .unwrap_or_else(|| "unknown".to_owned());

    let path = request.uri().path().to_owned();
    let is_options = request.method() == Method::OPTIONS;
    if path != "/health/live"
        && path != "/health/ready"
        && path != "/internal/rate-limit"
        && !is_options
    {
        let (route_limit, route_key) = if path == "/v1/uploads" {
            (30, "upload")
        } else if path == "/v1/payments/verify" {
            (20, "payment-verify")
        } else if path.starts_with("/v1/security/") {
            (45, "security")
        } else {
            (100, "api")
        };

        for (key, limit) in [
            (format!("global:{ip}"), 180),
            (format!("{route_key}:{ip}"), route_limit),
        ] {
            match state
                .limiter
                .check(&key, limit, Duration::from_secs(60))
                .await
            {
                Ok(decision) if decision.allowed => {}
                Ok(decision) => {
                    let retry =
                        HeaderValue::from_str(&decision.retry_after_secs.max(1).to_string())
                            .unwrap_or_else(|_| HeaderValue::from_static("1"));
                    let mut response = (
                        StatusCode::TOO_MANY_REQUESTS,
                        Json(json!({
                            "success": false,
                            "error": "Too many requests. Please retry shortly.",
                            "retryAfter": decision.retry_after_secs,
                            "requestId": request_id
                        })),
                    )
                        .into_response();
                    response.headers_mut().insert("retry-after", retry);
                    add_security_headers(&mut response, &request_id);
                    return response;
                }
                Err(_) => {
                    let mut response = (
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(json!({
                            "success": false,
                            "error": "Request protection is temporarily unavailable.",
                            "requestId": request_id
                        })),
                    )
                        .into_response();
                    add_security_headers(&mut response, &request_id);
                    return response;
                }
            }
        }
    }

    let mut response = next.run(request).await;
    add_security_headers(&mut response, &request_id);
    response
}

fn add_security_headers(response: &mut Response, request_id: &str) {
    let headers = response.headers_mut();
    headers.insert(
        "x-request-id",
        request_id
            .parse()
            .unwrap_or_else(|_| HeaderValue::from_static("unknown")),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert(
        "referrer-policy",
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-site"),
    );
}

async fn live() -> impl IntoResponse {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    Json(json!({ "status": "ok", "service": "goodsale-rust-api", "timestampUnix": timestamp }))
}

async fn ready(State(state): State<AppState>) -> Response {
    let supabase_ready = state.settings.supabase_configured();
    let limiter_ready = state.limiter.is_distributed() || !state.settings.rate_limit_required;
    let ready = supabase_ready && limiter_ready;
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({
            "status": if ready { "ready" } else { "degraded" },
            "service": "goodsale-rust-api",
            "integrations": {
                "supabase": supabase_ready,
                "distributedRateLimit": state.limiter.is_distributed()
            }
        })),
    )
        .into_response()
}

async fn inspect_text(Json(body): Json<InspectText>) -> Response {
    match security::normalize_plain_text(&body.text, 10_000) {
        Ok(text) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "text": text,
                "containsMarkup": text.contains('<') && text.contains('>'),
                "rendering": "plain-text-only"
            })),
        )
            .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": error.0 })),
        )
            .into_response(),
    }
}

async fn validate_url(Json(body): Json<ValidateUrl>) -> Response {
    match security::validate_external_url(&body.url) {
        Ok(url) => (StatusCode::OK, Json(json!({ "success": true, "url": url }))).into_response(),
        Err(message) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": message })),
        )
            .into_response(),
    }
}

async fn internal_rate_limit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<RateLimitRequest>,
) -> Response {
    let expected = std::env::var("RATE_LIMIT_SHARED_SECRET").unwrap_or_default();
    let supplied = headers
        .get("x-rate-limit-secret")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if expected.is_empty() || !bool::from(expected.as_bytes().ct_eq(supplied.as_bytes())) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "success": false, "error": "Internal authorization failed."
            })),
        )
            .into_response();
    }
    if input.key.is_empty()
        || input.key.len() > 256
        || input.limit == 0
        || input.limit > 5_000
        || input.window_ms < 1_000
        || input.window_ms > 600_000
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false, "error": "Rate-limit parameters are invalid."
            })),
        )
            .into_response();
    }

    match state
        .limiter
        .check(
            &format!("next:{}", input.key),
            input.limit,
            Duration::from_millis(input.window_ms),
        )
        .await
    {
        Ok(decision) => (
            StatusCode::OK,
            Json(json!({
                "allowed": decision.allowed,
                "remaining": decision.remaining,
                "retryAfterMs": decision.retry_after_secs * 1000
            })),
        )
            .into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "success": false, "error": "Distributed rate limiting is unavailable."
            })),
        )
            .into_response(),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let settings = Settings::from_env();
    let redis_url = std::env::var("REDIS_URL")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let limiter = RateLimiter::connect(redis_url, settings.rate_limit_required)
        .await
        .map_err(std::io::Error::other)?;
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .user_agent("GoodSale-Rust-API/0.1")
        .build()?;
    let state = AppState {
        settings: Arc::new(settings.clone()),
        http,
        limiter,
    };

    let allowed_origins = settings
        .allowed_origins
        .iter()
        .filter_map(|origin| origin.parse::<HeaderValue>().ok())
        .collect::<Vec<HeaderValue>>();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(allowed_origins))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::ACCEPT,
            "x-request-id".parse()?,
        ])
        .expose_headers(["retry-after".parse()?, "x-request-id".parse()?])
        .allow_credentials(true)
        .max_age(Duration::from_secs(600));

    let app = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route(
            "/internal/rate-limit",
            post(internal_rate_limit).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route("/v1/security/inspect-text", post(inspect_text))
        .route("/v1/security/validate-url", post(validate_url))
        .route(
            "/v1/payments/verify",
            post(payments::verify).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/v1/uploads",
            post(uploads::upload).layer(DefaultBodyLimit::max(27 * 1024 * 1024)),
        )
        .with_state(state.clone())
        .layer(cors)
        .layer(middleware::from_fn_with_state(state, request_guard));

    let address = format!("{}:{}", settings.host, settings.port);
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(address = %address, "GoodSale Rust API started");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
