#!/usr/bin/env node
// T-083 sentetik sonda (bağımlılıksız, Node 20 ESM). Bir tur:
//   1) Keycloak consumers realm well-known (kimlik sağlayıcı ayakta mı)
//   2) API erişilebilirliği (kimliksiz ucuz istek → 401 beklenir; 5xx/ağ hatası = başarısız)
//   3) OIDC client-credentials ile token (servis hesabı, FAMILY rolü; sırlar yalnız ortamdan)
//   4) POST /v1/protected-persons/{id}/test-sos (Idempotency-Key) → TEST olayı
//   5) GET …/test-sos/{eventId} yoklaması: durum OPERATOR_QUEUE veya sonrasına ulaşana kadar → süre ölçülür
// Çıktı: Pushgateway (Prometheus metin biçimi) ve/veya Uptime Kuma push URL'i. Başarısızlıkta çıkış kodu 1.
// Token, sır ve kişi verisi LOG'A YAZILMAZ (kişi kimliği yalnız kısaltılmış: ilk 8 karakter).
//
// Kullanım: node probe.mjs          (bir tur)
//           node probe.mjs --dry    (yalnız yapılandırma doğrulaması, ağ yok)
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const QUEUE_OR_LATER = new Set([
  'OPERATOR_QUEUE',
  'OPERATOR_ASSIGNED',
  'CONTACT_CHAIN',
  'CONFIRMED_OK',
  'CONFIRMED_EMERGENCY',
  'DISPATCH',
  'FOLLOW_UP',
  'CLOSED',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loadConfig(env = process.env) {
  const errors = [];
  const req = (k) => {
    const v = (env[k] ?? '').trim();
    if (!v) errors.push(`${k} gerekli`);
    return v;
  };
  const url = (k, v) => {
    try {
      const u = new URL(v);
      if (!/^https?:$/.test(u.protocol)) errors.push(`${k} http(s) olmalı`);
    } catch {
      if (v) errors.push(`${k} geçerli URL değil`);
    }
    return v.replace(/\/+$/, '');
  };
  const cfg = {
    apiUrl: url('SYNTHETIC_API_URL', req('SYNTHETIC_API_URL')),
    issuer: url('SYNTHETIC_OIDC_ISSUER', req('SYNTHETIC_OIDC_ISSUER')),
    clientId: req('SYNTHETIC_CLIENT_ID'),
    clientSecret: req('SYNTHETIC_CLIENT_SECRET'),
    personIds: req('SYNTHETIC_PERSON_IDS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    timeoutSec: Number(env.SYNTHETIC_TIMEOUT_SEC || 60),
    pollMs: Number(env.SYNTHETIC_POLL_MS || 500),
    env: (env.SYNTHETIC_ENV || 'staging').replace(/[^a-z0-9_-]/gi, ''),
    pushgateway: env.PUSHGATEWAY_URL ? url('PUSHGATEWAY_URL', env.PUSHGATEWAY_URL) : '',
    kumaPush: env.UPTIME_KUMA_PUSH_URL ? url('UPTIME_KUMA_PUSH_URL', env.UPTIME_KUMA_PUSH_URL) : '',
  };
  for (const id of cfg.personIds) if (!UUID.test(id)) errors.push('SYNTHETIC_PERSON_IDS yalnız UUID içermeli');
  if (cfg.personIds.length < 3)
    errors.push('SYNTHETIC_PERSON_IDS en az 3 kişi olmalı (10 dk test bekleme süresi, 5 dk aralık)');
  if (!(cfg.timeoutSec > 0 && cfg.timeoutSec <= 600)) errors.push('SYNTHETIC_TIMEOUT_SEC 1–600 olmalı');
  if (!(cfg.pollMs >= 100)) errors.push('SYNTHETIC_POLL_MS ≥ 100 olmalı');
  return { cfg, errors: [...new Set(errors)] };
}

const short = (id) => `${id.slice(0, 8)}…`;
const log = (msg) => console.log(`${new Date().toISOString()} synthetic: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, init = {}, timeoutMs = 10_000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
}

async function checkIssuer(cfg) {
  const r = await http(`${cfg.issuer}/.well-known/openid-configuration`);
  if (r.status !== 200) throw new Error(`well-known HTTP ${r.status}`);
  const body = await r.json();
  if (!body.token_endpoint) throw new Error('well-known: token_endpoint yok');
  return body.token_endpoint;
}

async function checkApi(cfg) {
  const r = await http(`${cfg.apiUrl}/v1/queue`);
  // Kimliksiz istek: 401 = API ayakta ve yönlendirme doğru. 5xx/502 = vekil arkasında kopya yok.
  if (r.status >= 500) throw new Error(`API HTTP ${r.status}`);
}

async function token(cfg, tokenEndpoint) {
  const r = await http(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (r.status !== 200) throw new Error(`token HTTP ${r.status}`);
  const body = await r.json();
  if (typeof body.access_token !== 'string') throw new Error('token yanıtı geçersiz');
  return body.access_token;
}

/**
 * Kişiler sırayla denenir (tur başına başlangıç kişisi değişir). 409 (açık olay) / 429 (10 dk bekleme) → sonraki.
 * Hepsi meşgulse "blocked": TEST olayları operatörce kapatılmıyor demektir (README "Sentetik").
 */
async function startTest(cfg, bearer) {
  const slot = Math.floor(Date.now() / 1000 / 300);
  const n = cfg.personIds.length;
  for (let i = 0; i < n; i++) {
    const id = cfg.personIds[(slot + i) % n];
    const t0 = performance.now();
    const r = await http(`${cfg.apiUrl}/v1/protected-persons/${id}/test-sos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': `synthetic-${randomUUID()}` },
    });
    if (r.status === 409 || r.status === 429) {
      log(`kişi ${short(id)} meşgul (HTTP ${r.status}), sonraki deneniyor`);
      continue;
    }
    if (r.status !== 202 && r.status !== 200) throw new Error(`test-sos HTTP ${r.status}`);
    const body = await r.json();
    if (!UUID.test(body.eventId ?? '')) throw new Error('test-sos yanıtında eventId yok');
    return { id, eventId: body.eventId, state: body.state, t0 };
  }
  return null;
}

