use crate::AppState;
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

const USER_RPCS: &[&str] = &[
    "complete_delivery_job_with_pin",
    "delivery_assign_rider",
    "delivery_cancel",
    "delivery_confirm_with_code",
    "delivery_generate_confirmation_code",
    "delivery_initiate_return",
    "delivery_report_failure",
    "delivery_set_courier",
    "delivery_set_instructions",
    "delivery_set_route",
    "delivery_seller_action",
    "delivery_tracking_view",
    "delivery_transition",
    "evaluate_my_referral",
    "generate_referral_code",
    "mark_order_paid_by_reference",
    "open_dispute",
    "pay_order_with_wallet",
    "premium_credit_balance",
    "rider_accept_delivery",
    "rider_apply",
    "rider_available_deliveries",
    "rider_contact_seller",
    "rider_mark_arrival",
    "rider_record_failed_attempt",
    "rider_reject_delivery",
    "rider_set_location_sharing",
    "rider_update_availability",
    "rider_update_location",
    "release_escrow_with_pin",
    "request_withdrawal",
    "seller_public_verification",
    "set_own_role",
    "update_order_status",
    "purchase_sponsored_campaign_v2",
    "record_sponsored_ad_event_v2",
    "purchase_featured_promotion",
    "purchase_flash_sale",
];
const ADMIN_RPCS: &[&str] = &[
    "admin_auto_assign_delivery",
    "admin_delivery_analytics",
    "admin_force_escrow",
    "admin_manual_courier_update",
    "admin_payout_begin",
    "admin_payout_complete",
    "admin_payout_fail",
    "admin_payout_processing",
    "admin_record_courier_shipment",
    "courier_apply_tracking_event",
    "admin_resolve_delivery_failure",
    "admin_review_rider",
    "admin_review_sponsored_campaign",
    "admin_review_flash_sale",
    "admin_set_delivery_settings",
    "admin_set_rider_service_areas",
    "admin_set_rider_commission",
    "admin_set_rider_earning_status",
    "admin_adjust_rider_earning",
    "admin_update_delivery_return",
    "admin_verification_action",
    "admin_referral_analytics",
    "admin_disqualify_referral",
    "admin_mark_referral_reviewed",
    "issue_premium_credits",
    "mark_refund_completed",
    "referral_evaluate",
    "run_premium_jobs",
    "expire_rider_assignments",
    "resolve_dispute",
];
const PUBLIC_RPCS: &[&str] = &["seller_public_verification", "shipment_tracking_lookup"];
const INTERNAL_RPCS: &[&str] = &[
    "courier_apply_tracking_event",
    "admin_payout_complete",
    "admin_payout_fail",
    "mark_refund_completed",
    "attribute_referral",
    "admin_record_courier_shipment",
    "wallet_funding_event",
    "premium_activation_event",
    "order_payment_event",
];
const INTERNAL_JOBS: &[&str] = &[
    "run_delivery_jobs",
    "run_premium_jobs",
    "expire_unpaid_order_reservations",
];

