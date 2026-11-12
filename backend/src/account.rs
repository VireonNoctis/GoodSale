use crate::{security, AppState};
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Map, Value};

const SETTINGS_KEY: &str = "goodsale_settings";
const ALLOWED_SETTINGS: &[&str] = &[
    "twoFactorEnabled", "biometricsEnabled", "profileVisibility", "hidePhone", "hideEmail",
    "onlineStatus", "readReceipts", "whoCanMessage", "blockedUsers", "mutedUsers",
    "savedAddresses", "defaultPayment", "savedSearches", "vacationMode", "vacationAutoReply",
    "inventoryAlertThreshold", "defaultCategory", "defaultDeliveryMethod", "businessHours",
    "staffList", "preferredCourier", "safeMeetPreSel", "pickupAddress", "supportTickets",
    "redeemedVouchers",
];

fn fail(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "success": false, "error": message }))).into_response()
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION)?.to_str().ok()?
        .strip_prefix("Bearer ").filter(|value| !value.is_empty())
}

async fn auth_user(state: &AppState, token: &str) -> Result<(String, Value), StatusCode> {
    let base = state.settings.supabase_url.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let anon = state.settings.supabase_anon_key.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let response = state.http.get(format!("{}/auth/v1/user", base.trim_end_matches('/')))
        .header("apikey", anon).bearer_auth(token).send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    if !response.status().is_success() { return Err(StatusCode::UNAUTHORIZED); }
    let user: Value = response.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let auth_id = user.get("id").and_then(Value::as_str).ok_or(StatusCode::UNAUTHORIZED)?;
    Ok((auth_id.to_owned(), user))
}

async fn profile_id(state: &AppState, auth_id: &str) -> Result<i64, StatusCode> {
    let base = state.settings.supabase_url.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let key = state.settings.supabase_service_role_key.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let response = state.http.get(format!("{}/rest/v1/profiles", base.trim_end_matches('/')))
        .header("apikey", key).bearer_auth(key)
        .query(&[
            ("select", "id"),
            ("auth_id", format!("eq.{auth_id}").as_str()),
            ("limit", "1"),
        ])
        .send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    if !response.status().is_success() { return Err(StatusCode::BAD_GATEWAY); }
    let rows: Vec<Value> = response.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    rows.first().and_then(|row| row.get("id")).and_then(Value::as_i64).ok_or(StatusCode::NOT_FOUND)
}

fn add_text_patch(
    input: &Value,
    source_key: &str,
    target_key: &str,
    max_chars: usize,
    output: &mut Map<String, Value>,
) -> Result<(), StatusCode> {
    if let Some(value) = input.get(source_key) {
        let raw = value.as_str().ok_or(StatusCode::BAD_REQUEST)?;
        let clean = security::normalize_plain_text(raw, max_chars).map_err(|_| StatusCode::BAD_REQUEST)?;
        output.insert(target_key.to_owned(), json!(clean));
    }
    Ok(())
}

fn add_url_patch(
    input: &Value,
    source_key: &str,
    target_key: &str,
    output: &mut Map<String, Value>,
) -> Result<(), StatusCode> {
    if let Some(value) = input.get(source_key) {
        let raw = value.as_str().ok_or(StatusCode::BAD_REQUEST)?;
        if raw.trim().is_empty() {
            output.insert(target_key.to_owned(), json!(""));
        } else {
            let url = security::validate_external_url(raw).map_err(|_| StatusCode::BAD_REQUEST)?;
            output.insert(target_key.to_owned(), json!(url));
        }
    }
    Ok(())
}

