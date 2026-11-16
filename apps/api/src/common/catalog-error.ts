import { HttpException, HttpStatus } from '@nestjs/common';
import { t } from '@yanimda/messages';

type ExceptionCtor = new (body: object) => HttpException;

/**
 * Katalog kodlu HTTP hatası (RFC 7807, ProblemFilter): `detail` katalog metni (log ve curl için okunur), `code`
 * istemcinin kendi kataloğundan göstermesi için (konsol `t(code)`, aile `has(code)`). Metin kataloğun dışına
 * yazılmaz; değişkenler `{alan}` yer tutucularıyla doldurulur.
 *
 * `fail(NotFoundException, 'F-ERR-PERSON-NOT-FOUND')`
 * `fail(HttpStatus.TOO_MANY_REQUESTS, 'A-ERR-RATE-LIMIT')`
 * `fail(BadRequestException, 'A-ERR-FIELD-RANGE', { field: 'days', min: 1, max: 30 })`
 */
export function fail(
  ex: ExceptionCtor | HttpStatus,
  code: string,
  vars?: Record<string, string | number>,
  extra?: object,
): HttpException {
  const body = { message: t(code, 'tr', vars), code, ...extra };
  return typeof ex === 'number' ? new HttpException(body, ex) : new ex(body);
}
