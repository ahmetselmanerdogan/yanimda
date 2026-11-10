import { randomBytes } from 'node:crypto';

import { ConsoleLogger, Logger, type LoggerService } from '@nestjs/common';
import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bus } from '../src/common/bus';
import { FieldCipher } from '../src/common/field-cipher';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import { EnrollmentService } from '../src/modules/device/enrollment.service';
import { ProtectionService } from '../src/modules/event/protection.service';
import { loadRulePack, staticRules } from '../src/modules/event/rules.loader';
import type { Actor } from '../src/modules/profile/contacts';
import { ProfileService } from '../src/modules/profile/profile.service';
import { FakeProvider } from '../src/modules/telephony/fake-cpaas';
import { MemoryRecordingStore } from '../src/modules/telephony/recording-store';
import { TelephonyService, type WebhookKind } from '../src/modules/telephony/telephony.service';
import { TwilioProvider } from '../src/modules/telephony/twilio';
import { createHarness, type Harness, sig } from './support/harness';
import { scanPii, validTckn } from './support/pii-scan';

/**
 * T-081 adım 3 PII denetimi (CLAUDE.md: "log'lara PII yazılmaz"). Kabul:
 *  - tarayıcı telefon, TC kimlik, e-posta, token, adres, konum, tıbbi terim kalıplarını yakalar; UUID/zamanı yakalamaz
 *  - kişi/tıbbi veri/rehber/olay/arama akışları boyunca yazılan TÜM log'larda (Nest Logger + console) PII yok
 * Uçtan uca log'lar CI'da `test/e2e/pii-audit-cli.ts` ile ayrıca taranır.
 */
describe('PII tarayıcısı', () => {
  const kinds = (s: string, lits?: string[]) => scanPii(s, lits).map((f) => f.kind);

  it('kalıpları yakalar', () => {
    expect(kinds('arama +905551112233 başladı')).toContain('phone');
    expect(kinds('aranan 0555 111 22 33')).toContain('phone');
    expect(kinds('tc=10000000146')).toEqual(['tckn']);
    expect(kinds('kime: ayse@example.com')).toContain('email');
    expect(kinds('auth eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvcC0xIn0.c2ln')).toContain('jwt');
    expect(kinds('Authorization: Bearer abcdefghijklmnop0123456789')).toContain('bearer');
    expect(kinds('IBAN TR33 0006 1005 1978 6457 8413 26')).toContain('iban');
    expect(kinds('Bağdat Cd. No:1 D:3')).toContain('address');
    expect(kinds('Moda Mahallesi')).toContain('address');
    expect(kinds('konum 40.98731, 29.02912')).toContain('coordinates');
    expect(kinds('Tanı: Tip 2 Diyabet, ilaç: Metformin')).toContain('medical');
    expect(kinds('kişi Ayşe Y. çağrıldı', ['Ayşe Y.'])).toEqual(['literal']);
  });

  it('kimlik, zaman, durum kodu ve sayaçları yakalamaz; bulgu değeri maskelidir', () => {
    const line =
      '[Nest] 5508  - 11/10/2026, 2:59:23 AM  WARN [EventService] KUYRUK: FALL P1 olay=01a1c2c0-9724-799d-92b7-97b5fdd2a815 ' +
      '2026-11-10T00:01:51.123Z HTTP 503 error(08P01) 1794268942709 accepted=12 attempts=3 port=55432';
    expect(scanPii(line)).toEqual([]);
    expect(validTckn('12345678901')).toBe(false);
    const [f] = scanPii('+905551112233');
    expect(f!.sample).not.toContain('5551112233');
  });
});