async fn patch_postgrest(
    state: &AppState,
    table: &str,
    filter_key: &str,
    filter_value: &str,
    patch: &Value,
) -> Result<(), StatusCode> {
    let base = state.settings.supabase_url.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let key = state.settings.supabase_service_role_key.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let response = state.http.patch(format!("{}/rest/v1/{table}", base.trim_end_matches('/')))
        .header("apikey", key).bearer_auth(key)
        .header("Prefer", "return=minimal")
        .query(&[(filter_key, filter_value)])
        .json(patch)
        .send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    if response.status().is_success() { Ok(()) } else {
        tracing::warn!(table, status=%response.status(), "Account profile update rejected");
        Err(StatusCode::BAD_REQUEST)
    }
}

pub async fn update_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(token) = bearer(&headers) else { return fail(StatusCode::UNAUTHORIZED, "Sign in to continue."); };
    let (auth_id, user) = match auth_user(&state, token).await {
        Ok(value) => value,
        Err(code) => return fail(code, "Your session could not be verified."),
    };
    let Some(service_key) = state.settings.supabase_service_role_key.as_ref() else {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "Account service is not configured.");
    };
    let profile = body.get("profile").cloned().unwrap_or_else(|| json!({}));
    let business = body.get("business").cloned().unwrap_or_else(|| json!({}));
    if !profile.is_object() || !business.is_object() {
        return fail(StatusCode::BAD_REQUEST, "Profile and business values must be objects.");
    }

    let mut profile_patch = Map::new();
    for (source, target, max) in [
        ("fullName", "full_name", 120usize),
        ("phoneNumber", "phone_number", 30),
        ("bio", "bio", 500),
        ("address", "address", 240),
        ("city", "city", 80),
        ("state", "state", 80),
    ] {
        if let Err(code) = add_text_patch(&profile, source, target, max, &mut profile_patch) {
            return fail(code, "A profile field contains invalid text.");
        }
    }
    for (source, target) in [("photoUrl", "photo_url"), ("coverUrl", "cover_url")] {
        if let Err(code) = add_url_patch(&profile, source, target, &mut profile_patch) {
            return fail(code, "A profile image URL is invalid.");
        }
    }
    if !profile_patch.is_empty() {
        if let Err(code) = patch_postgrest(
            &state, "profiles", "auth_id", &format!("eq.{auth_id}"), &Value::Object(profile_patch)
        ).await {
            return fail(code, "Could not update your profile.");
        }
    }

    if let Some(email_value) = profile.get("email") {
        let next_email = match email_value.as_str() {
            Some(value) => value.trim(),
            None => return fail(StatusCode::BAD_REQUEST, "Email address is invalid."),
        };
        if !next_email.is_empty()
            && next_email.len() <= 254
            && next_email.contains('@')
            && next_email != user.get("email").and_then(Value::as_str).unwrap_or_default()
        {
            let response = state.http.put(format!("{}/auth/v1/admin/users/{auth_id}", state.settings.supabase_url.as_ref().unwrap().trim_end_matches('/')))
                .header("apikey", service_key).bearer_auth(service_key)
                .json(&json!({ "email": next_email, "email_confirm": true }))
                .send().await.map_err(|_| ());
            match response {
                Ok(value) if value.status().is_success() => {}
                _ => return fail(StatusCode::BAD_REQUEST, "Could not update the account email."),
            }
        }
    }

    let business_has_fields = [
        "name", "description", "logoUrl", "bannerUrl", "openingHours",
    ].iter().any(|key| business.get(*key).is_some());
    if business_has_fields {
        let owner_id = match profile_id(&state, &auth_id).await {
            Ok(id) => id,
            Err(code) => return fail(code, "Your seller profile could not be found."),
        };
        let mut business_patch = Map::new();
        for (source, target, max) in [
            ("name", "name", 120usize),
            ("description", "description", 1000),
            ("openingHours", "opening_hours", 500),
        ] {
            if let Err(code) = add_text_patch(&business, source, target, max, &mut business_patch) {
                return fail(code, "A business field contains invalid text.");
            }
        }
        for (source, target) in [("logoUrl", "logo_url"), ("bannerUrl", "banner_url")] {
            if let Err(code) = add_url_patch(&business, source, target, &mut business_patch) {
                return fail(code, "A business image URL is invalid.");
            }
        }
        if !business_patch.is_empty() {
            if let Err(code) = patch_postgrest(
                &state, "businesses", "owner_id", &format!("eq.{owner_id}"), &Value::Object(business_patch)
            ).await {
                return fail(code, "Could not update your business profile.");
            }
        }
    }

    Response::builder().status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(json!({ "success": true }).to_string()))
        .unwrap_or_else(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "Could not return account result."))
}

