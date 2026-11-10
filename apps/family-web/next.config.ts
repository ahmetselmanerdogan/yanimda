import type { NextConfig } from 'next';

/**
 * T-060 aile web (abonelik). API'ye aynı kökten gidilir (`/v1/*` → API_URL): CORS yok, çerez yok.
 * Sırlar burada değil; tarayıcıya yalnız NEXT_PUBLIC_* (genel) değerler gider.
 */
const api = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${api}/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
