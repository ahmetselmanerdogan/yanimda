import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';

/** RFC 7807 problem+json hata biçimi (03-teknik-mimari.md "API sözleşmeleri"). PII içermez. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (!(exception instanceof HttpException))
      console.error('[unhandled]', exception instanceof Error ? exception.message : exception);
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = exception instanceof HttpException ? exception.getResponse() : { message: 'Internal error' };
    const detail = typeof body === 'string' ? body : ((body as { message?: unknown }).message ?? 'Error');
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