describe('log’larda PII yok (akış boyunca)', () => {
  const PHONE = { watch: '+905550000005', elder: '+905551234567', daughter: '+905559876543' };
  const ALICE: Actor = { kind: 'FAMILY', id: 'fam-alice' };
  const NAME = 'Ayşe Yılmaz';
  const DOOR = 'Anahtar paspasın altında, kod 4512';
  const ADDRESS = { line: 'Bağdat Cd. No:1 D:3', district: 'Kadıköy', city: 'İstanbul' };
  const MED = {
    consentAt: new Date(Date.now() - 60_000).toISOString(),
    conditions: ['Hipertansiyon', 'Tip 2 diyabet'],
    medications: ['Metformin 1000 mg'],
    allergies: ['Penisilin'],
    bloodType: 'A+',
    notes: 'Kalp pili var',
  };
  const lines: string[] = [];
  const capture = (...a: unknown[]) =>
    void lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const logger: LoggerService = {
    log: capture,
    error: capture,
    warn: capture,
    debug: capture,
    verbose: capture,
    fatal: capture,
  };
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    await h.reset();
    Logger.overrideLogger(logger);
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, m).mockImplementation(capture);
  });
  afterAll(async () => {
    Logger.overrideLogger(new ConsoleLogger());
    vi.restoreAllMocks();
    await h.close();
  });

  it(
    'kişi + tıbbi özet + rehber + SOS + kişi kartı + 112 şablonu + arama + CPaaS hatası',
    { timeout: 60_000 },
    async () => {
      const cipher = new FieldCipher(`k1:${randomBytes(32).toString('base64')}`);
      const enrollment = new EnrollmentService(
        h.db,
        h.redis as never,
        new ProtectionService(h.db, h.outbox),
        staticRules(loadRulePack()),
        'test-device-secret-0123456789abcdef',
      );
      const profile = new ProfileService(h.db, cipher, enrollment, {
        geocode: async () => ({ lat: 40.98731, lng: 29.02912 }),
      });
      const fake = new FakeProvider({
        stepMs: 1,
        talkMs: 2,
        transport: async (url, params) => {
          const u = new URL(url);
          await tel.webhook(u.pathname.split('/').at(-1) as WebhookKind, u.searchParams.get('call')!, params);
        },
      });
      const env = {
        CPAAS_WEBHOOK_BASE: 'https://api.test',
        CPAAS_AGENT_NUMBER: '+902120000000',
        CPAAS_SOFTPHONE: 'off',
      };
      // fake'in taşıyıcısı tel'i ilk aramada (tanımdan sonra) kullanır
      const tel = new TelephonyService(h.db, h.outbox, fake, new MemoryRecordingStore(), env);
      const chain = new ChainService(h.db, h.events(new InMemoryTimers()), loadProcedures(), tel, profile);

      const p = await profile.create(ALICE, {
        displayName: NAME,
        birthYear: 1945,
        relation: 'Kızı',
        address: ADDRESS,
        doorAccessNote: DOOR,
      });
      await profile.setMedical(ALICE, p.id, MED);
      await tel.setContacts(p.id, [
        { role: 'WATCH', phone: PHONE.watch },
        { role: 'ELDER', phone: PHONE.elder },
        { role: 'CONTACT', priority: 1, displayName: 'Zeynep Yılmaz', phone: PHONE.daughter },
      ]);
      await bus.deliver<Signal>('signal.received', {
        payload: sig('SOS', { protectedPersonId: p.id, location: { lat: 40.98731, lng: 29.02912, accuracyM: 8 } }),
      } as unknown as KafkaEnvelope<Signal>);
      const [{ id }] = await h.rows<{ id: string }>('SELECT id FROM event.event WHERE protected_person_id = $1', [
        p.id,
      ]);
      await chain.claim(id, 'op-1');
      expect(await chain.personCard(id, 'op-1')).toMatchObject({ displayName: NAME });
      await chain.dispatchScript(id, 'op-1', 'dispatch112');
      await chain.call(id, 1, 'op-1');
      await fake.settled;

      // CPaaS 500 (gövdesinde numara): hata log'a gövdesiz yazılmalı
      const tw = new TwilioProvider(
        { accountSid: 'AC1', authToken: 'tok', from: '+908500000000' },
        (async () => new Response(`{"message":"bad To ${PHONE.elder}"}`, { status: 500 })) as unknown as typeof fetch,
      );
      const tel500 = new TelephonyService(h.db, h.outbox, tw, null, env);
      const chain500 = new ChainService(h.db, h.events(new InMemoryTimers()), loadProcedures(), tel500, profile);
      await chain500.call(id, 1, 'op-1'); // aynı adım yeniden: yeni arama, sağlayıcı 500

      expect(lines.length).toBeGreaterThan(0); // akış gerçekten log üretti
      const literals = [
        NAME,
        'Zeynep Yılmaz',
        DOOR,
        ADDRESS.line,
        'Kadıköy',
        ...Object.values(PHONE).map((x) => x.slice(3)),
        ...MED.conditions,
        ...MED.medications,
        ...MED.allergies,
        MED.notes,
      ];
      const findings = scanPii(lines.join('\n'), literals);
      expect(
        findings,
        findings.map((f) => `${f.kind}@${f.line}: ${lines[f.line - 1]?.slice(0, 80)}`).join('\n'),
      ).toEqual([]);
    },
  );
});
