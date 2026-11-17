import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

/**
 * X-01 / CLAUDE.md: OpenAPI şeması (packages/contracts/openapi.yaml) uçlarla birebir; .env.example API'nin okuduğu
 * her ortam değişkenini listeler. Kaynak metin taranır (Nest uygulaması açılmaz).
 */
const ROOT = join(__dirname, '../../..');
const SRC = join(ROOT, 'apps/api/src');

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')
        ? [join(dir, e.name)]
        : [],
  );

const str = (arg: string) => /^\s*['"`]([^'"`$]*)['"`]\s*$/.exec(arg)?.[1];

/** "@Controller('x')" + "@Get(':id/y')" → "GET /x/{id}/y" (global önek v1 OpenAPI sunucu adresinde). */
function routes() {
  const out: string[] = [];
  const unparsed: string[] = [];
  for (const f of files(SRC)) {
    let prefix: string | undefined;
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const where = `${relative(ROOT, f)}:${i + 1}`;
        const c = /@Controller\((.*)\)/.exec(line);
        if (c) {
          prefix = c[1]!.trim() === '' ? '' : str(c[1]!);
          if (prefix === undefined) unparsed.push(where);
          return;
        }
        const r = /@(Get|Post|Put|Patch|Delete)\((.*?)\)/.exec(line);
        if (!r) return;
        const sub = r[2]!.trim() === '' ? '' : str(r[2]!);
        if (sub === undefined || prefix === undefined) return void unparsed.push(where);
        const path = `/${[prefix, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/:(\w+)/g, '{$1}');
        out.push(`${r[1]!.toUpperCase()} ${path}`);
      });
  }
  return { routes: out, unparsed };
}

describe('sözleşme eşliği', () => {
  it('her uç openapi.yaml’da, her belgelenmiş uç kodda (yol, yöntem, parametre adı)', () => {
    const { routes: code, unparsed } = routes();
    expect(unparsed).toEqual([]);
    const doc = YAML.parse(readFileSync(join(ROOT, 'packages/contracts/openapi.yaml'), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const verbs = ['get', 'post', 'put', 'patch', 'delete'];
    const documented = Object.entries(doc.paths).flatMap(([p, ops]) =>
      Object.keys(ops)
        .filter((m) => verbs.includes(m))
        .map((m) => `${m.toUpperCase()} ${p}`),
    );
    expect(code.length).toBeGreaterThan(100);
    expect([...new Set(code)].filter((r) => !documented.includes(r)).sort()).toEqual([]);
    expect(documented.filter((r) => !code.includes(r)).sort()).toEqual([]);
  });

  it('API’nin okuduğu her ortam değişkeni .env.example’da', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const declared = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
    const used = new Set(
      files(SRC).flatMap((f) =>
        [...readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!),
      ),
    );
    // Platform / çalışma ortamının verdiği değişkenler.
    for (const k of ['NODE_ENV', 'PORT', 'HOSTNAME']) used.delete(k);
    expect([...used].filter((k) => !declared.has(k)).sort()).toEqual([]);
  });

  /**
   * Üretimde okunan (gizli veya ortama özgü) değişkenler: VPS compose şablonu (infra/.env.prod.example, api/worker
   * `env_file`) ve Helm (values.yaml api.env/Secret anahtar listesi veya şablonlar) bunları bilmeli. Yeni bir üretim
   * değişkeni eklenince buraya, .env.prod.example'a ve Helm'e birlikte eklenir.
   */
  const PRODUCTION_REQUIRED = [
    // Veri, şifreleme, cihaz/kayıt token'ları
    'DATABASE_URL',
    'REDIS_URL',
    'FIELD_ENC_KEYS',
    'DEVICE_TOKEN_SECRET',
    'DEVICE_TOKEN_SECRETS',
    'BLE_ADDRESS_PEPPER',
    'SIGNUP_TOKEN_SECRET',
    // Kimlik (Keycloak / OIDC)
    'KEYCLOAK_URL',
    'OIDC_OPERATIONS_ISSUER',
    'OIDC_CONSUMERS_ISSUER',
    'OIDC_AUDIENCE',
    'OIDC_REQUIRE_MFA',
    'KEYCLOAK_SIGNUP_CLIENT_ID',
    'KEYCLOAK_SIGNUP_CLIENT_SECRET',
    'KEYCLOAK_CONSUMERS_REALM',
    'KEYCLOAK_FAMILY_CLIENT_ID',
    // Genel adresler (ödeme dönüşü, sağlayıcı webhook'ları)
    'FAMILY_WEB_URL',
    'PUBLIC_API_URL',
    'CPAAS_WEBHOOK_BASE',
    // Ses kayıtları
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    // Telefoni
    'CPAAS_PROVIDER',
    'CPAAS_AGENT_NUMBER',
    'CPAAS_INBOUND_NUMBER',
    'CPAAS_BACKUP_NUMBER',
    'OPERATOR_CALLER_IDS',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'TWILIO_API_KEY_SID',
    'TWILIO_API_KEY_SECRET',
    'TWILIO_TWIML_APP_SID',
    // Mobil ve web push
    'FCM_PROJECT_ID',
    'FCM_CLIENT_EMAIL',
    'FCM_PRIVATE_KEY',
    'APNS_KEY_ID',
    'APNS_TEAM_ID',
    'APNS_PRIVATE_KEY',
    'APNS_TOPIC',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
    'VAPID_SUBJECT',
    // T-060 abonelik ve ödeme
    'PAYMENT_PROVIDER',
    'IYZICO_API_KEY',
    'IYZICO_SECRET_KEY',
    'IYZICO_MERCHANT_ID',
    'IYZICO_BASE_URL',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'KVKK_NOTICE_VERSION',
    // Bayraklar
    'VITALS_ENABLED',
  ];

  it('üretim değişkenleri API kaynağında okunuyor, infra/.env.prod.example ve Helm’de var', () => {
    const source = files(SRC)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    expect(PRODUCTION_REQUIRED.filter((k) => !source.includes(k))).toEqual([]);

    const prod = readFileSync(join(ROOT, 'infra/.env.prod.example'), 'utf8');
    const prodKeys = new Set([...prod.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
    expect(PRODUCTION_REQUIRED.filter((k) => !prodKeys.has(k))).toEqual([]);

    const helmDir = join(ROOT, 'infra/helm/yanimda');
    const helm = [
      join(helmDir, 'values.yaml'),
      ...readdirSync(join(helmDir, 'templates')).map((f) => join(helmDir, 'templates', f)),
    ]
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    expect(PRODUCTION_REQUIRED.filter((k) => !new RegExp(`\\b${k}\\b`).test(helm))).toEqual([]);
    // Üretimde yönetici kısa yolu yok (T-081 G-4): şablon dosyasında değer atanmış ADMIN_TOKEN olmamalı.
    expect(prod).not.toMatch(/^ADMIN_TOKEN=/m);
  });
});
