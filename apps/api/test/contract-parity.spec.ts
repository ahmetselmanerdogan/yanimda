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
   * Üretimde okunan (gizli veya ortama özgü) değişkenler: VPS compose şablonu (infra/.env.prod.api.example; api/worker/
   * migrate `env_file`) ve Helm (values.yaml api.env/Secret anahtar listesi veya şablonlar) bunları bilmeli. Yeni bir
   * üretim değişkeni eklenince buraya, .env.prod.api.example'a ve Helm'e birlikte eklenir.
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

  it('üretim değişkenleri API kaynağında okunuyor, infra/.env.prod.api.example ve Helm’de var', () => {
    const source = files(SRC)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    expect(PRODUCTION_REQUIRED.filter((k) => !source.includes(k))).toEqual([]);

    const prod = readFileSync(join(ROOT, 'infra/.env.prod.api.example'), 'utf8');
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

  /**
   * En az yetki (inceleme I1): API kapları yalnız API'nin okuduğu değişkenleri alır. Keycloak yönetici/DB/SMTP, yedek
   * (S3/AWS, yedek DB kullanıcısı), Grafana/dışa aktarıcı ve sonda sırları API ortam şablonunda, compose'un api/worker/
   * migrate env_file'ında ve Helm API Secret'ında yer almaz.
   */
  const FOREIGN_SECRET =
    /^(KC_|YANIMDA_|BACKUP_|GRAFANA_|GF_|AWS_|PG_EXPORTER_|REDIS_EXPORTER_|SYNTHETIC_CLIENT_SECRET)/;

  it('API ortam şablonunda Keycloak / yedek / izleme sırrı yok; API kodu bunları okumuyor', () => {
    const keys = (p: string) =>
      [...readFileSync(join(ROOT, p), 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    const api = keys('infra/.env.prod.api.example');
    expect(api.length).toBeGreaterThan(40);
    expect(api.filter((k) => FOREIGN_SECRET.test(k))).toEqual([]);
    // Başka servislerin sırları kendi şablonlarında (ve yalnız orada)
    expect(keys('infra/.env.prod.keycloak.example')).toEqual(
      expect.arrayContaining(['KC_DB_PASSWORD', 'KC_BOOTSTRAP_ADMIN_PASSWORD', 'YANIMDA_KC_SMTP_PASSWORD']),
    );
    expect(keys('infra/.env.prod.backup.example')).toEqual(expect.arrayContaining(['AWS_SECRET_ACCESS_KEY']));
    expect(keys('infra/.env.prod.monitoring.example')).toEqual(expect.arrayContaining(['GRAFANA_ADMIN_PASSWORD']));
    // Dağıtım (değişken çözümü) dosyası sırsız
    expect(keys('infra/.env.prod.example').filter((k) => /PASSWORD|SECRET|TOKEN|_KEY$|_DSN$|_URL$/.test(k))).toEqual([
      'PUSHGATEWAY_URL',
    ]);
    // API kaynağı başka servislerin sırlarını okumaz
    const read = new Set(
      files(SRC).flatMap((f) =>
        [...readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!),
      ),
    );
    expect([...read].filter((k) => FOREIGN_SECRET.test(k))).toEqual([]);
  });

  it('compose: api/worker/migrate yalnız .env.prod.api alır; Helm API pod’ları yalnız API Secret’ını bağlar', () => {
    const compose = YAML.parse(readFileSync(join(ROOT, 'infra/docker-compose.prod.yml'), 'utf8'), {
      merge: true,
    }) as { services: Record<string, { env_file?: string[]; environment?: Record<string, unknown> }> };
    for (const s of ['api', 'worker', 'migrate']) {
      const svc = compose.services[s]!;
      expect(svc.env_file, s).toEqual(['.env.prod.api']);
      expect(
        Object.keys(svc.environment ?? {}).filter((k) => FOREIGN_SECRET.test(k)),
        s,
      ).toEqual([]);
    }
    expect(compose.services.keycloak!.env_file).toEqual(['.env.prod.keycloak']);
    expect(compose.services.backup!.env_file).toEqual(['.env.prod.backup']);
    // Hiçbir servis dağıtım dosyasını (tüm değişkenler) env_file olarak almaz
    for (const [name, svc] of Object.entries(compose.services))
      expect(svc.env_file ?? [], name).not.toContain('.env.prod');

    // Helm: API Deployment'ları ve migration Job'u yalnız api.existingSecret'ı (envFrom/secretKeyRef) kullanır.
    const tpl = (f: string) => readFileSync(join(ROOT, 'infra/helm/yanimda/templates', f), 'utf8');
    for (const f of ['api.yaml', 'migrate-job.yaml']) {
      const refs = [...tpl(f).matchAll(/secretRef:\s*\n\s*name: (.+)|secretKeyRef:\s*\n\s*name: (.+)/g)].map((m) =>
        (m[1] ?? m[2])!.trim(),
      );
      expect(refs.length, f).toBeGreaterThan(0);
      expect(
        refs.filter((r) => !/\.Values\.api\.existingSecret/.test(r)),
        f,
      ).toEqual([]);
    }
  });
});

/** Sözleşme bulguları (denetim B1–B5): yanıt şemaları sunucunun gerçekten döndürdüğüyle örtüşür. */
describe('sözleşme eşliği — yanıt şemaları ve sayımlar', () => {
  type Node = Record<string, unknown>;
  const doc = YAML.parse(readFileSync(join(ROOT, 'packages/contracts/openapi.yaml'), 'utf8')) as {
    paths: Record<string, Record<string, Node>>;
    components: { schemas: Record<string, Node> };
  };
  const schemas = doc.components.schemas;
  const at = (n: unknown, ...keys: string[]): Node =>
    keys.reduce<Node>((x, k) => {
      const next = x[k] as Node | undefined;
      if (!next) throw new Error(`openapi: ${keys.join('.')} yok (${k})`);
      return next;
    }, n as Node);
  const enumOf = (name: string) => schemas[name]!.enum as string[];
  const contracts = readFileSync(join(ROOT, 'packages/contracts/src/index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const tsUnion = (name: string) => {
    const body = new RegExp(`export type ${name} =([^;]+);`).exec(contracts)?.[1] ?? '';
    return [...body.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]!);
  };
  const sorted = (xs: string[]) => [...xs].sort();

  it('B1 aile olay adımı `kind`: kural paketinin her adım türü geçerli (chain_step.kind)', () => {
    const procedures = YAML.parse(readFileSync(join(ROOT, 'packages/rules/procedures.tr.yaml'), 'utf8')) as {
      steps: Record<string, unknown>;
    };
    const kinds = Object.keys(procedures.steps);
    expect(kinds).toEqual(expect.arrayContaining(['CALL_VOICE_2', 'CALL_REDIAL', 'CALL_KEY_HOLDER', 'NOTIFY_FAMILY']));
    const famEvent = schemas.FamilyEvent!.allOf as Node[];
    const kind = at(famEvent[1], 'properties', 'steps', 'items', 'properties', 'kind');
    if (kind.enum) expect(kind.enum).toEqual(expect.arrayContaining(kinds));
    else expect(kind.type).toBe('string');
    expect(at(schemas.ChainStep, 'properties', 'kind').type).toBe('string');
  });

  it('B2 DispatchView: sunucu arayüzünün her alanı şemada (followUps dahil)', () => {
    const src = readFileSync(join(SRC, 'modules/chain/dispatch.service.ts'), 'utf8');
    const block = /export interface DispatchView \{([\s\S]*?)\n\}/.exec(src)![1]!;
    const fields = [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
    const props = Object.keys(at(schemas.DispatchView, 'properties'));
    expect(fields).toContain('followUps');
    expect(fields.filter((f) => !props.includes(f))).toEqual([]);
    expect(at(schemas.DispatchView, 'properties', 'followUps').type).toBe('integer');
    const tl = /timeline: \{([\s\S]*?)\}\[\];/.exec(block)![1]!;
    const tlProps = Object.keys(at(schemas.DispatchView, 'properties', 'timeline', 'items', 'properties'));
    expect([...tl.matchAll(/(\w+):/g)].map((m) => m[1]!).filter((f) => !tlProps.includes(f))).toEqual([]);
  });

  it('B3 kayıt / sahte ödeme yanıtlarının gövde şeması var (istemcinin okuduğu alanlar)', () => {
    const body = (path: string) =>
      at(doc.paths[path], 'post', 'responses', '200', 'content', 'application/json', 'schema', 'properties');
    expect(Object.keys(body('/signup/{id}/phone/code'))).toEqual(['phoneVerification', 'devCode']);
    expect(Object.keys(body('/signup/{id}/phone/verify'))).toEqual(['phoneVerified']);
    expect(Object.keys(body('/payments/fake/{ref}/pay'))).toEqual(
      expect.arrayContaining(['received', 'duplicate', 'outcome', 'redirect']),
    );
  });

  it('B4 EventType / EventState bileşenleri contracts ve kural paketiyle aynı; olay türü/durumu alanları $ref', () => {
    const rules = JSON.parse(readFileSync(join(ROOT, 'packages/rules/schema.json'), 'utf8')) as Node;
    const ruleTypes = at(rules, 'properties', 'rules', 'items', 'properties', 'type').enum as string[];
    expect(tsUnion('EventType').length).toBeGreaterThan(10);
    expect(sorted(enumOf('EventType'))).toEqual(sorted(tsUnion('EventType')));
    expect(sorted(enumOf('EventType'))).toEqual(sorted(ruleTypes));
    expect(sorted(enumOf('EventState'))).toEqual(sorted(tsUnion('EventState')));
    const ref = (name: string, k: string) => at(schemas[name], 'properties', k).$ref;
    expect([ref('FamilyEventSummary', 'type'), ref('QueueItem', 'type'), ref('SlaBreach', 'type')]).toEqual(
      Array(3).fill('#/components/schemas/EventType'),
    );
    expect([ref('FamilyEventSummary', 'state'), ref('QueueItem', 'state'), ref('TestStatus', 'state')]).toEqual(
      Array(3).fill('#/components/schemas/EventState'),
    );
  });

  it('YAML akış eşlemesi bozulmadı: özellik adları ve şema anahtarları düz, değerleri null değil', () => {
    // `{ type: integer, description: a (b, c) }` gibi tırnaksız virgül eşlemeyi böler: `c)` anahtar, değer null olur.
    const KEY = /^[A-Za-z0-9_$@.-]+$/;
    const bad: string[] = [];
    const walk = (n: unknown, path: string): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${path}[${i}]`));
      for (const [k, v] of Object.entries(n as Node)) {
        if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v))
          for (const [pk, pv] of Object.entries(v as Node)) {
            if (!KEY.test(pk)) bad.push(`${path}.properties["${pk}"]`);
            if (pv === null || typeof pv !== 'object') bad.push(`${path}.properties.${pk} = ${String(pv)}`);
            else
              for (const [sk, sv] of Object.entries(pv as Node))
                if (!KEY.test(sk) || sv === null) bad.push(`${path}.properties.${pk}["${sk}"]`);
          }
        walk(v, `${path}.${k}`);
      }
    };
    walk(doc, '');
    expect(bad).toEqual([]);
  });

  it('setThresholds inactivityMin sınırları kural paketi INACTIVITY.thresholdMin min–max ile aynı', () => {
    const pack = YAML.parse(readFileSync(join(ROOT, 'packages/rules/tr.yaml'), 'utf8')) as {
      rules: { type: string; thresholdMin?: { min: number; max: number } }[];
    };
    const t = pack.rules.find((r) => r.type === 'INACTIVITY')!.thresholdMin!;
    const op = at(doc.paths['/protected-persons/{id}/thresholds'], 'put');
    expect(op.operationId).toBe('setThresholds');
    const prop = at(op, 'requestBody', 'content', 'application/json', 'schema', 'properties', 'inactivityMin');
    expect([prop.minimum, prop.maximum]).toEqual([t.min, t.max]);
    expect(at(op).description).toContain(`(${t.min}–${t.max})`);
  });

  it('amir kapsama panosu dispatch112 olay türü contracts ile openapi’de aynı', () => {
    const line = /dispatch112: \{([^}]*)\}\[\];/.exec(contracts)![1]!;
    const ts = [.../eventType: ([^;]+);/.exec(line)![1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
    const find = (n: unknown): Node | undefined => {
      if (!n || typeof n !== 'object') return undefined;
      const o = n as Node;
      if (o.dispatch112) return o.dispatch112 as Node;
      for (const v of Object.values(o)) {
        const f = find(v);
        if (f) return f;
      }
      return undefined;
    };
    const d = find(doc)!;
    expect(sorted(ts)).toEqual(sorted(at(d, 'items', 'properties', 'eventType').enum as string[]));
  });

  it('B5 cihaz adaptörlerinin sinyal türleri listesi signal.schema.json ve contracts SignalKind ile aynı', async () => {
    const { ALL_SIGNAL_KINDS } = await import('../src/modules/device/device.types');
    const schema = JSON.parse(
      readFileSync(join(ROOT, 'packages/contracts/schemas/signal.schema.json'), 'utf8'),
    ) as Node;
    const kinds = at(schema, 'properties', 'kind').enum as string[];
    expect(sorted(ALL_SIGNAL_KINDS)).toEqual(sorted(kinds));
    expect(sorted(ALL_SIGNAL_KINDS)).toEqual(sorted(tsUnion('SignalKind')));
  });
});