pub async fn delete_account(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(token) = bearer(&headers) else { return fail(StatusCode::UNAUTHORIZED, "Sign in to continue."); };
    let (auth_id, _) = match auth_user(&state, token).await {
        Ok(value) => value,
        Err(code) => return fail(code, "Your session could not be verified."),
    };
    let Some(key) = state.settings.supabase_service_role_key.as_ref() else {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "Account deletion is not configured.");
    };
    let base = state.settings.supabase_url.as_ref().unwrap().trim_end_matches('/');
    let response = match state.http.delete(format!("{base}/auth/v1/admin/users/{auth_id}"))
        .header("apikey", key).bearer_auth(key).send().await {
            Ok(value) => value,
            Err(_) => return fail(StatusCode::BAD_GATEWAY, "Account deletion service could not be reached."),
        };
    if response.status().is_success() {
        (StatusCode::OK, Json(json!({ "success": true }))).into_response()
    } else {
        tracing::error!(status=%response.status(), "Supabase Auth account deletion failed");
        fail(StatusCode::BAD_GATEWAY, "Your account could not be deleted.")
    }
}

pub async fn get_settings(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(token) = bearer(&headers) else { return fail(StatusCode::UNAUTHORIZED, "Sign in to continue."); };
    let user = match auth_user(&state, token).await {
        Ok((_, user)) => user,
        Err(code) => return fail(code, "Your session could not be verified."),
    };
    let settings = user.get("user_metadata").and_then(|v| v.get(SETTINGS_KEY)).cloned().unwrap_or_else(|| json!({}));
    (StatusCode::OK, Json(json!({ "success": true, "settings": settings }))).into_response()
}

pub async fn patch_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(token) = bearer(&headers) else { return fail(StatusCode::UNAUTHORIZED, "Sign in to continue."); };
    let (auth_id, user) = match auth_user(&state, token).await {
        Ok(value) => value,
        Err(code) => return fail(code, "Your session could not be verified."),
    };
    let anon = match state.settings.supabase_anon_key.as_ref() {
        Some(value) => value,
        None => return fail(StatusCode::SERVICE_UNAVAILABLE, "Account settings are not configured."),
    };
    let patch = body.as_object().cloned().unwrap_or_default();
    let current = user.get("user_metadata").and_then(|v| v.get(SETTINGS_KEY))
        .and_then(Value::as_object).cloned().unwrap_or_default();
    let mut merged = current;
    for key in ALLOWED_SETTINGS {
        if let Some(value) = patch.get(*key) {
            merged.insert((*key).to_owned(), value.clone());
        }
    }
    let base = state.settings.supabase_url.as_ref().unwrap().trim_end_matches('/');
    let mut user_data = Map::new();
    user_data.insert(SETTINGS_KEY.to_owned(), Value::Object(merged.clone()));
    let response = match state.http.put(format!("{base}/auth/v1/user"))
        .header("apikey", anon).bearer_auth(token)
        .json(&json!({ "data": Value::Object(user_data) }))
        .send().await {
            Ok(value) => value,
            Err(_) => return fail(StatusCode::BAD_GATEWAY, "Account settings could not be saved."),
        };
    if !response.status().is_success() {
        return fail(StatusCode::BAD_REQUEST, "Account settings could not be saved.");
    }
    let _ = auth_id;
    (StatusCode::OK, Json(json!({ "success": true, "settings": merged }))).into_response()
}
