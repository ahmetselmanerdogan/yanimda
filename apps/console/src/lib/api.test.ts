import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, createApi } from './api';
import { t } from './i18n';

const problem = (status: number, body: unknown, type = 'application/problem+json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': type },
  });

describe('ses kaydı indirme hatası (problem+json)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('kaydı olmayan çağrı: ApiError katalog kodu ve metniyle (durum kodu değil)', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return Promise.resolve(problem(404, { status: 404, code: 'O-ERR-RECORDING-NOT-FOUND', detail: 'yok' }));
    });
    const api = createApi(() => Promise.resolve('tok'), '/v1');
    const err = await api.recordingUrl('c1', 'denetim').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('O-ERR-RECORDING-NOT-FOUND');
    expect((err as ApiError).message).toBe(t('O-ERR-RECORDING-NOT-FOUND'));
    expect(calls).toEqual(['/v1/admin/calls/c1/recording?reason=denetim']);
  });

  it('JSON olmayan hata gövdesi: durum kodu', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem(502, '<html>bad gateway</html>', 'text/html')));
    const err = (await createApi(() => Promise.resolve(null), '/v1')
      .recordingUrl('c1', 'x')
      .catch((e: unknown) => e)) as ApiError;
    expect([err.status, err.detail, err.code]).toEqual([502, '502', undefined]);
  });
});
