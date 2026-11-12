use crate::AppState;
use axum::{
    extract::{Multipart, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const IMAGE_MAX: usize = 8 * 1024 * 1024;
const VIDEO_MAX: usize = 25 * 1024 * 1024;

fn allowed_mime(bucket: &str, mime: &str) -> bool {
    match bucket {
        "product-images" => matches!(
            mime,
            "image/jpeg"
                | "image/png"
                | "image/webp"
                | "image/avif"
                | "image/gif"
                | "video/mp4"
                | "video/webm"
                | "video/quicktime"
        ),
        "chat-media" | "ad-media" => matches!(
            mime,
            "image/jpeg"
                | "image/png"
                | "image/webp"
                | "image/gif"
                | "video/mp4"
                | "video/webm"
                | "video/quicktime"
        ),
        "government-ids" => matches!(
            mime,
            "image/jpeg" | "image/png" | "image/webp" | "application/pdf"
        ),
        "avatars" => matches!(mime, "image/jpeg" | "image/png" | "image/webp"),
        _ => false,
    }
}

fn extension(mime: &str) -> Option<&'static str> {
    match mime {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/avif" => Some("avif"),
        "image/gif" => Some("gif"),
        "application/pdf" => Some("pdf"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        _ => None,
    }
}

fn valid_signature(data: &[u8], mime: &str) -> bool {
    match mime {
        "image/jpeg" => data.len() > 3 && data[0..3] == [0xff, 0xd8, 0xff],
        "image/png" => data.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/webp" => data.len() > 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP",
        "image/gif" => data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a"),
        "image/avif" => {
            data.len() > 12
                && &data[4..8] == b"ftyp"
                && (&data[8..12] == b"avif" || &data[8..12] == b"avis")
        }
        "application/pdf" => data.starts_with(b"%PDF-"),
        "video/mp4" => data.len() > 12 && &data[4..8] == b"ftyp",
        "video/quicktime" => data.len() > 12 && &data[4..8] == b"ftyp" && &data[8..12] == b"qt  ",
        "video/webm" => data.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        _ => false,
    }
}

fn failure(status: StatusCode, message: &str) -> impl IntoResponse {
    (status, Json(json!({ "success": false, "error": message })))
}

async fn user_id(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<String, (StatusCode, &'static str)> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty())
        .ok_or((StatusCode::UNAUTHORIZED, "Sign in to upload media."))?;

    let base = state.settings.supabase_url.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "Storage is not configured.",
    ))?;
    let anon = state.settings.supabase_anon_key.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "Authentication is not configured.",
    ))?;
    let response = state
        .http
        .get(format!("{}/auth/v1/user", base.trim_end_matches('/')))
        .header("apikey", anon)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Could not verify your session."))?;

    if !response.status().is_success() {
        return Err((
            StatusCode::UNAUTHORIZED,
            "Your session has expired. Sign in again.",
        ));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Could not verify your session."))?;
    payload
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or((StatusCode::UNAUTHORIZED, "Your session is not valid."))
}

async fn is_admin(state: &AppState, user_id: &str) -> Result<bool, ()> {
    let base = state.settings.supabase_url.as_ref().ok_or(())?;
    let key = state
        .settings
        .supabase_service_role_key
        .as_ref()
        .ok_or(())?;
    let response = state
        .http
        .get(format!(
            "{}/rest/v1/profiles?select=role&auth_id=eq.{}&limit=1",
            base.trim_end_matches('/'),
            user_id
        ))
        .header("apikey", key)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let rows: Vec<Value> = response.json().await.map_err(|_| ())?;
    Ok(rows
        .first()
        .and_then(|row| row.get("role"))
        .and_then(Value::as_str)
        .map(|role| matches!(role, "ADMIN" | "SUPER_ADMIN"))
        .unwrap_or(false))
}

