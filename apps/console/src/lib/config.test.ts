import { afterEach, describe, expect, it } from 'vitest';

import { CONFIG_URL, loadRuntimeConfig, parseRuntimeConfig, resetRuntimeConfig, runtimeConfig } from './config';

const BUILD = {
  oidcAuthority: 'http://localhost:8080/realms/operations',
  oidcClientId: 'console',
  apiBase: '',
};

const response = (body: string, ok = true, type = 'application/json') =>
  ({
    ok,
    headers: new Headers({ 'content-type': type }),
    json: () => Promise.resolve(JSON.parse(body)),
  }) as unknown as Response;

describe('çalışma zamanı yapılandırması (tek imaj, ortam başına /config.json)', () => {
  afterEach(resetRuntimeConfig);

  it('yüklenmeden önce derleme (VITE_*) değerleri', () => {
    expect(runtimeConfig()).toEqual(BUILD);
  });

  it('/config.json dolu alanları geçersiz kılar, boş alanlar varsayılanda kalır, sondaki / kırpılır', async () => {
    const calls: string[] = [];
    const cfg = await loadRuntimeConfig((url) => {
      calls.push(String(url));
      return Promise.resolve(
        response('{"oidcAuthority":"https://auth.example/realms/operations/","oidcClientId":"","apiBase":"  "}'),
      );
    });
    expect(calls).toEqual([CONFIG_URL]);
    expect(cfg).toEqual({ ...BUILD, oidcAuthority: 'https://auth.example/realms/operations' });
    expect(runtimeConfig()).toBe(cfg);
  });

  it('SPA yedeği (index.html) veya 404: JSON değil → derleme değerleri', async () => {
    expect(await loadRuntimeConfig(() => Promise.resolve(response('{}', true, 'text/html')))).toEqual(BUILD);
    expect(await loadRuntimeConfig(() => Promise.resolve(response('{}', false)))).toEqual(BUILD);
  });

  it('ağ hatası veya bozuk gövde fırlatmaz', async () => {
    expect(await loadRuntimeConfig(() => Promise.reject(new Error('ağ')))).toEqual(BUILD);
    expect(parseRuntimeConfig(null)).toEqual(BUILD);
    expect(parseRuntimeConfig({ oidcAuthority: 42, apiBase: ['x'] })).toEqual(BUILD);
  });
});
