use crate::AppState;
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[derive(Debug, Deserialize)]
pub struct VerifyRequest {
    reference: String,
    #[serde(rename = "orderId")]
    order_id: Option<i64>,
    #[serde(rename = "orderIds")]
    order_ids: Option<Vec<i64>>,
}

#[derive(Debug)]
struct OrderRow {
    id: i64,
    buyer_id: i64,
    total_amount: f64,
    status: String,
    payment_method: String,
    deposit_percent: Option<f64>,
    balance_remaining: Option<f64>,
}

impl OrderRow {
    fn payment_due(&self) -> f64 {
        if !self.payment_method.eq_ignore_ascii_case("PARTIAL") {
            return self.total_amount.max(0.0);
        }
        if self.status.eq_ignore_ascii_case("PARTIAL_DEPOSIT_PAID") {
            return self
                .balance_remaining
                .unwrap_or_else(|| {
                    let percent = self.deposit_percent.unwrap_or(30.0).clamp(1.0, 100.0);
                    (self.total_amount - (self.total_amount * percent / 100.0).round()).max(0.0)
                })
                .max(0.0);
        }
        let percent = self.deposit_percent.unwrap_or(30.0).clamp(1.0, 100.0);
        (self.total_amount * percent / 100.0).round().max(0.0)
    }

    fn terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            "DELIVERED_SUCCESS" | "REFUNDED" | "CANCELLED"
        )
    }
    fn paid(&self) -> bool {
        matches!(
            self.status.as_str(),
            "PAID_ESCROW" | "SHIPPED" | "OUT_FOR_DELIVERY" | "DISPUTED"
        )
    }
    fn payable(&self) -> bool {
        matches!(
            self.status.as_str(),
            "PENDING"
                | "PENDING_BANK_TRANSFER"
                | "PARTIAL_DEPOSIT_PAID"
                | "INVOICE_SENT"
                | "COD_PENDING"
        )
    }
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(|v| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
    })
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "success": false, "error": message }))).into_response()
}

fn order_id_from_reference(reference: &str) -> Option<i64> {
    let mut parts = reference.split('_');
    if !parts.next()?.eq_ignore_ascii_case("GS") {
        return None;
    }
    let id = parts.next()?.parse::<i64>().ok()?;
    if id > 0 {
        Some(id)
    } else {
        None
    }
}

async fn authenticated_profile_id(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<i64, StatusCode> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let base = state
        .settings
        .supabase_url
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let anon = state
        .settings
        .supabase_anon_key
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let response = state
        .http
        .get(format!("{}/auth/v1/user", base.trim_end_matches('/')))
        .header("apikey", anon)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    if !response.status().is_success() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let user: Value = response.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let auth_id = user
        .get("id")
        .and_then(Value::as_str)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let service = state
        .settings
        .supabase_service_role_key
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let profile_response = state
        .http
        .get(format!("{}/rest/v1/profiles", base.trim_end_matches('/')))
        .header("apikey", service)
        .bearer_auth(service)
        .query(&[
            ("select", "id"),
            ("auth_id", format!("eq.{auth_id}").as_str()),
            ("limit", "1"),
        ])
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    if !profile_response.status().is_success() {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let profiles: Vec<Value> = profile_response
        .json()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    profiles
        .first()
        .and_then(|profile| profile.get("id"))
        .and_then(Value::as_i64)
        .ok_or(StatusCode::FORBIDDEN)
}

async fn fetch_orders(state: &AppState, ids: &[i64]) -> Result<Vec<OrderRow>, ()> {
    let base = state.settings.supabase_url.as_ref().ok_or(())?;
    let key = state
        .settings
        .supabase_service_role_key
        .as_ref()
        .ok_or(())?;
    let id_filter = format!(
        "in.({})",
        ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
    );
    let response = state
        .http
        .get(format!("{}/rest/v1/orders", base.trim_end_matches('/')))
        .header("apikey", key)
        .bearer_auth(key)
        .query(&[
            (
                "select",
                "id,buyer_id,total_amount,status,payment_method,deposit_percent,balance_remaining",
            ),
            ("id", id_filter.as_str()),
        ])
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        tracing::error!(status = %response.status(), "Supabase order lookup failed during payment verification");
        return Err(());
    }
    let rows: Vec<Value> = response.json().await.map_err(|_| ())?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            Some(OrderRow {
                id: row.get("id")?.as_i64()?,
                buyer_id: row.get("buyer_id")?.as_i64()?,
                total_amount: number(row.get("total_amount"))?,
                status: row.get("status")?.as_str()?.to_owned(),
                payment_method: row
                    .get("payment_method")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                deposit_percent: number(row.get("deposit_percent")),
                balance_remaining: number(row.get("balance_remaining")),
            })
        })
        .collect())
}