fn cloudinary_signature(timestamp: &str) -> Option<String> {
    let secret = std::env::var("CLOUDINARY_API_SECRET").ok()?;
    let mut digest = Sha1::new();
    digest.update(format!("folder=goodsale&timestamp={timestamp}{secret}"));
    Some(hex::encode(digest.finalize()))
}

async fn upload_cloudinary(
    state: &AppState,
    bytes: Vec<u8>,
    mime: &str,
    ext: &str,
) -> Option<Value> {
    let cloud = state.settings.cloudinary_cloud_name.as_ref()?;
    let api_key = state.settings.cloudinary_api_key.as_ref()?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs()
        .to_string();
    let signature = cloudinary_signature(&timestamp)?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("goodsale-upload.{ext}"))
        .mime_str(mime)
        .ok()?;
    let form = reqwest::multipart::Form::new()
        .text("api_key", api_key.clone())
        .text("folder", "goodsale")
        .text("timestamp", timestamp)
        .text("signature", signature)
        .part("file", part);
    let response = state
        .http
        .post(format!(
            "https://api.cloudinary.com/v1_1/{cloud}/auto/upload"
        ))
        .multipart(form)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let result: Value = response.json().await.ok()?;
    let url = result
        .get("secure_url")?
        .as_str()?
        .replace("/upload/", "/upload/f_auto,q_auto/");
    Some(json!({
        "success": true,
        "url": url,
        "publicId": result.get("public_id").and_then(Value::as_str).unwrap_or(""),
        "provider": "cloudinary"
    }))
}

