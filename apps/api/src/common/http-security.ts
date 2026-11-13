import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';

/**
 * T-081 (ASVS 14.3.3, 14.4.1–14.4.7, 8.2.1, 7.1.4) HTTP güvenliği. Ters vekil (Caddy) HSTS'yi ekler; burada API'nin
 * kendisi vekil olmadan da güvenli başlıklarla döner. Hassas veri (profil, kişi listesi, sağlık) önbelleğe alınmaz:
 * varsayılan `no-store`, yalnız cihaz yapılandırması kendi `private, no-cache` + ETag'ini yazar.
 */
type Req = { headers: Record<string, string | string[] | undefined>; id?: string };
type Res = { setHeader(k: string, v: string): unknown; removeHeader(k: string): unknown };
type Next = () => void;

const REQ_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Korelasyon kimliği: vekilden / istemciden gelen geçerli `X-Request-Id` korunur, yoksa üretilir; yanıta yazılır. */
export function requestId(req: Req, res: Res, next: Next) {
  const h = req.headers['x-request-id'];
  const v = Array.isArray(h) ? h[0] : h;
  req.id = v && REQ_ID.test(v) ? v : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

export function securityHeaders(_req: unknown, res: Res, next: Next) {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  // JSON API: hiçbir kaynak yüklenmez, çerçevelenmez. Konsol / aile web CSP'si vekilde (infra/caddy/Caddyfile).
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  // ASVS 14.4.2: yanıt tarayıcıda belge olarak yorumlanmaz; kayıt indirme gibi uçlar kendi değerini yazar.
  res.setHeader('Content-Disposition', 'attachment; filename="api.json"');
  next();
}

/**
 * T-081 (ASVS 13.1.5, 13.2.5) içerik türü denetimi. Gövdeli her istek yalnız `application/json` olabilir (Express
 * JSON ayrıştırıcısının ayrıştırdığı tek tür; `+json` türleri ayrıştırılmadığı için kabul edilmez); form (`application/x-www-form-urlencoded`) yalnız Twilio / CPaaS ve iyzico geri
 * çağrısı gibi form gönderen webhook rotalarında — orada da yalnız form. Aksi 415 (problem+json). Express gövde
 * ayrıştırıcılarından önce çalışır: JSON uçlarında urlencoded gövde hiç ayrıştırılmaz. Gövdesiz istek serbest.
 */
const FORM_ROUTES = [
  /^\/v1\/webhooks\/cpaas\/[^/]+\/?$/i,
  /^\/v1\/webhooks\/cpaas-inbound\/[^/]+\/?$/i,
  /^\/v1\/webhooks\/screening\/[^/]+\/?$/i,
  /^\/v1\/webhooks\/notify\/sms\/?$/i,
  /^\/v1\/payments\/iyzico\/callback\/?$/i,
];
const JSON_TYPE = 'application/json';
const FORM_TYPE = 'application/x-www-form-urlencoded';

type BodyReq = { headers: Record<string, string | string[] | undefined>; originalUrl?: string; url?: string };
type ProblemRes = { statusCode: number; setHeader(k: string, v: string): unknown; end(body: string): unknown };

const hasBody = (req: BodyReq) =>
  req.headers['transfer-encoding'] !== undefined ||
  (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== 0);

export const isFormRoute = (path: string) => FORM_ROUTES.some((r) => r.test(path));

export function contentTypeGuard(req: BodyReq, res: ProblemRes, next: Next) {
  if (!hasBody(req)) return next();
  const raw = req.headers['content-type'];
  const type = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0]?.trim().toLowerCase() ?? '';
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0]!;
  if (type === (isFormRoute(path) ? FORM_TYPE : JSON_TYPE)) return next();
  res.statusCode = 415;
  res.setHeader('Content-Type', 'application/problem+json');
  res.end(
    JSON.stringify({
      type: 'about:blank',
      title: 'UNSUPPORTED_MEDIA_TYPE',
      status: 415,
      detail: 'Desteklenmeyen içerik türü',
    }),
  );
}

/** main.ts: Express sürüm başlığı kapalı, vekil arkasında gerçek istemci IP'si (`TRUST_PROXY` atlama sayısı). */
export function configureHttpSecurity(app: INestApplication, env: NodeJS.ProcessEnv = process.env) {
  const express = app.getHttpAdapter().getInstance() as {
    disable(k: string): void;
    set(k: string, v: unknown): void;
  };
  express.disable('x-powered-by');
  const hops = Number(env.TRUST_PROXY ?? 0);
  if (Number.isInteger(hops) && hops > 0) express.set('trust proxy', hops);
  app.use(requestId);
  app.use(securityHeaders);
  // Nest gövde ayrıştırıcılarını init()'te ekler; app.use ile eklenen bu denetim onlardan önce çalışır.
  app.use(contentTypeGuard);
}
