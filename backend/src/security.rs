use unicode_normalization::UnicodeNormalization;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextError(pub &'static str);

/// Normalize plain text and reject invisible/control characters frequently used to disguise input.
/// This is not HTML sanitization: the frontend must render the result as text, never raw HTML.
pub fn normalize_plain_text(input: &str, max_chars: usize) -> Result<String, TextError> {
    let normalized: String = input.nfc().collect();
    let trimmed = normalized.trim();
    if trimmed.chars().count() > max_chars {
        return Err(TextError("Text is longer than the allowed limit."));
    }
    for ch in trimmed.chars() {
        let code = ch as u32;
        if ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t' {
            return Err(TextError("Text contains unsupported control characters."));
        }
        if (0x202A..=0x202E).contains(&code) || (0x2066..=0x2069).contains(&code) {
            return Err(TextError(
                "Text contains unsupported directional formatting.",
            ));
        }
    }
    Ok(trimmed.to_owned())
}

/// Validate links that will be displayed to users. This service does not fetch user-supplied URLs.
pub fn validate_external_url(input: &str) -> Result<String, &'static str> {
    let parsed = Url::parse(input.trim()).map_err(|_| "Enter a valid URL.")?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("Only HTTP and HTTPS links are allowed.");
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("This URL is not allowed.");
    }

    let host = parsed
        .host_str()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err("Local network addresses are not allowed.");
    }

    let host_for_ip = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host_for_ip.parse::<std::net::IpAddr>() {
        let blocked = match ip {
            std::net::IpAddr::V4(v4) => {
                v4.is_private()
                    || v4.is_loopback()
                    || v4.is_link_local()
                    || v4.is_unspecified()
                    || v4.is_broadcast()
                    || v4.is_multicast()
            }
            std::net::IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    || v6.is_multicast()
                    || (v6.segments()[0] & 0xfe00) == 0xfc00
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
            }
        };
        if blocked {
            return Err("Private network addresses are not allowed.");
        }
    }
    Ok(parsed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_unicode_and_preserves_readable_punctuation() {
        assert_eq!(normalize_plain_text("  Cafe\u{301}  ", 20).unwrap(), "Café");
    }

    #[test]
    fn rejects_control_and_directional_override_characters() {
        assert!(normalize_plain_text("hello\0world", 40).is_err());
        assert!(normalize_plain_text("pay\u{202e}now", 40).is_err());
    }

    #[test]
    fn rejects_script_schemes_and_private_host_urls() {
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("http://127.0.0.1:5432").is_err());
        assert!(validate_external_url("http://[::1]:5432").is_err());
        assert!(validate_external_url("https://goodsale.ng/path").is_ok());
    }
}
