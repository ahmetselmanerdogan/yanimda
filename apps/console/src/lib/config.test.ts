import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { BootConfigError, BootGate, bootGateCode } from '../BootGate';
import {
  CONFIG_URL,
  configProblem,
  loadRuntimeConfig,
  parseRuntimeConfig,
  resetRuntimeConfig,
  runtimeConfig,
  runtimeConfigProblem,
} from './config';
import { action, t } from './i18n';

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

describe('üretimde eksik yapılandırma ölümcül (Caddy boş CONSOLE_OIDC_AUTHORITY → "")', () => {
  afterEach(resetRuntimeConfig);
  const prod = (raw: unknown) => configProblem(raw, true);

  it('üretim: boş / yok / geçersiz / yerel oidcAuthority → O-UI-CONFIG-MISSING', () => {
    expect(prod({ oidcAuthority: '', oidcClientId: 'console', apiBase: '' })).toBe('O-UI-CONFIG-MISSING');
    expect(prod({ oidcAuthority: '   ' })).toBe('O-UI-CONFIG-MISSING');
    expect(prod({})).toBe('O-UI-CONFIG-MISSING');
    expect(prod(null)).toBe('O-UI-CONFIG-MISSING');
    expect(prod({ oidcAuthority: 'bozuk adres' })).toBe('O-UI-CONFIG-MISSING');
    expect(prod({ oidcAuthority: 'http://localhost:8080/realms/operations' })).toBe('O-UI-CONFIG-MISSING');
    expect(prod({ oidcAuthority: 'http://127.0.0.1:8080/realms/operations' })).toBe('O-UI-CONFIG-MISSING');
    expect(prod({ oidcAuthority: 'http://keycloak.localhost/realms/operations' })).toBe('O-UI-CONFIG-MISSING');
    expect(prod({ oidcAuthority: 'https://auth.yanimda.example/realms/operations' })).toBeNull();
  });

  it('geliştirme ve dosyasız önizleme derleme değerleriyle sürer', () => {
    expect(configProblem({ oidcAuthority: '' }, false)).toBeNull();
    expect(configProblem(undefined, true)).toBeNull(); // vite preview / Playwright: /config.json yok
  });

  it('açılış: yüklenen /config.json’a göre karar; dosya yoksa sorun yok', async () => {
    await loadRuntimeConfig(() => Promise.resolve(response('{"oidcAuthority":"","oidcClientId":"","apiBase":""}')));
    expect(runtimeConfigProblem(true)).toBe('O-UI-CONFIG-MISSING');
    expect(runtimeConfigProblem(false)).toBeNull();
    await loadRuntimeConfig(() => Promise.resolve(response('{}', true, 'text/html')));
    expect(runtimeConfigProblem(true)).toBeNull();
  });
});

describe('açılış kapısı (parça 404 / yapılandırma hatası → boş sayfa yerine yenile)', () => {
  it('hata türüne göre katalog metni; yenile düğmesi; App’e bağımlı değil', () => {
    expect(bootGateCode(new TypeError('Failed to fetch dynamically imported module'))).toBe('O-UI-RELOAD');
    expect(bootGateCode(new BootConfigError())).toBe('O-UI-CONFIG-MISSING');
    const html = (code: 'O-UI-RELOAD' | 'O-UI-CONFIG-MISSING') =>
      renderToStaticMarkup(createElement(BootGate, { code, reload: () => undefined }));
    expect(html('O-UI-RELOAD')).toContain(t('O-UI-RELOAD'));
    expect(html('O-UI-RELOAD')).toContain(`>${action('O-UI-RELOAD')}</button>`);
    expect(html('O-UI-CONFIG-MISSING')).toContain(t('O-UI-CONFIG-MISSING'));
    expect(action('O-UI-RELOAD')).toBe('Yenile');
  });
});