pub async fn upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let uid = match user_id(&state, &headers).await {
        Ok(id) => id,
        Err((status, message)) => return failure(status, message).into_response(),
    };

    match state
        .limiter
        .check(
            &format!("upload:user:{uid}"),
            20,
            std::time::Duration::from_secs(60),
        )
        .await
    {
        Ok(decision) if decision.allowed => {}
        Ok(decision) => {
            return failure(
                StatusCode::TOO_MANY_REQUESTS,
                &format!(
                    "Upload limit reached. Retry in {} seconds.",
                    decision.retry_after_secs
                ),
            )
            .into_response()
        }
        Err(_) => {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Upload protection is temporarily unavailable.",
            )
            .into_response()
        }
    }

    let mut bucket = "product-images".to_owned();
    let mut file_bytes: Option<Vec<u8>> = None;
    let mut mime = String::new();

    loop {
        let mut field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => {
                return failure(StatusCode::BAD_REQUEST, "The upload form is malformed.")
                    .into_response()
            }
        };
        let name = field.name().unwrap_or_default().to_owned();
        match name.as_str() {
            "bucket" => {
                if let Ok(value) = field.text().await {
                    bucket = value;
                }
            }
            "file" => {
                mime = field
                    .content_type()
                    .unwrap_or("application/octet-stream")
                    .to_ascii_lowercase();
                match field.bytes().await {
                    Ok(bytes) => file_bytes = Some(bytes.to_vec()),
                    Err(_) => {
                        return failure(
                            StatusCode::BAD_REQUEST,
                            "The uploaded file could not be read.",
                        )
                        .into_response()
                    }
                }
            }
            _ => {}
        }
    }

    let Some(bytes) = file_bytes else {
        return failure(StatusCode::BAD_REQUEST, "Choose a file to upload.").into_response();
    };
    if !matches!(
        bucket.as_str(),
        "product-images" | "chat-media" | "government-ids" | "avatars" | "ad-media"
    ) {
        return failure(
            StatusCode::BAD_REQUEST,
            "This upload destination is not supported.",
        )
        .into_response();
    }
    if !allowed_mime(&bucket, &mime) {
        return failure(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "This file type is not allowed for this upload.",
        )
        .into_response();
    }

    let is_video = mime.starts_with("video/");
    let max_bytes = if is_video { VIDEO_MAX } else { IMAGE_MAX };
    if bytes.is_empty() || bytes.len() > max_bytes {
        return failure(
            StatusCode::PAYLOAD_TOO_LARGE,
            "This file is larger than the allowed limit.",
        )
        .into_response();
    }
    if !valid_signature(&bytes, &mime) {
        return failure(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "The file content does not match its declared type.",
        )
        .into_response();
    }

    let extension = extension(&mime).unwrap_or("bin");
    let service_key = match state.settings.supabase_service_role_key.as_ref() {
        Some(key) => key,
        None => {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Storage is not configured.",
            )
            .into_response()
        }
    };
    let base = match state.settings.supabase_url.as_ref() {
        Some(url) => url.trim_end_matches('/'),
        None => {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Storage is not configured.",
            )
            .into_response()
        }
    };

    if bucket == "ad-media" {
        match is_admin(&state, &uid).await {
            Ok(true) => {}
            Ok(false) => {
                return failure(
                    StatusCode::FORBIDDEN,
                    "Advertising uploads are restricted to administrators.",
                )
                .into_response()
            }
            Err(_) => {
                return failure(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Upload permissions could not be verified.",
                )
                .into_response()
            }
        }
    }

    if bucket != "government-ids" {
        if let Some(result) = upload_cloudinary(&state, bytes.clone(), &mime, extension).await {
            let mut data = result;
            data["bucket"] = json!(bucket);
            return (StatusCode::OK, Json(data)).into_response();
        }
    }

    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = format!("{uid}/{millis}_{}.{}", Uuid::new_v4(), extension);
    let upload_url = format!("{base}/storage/v1/object/{bucket}/{path}");
    let response = match state
        .http
        .post(upload_url)
        .header("apikey", service_key)
        .bearer_auth(service_key)
        .header("Content-Type", &mime)
        .header("x-upsert", "false")
        .body(bytes)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => {
            return failure(
                StatusCode::BAD_GATEWAY,
                "The storage service could not be reached.",
            )
            .into_response()
        }
    };

    if !response.status().is_success() {
        tracing::error!(status = %response.status(), "Supabase Storage upload failed");
        return failure(
            StatusCode::BAD_GATEWAY,
            "The file could not be stored. Please retry.",
        )
        .into_response();
    }

    if bucket == "government-ids" {
        let sign_url = format!("{base}/storage/v1/object/sign/{bucket}/{path}");
        let response = match state
            .http
            .post(sign_url)
            .header("apikey", service_key)
            .bearer_auth(service_key)
            .json(&json!({ "expiresIn": 90 }))
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => {
                return failure(
                    StatusCode::BAD_GATEWAY,
                    "A private file link could not be created.",
                )
                .into_response()
            }
        };
        if !response.status().is_success() {
            return failure(
                StatusCode::BAD_GATEWAY,
                "A private file link could not be created.",
            )
            .into_response();
        }
        let signed: Value = response.json().await.unwrap_or_else(|_| json!({}));
        let relative = signed
            .get("signedURL")
            .or_else(|| signed.get("signedUrl"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let url = if relative.starts_with("http") {
            relative.to_owned()
        } else {
            format!("{base}/storage/v1{relative}")
        };
        return (
            StatusCode::OK,
            Json(json!({
                "success": true, "url": url, "path": path, "bucket": bucket, "private": true
            })),
        )
            .into_response();
    }

    let public_url = format!("{base}/storage/v1/object/public/{bucket}/{path}");
    (
        StatusCode::OK,
        Json(json!({
            "success": true, "url": public_url, "path": path, "bucket": bucket, "private": false
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_mime_spoofing() {
        assert!(!valid_signature(b"<script>alert(1)</script>", "image/png"));
        assert!(!valid_signature(b"not a pdf", "application/pdf"));
    }

    #[test]
    fn enforces_bucket_type_policies() {
        assert!(!allowed_mime("government-ids", "video/mp4"));
        assert!(!allowed_mime("avatars", "application/pdf"));
        assert!(allowed_mime("government-ids", "application/pdf"));
    }
}
