import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { fail } from '../src/common/catalog-error';

/**
 * M-2: API'nin fırlattığı her HTTP hatası katalog kodu taşır (RFC 7807 `code`); konsol ve aile uygulaması metni
 * kendi kataloğundan gösterir, sunucudan gelen ham Türkçe `detail` ekrana düşmez. Kaynakta düz metinli
 * `new XxxException('…')` kalmadığını ve kullanılan her kodun packages/messages/tr.json'da olduğunu doğrular.
 */
const ROOT = join(__dirname, '../../..');
const SRC = join(__dirname, '../src');
const catalog = JSON.parse(readFileSync(join(ROOT, 'packages/messages/tr.json'), 'utf8')) as Record<
  string,
  { channel: string; text: string }
>;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [p] : [];
  });
}
const files = sources(SRC).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }));

/** `new XxxException('…')`, `new XxxException(\`…\`)` ve `new XxxException({ message: '…' })` düz metinleri. */
const LITERAL = /new [A-Z][A-Za-z]*Exception\(\s*(?:['`]|\{[^}]*message:\s*['`])/g;
/** Katalog kodu geçen yerler: `fail(X, 'KOD'`, `? 'KOD' : 'KOD'`, `code: 'KOD'`, `code = 'KOD'`. */
const CODE = /'([A-Z]-[A-Z0-9-]{2,60})'/g;
const CODE_LINE = /\bfail\(|\bcode\s*[:=]\s*'/;
const CHANNEL: Record<string, string> = { A: 'api', O: 'console', F: 'family', P: 'phone' };

describe('API hataları katalog kodlu (M-2)', () => {
  it('kaynakta düz metinli HttpException kalmadı', () => {
    const hits = files.flatMap(({ path, text }) =>
      [...text.matchAll(LITERAL)].map((m) => `${path}:${text.slice(0, m.index).split('\n').length}`),
    );
    expect(hits).toEqual([]);
  });

  it('fail(...) ve code: ile kullanılan her kod tr.json kataloğunda', () => {
    const used = new Set<string>();
    for (const { text } of files)
      for (const line of text.split('\n'))
        if (CODE_LINE.test(line)) for (const m of line.matchAll(CODE)) used.add(m[1]!);
    expect(used.size).toBeGreaterThan(150);
    expect([...used].filter((c) => !(c in catalog)).sort()).toEqual([]);
  });

  it('*-ERR-* kataloğu kanalı önekiyle uyumlu; metin boş değil', () => {
    const bad = Object.entries(catalog)
      .filter(([k]) => /^[A-Z]-ERR-/.test(k))
      .filter(([k, v]) => v.channel !== CHANNEL[k[0]!] || !v.text.trim())
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('fail(): durum korunur, detail katalog metni, code istemciye; değişkenler ve ek alanlar', () => {
    const nf = fail(NotFoundException, 'F-ERR-PERSON-NOT-FOUND');
    expect(nf.getStatus()).toBe(404);
    expect(nf.getResponse()).toEqual({ message: 'Kişi bulunamadı', code: 'F-ERR-PERSON-NOT-FOUND' });

    const range = fail(BadRequestException, 'A-ERR-FIELD-RANGE', { field: 'days', min: 1, max: 30 });
    expect(range.getStatus()).toBe(400);
    expect(range.getResponse()).toMatchObject({ message: 'days 1–30 arası tam sayı olmalı' });

    const tooMany = fail(HttpStatus.TOO_MANY_REQUESTS, 'A-ERR-RATE-LIMIT');
    expect(tooMany.getStatus()).toBe(429);
    expect(tooMany.getResponse()).toMatchObject({ code: 'A-ERR-RATE-LIMIT' });

    const withExtra = fail(BadRequestException, 'P-ERR-SIGNAL-BATCH-REJECTED', undefined, { rejected: [] });
    expect(withExtra.getResponse()).toEqual({
      message: 'Partide kabul edilebilir sinyal yok',
      code: 'P-ERR-SIGNAL-BATCH-REJECTED',
      rejected: [],
    });

    expect(() => fail(BadRequestException, 'A-ERR-YOK')).toThrow(/kataloğunda yok/);
  });
});
