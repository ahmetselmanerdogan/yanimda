import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { RULES_DIR, RulesService } from '../src/modules/rules/rules.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-012 · D-02 Kural paketi: YAML → JSON Schema doğrulama → chain.procedure_template'e sürümlü kayıt →
 * sıcak yükleme. Kabul: sıcak yükleme sonrası yeni pencere süresi uygulanır.
 */
let h: Harness;
let dir: string;
const file = () => join(dir, 'tr.yaml');
/** Depodaki paketin sürümü (testler buna göre artırır). */
const BASE = (YAML.parse(readFileSync(join(RULES_DIR, 'tr.yaml'), 'utf8')) as { version: number }).version;
const edit = (fn: (doc: Record<string, unknown>) => void) => {
  const doc = YAML.parse(readFileSync(file(), 'utf8'));
  fn(doc);
  writeFileSync(file(), YAML.stringify(doc));
};
const fallWindow = (doc: Record<string, unknown>, sec: number) => {
  const rules = doc.rules as { type: string; devicePrompt?: { windowSec?: number } }[];
  rules.find((r) => r.type === 'FALL')!.devicePrompt!.windowSec = sec;
};
const templates = () =>
  h.rows<{ country: string; version: number; checksum: string }>(
    'SELECT country, version, checksum FROM chain.procedure_template ORDER BY version',
  );

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.pg.exec('TRUNCATE chain.procedure_template');
  dir = mkdtempSync(join(tmpdir(), 'rules-'));
  copyFileSync(join(RULES_DIR, 'tr.yaml'), file());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(async () => {
  await h.close();
});

describe('RulesService', () => {
  it('açılışta paketi doğrular ve sürümüyle kaydeder', async () => {
    const rules = new RulesService(h.db, { dir });
    await rules.init();
    expect(rules.current()).toMatchObject({ country: 'TR', version: BASE });
    expect(await templates()).toEqual([{ country: 'TR', version: BASE, checksum: expect.any(String) }]);
  });

  it('aynı içerik yeniden yüklenirse değişiklik yok', async () => {
    const rules = new RulesService(h.db, { dir });
    await rules.init();
    expect(await rules.reload()).toMatchObject({ version: BASE, changed: false });
    expect(await templates()).toHaveLength(1);
  });

  it('sürüm artırılmadan içerik değişirse reddedilir (409), geçerli paket değişmez', async () => {
    const rules = new RulesService(h.db, { dir });
    await rules.init();
    edit((doc) => fallWindow(doc, 30));
    await expect(rules.reload()).rejects.toMatchObject({ status: 409 });
    expect(rules.current().rules.find((r) => r.type === 'FALL')!.devicePrompt!.windowSec).toBe(60);
  });

  it('daha düşük sürüm reddedilir (409)', async () => {
    const rules = new RulesService(h.db, { dir });
    edit((doc) => (doc.version = BASE + 2));
    await rules.init();
    edit((doc) => (doc.version = BASE + 1));
    await expect(rules.reload()).rejects.toMatchObject({ status: 409 });
  });

  it('şemaya uymayan paket reddedilir (400), geçerli paket değişmez', async () => {
    const rules = new RulesService(h.db, { dir });
    await rules.init();
    edit((doc) => {
      doc.version = BASE + 1;
      (doc.rules as { priority: number }[])[0].priority = 9;
    });
    await expect(rules.reload()).rejects.toMatchObject({ status: 400 });
    expect(rules.current().version).toBe(BASE);
    expect(await templates()).toHaveLength(1);
  });

  it('katalogda olmayan TTS kodu reddedilir (mesaj uydurulmaz)', async () => {
    const rules = new RulesService(h.db, { dir });
    await rules.init();
    edit((doc) => {
      doc.version = BASE + 1;
      (doc.rules as { type: string; devicePrompt?: { tts?: string } }[]).find(
        (r) => r.type === 'FALL',
      )!.devicePrompt!.tts = 'W-YOK-1';
    });
    await expect(rules.reload()).rejects.toMatchObject({ status: 400 });
  });

  it('T-089 operatör sorusu saat kanalında bir katalog kodu olmalı (P-* / olmayan kod 400)', async () => {
    const rules = new RulesService(h.db, { dir });
    await rules.init();
    for (const tts of ['W-YOK-1', 'P-CHARGE-NOW']) {
      edit((doc) => {
        doc.version = BASE + 1;
        (doc.ladder as { operatorPrompt: { tts: string } }).operatorPrompt.tts = tts;
      });
      await expect(rules.reload()).rejects.toMatchObject({ status: 400 });
    }
    expect(rules.current().ladder?.operatorPrompt).toEqual({ windowSec: 60, tts: 'W-INACT-1' });
  });

  it('diğer API örneği yeni sürümü veritabanından alır (refresh)', async () => {
    const a = new RulesService(h.db, { dir });
    const b = new RulesService(h.db, { dir });
    await a.init();
    await b.init();
    edit((doc) => {
      doc.version = BASE + 1;
      fallWindow(doc, 30);
    });
    await a.reload();
    expect(b.current().version).toBe(BASE);
    expect(await b.refresh()).toBe(true);
    expect(b.current().version).toBe(BASE + 1);
  });
});

describe('Sıcak yükleme → yeni pencere süresi uygulanır (kabul)', () => {
  it('FALL penceresi 60 sn → yeniden yükleme → 30 sn', async () => {
    const rules = new RulesService(h.db, { dir });
    await rules.init();
    const timers = new InMemoryTimers();
    const events = h.events(timers, rules);
    const deliver = (s: ReturnType<typeof sig>) =>
      bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);

    await deliver(sig('FALL', { protectedPersonId: 'pp-1' }));
    edit((doc) => {
      doc.version = BASE + 1;
      fallWindow(doc, 30);
    });
    expect(await rules.reload()).toMatchObject({ version: BASE + 1, changed: true });
    await deliver(sig('FALL', { protectedPersonId: 'pp-2' }));

    const all = await events.all();
    const id = (p: string) => all.find((e) => e.protectedPersonId === p)!.id;
    expect(timers.delayOf(`${id('pp-1')}.prompt-expire`)).toBe(60_000);
    expect(timers.delayOf(`${id('pp-2')}.prompt-expire`)).toBe(30_000);
  });
});
