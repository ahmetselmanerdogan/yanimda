import { Logger } from '@nestjs/common';

/**
 * T-081 (ASVS 7.1.3, 7.2.1, 7.2.2, 11.1.8) güvenlik olayı: kimlik doğrulama (401), erişim kontrolü (403), hız
 * sınırı (429) ve doğrulama (400/422) hataları. Log'a yalnız durum, yöntem, ROTA ŞABLONU (`/v1/x/:id`, ham URL değil)
 * ve istek kimliği yazılır: kimlik, token, gövde, IP yok (PII kuralı). Metrik: `yanimda_security_events_total`
 * (MetricsService bağlar) → Prometheus `SecurityEventsSpike` uyarısı.
 */
export interface SecurityEvent {
  status: number;
  method: string;
  route: string;
  requestId?: string;
}

const SECURITY_STATUSES = new Set([400, 401, 403, 422, 429]);
const log = new Logger('Security');
let sink: ((e: SecurityEvent) => void) | null = null;

export function setSecurityEventSink(fn: ((e: SecurityEvent) => void) | null) {
  sink = fn;
}

export function isSecurityStatus(status: number) {
  return SECURITY_STATUSES.has(status);
}

type Req = { method?: string; route?: { path?: string }; baseUrl?: string; id?: string } | undefined;

/** Eşleşen rota şablonu; rota eşleşmediyse (guard'dan önce düşen istek) sabit `unmatched`. */
export function routeTemplate(req: Req): string {
  const p = req?.route?.path;
  return typeof p === 'string' ? `${req?.baseUrl ?? ''}${p}` : 'unmatched';
}

export function recordSecurityEvent(status: number, req: Req) {
  if (!isSecurityStatus(status)) return;
  const e: SecurityEvent = { status, method: req?.method ?? '-', route: routeTemplate(req), requestId: req?.id };
  const line = `[güvenlik] ${e.status} ${e.method} ${e.route} istek=${e.requestId ?? '-'}`;
  if (status === 400 || status === 422) log.log(line);
  else log.warn(line);
  sink?.(e);
}