async fn mark_order_paid(
    state: &AppState,
    order_id: i64,
    reference: &str,
    amount_kobo: Option<i64>,
    channel: &str,
) -> Result<Value, ()> {
    let base = state.settings.supabase_url.as_ref().ok_or(())?;
    let key = state
        .settings
        .supabase_service_role_key
        .as_ref()
        .ok_or(())?;
    let response = state
        .http
        .post(format!(
            "{}/rest/v1/rpc/mark_order_paid_by_reference",
            base.trim_end_matches('/')
        ))
        .header("apikey", key)
        .bearer_auth(key)
        .json(&json!({
            "p_order_id": order_id,
            "p_reference": reference,
            "p_amount_kobo": amount_kobo,
            "p_channel": if channel.is_empty() { "card" } else { channel }
        }))
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        tracing::warn!(order_id, status = %response.status(), "Order payment RPC rejected reconciliation");
        return Err(());
    }
    response.json().await.map_err(|_| ())
}

pub async fn verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<VerifyRequest>,
) -> Response {
    let profile_id = match authenticated_profile_id(&state, &headers).await {
        Ok(id) => id,
        Err(status) => return error(status, "Sign in with the account that placed this order."),
    };
    let reference = input.reference.trim().to_owned();
    if reference.len() < 3
        || reference.len() > 128
        || !reference
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return error(
            StatusCode::BAD_REQUEST,
            "A valid payment reference is required.",
        );
    }

    let secret = match std::env::var("PAYSTACK_SECRET_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        Some(secret) => secret,
        None => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Paystack is not configured.",
            )
        }
    };
    let verification = match state
        .http
        .get(format!(
            "https://api.paystack.co/transaction/verify/{}",
            url::form_urlencoded::byte_serialize(reference.as_bytes()).collect::<String>()
        ))
        .header("Authorization", format!("Bearer {secret}"))
        .header("Content-Type", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "Paystack could not be reached."),
    };

    let http_ok = verification.status().is_success();
    let payload: Value = match verification.json().await {
        Ok(value) => value,
        Err(_) => {
            return error(
                StatusCode::BAD_GATEWAY,
                "Paystack returned an invalid verification response.",
            )
        }
    };
    let data = payload.get("data").cloned().unwrap_or(Value::Null);
    if !http_ok
        || payload.get("status").and_then(Value::as_bool) != Some(true)
        || data.get("status").and_then(Value::as_str) != Some("success")
    {
        return error(
            StatusCode::PAYMENT_REQUIRED,
            "Payment could not be verified.",
        );
    }

    if data
        .get("reference")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != reference
    {
        return error(StatusCode::BAD_REQUEST, "Payment reference mismatch.");
    }
    let currency = data
        .get("currency")
        .and_then(Value::as_str)
        .unwrap_or("NGN");
    if !currency.eq_ignore_ascii_case("NGN") {
        return error(
            StatusCode::BAD_REQUEST,
            "Payment currency does not match this marketplace.",
        );
    }
    let amount_kobo = data.get("amount").and_then(Value::as_i64);
    if amount_kobo.unwrap_or_default() <= 0 {
        return error(
            StatusCode::BAD_REQUEST,
            "Verified payment amount is invalid.",
        );
    }

    let metadata = data.get("metadata").unwrap_or(&Value::Null);
    let mut trusted_order_ids = BTreeSet::new();
    for key in ["order_id", "orderId"] {
        if let Some(id) = metadata
            .get(key)
            .and_then(Value::as_i64)
            .filter(|id| *id > 0)
        {
            trusted_order_ids.insert(id);
        } else if let Some(id) = metadata
            .get(key)
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|id| *id > 0)
        {
            trusted_order_ids.insert(id);
        }
    }
    if let Some(raw) = metadata.get("order_ids").and_then(Value::as_str) {
        for id in raw
            .split(',')
            .filter_map(|part| part.trim().parse::<i64>().ok())
            .filter(|id| *id > 0)
            .take(100)
        {
            trusted_order_ids.insert(id);
        }
    }
    let reference_order_id = order_id_from_reference(&reference);
    if let Some(reference_id) = reference_order_id {
        if !trusted_order_ids.is_empty() && !trusted_order_ids.contains(&reference_id) {
            return error(
                StatusCode::BAD_REQUEST,
                "Payment reference and order metadata do not match.",
            );
        }
        trusted_order_ids.insert(reference_id);
    }

    // A browser-supplied order ID may narrow a verified provider reference, but
    // must never add an unrelated order to the set being marked as paid.
    if input
        .order_id
        .is_some_and(|id| id > 0 && !trusted_order_ids.contains(&id))
        || input.order_ids.as_ref().is_some_and(|ids| {
            ids.iter()
                .any(|id| *id > 0 && !trusted_order_ids.contains(id))
        })
    {
        return error(
            StatusCode::BAD_REQUEST,
            "The supplied order does not match this payment reference.",
        );
    }
    let order_ids = trusted_order_ids;

    if order_ids.is_empty() {
        let service_key = match state.settings.supabase_service_role_key.as_ref() {
            Some(key) => key,
            None => {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Payment reconciliation is not configured.",
                )
            }
        };
        let base = state.settings.supabase_url.as_ref().unwrap();
        let details = json!({
            "reference": reference,
            "amountKobo": amount_kobo,
            "channel": data.get("channel").and_then(Value::as_str)
        })
        .to_string();
        let _ = state
            .http
            .post(format!(
                "{}/rest/v1/payment_logs",
                base.trim_end_matches('/')
            ))
            .header("apikey", service_key)
            .bearer_auth(service_key)
            .json(&json!({
                "action": "PAYSTACK_VERIFIED_NO_ORDER",
                "details": details,
                "ip_address": ""
            }))
            .send()
            .await;
        return (
            StatusCode::OK,
            Json(json!({
                "success": false,
                "reconciliation": { "reconciled": false, "reason": "order_not_found" },
                "data": {
                    "status": "success", "reference": reference, "amount": amount_kobo,
                    "currency": currency, "paid_at": data.get("paid_at"),
                    "channel": data.get("channel"), "customer": data.pointer("/customer/email")
                }
            })),
        )
            .into_response();
    }

    let ids = order_ids.into_iter().collect::<Vec<_>>();
    let orders = match fetch_orders(&state, &ids).await {
        Ok(rows) => rows,
        Err(_) => {
            return error(
                StatusCode::BAD_GATEWAY,
                "Could not load the order for payment verification.",
            )
        }
    };
    if orders.iter().any(|order| order.buyer_id != profile_id) {
        return error(
            StatusCode::FORBIDDEN,
            "This payment does not belong to the signed-in buyer.",
        );
    }
    if ids.len() > 1 {
        let sum_kobo =
            (orders.iter().map(OrderRow::payment_due).sum::<f64>() * 100.0).round() as i64;
        if orders.len() != ids.len() || (sum_kobo - amount_kobo.unwrap_or_default()).abs() > 100 {
            return (
                StatusCode::OK,
                Json(json!({
                    "success": false,
                    "reconciliation": { "reconciled": false, "reason": "amount_mismatch", "orderIds": ids },
                    "data": {
                        "status": "success", "reference": reference, "amount": amount_kobo,
                        "currency": currency, "paid_at": data.get("paid_at"),
                        "channel": data.get("channel"), "customer": data.pointer("/customer/email")
                    }
                }))
            ).into_response();
        }
    }

    let channel = data
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or("card");
    let mut results = Vec::new();
    for order_id in &ids {
        let Some(order) = orders.iter().find(|row| row.id == *order_id) else {
            results.push(json!({ "orderId": order_id, "ok": false, "error": "order_not_found" }));
            continue;
        };
        if ids.len() == 1 {
            if order.terminal() {
                results
                    .push(json!({ "orderId": order_id, "ok": false, "error": "terminal_status" }));
                continue;
            }
            if !order.paid() && !order.payable() {
                results
                    .push(json!({ "orderId": order_id, "ok": false, "error": "invalid_status" }));
                continue;
            }
            let expected = (order.payment_due() * 100.0).round() as i64;
            if !order.paid() && (expected - amount_kobo.unwrap_or_default()).abs() > 100 {
                results
                    .push(json!({ "orderId": order_id, "ok": false, "error": "amount_mismatch" }));
                continue;
            }
        }

        let reference_for_order = if ids.len() > 1 {
            format!("{reference}#{order_id}")
        } else {
            reference.clone()
        };
        match mark_order_paid(
            &state,
            *order_id,
            &reference_for_order,
            if ids.len() > 1 { None } else { amount_kobo },
            channel,
        )
        .await
        {
            Ok(data) => results.push(json!({ "orderId": order_id, "ok": true, "data": data })),
            Err(_) => {
                results.push(json!({ "orderId": order_id, "ok": false, "error": "update_failed" }))
            }
        }
    }

    let any_ok = results
        .iter()
        .any(|result| result.get("ok").and_then(Value::as_bool) == Some(true));
    let reconciliation = json!({
        "reconciled": any_ok,
        "orderId": ids.first(),
        "orderIds": ids,
        "results": results,
        "reason": if any_ok { Value::Null } else { json!("update_failed") }
    });

    (
        StatusCode::OK,
        Json(json!({
            "success": any_ok,
            "reconciliation": reconciliation,
            "data": {
                "status": "success", "reference": reference, "amount": amount_kobo,
                "currency": currency, "paid_at": data.get("paid_at"),
                "channel": data.get("channel"), "customer": data.pointer("/customer/email")
            }
        })),
    )
        .into_response()
}

