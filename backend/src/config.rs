use std::env;

#[derive(Clone)]
pub struct Settings {
    pub host: String,
    pub port: u16,
    pub supabase_url: Option<String>,
    pub supabase_anon_key: Option<String>,
    pub supabase_service_role_key: Option<String>,
    pub cloudinary_cloud_name: Option<String>,
    pub cloudinary_api_key: Option<String>,
    pub cloudinary_api_secret: Option<String>,
    pub allowed_origins: Vec<String>,
    pub trust_proxy_headers: bool,
    pub rate_limit_required: bool,
}

fn value(primary: &str, fallback: Option<&str>) -> Option<String> {
    env::var(primary)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            fallback
                .and_then(|name| env::var(name).ok())
                .filter(|v| !v.trim().is_empty())
        })
}

fn flag(name: &str, default: bool) -> bool {
    env::var(name)
        .ok()
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(default)
}

impl Settings {
    pub fn from_env() -> Self {
        let app_origin = value("NEXT_PUBLIC_APP_URL", None);
        let origins = env::var("RUST_BACKEND_ALLOWED_ORIGINS")
            .ok()
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_else(|| app_origin.into_iter().collect());

        Self {
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_owned()),
            port: env::var("PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8080),
            supabase_url: value("SUPABASE_URL", Some("NEXT_PUBLIC_SUPABASE_URL")),
            supabase_anon_key: value("SUPABASE_ANON_KEY", Some("NEXT_PUBLIC_SUPABASE_ANON_KEY")),
            supabase_service_role_key: value("SUPABASE_SERVICE_ROLE_KEY", None),
            cloudinary_cloud_name: value(
                "CLOUDINARY_CLOUD_NAME",
                Some("NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME"),
            ),
            cloudinary_api_key: value("CLOUDINARY_API_KEY", None),
            cloudinary_api_secret: value("CLOUDINARY_API_SECRET", None),
            allowed_origins: origins,
            trust_proxy_headers: flag("TRUST_PROXY_HEADERS", false),
            rate_limit_required: flag("RATE_LIMIT_REQUIRE_REDIS", cfg!(not(debug_assertions))),
        }
    }

    pub fn supabase_configured(&self) -> bool {
        self.supabase_url.is_some()
            && self.supabase_anon_key.is_some()
            && self.supabase_service_role_key.is_some()
    }
}
