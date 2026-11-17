import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

/**
 * Kural paketi şeması sıkı (denetim bulgusu 2/3/4/16): bilinmeyen anahtar yazım hatasıdır, sessizce yok sayılmaz;
 * motorun okumadığı alan pakette taşınmaz; zincir adımı yalnız prosedür paketinde tanımlı adım türlerinden olur.
 */
const DIR = join(__dirname, '../../../packages/rules');
const schema = JSON.parse(readFileSync(join(DIR, 'schema.json'), 'utf8')) as {
  properties: { rules: { items: { properties: { chain: { items: { pattern: string } } } } } };
};
const validate = new Ajv2020({ allErrors: true }).compile(schema);
const read = (f: string) => YAML.parse(readFileSync(join(DIR, f), 'utf8')) as Record<string, unknown>;
const tr = () => read('tr.yaml') as { rules: Record<string, unknown>[] } & Record<string, unknown>;

describe('kural paketi şeması', () => {
  it('tr.yaml geçerli', () => {
    expect(validate(tr())).toBe(true);
  });

  it('kökte bilinmeyen anahtar reddedilir (ör. yazım hatası "coverge")', () => {
    expect(validate({ ...tr(), coverge: { onlineMin: { A: 15, B: 30 } } })).toBe(false);
  });

  it.each([
    ['escalateWhen', { escalateWhen: { noAnswer: true } }],
    ['activeHours', { activeHours: { useSleepWindow: true } }],
    ['silenceIsEmergencySec', { silenceIsEmergencySec: 20 }],
  ])('motorun okumadığı kural alanı reddedilir: %s', (_, extra) => {
    const doc = tr();
    Object.assign(
      doc.rules.find((r) => r.type === 'FALL')!,
      extra,
    );
    expect(validate(doc)).toBe(false);
  });

  it('devicePrompt.repeatVibrateSec ve coverage.locationStaleMin reddedilir', () => {
    const a = tr();
    (a.rules.find((r) => r.type === 'FALL')!.devicePrompt as Record<string, unknown>).repeatVibrateSec = 5;
    expect(validate(a)).toBe(false);
    const b = tr();
    (b.coverage as Record<string, unknown>).locationStaleMin = 30;
    expect(validate(b)).toBe(false);
  });

  it('zincir adım türleri prosedür paketindekilerle aynı (DISPATCH_PRIVATE gibi tanımsız adım yok)', () => {
    const steps = Object.keys((read('procedures.tr.yaml') as { steps: Record<string, unknown> }).steps).sort();
    const pattern = schema.properties.rules.items.properties.chain.items.pattern;
    const kinds = [
      ...new Set(
        pattern
          .replace(/^\^\(|\)\$$/g, '')
          .split('|')
          .map((s) => s.split(':')[0]!),
      ),
    ].sort();
    expect(kinds).toEqual(steps);
    const doc = tr();
    (doc.rules[0]!.chain as string[]).push('DISPATCH_PRIVATE');
    expect(validate(doc)).toBe(false);
  });
});
