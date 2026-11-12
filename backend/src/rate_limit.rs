use redis::aio::ConnectionManager;
use std::{collections::HashMap, sync::{Arc, Mutex}, time::{Duration, Instant}};

#[derive(Clone, Copy, Debug)]
pub struct Decision {
    pub allowed: bool,
    pub remaining: u32,
    pub retry_after_secs: u64,
}

#[derive(Clone)]
pub struct RateLimiter {
    redis: Option<ConnectionManager>,
    required: bool,
    local: Arc<Mutex<HashMap<String, (Instant, u32)>>>,
}

impl RateLimiter {
    pub async fn connect(redis_url: Option<String>, required: bool) -> Result<Self, String> {
        let redis = if let Some(url) = redis_url {
            let client = redis::Client::open(url).map_err(|e| format!("Invalid REDIS_URL: {e}"))?;
            match client.get_connection_manager().await {
                Ok(connection) => Some(connection),
                Err(error) if required => return Err(format!("Redis is required but unavailable: {error}")),
                Err(_) => None,
            }
        } else if required {
            return Err("RATE_LIMIT_REQUIRE_REDIS is enabled but REDIS_URL is missing.".to_owned());
        } else {
            None
        };

        Ok(Self {
            redis,
            required,
            local: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn is_distributed(&self) -> bool {
        self.redis.is_some()
    }

    pub async fn check(&self, key: &str, limit: u32, window: Duration) -> Result<Decision, ()> {
        let window_secs = window.as_secs().max(1);
        if let Some(connection) = &self.redis {
            let mut conn = connection.clone();
            // Run increment + expiry atomically. A split INCR/EXPIRE can leave
            // a permanent key if the connection drops between the two commands.
            let (count, ttl): (i64, i64) = redis::cmd("EVAL")
                .arg("local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; local ttl = redis.call('TTL', KEYS[1]); return {count, ttl}")
                .arg(1)
                .arg(key)
                .arg(window_secs)
                .query_async(&mut conn)
                .await
                .map_err(|_| ())?;

            let remaining = limit.saturating_sub(count.max(0) as u32);
            return Ok(Decision {
                allowed: count <= i64::from(limit),
                remaining,
                retry_after_secs: if count > i64::from(limit) { ttl.max(1) as u64 } else { 0 },
            });
        }

        if self.required {
            return Err(());
        }

        let now = Instant::now();
        let mut buckets = self.local.lock().map_err(|_| ())?;
        let entry = buckets.entry(key.to_owned()).or_insert((now, 0));
        if now.duration_since(entry.0) >= window {
            *entry = (now, 0);
        }
        entry.1 = entry.1.saturating_add(1);
        let count = entry.1;
        let retry = window.saturating_sub(now.duration_since(entry.0)).as_secs().max(1);

        if buckets.len() > 20_000 {
            buckets.retain(|_, (start, _)| now.duration_since(*start) < window);
        }

        Ok(Decision {
            allowed: count <= limit,
            remaining: limit.saturating_sub(count),
            retry_after_secs: if count > limit { retry } else { 0 },
        })
    }
}
