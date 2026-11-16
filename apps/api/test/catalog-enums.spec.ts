import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * X-03: istemciler sunucunun döndürdüğü enum değerlerini katalog koduna çevirir (aile `F-UI-STEP-${result}`,
 * konsol `O-UI-COVERAGE-REASON-${reason}` …). Sözleşmeye yeni değer eklenince her kanalın metni de eklenmeli;
 * yoksa aile uygulaması debug'da düşer, sürümde ham kod görünür.
 */
const ROOT = join(__dirname, '../../..');
const catalog = JSON.parse(readFileSync(join(ROOT, 'packages/messages/tr.json'), 'utf8')) as Record<string, unknown>;
const contracts = readFileSync(join(ROOT, 'packages/contracts/src/index.ts'), 'utf8');

/** `export type X = | 'A' | 'B';` birleşimindeki değerler (yorumlar atlanır). */
function union(name: string): string[] {
  const m = new RegExp(`export type ${name} =([^;]*);`).exec(contracts);
  if (!m) throw new Error(`${name} sözleşmede yok`);
  const body = m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return [...body.matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]!);
}

const missing = (codes: string[]) => codes.filter((c) => !(c in catalog));

describe('katalog ↔ sözleşme enumları', () => {
  it('adım sonucu (StepResult): aile F-UI-STEP-*, konsol O-RES-*', () => {
    const r = union('StepResult');
    expect(r).toContain('OFFLINE_SKIPPED');
    expect(missing(r.map((x) => `F-UI-STEP-${x}`))).toEqual([]);
    expect(missing(r.map((x) => (x === 'OFFLINE_SKIPPED' ? 'O-RES-SKIPPED_OFFLINE' : `O-RES-${x}`)))).toEqual([]);
  });

  it('kapsama nedeni (CoverageReason): aile ve konsol', () => {
    const r = union('CoverageReason');
    expect(r.length).toBeGreaterThan(5);
    expect(missing(r.map((x) => `F-UI-COVERAGE-REASON-${x}`))).toEqual([]);
    expect(missing(r.map((x) => `O-UI-COVERAGE-REASON-${x}`))).toEqual([]);
  });

  it('cihaz kategorisi (DeviceCategory): aile ve konsol', () => {
    const r = union('DeviceCategory');
    expect(r).toContain('SENSOR');
    expect(missing(r.map((x) => `F-UI-DEVICE-CAT-${x}`))).toEqual([]);
    expect(missing(r.map((x) => `O-UI-DEV-CAT-${x}`))).toEqual([]);
  });
});
