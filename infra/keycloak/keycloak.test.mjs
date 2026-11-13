// T-081 Keycloak realm/tema/kara liste denetimleri (ağsız). CI: node --test infra/keycloak/
//   ASVS 2.1.1/2.1.7 parola politikası + kara liste, 2.1.8 güç göstergesi, 3.3.2 oturum süreleri,
//   3.5.1 yenileme token'ı döndürme, 5.1.5 yönlendirme izin listesi (geliştirme adresi yalnız varsayılan değer).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { blacklist, expected, paths } from './generate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const realm = (name) => JSON.parse(readFileSync(join(here, `realm-${name}.json`), 'utf8'));
const realms = { operations: realm('operations'), consumers: realm('consumers') };
const DAY = 86_400;

test('üretilmiş dosyalar güncel (generate.mjs --check)', () => {
  for (const [p, content] of Object.entries(expected())) assert.equal(readFileSync(p, 'utf8'), content, p);
});

test('iki realm: length(12) + kara liste dosyası bağlı, tema yanimda', () => {
  const file = 'yanimda-blacklist.txt';
  assert.ok(existsSync(join(here, 'password-blacklists', file)));
  for (const [name, r] of Object.entries(realms)) {
    assert.match(r.passwordPolicy, /(^| and )length\(12\)( and |$)/, name);
    assert.ok(r.passwordPolicy.includes(`passwordBlacklist(${file})`), name);
    assert.equal(r.loginTheme, 'yanimda', name);
    assert.match(r.sslRequired, /^\$\{YANIMDA_KC_SSL_REQUIRED:external\}$/, name);
  }
  assert.ok(existsSync(join(here, 'themes', 'yanimda', 'login', 'theme.properties')));
});

test('consumers: oturum süreleri risk kabulündeki sınırlar içinde, yenileme token döndürme açık', () => {
  const r = realms.consumers;
  assert.ok(r.ssoSessionIdleTimeout <= 14 * DAY);
  assert.ok(r.ssoSessionMaxLifespan <= 30 * DAY);
  assert.ok(r.offlineSessionIdleTimeout <= 14 * DAY);
  assert.equal(r.offlineSessionMaxLifespanEnabled, true);
  assert.ok(r.offlineSessionMaxLifespan <= 30 * DAY);
  assert.equal(r.revokeRefreshToken, true);
  assert.equal(r.refreshTokenMaxReuse, 0);
  assert.ok(r.accessTokenLifespan <= 300);
  const web = r.clients.find((c) => c.clientId === 'family-web');
  assert.ok(Number(web.attributes['client.session.idle.timeout']) <= 1800);
  assert.ok(Number(web.attributes['client.session.max.lifespan']) <= 12 * 3600);
});

test('operations: oturum ≤ 1 sa boşta / 12 sa mutlak', () => {
  assert.ok(realms.operations.ssoSessionIdleTimeout <= 3600);
  assert.ok(realms.operations.ssoSessionMaxLifespan <= 12 * 3600);
});

test('yönlendirme adresleri: sabit uygulama şeması veya ortamdan gelen değer (geliştirme adresi yalnız varsayılan)', () => {
  const placeholder = /^\$\{YANIMDA_[A-Z_]+:[^}]*\}(\/\*)?$/;
  for (const r of Object.values(realms)) {
    for (const c of r.clients.filter((x) => x.standardFlowEnabled)) {
      const uris = [...(c.redirectUris ?? []), ...(c.attributes?.['post.logout.redirect.uris'] ?? '').split('##')];
      if (c.rootUrl) uris.push(c.rootUrl);
      for (const u of uris.filter(Boolean)) {
        assert.ok(u === 'app.yanimda.family:/oauth2redirect' || placeholder.test(u), `${c.clientId}: ${u}`);
        assert.ok(!u.includes('*') || u.endsWith('/*') || u.endsWith('/*}'), `joker yalnız yol sonunda: ${u}`);
      }
      assert.deepEqual(c.webOrigins, ['+'], `${c.clientId}: webOrigins yalnız yönlendirme kökenleri`);
    }
  }
});

test('kara liste: ≥ 12 karakter, sıralı, tekil, yaygın örnekleri içerir, ConfigMap sınırının altında', () => {
  const list = blacklist();
  assert.deepEqual(list, [...new Set(list)].sort());
  assert.ok(list.every((l) => [...l].length >= 12));
  assert.ok(
    list.every((l) => l === l.toLowerCase()),
    'Keycloak küçük harfle arar',
  );
  for (const p of ['galatasaray1905', 'password1234', 'qwertyuiop123', '123456789012', 'yanimda2026!'])
    assert.ok(list.includes(p), p);
  assert.ok(statSync(paths.blacklist).size < 900_000, 'ConfigMap (1 MiB) ve Helm sürüm sırrı için küçük kalmalı');
});

// password-strength.js tarayıcı betiği (window); `module` verilince saf işlevleri dışa aktarır.
const strength = (() => {
  const src = readFileSync(join(here, 'themes/yanimda/login/resources/js/password-strength.js'), 'utf8');
  const sandbox = { module: { exports: {} }, Set, Array, Math, String };
  vm.runInNewContext(src, sandbox);
  return sandbox.module.exports;
})();

test('güç göstergesi: kısa/yaygın zayıf, uzun ve çeşitli güçlü', () => {
  const s = (p) => strength.score(p, 12).score;
  assert.equal(s(''), 0);
  assert.equal(s('Kx9!pLm2#Q'), 0); // 10 karakter < 12
  assert.equal(strength.score('Kx9!pLm2#Q', 12).short, true);
  assert.equal(s('Galatasaray1905'), 0);
  assert.equal(strength.score('Galatasaray1905', 12).weak, true);
  assert.equal(s('123456789012'), 0);
  assert.equal(s('aaaaaaaaaaaaaaa'), 0);
  assert.equal(s('Kxv9!pLm2#Qr'), 2);
  assert.equal(s('Kxv9!pLm2#QrTz7$wN4&'), 4);
  assert.ok(s('mavi deniz sabah kahvesi') >= 3);
  assert.equal(strength.fill('Parola gücü: {level}', { level: 'Orta' }), 'Parola gücü: Orta');
});

test('tema: keycloak.v2 üstüne, betik ve stiller mevcut', () => {
  const props = readFileSync(join(here, 'themes/yanimda/login/theme.properties'), 'utf8');
  assert.match(props, /^parent=keycloak\.v2$/m);
  const res = join(here, 'themes/yanimda/login/resources');
  for (const line of props.split('\n').filter((l) => /^(scripts|styles)=/.test(l)))
    for (const f of line
      .split('=')[1]
      .split(' ')
      .filter((x) => x !== 'css/styles.css'))
      assert.ok(existsSync(join(res, f)), f);
});
