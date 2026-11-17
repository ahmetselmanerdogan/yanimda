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
