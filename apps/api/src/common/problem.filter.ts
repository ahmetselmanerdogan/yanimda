import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

import { safeError } from './safe-error';

const log = new Logger('ProblemFilter');

/**
 * Altyapı geçici olarak yok (Postgres/Redis bağlantısı, failover, yönetici kapatması): 500 değil 503 + Retry-After;
 * istemci (cihaz, konsol) yeniden dener. Kodlar: Node ağ hataları, Postgres 08xxx (bağlantı), 57P0x (kapatma).
 */
const TRANSIENT = /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|08\d{3}|57P0[1-3])$/;

export function isTransient(e: unknown): boolean {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err?.cause?.code ?? err?.code;
  if (code && TRANSIENT.test(code)) return true;
  return /Connection terminated|connection timeout/i.test(err?.cause?.message ?? err?.message ?? '');
}

/** RFC 7807 problem+json hata biçimi (03-teknik-mimari.md "API sözleşmeleri"). PII içermez. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    let status: number;
    let detail: unknown;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      detail = typeof body === 'string' ? body : ((body as { message?: unknown }).message ?? 'Error');
    } else if (isTransient(exception)) {
      log.warn(`[geçici] ${safeError(exception)}`);
      status = HttpStatus.SERVICE_UNAVAILABLE;
      detail = 'Hizmet geçici olarak kullanılamıyor, yeniden deneyin';
    } else {
      log.error(`[unhandled] ${safeError(exception)}`);
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      detail = 'Internal error';
    }
    if (status === HttpStatus.SERVICE_UNAVAILABLE) res.setHeader('Retry-After', '2');
    res
      .status(status)
      .type('application/problem+json')
      .send({
        type: 'about:blank',
        title: HttpStatus[status],
        status,
        detail: Array.isArray(detail) ? detail.join('; ') : String(detail),
      });
  }
}