fn fail(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"success":false,"error":message}))).into_response()
}
fn bearer(h: &HeaderMap) -> Option<&str> {
    h.get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .filter(|v| !v.is_empty())
}
fn shared_secret(h: &HeaderMap, name: &str) -> bool {
    let expected = std::env::var(name).unwrap_or_default();
    let supplied = h
        .get("x-internal-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    !expected.is_empty() && bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
}

async fn auth_user(s: &AppState, token: &str) -> Result<String, StatusCode> {
    let base = s
        .settings
        .supabase_url
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let anon = s
        .settings
        .supabase_anon_key
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let r = s
        .http
        .get(format!("{}/auth/v1/user", base.trim_end_matches('/')))
        .header("apikey", anon)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    if !r.status().is_success() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let v: Value = r.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    v.get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(StatusCode::UNAUTHORIZED)
}
async fn user_role(s: &AppState, id: &str) -> Result<String, StatusCode> {
    let base = s
        .settings
        .supabase_url
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let key = s
        .settings
        .supabase_service_role_key
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let r = s
        .http
        .get(format!("{}/rest/v1/profiles", base.trim_end_matches('/')))
        .header("apikey", key)
        .bearer_auth(key)
        .query(&[
            ("select", "role"),
            ("auth_id", format!("eq.{id}").as_str()),
            ("limit", "1"),
        ])
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    if !r.status().is_success() {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let rows: Vec<Value> = r.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(rows
        .first()
        .and_then(|x| x.get("role"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned())
}
async fn invoke(
    s: &AppState,
    name: &str,
    args: &Value,
    key: &str,
    token: Option<&str>,
) -> Result<Response, StatusCode> {
    let base = s
        .settings
        .supabase_url
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let mut q = s
        .http
        .post(format!("{}/rest/v1/rpc/{name}", base.trim_end_matches('/')))
        .header("apikey", key)
        .header(header::CONTENT_TYPE, "application/json")
        .json(args);
    if let Some(t) = token {
        q = q.bearer_auth(t)
    }
    let r = q.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = r.status();
    let ty = r.headers().get(header::CONTENT_TYPE).cloned();
    let bytes = r.bytes().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let mut b = Response::builder().status(status);
    if let Some(v) = ty {
        b = b.header(header::CONTENT_TYPE, v)
    }
    Ok(b.body(axum::body::Body::from(bytes)).unwrap_or_else(|_| {
        fail(
            StatusCode::BAD_GATEWAY,
            "Could not return database response.",
        )
    }))
}
async fn admin_auth(s: &AppState, token: &str, name: &str) -> Result<(), StatusCode> {
    let id = auth_user(s, token).await?;
    let role = user_role(s, &id).await?;
    if matches!(role.as_str(), "ADMIN" | "SUPER_ADMIN")
        || (name == "admin_verification_action" && role == "MODERATOR")
    {
        Ok(())
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}
pub async fn user_rpc(
    State(s): State<AppState>,
    Path(name): Path<String>,
    h: HeaderMap,
    Json(args): Json<Value>,
) -> Response {
    if !USER_RPCS.contains(&name.as_str()) {
        return fail(StatusCode::NOT_FOUND, "Operation not available.");
    }
    if !args.is_object() && !args.is_null() {
        return fail(StatusCode::BAD_REQUEST, "RPC args must be an object.");
    }
    let Some(token) = bearer(&h) else {
        return fail(StatusCode::UNAUTHORIZED, "Sign in to continue.");
    };
    if let Err(code) = auth_user(&s, token).await {
        return fail(code, "Session could not be verified.");
    }
    let Some(key) = s.settings.supabase_anon_key.as_ref() else {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Database is not configured.",
        );
    };
    match invoke(&s, &name, &args, key, Some(token)).await {
        Ok(v) => v,
        Err(code) => fail(code, "Database operation failed."),
    }
}
pub async fn admin_rpc(
    State(s): State<AppState>,
    Path(name): Path<String>,
    h: HeaderMap,
    Json(args): Json<Value>,
) -> Response {
    if !ADMIN_RPCS.contains(&name.as_str()) {
        return fail(StatusCode::NOT_FOUND, "Admin operation not available.");
    }
    if !args.is_object() && !args.is_null() {
        return fail(StatusCode::BAD_REQUEST, "RPC args must be an object.");
    }
    let Some(token) = bearer(&h) else {
        return fail(StatusCode::UNAUTHORIZED, "Sign in to continue.");
    };
    if let Err(code) = admin_auth(&s, token, &name).await {
        return fail(code, "Administrator permission is required.");
    }
    let Some(key) = s.settings.supabase_service_role_key.as_ref() else {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Admin database access is not configured.",
        );
    };
    match invoke(&s, &name, &args, key, Some(key)).await {
        Ok(v) => v,
        Err(code) => fail(code, "Admin operation failed."),
    }
}
pub async fn public_rpc(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Json(args): Json<Value>,
) -> Response {
    if !PUBLIC_RPCS.contains(&name.as_str()) || (!args.is_object() && !args.is_null()) {
        return fail(StatusCode::NOT_FOUND, "Public operation not available.");
    }
    let Some(key) = s.settings.supabase_anon_key.as_ref() else {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Database is not configured.",
        );
    };
    match invoke(&s, &name, &args, key, None).await {
        Ok(v) => v,
        Err(code) => fail(code, "Public lookup failed."),
    }
}
pub async fn internal_rpc(
    State(s): State<AppState>,
    Path(name): Path<String>,
    h: HeaderMap,
    Json(args): Json<Value>,
) -> Response {
    if !INTERNAL_RPCS.contains(&name.as_str()) {
        return fail(StatusCode::NOT_FOUND, "Internal operation not available.");
    }
    if !shared_secret(&h, "RUST_INTERNAL_SECRET") {
        return fail(StatusCode::UNAUTHORIZED, "Internal authorization failed.");
    }
    if !args.is_object() && !args.is_null() {
        return fail(StatusCode::BAD_REQUEST, "RPC args must be an object.");
    }
    if [
        "wallet_funding_event",
        "premium_activation_event",
        "order_payment_event",
    ]
    .contains(&name.as_str())
    {
        let reference = args
            .get("reference")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if reference.len() < 8
            || reference.len() > 128
            || !reference
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return fail(
                StatusCode::BAD_REQUEST,
                "A valid payment reference is required.",
            );
        }
        let result = match name.as_str() {
            "wallet_funding_event" => {
                crate::wallet_premium::verify_wallet_event(&s, reference).await
            }
            "premium_activation_event" => {
                crate::wallet_premium::verify_premium_event(&s, reference).await
            }
            _ => crate::payments::verify_event(&s, reference).await,
        };
        return match result {
            Ok(data) => (
                StatusCode::OK,
                Json(json!({ "success": true, "data": data })),
            )
                .into_response(),
            Err(code) => fail(code, "Provider payment verification failed."),
        };
    }
    let Some(key) = s.settings.supabase_service_role_key.as_ref() else {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Service role is not configured.",
        );
    };
    match invoke(&s, &name, &args, key, Some(key)).await {
        Ok(v) => v,
        Err(code) => fail(code, "Internal operation failed."),
    }
}
pub async fn internal_job(
    State(s): State<AppState>,
    Path(name): Path<String>,
    h: HeaderMap,
) -> Response {
    if !INTERNAL_JOBS.contains(&name.as_str()) {
        return fail(StatusCode::NOT_FOUND, "Scheduled task not available.");
    }
    let key_name = if name == "run_premium_jobs" || name == "expire_unpaid_order_reservations" {
        "PREMIUM_CRON_SECRET"
    } else {
        "DELIVERY_CRON_SECRET"
    };
    let expected = std::env::var(key_name)
        .or_else(|_| std::env::var("DELIVERY_CRON_SECRET"))
        .unwrap_or_default();
    let supplied = h
        .get("x-cron-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if expected.is_empty() || !bool::from(expected.as_bytes().ct_eq(supplied.as_bytes())) {
        return fail(
            StatusCode::UNAUTHORIZED,
            "Scheduled task authorization failed.",
        );
    }
    let Some(key) = s.settings.supabase_service_role_key.as_ref() else {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Service role is not configured.",
        );
    };
    match invoke(&s, &name, &json!({}), key, Some(key)).await {
        Ok(v) => v,
        Err(code) => fail(code, "Scheduled task failed."),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn route_allowlists_are_closed() {
        assert!(USER_RPCS.contains(&"rider_apply"));
        assert!(ADMIN_RPCS.contains(&"mark_refund_completed"));
        assert!(PUBLIC_RPCS.contains(&"shipment_tracking_lookup"));
        assert!(!USER_RPCS.contains(&"delete_everything"));
    }
}
