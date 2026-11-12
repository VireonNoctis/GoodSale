# GoodSale Rust API

The Rust service is the target backend for GoodSale. It runs beside the Next.js frontend and uses Supabase Auth, Postgres REST/RPC and Storage as the existing identity/data layer.

## Current migration boundary

The repository originally contained 84 Next.js API route handlers. This migration now moves media uploads and Paystack order verification behind Rust:

- `POST /api/upload` remains the browser-facing compatibility route.
- `POST /api/payments/verify` remains the browser-facing compatibility route and requires the signed-in buyer session.
- When `RUST_BACKEND_URL` is configured, the upload route forwards the authenticated multipart request to `POST /v1/uploads`.
- The payment route forwards the verified Supabase access token and reference to `POST /v1/payments/verify`; Rust verifies the Paystack charge, checks that every referenced order belongs to the signed-in buyer, validates the amount/currency/order status, then calls the existing idempotent RPC.
- The Rust service verifies the access token against Supabase Auth, enforces bucket policy and limits, verifies file signatures, and writes to Cloudinary or Supabase Storage.
- When `RUST_BACKEND_URL` is absent, the original Next.js upload and payment verification paths remain available as a controlled rollout fallback, with buyer-session and order-ownership checks.
- Once `RUST_BACKEND_URL` is set, Rust failures are returned to the caller; the application does not silently bypass Rust and retry through the legacy handler.

**This is an incremental cutover, not a completed 84-route migration.** The remaining account, admin, auth registration, marketplace, checkout, Paystack, wallet, escrow, dispute, delivery, rider, chat, support, ads, premium and referral handlers still run in Next.js. Keep them until equivalent Rust handlers and contract tests exist.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health/live` | Process liveness |
| GET | `/health/ready` | Supabase and distributed-limiter readiness |
| POST | `/v1/uploads` | Authenticated and validated media upload |
| POST | `/v1/payments/verify` | Paystack order verification and buyer-bound reconciliation |
| POST | `/internal/rate-limit` | Private Next.js-to-Rust Redis rate-limit decision (shared-secret protected) |
| POST | `/v1/security/inspect-text` | Unicode/control-character validation for plain text |
| POST | `/v1/security/validate-url` | HTTP(S) URL validation for displayed links |

## Security controls

- Redis-backed global and route-scoped request limits; account-scoped upload limit; internal shared-secret API for Next.js middleware.
- Production rate limiting is fail-closed. Configure a private `REDIS_URL`; do not rely on per-process memory limits in a multi-instance deployment.
- Request bodies are capped. The upload route has a 27 MiB multipart ceiling, then applies the existing 8 MiB image and 25 MiB video limits.
- MIME allowlists are bucket-specific and checked against file magic bytes; filenames are server-generated.
- Identity documents are never sent to Cloudinary. They remain in the private Supabase bucket and receive a time-limited signed URL.
- The `ad-media` bucket requires an authenticated `ADMIN` or `SUPER_ADMIN` profile.
- Supabase access tokens are verified server-to-server before an upload is accepted. The service-role key is never returned to the client.
- CORS uses exact configured origins; request IDs and defensive response headers are attached centrally.
- Plain-text input is NFC-normalised and rejects control characters and bidirectional override controls. It is **not** converted into executable HTML. Render untrusted strings as React text; do not pass user content to `dangerouslySetInnerHTML`.
- User-provided URLs are not fetched by this service. The URL validator rejects non-web schemes, credentials, localhost and literal private IPs; it is not sufficient protection for a future server-side URL fetcher, which must also validate DNS results and every redirect.

Next.js API traffic uses the internal `/internal/rate-limit` endpoint when `RUST_BACKEND_URL` and `RATE_LIMIT_SHARED_SECRET` are set. If using Upstash instead, both Upstash REST settings must be present. Production fails closed if neither distributed limiter is available.

## Run locally

Install Rust and run Redis locally, then:

```bash
cargo run --manifest-path backend/Cargo.toml
```

Set `RUST_BACKEND_URL=http://localhost:8080` in the Next.js environment to route uploads through Rust. For the local Rust process, `RATE_LIMIT_REQUIRE_REDIS=false` allows a development-only in-memory fallback. Never use that fallback as production protection.

## Docker Compose

```bash
docker compose up --build
```

Compose starts the Next.js app, Rust API and a private Redis service. The API is exposed only to the Compose network, not directly to the host. Persistent Redis data is stored in the `redis-data` volume.

Required backend environment:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `REDIS_URL` (private Redis or a compatible managed Redis endpoint)
- `RATE_LIMIT_SHARED_SECRET` (long random value shared by Next.js and Rust)
- `TRUSTED_CLIENT_IP_HEADER` (optional; set only when a reverse proxy overwrites the selected header, e.g. `x-real-ip`)

Optional media environment:
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

## Migration order

Port one domain at a time and preserve the exact JSON/status contracts used by the existing frontend:

1. Auth, sessions, profiles and account lifecycle.
2. Listings, catalogue, search, seller tools, reviews and inventory.
3. Checkout, Paystack webhooks, wallet, payouts and refunds (order verification is already on Rust).
4. Orders, buyer protection, disputes and claims.
5. Delivery, courier webhooks, rider operations and tracking.
6. Chat, notifications, support and realtime integration.
7. Admin, verification, ads, premium subscriptions and referrals.

Each cutover needs Rust unit/integration tests, Supabase RPC permission checks, idempotency tests for money-moving operations, and frontend contract verification before the matching TypeScript route can be removed.


## CI checks

The fork's Rust workflow formats Rust sources on pushes to `premium-marketplace-rework`, commits formatter-only changes, then runs Clippy with warnings denied, unit tests and a release build. Pull-request runs check formatting without modifying the branch. The repository's main CI separately runs Next.js lint, typecheck, tests and build.