/// Verify a signed-webhook payment reference directly with Paystack and reconcile its orders.
pub async fn verify_event(state: &AppState, reference: &str) -> Result<Value, StatusCode> {
    let reference = reference.trim();
    if reference.len() < 3
        || reference.len() > 128
        || !reference
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let secret = std::env::var("PAYSTACK_SECRET_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let escaped = url::form_urlencoded::byte_serialize(reference.as_bytes()).collect::<String>();
    let response = state
        .http
        .get(format!(
            "https://api.paystack.co/transaction/verify/{escaped}"
        ))
        .header("Authorization", format!("Bearer {secret}"))
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let http_ok = response.status().is_success();
    let payload: Value = response.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let data = payload.get("data").cloned().unwrap_or(Value::Null);
    if !http_ok
        || payload.get("status").and_then(Value::as_bool) != Some(true)
        || data.get("status").and_then(Value::as_str) != Some("success")
    {
        return Err(StatusCode::PAYMENT_REQUIRED);
    }
    if data.get("reference").and_then(Value::as_str) != Some(reference)
        || !data
            .get("currency")
            .and_then(Value::as_str)
            .unwrap_or("")
            .eq_ignore_ascii_case("NGN")
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let amount = data
        .get("amount")
        .and_then(Value::as_i64)
        .filter(|v| *v > 0)
        .ok_or(StatusCode::BAD_REQUEST)?;
    let metadata = data.get("metadata").unwrap_or(&Value::Null);
    let mut ids = BTreeSet::new();
    let mut metadata_ids = BTreeSet::new();
    for key in ["order_id", "orderId"] {
        let value = metadata.get(key);
        if let Some(id) = value
            .and_then(Value::as_i64)
            .or_else(|| {
                value
                    .and_then(Value::as_str)
                    .and_then(|v| v.parse::<i64>().ok())
            })
            .filter(|id| *id > 0)
        {
            metadata_ids.insert(id);
        }
    }
    if let Some(raw) = metadata.get("order_ids").and_then(Value::as_str) {
        for id in raw
            .split(',')
            .filter_map(|v| v.trim().parse::<i64>().ok())
            .filter(|id| *id > 0)
            .take(100)
        {
            metadata_ids.insert(id);
        }
    } else if let Some(values) = metadata.get("order_ids").and_then(Value::as_array) {
        for id in values
            .iter()
            .filter_map(|v| {
                v.as_i64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
            })
            .filter(|id| *id > 0)
            .take(100)
        {
            metadata_ids.insert(id);
        }
    }
    if let Some(id) = order_id_from_reference(reference) {
        if !metadata_ids.is_empty() && !metadata_ids.contains(&id) {
            return Err(StatusCode::BAD_REQUEST);
        }
        ids.insert(id);
    }
    ids.extend(metadata_ids);
    if ids.is_empty() {
        return Err(StatusCode::NOT_FOUND);
    }
    let ids = ids.into_iter().collect::<Vec<_>>();
    let orders = fetch_orders(state, &ids)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    if orders.len() != ids.len() {
        return Err(StatusCode::NOT_FOUND);
    }
    if orders
        .iter()
        .any(|o| o.terminal() || (!o.paid() && !o.payable()))
    {
        return Err(StatusCode::CONFLICT);
    }
    if ids.len() > 1 {
        let expected =
            (orders.iter().map(OrderRow::payment_due).sum::<f64>() * 100.0).round() as i64;
        if (expected - amount).abs() > 100 {
            return Err(StatusCode::BAD_REQUEST);
        }
    } else {
        let expected = (orders[0].payment_due() * 100.0).round() as i64;
        if !orders[0].paid() && (expected - amount).abs() > 100 {
            return Err(StatusCode::BAD_REQUEST);
        }
    }
    let channel = data
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or("card");
    let mut results = Vec::new();
    for id in &ids {
        let per_order = if ids.len() > 1 {
            format!("{reference}#{id}")
        } else {
            reference.to_owned()
        };
        match mark_order_paid(
            state,
            *id,
            &per_order,
            if ids.len() > 1 { None } else { Some(amount) },
            channel,
        )
        .await
        {
            Ok(value) => results.push(json!({"orderId":id,"ok":true,"data":value})),
            Err(_) => results.push(json!({"orderId":id,"ok":false,"error":"update_failed"})),
        }
    }
    let all_ok = results
        .iter()
        .all(|row| row.get("ok").and_then(Value::as_bool) == Some(true));
    Ok(
        json!({"success":all_ok,"reference":reference,"amount":amount,"currency":"NGN","channel":channel,"orderIds":ids,"results":results}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_good_sale_order_references() {
        assert_eq!(order_id_from_reference("GS_73_1234_abcd"), Some(73));
        assert_eq!(order_id_from_reference("gs_9_1234_abcd"), Some(9));
        assert_eq!(order_id_from_reference("GSW_73_1234_abcd"), None);
        assert_eq!(order_id_from_reference("GS_0_1234_abcd"), None);
    }

    #[test]
    fn calculates_deposit_and_balance_due() {
        let deposit = OrderRow {
            id: 1,
            buyer_id: 2,
            total_amount: 1000.0,
            status: "PENDING".into(),
            payment_method: "PARTIAL".into(),
            deposit_percent: Some(30.0),
            balance_remaining: None,
        };
        assert_eq!(deposit.payment_due(), 300.0);
        let balance = OrderRow {
            id: 1,
            buyer_id: 2,
            total_amount: 1000.0,
            status: "PARTIAL_DEPOSIT_PAID".into(),
            payment_method: "PARTIAL".into(),
            deposit_percent: Some(30.0),
            balance_remaining: Some(700.0),
        };
        assert_eq!(balance.payment_due(), 700.0);
    }
}