async function waitQueue(cfg, bearer, test) {
  const deadline = test.t0 + cfg.timeoutSec * 1000;
  let state = test.state;
  while (!QUEUE_OR_LATER.has(state)) {
    if (state === 'CANCELLED_BY_USER') throw new Error('TEST olayı iptal edildi');
    if (performance.now() > deadline) throw new Error(`zaman aşımı: son durum ${state}`);
    await sleep(cfg.pollMs);
    const r = await http(`${cfg.apiUrl}/v1/protected-persons/${test.id}/test-sos/${test.eventId}`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (r.status !== 200) throw new Error(`test durumu HTTP ${r.status}`);
    state = (await r.json()).state;
  }
  return (performance.now() - test.t0) / 1000;
}

function metrics(cfg, m) {
  const lines = [
    '# HELP synthetic_success Son sentetik tur başarılı mı (1/0)',
    '# TYPE synthetic_success gauge',
    `synthetic_success ${m.success ? 1 : 0}`,
    '# HELP synthetic_blocked Tüm sentetik kişiler açık olay/bekleme nedeniyle meşgul (1/0)',
    '# TYPE synthetic_blocked gauge',
    `synthetic_blocked ${m.blocked ? 1 : 0}`,
    '# HELP synthetic_last_run_timestamp Son turun zamanı (unix sn)',
    '# TYPE synthetic_last_run_timestamp gauge',
    `synthetic_last_run_timestamp ${Math.floor(Date.now() / 1000)}`,
    '# HELP synthetic_check_success Alt kontrol başarısı (1/0)',
    '# TYPE synthetic_check_success gauge',
    ...Object.entries(m.checks).map(([k, v]) => `synthetic_check_success{check="${k}"} ${v ? 1 : 0}`),
  ];
  if (m.seconds !== undefined)
    lines.push(
      '# HELP synthetic_signal_to_queue_seconds test-sos isteği → olay operatör kuyruğunda (sn)',
      '# TYPE synthetic_signal_to_queue_seconds gauge',
      `synthetic_signal_to_queue_seconds ${m.seconds.toFixed(3)}`,
    );
  return `${lines.join('\n')}\n`;
}

async function report(cfg, m) {
  if (cfg.pushgateway) {
    try {
      const r = await http(`${cfg.pushgateway}/metrics/job/synthetic/env/${cfg.env}`, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain; version=0.0.4' },
        body: metrics(cfg, m),
      });
      if (r.status >= 300) log(`uyarı: Pushgateway HTTP ${r.status}`);
    } catch (e) {
      log(`uyarı: Pushgateway'e yazılamadı (${e.name})`);
    }
  }
  if (cfg.kumaPush) {
    try {
      const u = new URL(cfg.kumaPush);
      u.searchParams.set('status', m.success ? 'up' : 'down');
      u.searchParams.set('msg', m.success ? 'OK' : m.error.slice(0, 80));
      if (m.seconds !== undefined) u.searchParams.set('ping', String(Math.round(m.seconds * 1000)));
      await http(u.toString());
    } catch (e) {
      log(`uyarı: Uptime Kuma'ya yazılamadı (${e.name})`);
    }
  }
}

export async function run(cfg) {
  const m = { success: false, blocked: false, checks: {}, seconds: undefined, error: '' };
  try {
    const tokenEndpoint = await checkIssuer(cfg);
    m.checks.oidc = true;
    await checkApi(cfg);
    m.checks.api = true;
    const bearer = await token(cfg, tokenEndpoint);
    m.checks.token = true;
    const test = await startTest(cfg, bearer);
    if (!test) {
      m.blocked = true;
      throw new Error('tüm sentetik kişiler meşgul (açık TEST olayı veya 10 dk bekleme)');
    }
    m.seconds = await waitQueue(cfg, bearer, test);
    m.checks.test_sos = true;
    m.success = true;
    log(`başarılı: kişi ${short(test.id)} kuyruğa ${m.seconds.toFixed(2)} sn'de düştü`);
  } catch (e) {
    for (const k of ['oidc', 'api', 'token', 'test_sos']) m.checks[k] ??= false;
    // Hata iletisinde URL/token yok: yalnız kendi ürettiğimiz metin veya hata türü.
    m.error = e instanceof Error && !(e instanceof TypeError) ? e.message : `ağ hatası (${e?.name ?? 'Error'})`;
    log(`BAŞARISIZ: ${m.error}`);
  }
  await report(cfg, m);
  return m;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { cfg, errors } = loadConfig();
  if (errors.length) {
    for (const e of errors) console.error(`yapılandırma: ${e}`);
    process.exit(2);
  }
  if (process.argv.includes('--dry')) {
    log(
      `yapılandırma geçerli: ${cfg.personIds.length} kişi, zaman aşımı ${cfg.timeoutSec} sn, pushgateway=${cfg.pushgateway ? 'var' : 'yok'}, kuma=${cfg.kumaPush ? 'var' : 'yok'}`,
    );
    process.exit(0);
  }
  const m = await run(cfg);
  process.exit(m.success ? 0 : 1);
}
