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

test('sync-realms: yer tutucular çözülür, var olan istemci/rol atlanır, tüm istemciler gönderilir', async () => {
  const { resolvePlaceholders, syncBody } = await import('./sync-realms.mjs');
  assert.equal(resolvePlaceholders('${YANIMDA_X:http://localhost:1}/*', {}), 'http://localhost:1/*');
  assert.equal(resolvePlaceholders('${YANIMDA_X:a}', { YANIMDA_X: 'b' }), 'b');
  assert.equal(resolvePlaceholders('${YANIMDA_X:}', {}), '');
  const body = syncBody('consumers', {});
  assert.equal(body.ifResourceExists, 'SKIP');
  assert.deepEqual(body.clients.map((c) => c.clientId).sort(), realms.consumers.clients.map((c) => c.clientId).sort());
  assert.ok(body.clients.some((c) => c.clientId === 'family-web'));
  assert.doesNotMatch(JSON.stringify(body), /\$\{YANIMDA_/);
});

test('consumers hizmet hesapları: gizli istemci, sır ortamdan (prod compose/Helm zorunlu), yalnız service account', () => {
  const r = realms.consumers;
  const secrets = {
    'yanimda-signup': 'YANIMDA_SIGNUP_CLIENT_SECRET',
    'yanimda-synthetic': 'YANIMDA_SYNTHETIC_CLIENT_SECRET',
  };
  for (const [clientId, env] of Object.entries(secrets)) {
    const c = r.clients.find((x) => x.clientId === clientId);
    assert.ok(c, clientId);
    assert.equal(c.publicClient, false, clientId);
    assert.equal(c.clientAuthenticatorType, 'client-secret', clientId);
    assert.match(c.secret, new RegExp(`^\\$\\{${env}:dev-only-[a-z-]+\\}$`), clientId);
    assert.equal(c.serviceAccountsEnabled, true, clientId);
    assert.equal(c.standardFlowEnabled, false, clientId);
    assert.equal(c.directAccessGrantsEnabled, false, clientId);
    assert.ok(!c.implicitFlowEnabled, clientId);
  }
  // Üretimde geliştirme varsayılanı kalmaz: prod compose'da keycloak kabı sırrı yalnız .env.prod.keycloak'tan alır
  // (şablonda anahtar var) ve dağıtım ön kontrolü (scripts/prod-preflight.sh) boş/kısa değeri reddeder; Helm her
  // zaman secretKeyRef.
  const compose = readFileSync(join(here, '../docker-compose.prod.yml'), 'utf8');
  const kcEnv = readFileSync(join(here, '../.env.prod.keycloak.example'), 'utf8');
  const preflight = readFileSync(join(here, '../../scripts/prod-preflight.sh'), 'utf8');
  const helm = readFileSync(join(here, '../helm/yanimda/templates/keycloak.yaml'), 'utf8');
  assert.match(compose, /\n {2}keycloak:\n(?: {4}.*\n)*? {4}env_file: \[\.env\.prod\.keycloak\]\n/, 'compose env_file');
  for (const env of Object.values(secrets)) {
    assert.match(kcEnv, new RegExp(`^${env}=`, 'm'), `.env.prod.keycloak.example ${env}`);
    assert.ok(preflight.includes(`minlen "$f" ${env} 32`), `prod-preflight ${env}`);
    assert.doesNotMatch(compose, new RegExp(`${env}: \\$\\{[A-Z_]+:-`), `compose ${env} varsayılansız`);
    assert.match(helm, new RegExp(`- name: ${env}\\n\\s+valueFrom:\\n\\s+secretKeyRef:`), `helm ${env}`);
    assert.doesNotMatch(helm, new RegExp(`\\{\\{-? if[^}]*\\}\\}\\s*- name: ${env}`), `helm ${env} koşulsuz`);
  }
});

test('yanimda-synthetic: yalnız FAMILY rolü, aud=yanimda-api, sub (basic kapsamı) — API OIDC doğrulayıcısının beklediği', () => {
  const r = realms.consumers;
  const c = r.clients.find((x) => x.clientId === 'yanimda-synthetic');
  const aud = c.protocolMappers.find((m) => m.protocolMapper === 'oidc-audience-mapper');
  assert.equal(aud.config['included.custom.audience'], 'yanimda-api');
  assert.equal(aud.config['access.token.claim'], 'true');
  for (const s of ['basic', 'roles']) assert.ok(c.defaultClientScopes.includes(s), s);
  assert.equal(c.fullScopeAllowed, false);
  assert.deepEqual(r.scopeMappings.find((m) => m.client === 'yanimda-synthetic').roles, ['FAMILY']);
  const sa = r.users.find((u) => u.serviceAccountClientId === 'yanimda-synthetic');
  assert.equal(sa.username, 'service-account-yanimda-synthetic');
  assert.deepEqual(sa.realmRoles, ['FAMILY']);
  const signup = r.users.find((u) => u.serviceAccountClientId === 'yanimda-signup');
  assert.deepEqual(signup.clientRoles['realm-management'].sort(), ['manage-users', 'view-users']);
});

test('istemci açıklamaları ≤ 255 karakter (Keycloak sütun sınırı; aşılırsa realm içe aktarma çöker)', () => {
  for (const r of Object.values(realms))
    for (const c of r.clients) assert.ok([...(c.description ?? '')].length <= 255, c.clientId);
});

test('operator-token: form adresi çözülür, TOTP RFC 6238 (SHA1) ile uyumlu, PKCE S256', async () => {
  const { formAction, pkce, totp } = await import('./operator-token.mjs');
  assert.equal(
    formAction(
      '<form id="kc-form-login" action="http://kc/realms/operations/login-actions/authenticate?session_code=a&amp;execution=b" method="post">',
    ),
    'http://kc/realms/operations/login-actions/authenticate?session_code=a&execution=b',
  );
  assert.equal(formAction('<p>form yok</p>'), undefined);
  // RFC 6238 Ek B, SHA1 sırrı "12345678901234567890", T=59 sn → 94287082 (son 6 hane)
  assert.equal(totp('12345678901234567890', 59_000), '287082');
  const { verifier, challenge } = pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
});

test('Keycloak sürümü tek kaynaktan: infra/keycloak/Dockerfile FROM = Helm, dev/prod compose, .env.prod.example', () => {
  const root = join(here, '..', '..');
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const pin = /^FROM (\S+)$/m.exec(read('infra/keycloak/Dockerfile'))?.[1] ?? '';
  assert.match(pin, /^quay\.io\/keycloak\/keycloak:\d+\.\d+/);
  const kc = /^keycloak:\n[\s\S]*?\n {2}image:\n {4}repository: (\S+)\n {4}tag: '([^']+)'/m.exec(
    read('infra/helm/yanimda/values.yaml'),
  );
  assert.equal(kc && `${kc[1]}:${kc[2]}`, pin, 'helm values.yaml keycloak.image');
  assert.ok(read('infra/docker-compose.yml').includes(`image: ${pin}\n`), 'dev compose');
  assert.ok(read('infra/docker-compose.prod.yml').includes(`\${KEYCLOAK_IMAGE:-${pin}}`), 'prod compose varsayılanı');
  assert.ok(read('infra/.env.prod.example').includes(`KEYCLOAK_IMAGE=${pin}\n`), '.env.prod.example');
  // İş akışları sürümü sabit yazmaz, Dockerfile'dan okur.
  for (const wf of ['.github/workflows/ci.yml', '.github/workflows/security.yml']) {
    assert.doesNotMatch(read(wf), /quay\.io\/keycloak\/keycloak:\d/, wf);
  }
});
