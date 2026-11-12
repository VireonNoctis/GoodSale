# GoodSale

Nigeria's escrow-backed C2C marketplace with **live Supabase Auth**, realtime catalog/orders/chat/dispatch, and Paystack checkout.

Mock seed users/products/orders have been **removed**. The app loads empty until you connect Supabase.

## 1. Create a Supabase project

1. Create a project at [supabase.com](https://supabase.com)
2. Open **SQL Editor** → paste and run [`supabase/schema.sql`](./supabase/schema.sql)
3. (Optional) Create storage buckets: `government-ids` (private), `product-images` (public), `chat-media` (public)
4. Authentication → Providers → enable **Email**
5. Authentication → URL config → add `http://localhost:3000/auth/callback` (and your production URL)

## 2. Add credentials

```bash
cp .env.example .env.local
```

Fill in at minimum:

| Variable | Where to find it |
|----------|------------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings → API → `anon` `public` |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → `service_role` (server only) |
| `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` | Paystack Dashboard → Settings → API Keys |
| `PAYSTACK_SECRET_KEY` | Paystack secret key |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` locally |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME` + `CLOUDINARY_API_KEY` + `CLOUDINARY_API_SECRET` | Cloudinary dashboard → Settings → API Keys (optional, see below) |

Restart the dev server after saving `.env.local`.

### Media uploads (Cloudinary)

Image and video uploads go through Cloudinary's CDN when all three Cloudinary keys above
are set. Uploads are **signed server-side** with the API secret (HMAC-SHA1), so the secret
never reaches the browser and no client SDK is required.

- Without those keys the app falls back to Supabase Storage automatically.
- Identity documents (`government-ids`) are **never** sent to Cloudinary — they stay on the
  private Supabase bucket and are served via short-lived signed URLs.
- Upload size limits: 8MB for images, 25MB for video.

## 3. Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Sign up → create listings → checkout → chat → GoodDispatch jobs all hit Supabase with Realtime subscriptions.

See **[PRODUCTION.md](./PRODUCTION.md)** for the full go-live checklist (credentials only you can supply + what is already coded).

## SQL to run (order matters)

1. `supabase/schema.sql`
2. `supabase/migrations/002_production_hardening.sql`
3. `supabase/migrations/003_user_suspend.sql`
4. `supabase/migrations/004_realtime_dispatch_geo.sql`
5. `supabase/migrations/005_security_payments.sql` (RLS lockdown, disputes, refunds, withdrawals)
6. `supabase/migrations/006_payouts_and_suspend.sql` (Paystack transfer columns + suspend)
7. `supabase/migrations/007_avatars_bucket.sql` (avatars storage bucket)
8. `supabase/migrations/008_platform_fee_toggle.sql` (admin-controlled platform fee — OFF at launch)
9. `supabase/migrations/009_admin_ads.sql` (ads: image/video media, placements, `ad-media` bucket)
10. `supabase/migrations/010_announcements.sql` (admin popup shown on app entry)
11. `supabase/migrations/011_self_service_roles.sql`
12. `supabase/migrations/012_community_trust_areas.sql` (service coverage, reports, calls)
13. `supabase/migrations/013_seeded_catalog.sql` (`is_seeded` markers for the launch catalog)
14. `supabase/migrations/014_products_video.sql` (optional product video)
15. `supabase/migrations/015_resync_id_sequences.sql` (id sequences for safe re-seeding)
16. `supabase/migrations/016_compare_at_price.sql` (seller compare-at price — real discount badges)
17. `supabase/migrations/017_trust_safety.sql` (trust, safety and verification)
18. `supabase/migrations/018_shipping_engine.sql` (shipping rates, zones and quotes)
19. `supabase/migrations/019_delivery_tracking.sql` (delivery lifecycle, tracking and buyer confirmation code)
20. `supabase/migrations/020_rider_management.sql` (rider onboarding, availability and earnings)
21. `supabase/migrations/021_delivery_logistics.sql` (automated matching, live tracking, courier integration, failures/returns, notifications and analytics)
22. `supabase/migrations/022_premium_tracking.sql` (saved addresses, checkout groups, `GSD-` shipment IDs, public tracking)
23. `supabase/migrations/023_onboarding.sql` (buyer + seller onboarding state, store details, notification preferences)
24. `supabase/migrations/024_seller_verification.sql` (seller verification lifecycle, private documents, audit trail, approval RPCs)
25. `supabase/migrations/025_wallet_ledger.sql` (append-only wallet ledger, Paystack funding, wallet checkout, payout lifecycle, refunds to wallet, admin finance controls)
26. `supabase/migrations/026_referrals_rewards.sql` (referral campaigns, privacy-safe attribution, qualification, idempotent GoodSale Coin rewards, fraud review and reversal)

### Seller verification

- Sellers apply from the seller hub → **Verification** (`/seller/verification`): seller type,
  legal details, identity document, business details for registered businesses, store profile,
  then a signed declaration.
- Submitting sets the application to **Pending review**. It never verifies anyone. Only
  `admin_verification_action()` — callable by ADMIN / SUPER_ADMIN — can approve, reject, request
  information, suspend, revoke or expire a verification. Every decision writes an audit event
  (admin id, seller id, action, reason, timestamp) and a seller notification.
- Approval writes `profiles.verification_status = 'VERIFIED'`, `verified_at`, the reviewing admin,
  a 12-month `verification_expires_at`, mirrors `businesses.is_verified`, and upgrades the role.
  The public badge reads only that status, so suspending or revoking removes it everywhere.
- Identity documents live in the private `government-ids` bucket (5 MB limit, JPEG/PNG/WebP/PDF).
  The database stores storage paths, not URLs. Admins open files through
  `/api/admin/verifications/documents`, which issues a 90-second signed URL and records the view.
- Admins review from **Admin → Verifications**: filter by status, search sellers, open the file,
  read history, add internal notes, and confirm every decision with a reason.
- Verification does not change listing ranking. Any future seller programme is announced separately.

### Apply them from the terminal

Paste-and-run in the Supabase **SQL Editor** always works. To automate it instead, either:

- add a direct Postgres connection string as `DATABASE_URL` (Supabase → Project Settings →
  Database → Connection string, “Session pooler”), **or**
- add a Supabase **Personal Access Token** as `SUPABASE_ACCESS_TOKEN`
  (create one at https://supabase.com/dashboard/account/tokens)

then run:

```bash
npm run migrate            # applies every file in order
npm run migrate -- --from=002   # skip schema.sql, replay migrations from 002
npm run migrate -- --verify     # check RPCs, tables, the fee toggle, and admin accounts
npm run migrate -- --only=008_platform_fee_toggle.sql
```

The command is idempotent and verifies that every escrow/payout RPC is present when it finishes.

Paystack step-by-step: **[docs/PAYSTACK.md](./docs/PAYSTACK.md)**. Full env list: **`.env.example`**.

## What is live now

- **Auth**: Supabase email/password signup, login, password reset and session persistence on the dedicated `/auth` and `/auth/register` routes
- **Onboarding**: guided `/onboarding` flow (purpose, location, profile, notifications) and `/seller/onboarding` store setup, both persisted so they resume where they stopped
- **Profiles**: created by DB trigger on `auth.users` insert
- **Catalog / orders / escrow / chat / delivery jobs**: loaded from Postgres; writes for products, orders, messages, chat rooms persist to Supabase
- **Realtime**: `messages`, `orders`, `delivery_jobs`, `products`, `notifications`, `bids`, `chat_rooms`, …
- **Payments**: Order created first as `PENDING` → Paystack Inline with `GS_<orderId>_…` → `/api/payments/verify` + webhook mark `PAID_ESCROW`
- **Escrow**: Buyer PIN `/api/orders/release-escrow`; courier `/api/orders/complete-delivery-job`; admin force `/api/admin/escrow`
- **Disputes / payouts**: `/api/disputes/*`, `/api/wallet/withdraw`, `/api/admin/withdrawals`
- **Wallet**: `Wallet & payouts` shows database-backed available, pending, escrow-held and seller earnings. Funding uses `/api/wallet/fund` → Paystack → `/api/wallet/fund/verify` or signed webhook; the balance is credited only after intent, amount, currency and provider reference checks. Eligible pending orders can be paid from the wallet through `pay_order_with_wallet` (atomic debit + escrow hold). Funding and payouts report **unavailable** unless the Paystack keys are configured.
- **Wallet admin**: **Admin panel → Finance & Wallet** for ledger search, pending payouts, refund-to-wallet/provider, audited adjustments, limits/fees and reconciliation. `npm run verify:wallet` runs a rollback-only database test of funding, duplicate prevention, immutable ledger rows, withdrawal reservation, wallet checkout and refunds.
- **Referrals & rewards**: every account gets a unique code and share link at `/auth/register?ref=CODE`. **You → Referrals & rewards** shows the QR code, WhatsApp/X/Facebook/Telegram/native sharing, clicks, registrations, qualified referrals, pending/earned Coins and privacy-safe history. Attribution is server-only; rewards are issued only after the campaign's configured email, onboarding and genuine marketplace actions. **Admin panel → Referrals & Rewards** manages campaigns, limits, fraud flags, disqualification, reward transactions and audit history. `npm run verify:referrals` runs the rollback-only referral test.
- **Chat**: a rebuilt inbox with exact unread counts, All/Unread/Buying/Selling/Archived filters, persisted read receipts, per-conversation mute/archive, local drafts, typing indicators, in-thread search, date and unread dividers, and a listing/order details rail. Photos and videos upload to `chat-media` instead of being stored as base64. Replies, reactions, offers, receipts, calls and reporting remain. See [docs/CHAT.md](./docs/CHAT.md); `npm run verify:chat` covers the database contract.
- **Admin panel**: sign in as an `ADMIN` / `SUPER_ADMIN` account, open the account menu (top-right),
  and choose **Admin panel** → **Revenue & Payment Settings** to toggle the per-item platform fee
  and set its percentage. It is **OFF at launch** — buyers pay only the item price plus delivery.
- **Ads**: **Admin panel** → **Create an ad** — upload an image or video from your device, choose
  where it shows (home feed, category, product detail, chat, seller hub, search), then publish,
  pause or delete it. Ads render across the app through `components/AdSlot.tsx`.
- **Admin entry**: signed in as `ADMIN`/`SUPER_ADMIN` you get an **Admin** button in the header and
  as the middle tab of the mobile bottom nav — one tap to the admin panel.
- **Role-aware navigation**: registering as a **Buyer** shows a **Buy** button that jumps to the
  marketplace; **Sellers** get **Sell** and **Businesses** get **Business** (their dashboard, which
  can do everything a buyer and seller can). The profile shows your matching role badge.
- **Sign out**: avatar menu → **Log out**, or **Settings → Account Profile → Log out**.
- **Announcements**: **Admin panel → Announcements** → publish a headline/message; it pops up for
  users the next time they join or enter the app, and remembers that they dismissed it.
- **Setup banner**: shown until Supabase URL/anon key are present
- **Launch catalog (seeded marketplace)**: **Admin panel → Launch catalog** creates 20 Nigerian
  seller accounts (market stores, registered businesses and individual traders), 100 listings, four
  buyer accounts and their reviews. Seeded rows are flagged `is_seeded`, so the same screen can edit
  or delete any of them (including replacing product photos) without ever touching a real seller's
  account. Needs migration `013_seeded_catalog.sql` first.
- **Account avatars** are local monogram badges (`/api/avatar`) derived from each account's own name —
  no third-party stock portraits, so a seller's picture never contradicts their name.
- **Reviews** name the exact listing they are about (condition, warranty, dimensions, delivery) and
  mix in honest 2–3★ feedback, so the feed reads like a real market instead of generated praise.
- **Marketplace home**: deep-jade hero carousel, circular category rail, Flash Deals with a real
  midnight countdown, personalised recommendations (saved city + wishlist), a trust strip and a
  filterable catalog with sort. The app opens here; the marketing story is under **About GoodSale**.
- **Discounts are real**: a `-30%` badge and struck-through price render only when the seller set a
  higher compare-at price (`016_compare_at_price.sql`). Nothing is invented.
- **Wishlist** is stored locally (`goodsale_wishlist`) and can be filtered from the catalog header.
- **Admin → Products → Edit**: an admin can edit any listing's photos and video, title, price, stock,
  compare-at price, category, brand, condition, description and delivery terms, or delete it. Product
  video needs migration `014_products_video.sql`.
- **Notifications / follows / onboarding**: written to Supabase and reloaded live — they are
  real records, not local-only state

## Scripts

```bash
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
npm run migrate        # apply Supabase SQL (needs SUPABASE_ACCESS_TOKEN)
```
```bash
npm run dev
npm run build && npm run start
npm run lint
npm run typecheck
```

## Docker

```bash
docker compose up --build
```

Pass the same env vars into the compose service.

## Need help wiring credentials?

Add the Supabase + Paystack values to Cursor / Vercel / Docker secrets (or `.env.local`) and re-run. Without them the UI stays empty and the amber setup banner explains what is missing.


## Rust API and security services

The Rust API is being introduced as the backend migration target. Run it locally with `npm run backend:dev`, or use Docker Compose to start the Next.js app, Rust API and Redis together.

```bash
npm run backend:test
npm run backend:check
```

Before running Compose, set a strong random `RATE_LIMIT_SHARED_SECRET` in `.env.local`. The Next.js middleware uses that secret to ask the Rust service for shared Redis-backed rate-limit decisions. Redis is internal to the Compose network and is not published to the host.

**Migration status:** media uploads and Paystack order verification are routed to Rust when `RUST_BACKEND_URL` is configured. The rest of the current Next.js API handlers remain in place while their Supabase, checkout, escrow, payout, webhook, delivery and admin contracts are migrated and tested. This is deliberate: financial handlers must retain their idempotency, role checks and exact database RPC semantics.
