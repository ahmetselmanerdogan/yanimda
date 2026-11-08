import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

import { safeError } from './safe-error';

const log = new Logger('ProblemFilter');

/** RFC 7807 problem+json hata biçimi (03-teknik-mimari.md "API sözleşmeleri"). PII içermez. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (!(exception instanceof HttpException)) log.error(`[unhandled] ${safeError(exception)}`);
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = exception instanceof HttpException ? exception.getResponse() : { message: 'Internal error' };
    const detail = typeof body === 'string' ? body : ((body as { message?: unknown }).message ?? 'Error');
    if (status === HttpStatus.SERVICE_UNAVAILABLE) res.setHeader('Retry-After', '2'); // cihaz yeniden dener
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
