#!/usr/bin/env node
/* eslint-disable no-console -- komut satırı betiği */
/**
 * Geliştirme / CI kullanıcıları (T-020). Üretimde KULLANILMAZ: üretimde kullanıcılar Keycloak yönetim ekranından açılır,
 * ilk girişte parola değişimi ve OTP kurulumu zorunludur.
 *
 *   KEYCLOAK_DEV_PASSWORD=... [KEYCLOAK_DEV_OTP_SECRET=...] node infra/keycloak/dev-users.mjs
 *
 * operations: operator1 (OPERATOR), operator2 (OPERATOR), supervisor1 (SUPERVISOR), admin1 (ADMIN)
 * consumers : family1 (FAMILY)
 * KEYCLOAK_DEV_OTP_SECRET verilirse OTP önceden kayıtlı gelir (otomatik testler TOTP'yi bu sırdan üretir); verilmezse
 * ilk girişte QR ile kurulum istenir. Sır, Keycloak'ın sakladığı düz metindir; uygulamaya girilecek base32 hali yazdırılır.
 */
const KC = (process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const ADMIN_USER = process.env.KEYCLOAK_ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';
const PASSWORD = process.env.KEYCLOAK_DEV_PASSWORD;
const OTP_SECRET = process.env.KEYCLOAK_DEV_OTP_SECRET;

if (!PASSWORD || PASSWORD.length < 12) {
  console.error('KEYCLOAK_DEV_PASSWORD gerekli (en az 12 karakter; operations parola politikası).');
  process.exit(1);
}

async function adminToken() {
  const r = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
    }),
  });
  if (!r.ok) throw new Error(`Keycloak yönetici girişi başarısız: HTTP ${r.status}`);
  return (await r.json()).access_token;
}

const user = (username, roles, otp) => ({
  username,
  enabled: true,
  firstName: username,
  lastName: 'Dev',
  email: `${username}@dev.yanimda.local`,
  emailVerified: true,
  realmRoles: roles,
  requiredActions: [],
  credentials: [
    { type: 'password', value: PASSWORD, temporary: false },
    ...(otp && OTP_SECRET
      ? [
          {
            type: 'otp',
            userLabel: 'dev',
            secretData: JSON.stringify({ value: OTP_SECRET }),
            credentialData: JSON.stringify({
              subType: 'totp',
              digits: 6,
              counter: 0,
              period: 30,
              algorithm: 'HmacSHA1',
            }),
          },
        ]
      : []),
  ],
});

async function partialImport(token, realm, users) {
  const r = await fetch(`${KC}/admin/realms/${realm}/partialImport`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ifResourceExists: 'OVERWRITE', users }),
  });
  if (!r.ok) throw new Error(`${realm}: HTTP ${r.status} ${await r.text()}`);
  const j = await r.json();
  console.log(`${realm}: ${j.overwritten ?? 0} güncellendi, ${j.added ?? 0} eklendi`);
}

function base32(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

const token = await adminToken();
await partialImport(token, 'operations', [
  user('operator1', ['OPERATOR'], true),
  user('operator2', ['OPERATOR'], true),
  user('supervisor1', ['SUPERVISOR'], true),
  user('admin1', ['ADMIN'], true),
]);
await partialImport(token, 'consumers', [user('family1', ['FAMILY'], false)]);
if (OTP_SECRET) console.log(`OTP (authenticator uygulamasına elle): ${base32(Buffer.from(OTP_SECRET))}`);
else console.log('OTP sırrı verilmedi: operations kullanıcıları ilk girişte OTP kuracak.');
