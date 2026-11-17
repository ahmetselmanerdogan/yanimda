import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

/**
 * T-081 (M-1, ASVS 5.1.4 / 13.2.2): openapi.yaml'da `application/json` requestBody'si olan HER yazma işlemi
 * denetleyicide `@Body(new OpenApiBody('<operationId>'))` ile bağlı — ya da aşağıdaki listede gerekçesiyle. Kaynak
 * metin taranır (Nest açılmaz); yeni bir uç şemasız eklenirse bu test kırılır.
 */
const ROOT = join(__dirname, '../../..');
const SRC = join(ROOT, 'apps/api/src');

/** Pipe'sız JSON gövdeli işlemler ve gerekçesi (doğrulama başka yerde, aynı şemayla). */
const EXEMPT: Record<string, { reason: string; file: string; marker: string }> = {
  postSignals: {
    reason: 'Ajv signal.schema.json (dizi, sinyal başına ret ve sayım) SignalService içinde',
    file: 'modules/signal/signal.service.ts',
    marker: 'signal.schema.json',
  },
  partnerWebhook: {
    reason: 'imza ham gövde üzerinden önce; şema imza + tekrar kontrolünden sonra validateBody ile',
    file: 'modules/partner/partner-webhook.service.ts',
    marker: "validateBody('partnerWebhook'",
  },
  paymentWebhook: {
    reason:
      'imza ham gövde üzerinden önce (iyzico V3 imzası çözülmüş alanlar üzerinden); şema yalnız `type: object`, ' +
      'sağlayıcıların parseJson’u nesne olmayan gövdeyi reddeder',
    file: 'modules/billing/providers/provider.ts',
    marker: '!Array.isArray(v)) return v as Record<string, unknown>',
  },
};

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')
        ? [join(dir, e.name)]
        : [],
  );

const str = (arg: string) => /^\s*['"`]([^'"`$]*)['"`]\s*$/.exec(arg)?.[1];

type Spec = {
  paths: Record<string, Record<string, { operationId?: string; requestBody?: RB }>>;
  components: { requestBodies?: Record<string, RB> };
};
type RB = { $ref?: string; content?: Record<string, unknown> };

/** "POST /devices/{id}/commands" → operationId (yalnız application/json gövdeli yazma işlemleri). */
function jsonWriteOps(): Map<string, string> {
  const doc = YAML.parse(readFileSync(join(ROOT, 'packages/contracts/openapi.yaml'), 'utf8')) as Spec;
  const out = new Map<string, string>();
  for (const [path, methods] of Object.entries(doc.paths))
    for (const [m, op] of Object.entries(methods)) {
      if (!['post', 'put', 'patch', 'delete'].includes(m) || !op.requestBody) continue;
      const ref = op.requestBody.$ref?.replace('#/components/requestBodies/', '');
      const rb = ref ? doc.components.requestBodies?.[ref] : op.requestBody;
      if (rb?.content?.['application/json']) out.set(`${m.toUpperCase()} ${path}`, op.operationId!);
    }
  return out;
}

/** Denetleyici yolları ve her yolun işleyicisindeki `OpenApiBody('…')` kimlikleri. */
function controllerRoutes() {
  const routes: { route: string; where: string; pipes: string[] }[] = [];
  for (const f of files(SRC)) {
    let prefix: string | undefined;
    let cur: (typeof routes)[number] | undefined;
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const c = /@Controller\((.*)\)/.exec(line);
        if (c) {
          prefix = c[1]!.trim() === '' ? '' : str(c[1]!);
          cur = undefined;
          return;
        }
        const r = /@(Get|Post|Put|Patch|Delete)\((.*?)\)/.exec(line);
        if (r) {
          const sub = r[2]!.trim() === '' ? '' : str(r[2]!);
          const path = `/${[prefix, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/:(\w+)/g, '{$1}');
          cur = { route: `${r[1]!.toUpperCase()} ${path}`, where: `${relative(ROOT, f)}:${i + 1}`, pipes: [] };
          routes.push(cur);
          return;
        }
        for (const m of line.matchAll(/new OpenApiBody\(\s*'([^']+)'\s*\)/g)) cur?.pipes.push(m[1]!);
      });
  }
  return routes;
}

describe('OpenAPI gövde doğrulaması kapsamı (T-081)', () => {
  const ops = jsonWriteOps();
  const routes = controllerRoutes();

  it('JSON gövdeli her yazma işlemi OpenApiBody ile bağlı ya da gerekçeli listede', () => {
    expect(ops.size).toBeGreaterThan(40);
    const missing: string[] = [];
    for (const [route, opId] of ops) {
      if (EXEMPT[opId]) continue;
      const r = routes.find((x) => x.route === route);
      if (!r?.pipes.includes(opId)) missing.push(`${route} (${opId}) ${r?.where ?? 'denetleyicide yok'}`);
    }
    expect(missing).toEqual([]);
  });

  it('her OpenApiBody kendi yolunun operationId’si (yanlış şema bağlanmamış)', () => {
    const wrong = routes
      .filter((r) => r.pipes.length)
      .filter((r) => r.pipes.length !== 1 || ops.get(r.route) !== r.pipes[0])
      .map((r) => `${r.where} ${r.route}: ${r.pipes.join(',')} ≠ ${ops.get(r.route) ?? '(JSON gövdesi yok)'}`);
    expect(wrong).toEqual([]);
  });

  it('muafiyetler gerçek: işlem sözleşmede, pipe yok, doğrulama gerekçedeki yerde', () => {
    for (const [opId, { reason, file, marker }] of Object.entries(EXEMPT)) {
      expect(reason.length, opId).toBeGreaterThan(20);
      const route = [...ops].find(([, id]) => id === opId)?.[0];
      expect(route, opId).toBeDefined();
      expect(routes.find((r) => r.route === route)?.pipes ?? [], opId).toEqual([]);
      expect(readFileSync(join(SRC, file), 'utf8'), `${opId} → ${file}`).toContain(marker);
    }
  });
});
