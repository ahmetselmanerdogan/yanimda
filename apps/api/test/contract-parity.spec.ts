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
