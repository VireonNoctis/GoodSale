import type { NextConfig } from 'next';

/**
 * Development note: the Next.js dev bundle is executed through `eval()` (the
 * webpack devtool wraps every module in one) and React Refresh needs it too.
 * A CSP without `'unsafe-eval'` therefore blocks the client bundle from running
 * at all — the HTML still loads, but hydration never happens, so the app is
 * stuck on its server-rendered boot splash. `'unsafe-eval'` is added in
 * development only; the production policy stays strict.
 */
const isDev = process.env.NODE_ENV !== 'production';

const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  ...(isDev ? ["'unsafe-eval'"] : []),
  'https://js.paystack.co',
  'https://maps.googleapis.com',
].join(' ');

const connectSrc = [
  "'self'",
  // Dev only: HMR / Fast Refresh websockets.
  ...(isDev ? ['ws:', 'wss:'] : []),
  'https://api.paystack.co',
  'https://*.supabase.co',
  'wss://*.supabase.co',
  'https://generativelanguage.googleapis.com',
  'https://maps.googleapis.com',
  'https://*.googleapis.com',
  'https://*.gstatic.com',
  'https://api.resend.com',
  'https://*.upstash.io',
].join(' ');

const securityHeaders = [
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
  { key: 'Origin-Agent-Cluster', value: '?1' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',      // Camera and microphone are both required for the in-chat WebRTC calls,
      // so both are scoped to this origin rather than denied outright.
      value: 'camera=(self), microphone=(self), geolocation=(self), payment=(self)',
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      `script-src ${scriptSrc}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https: http:",
      // Product/chat/ads video (Supabase Storage or Cloudinary) plus local blobs.
      "media-src 'self' blob: https: http:",
      "font-src 'self' data: https://fonts.gstatic.com",
      `connect-src ${connectSrc}`,
      "frame-src 'self' https://js.paystack.co https://checkout.paystack.com https://*.paystack.co https://www.google.com https://maps.google.com https://www.google.com/maps/ https://maps.googleapis.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // The preview is served through a proxy origin, so dev asset requests arrive
  // cross-origin. Declaring it here keeps HMR and /_next/* loading working.
  allowedDevOrigins: ['*.e2b.app'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
