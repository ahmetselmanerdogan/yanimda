import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import catalog from '@yanimda/messages/tr.json';
import { describe, expect, it } from 'vitest';

import type { EventRecord, QueueItem } from './api';
import { t } from './i18n';
import { commandFor, type KeyInput } from './keys';
import { deadline112LeftSec, isDeviceStep, resultCode, systemReason } from './ladder';
import { canTakeOver, keepSelection, queueReducer } from './queue';
import { clock, slaOf } from './sla';
import { viewportOf } from './viewport';

const item = (id: string, priority: number, createdAt: string, state = 'OPERATOR_QUEUE'): QueueItem =>
  ({
    eventId: id,
    type: 'SOS',
    priority,
    state,
    createdAt,
    escalatedAt: createdAt,
    lockedBy: null,
    lockUntil: null,
    isTest: false,
    person: null,
  }) as QueueItem;

describe('canlı kuyruk', () => {
  const a = item('a', 2, '2026-11-09T10:00:00Z');
  const b = item('b', 1, '2026-11-09T10:05:00Z');
  const c = item('c', 1, '2026-11-09T10:01:00Z');
  it('snapshot öncelik → yaş sıralar', () => {
    expect(queueReducer({ items: [] }, { type: 'snapshot', items: [a, b, c] }).items.map((i) => i.eventId)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });
  it('upsert: yeni bekleyen olay "arrived", güncelleme değil; remove', () => {
    let s = queueReducer({ items: [] }, { type: 'snapshot', items: [a] });
    s = queueReducer(s, { type: 'upsert', item: b });
    expect(s.arrived?.eventId).toBe('b');
    s = queueReducer(s, { type: 'upsert', item: { ...b, lockedBy: 'op', state: 'OPERATOR_ASSIGNED' } });
    expect(s.arrived).toBeUndefined();
    expect(s.items.find((i) => i.eventId === 'b')?.lockedBy).toBe('op');
    expect(queueReducer(s, { type: 'remove', eventId: 'b' }).items.map((i) => i.eventId)).toEqual(['a']);
  });
  it('mevcut olaya yeni alarm veya öncelik yükselmesi de "arrived" (ses + uyarı); alarm türü taşınır', () => {
    let s = queueReducer({ items: [] }, { type: 'snapshot', items: [a, { ...b, priority: 4, type: 'CALLBACK' }] });
    s = queueReducer(s, { type: 'upsert', item: { ...b, priority: 1, type: 'SOS' } });
    expect(s.arrived?.eventId).toBe('b'); // kuyruktaki P4 olay SOS'a yükseldi
    s = queueReducer(s, { type: 'upsert', item: { ...b, state: 'CONTACT_CHAIN', lockedBy: 'op' } });
    expect(s.arrived).toBeUndefined();
    s = queueReducer(s, { type: 'upsert', item: { ...b, state: 'CONTACT_CHAIN', lockedBy: 'op' }, alarm: 'FALL' });
    expect(s.arrived?.eventId).toBe('b');
    expect(s.alarm).toBe('FALL');
  });
  it('seçim korunur; seçili düşerse aynı sıradaki olaya geçer', () => {
    expect(keepSelection([c, b, a], [c, b, a], 'b')).toBe('b');
    expect(keepSelection([c, b, a], [c, a], 'b')).toBe('a');
    expect(keepSelection([c, b, a], [c], 'a')).toBe('c');
    expect(keepSelection([], [c], null)).toBe('c');
    expect(keepSelection([c], [], 'c')).toBeNull();
  });
});

describe('SLA sayaçları', () => {
  const now = Date.parse('2026-11-09T10:00:30Z');
  it('olay yaşı ve üstlenmeye kalan (10 sn)', () => {
    const s = slaOf(item('a', 1, '2026-11-09T10:00:00Z'), null, undefined, now);
    expect(s.ageSec).toBe(30);
    expect(s.claimLeftSec).toBe(-20);
  });
  it('üstlenince ilk aramaya kalan (20 sn); arandıysa yok', () => {
    const ev = {
      state: 'OPERATOR_ASSIGNED',
      transitions: [{ to: 'OPERATOR_ASSIGNED', at: '2026-11-09T10:00:25Z', actorKind: 'OPERATOR' }],
    } as unknown as EventRecord;
    const it2 = item('a', 1, '2026-11-09T10:00:00Z', 'OPERATOR_ASSIGNED');
    expect(slaOf(it2, ev, undefined, now)).toEqual({ ageSec: 30, firstCallLeftSec: 15 });
    expect(slaOf(it2, ev, '2026-11-09T10:00:28Z', now).firstCallLeftSec).toBeUndefined();
  });
  it('saat biçimi', () => {
    expect(clock(75)).toBe('1:15');
    expect(clock(-3)).toBe('−0:03');
    expect(clock(3725)).toBe('1:02:05');
  });
});

describe('klavye (E-10)', () => {
  const k = (key: string, o: Partial<KeyInput> = {}): KeyInput => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    editing: false,
    ...o,
  });
  it('Enter üstlen, A ara, 1–5 sonuç, N not, C kapat, Ctrl+1 112', () => {
    expect(commandFor(k('Enter'), 'normal')).toEqual({ kind: 'claim' });
    expect(commandFor(k('a'), 'normal')).toEqual({ kind: 'call' });
    expect(commandFor(k('1'), 'normal')).toEqual({ kind: 'result', result: 'REACHED' });
    expect(commandFor(k('2'), 'normal')).toEqual({ kind: 'result', result: 'NO_ANSWER' });
    expect(commandFor(k('3'), 'normal')).toEqual({ kind: 'result', result: 'BUSY' });
    expect(commandFor(k('4'), 'normal')).toEqual({ kind: 'result', result: 'WRONG_NUMBER' });
    expect(commandFor(k('5'), 'normal')).toEqual({ kind: 'skip' });
    expect(commandFor(k('6'), 'normal')).toEqual({ kind: 'result', result: 'SILENT' }); // T-087
    expect(commandFor(k('N'), 'normal')).toEqual({ kind: 'note' });
    expect(commandFor(k('c'), 'normal')).toEqual({ kind: 'close' });
    expect(commandFor(k('1', { ctrlKey: true }), 'normal')).toEqual({ kind: 'escalate' });
    expect(commandFor(k('1', { metaKey: true }), 'normal')).toEqual({ kind: 'escalate' });
  });
  it('ulaşıldı sonrası 1 iyi / 2 acil / 3 devam', () => {
    expect(commandFor(k('1'), 'assess')).toEqual({ kind: 'assess', assessment: 'OK' });
    expect(commandFor(k('2'), 'assess')).toEqual({ kind: 'assess', assessment: 'EMERGENCY' });
    expect(commandFor(k('3'), 'assess')).toEqual({ kind: 'assess', assessment: 'CONTINUE' });
    expect(commandFor(k('a'), 'assess')).toBeNull();
  });
  it('metin yazarken kısayol yok (Esc ve Ctrl+1 hariç); diyalogda yok', () => {
    expect(commandFor(k('a', { editing: true }), 'normal')).toBeNull();
    expect(commandFor(k('Escape', { editing: true }), 'normal')).toEqual({ kind: 'escape' });
    expect(commandFor(k('1', { ctrlKey: true, editing: true }), 'normal')).toEqual({ kind: 'escalate' });
    expect(commandFor(k('Enter'), 'close')).toBeNull();
  });
});

describe('katalog', () => {
  it('değişken doldurur; eksik alan "bilinmiyor"', () => {
    expect(t('O-STEP-CONTACT', { n: 2 })).toBe('2. yakını ara');
    expect(t('O-SCRIPT-112', { type: 'Düşme', name: 'A', age: 80 })).toContain('Adres: bilinmiyor');
  });
  it('konsol kaynaklarında kullanılan her O-* kodu katalogda', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory()
          ? files(join(dir, d.name))
          : /\.tsx?$/.test(d.name) && !d.name.endsWith('.test.ts')
            ? [join(dir, d.name)]
            : [],
      );
    const used = new Set<string>();
    for (const f of files(join(__dirname, '..')))
      for (const m of readFileSync(f, 'utf8').matchAll(/'(O-[A-Z0-9-]+)'/g)) used.add(m[1]!);
    const missing = [...used].filter((c) => !(c in catalog));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(30);
  });
  it('dinamik kodlar (tip, durum, sonuç) katalogda', () => {
    const types = [
      'SOS',
      'FALL',
      'INACTIVITY',
      'CALLBACK',
      'WATCH_OFF',
      'BATTERY_LOW',
      'BATTERY_DEAD',
      'CONNECTION_LOST',
      'ROUTINE_DEVIATION',
      'HEART_ANOMALY',
      'TEST',
      'FOLLOW_UP',
      'COVERAGE_GAP',
      'WELFARE_CHECK',
    ];
    const states = [
      'OPERATOR_QUEUE',
      'OPERATOR_ASSIGNED',
      'CONTACT_CHAIN',
      'CONFIRMED_OK',
      'CONFIRMED_EMERGENCY',
      'DISPATCH',
    ];
    const codes = [
      ...types.map((x) => `O-TYPE-${x}`),
      ...states.map((x) => `O-STATE-${x}`),
      ...(['REACHED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'SKIPPED', 'SILENT', 'OFFLINE_SKIPPED'] as const).map(
        resultCode,
      ),
      ...['O-SKIP-AWAY', 'O-SKIP-IMPAIRED', 'O-SKIP-NO-KEY-HOLDER', 'O-UI-CORROBORATED', 'O-SCRIPT-APPLE-112'],
      ...['OK', 'EMERGENCY', 'FALSE_ALARM', 'TEST', 'UNREACHABLE'].map((x) => `O-OUT-${x}`),
    ];
    expect(codes.filter((c) => !(c in catalog))).toEqual([]);
  });
});

describe('T-087/T-088 merdiven', () => {
  const at = '2026-11-11T10:03:00.000Z';
  const now = Date.parse('2026-11-11T10:00:00.000Z');
  it('112 son sınırı geri sayımı: kalan / geçti; teyitli iyi, 112 arandı ve sınırsız olayda yok', () => {
    expect(deadline112LeftSec({ call112DeadlineAt: at }, 'OPERATOR_QUEUE', now)).toBe(180);
    expect(deadline112LeftSec({ call112DeadlineAt: at }, 'CONTACT_CHAIN', now + 200_000)).toBe(-20);
    expect(deadline112LeftSec({ call112DeadlineAt: at }, 'CONFIRMED_EMERGENCY', now)).toBe(180);
    expect(deadline112LeftSec({ call112DeadlineAt: at }, 'CONFIRMED_OK', now)).toBeUndefined();
    expect(deadline112LeftSec({ call112DeadlineAt: at }, 'DISPATCH', now)).toBeUndefined();
    expect(deadline112LeftSec({ call112DeadlineAt: null }, 'OPERATOR_QUEUE', now)).toBeUndefined();
    expect(deadline112LeftSec(undefined, 'OPERATOR_QUEUE', now)).toBeUndefined();
    expect(t('O-UI-112-DEADLINE', { time: clock(180) })).toBe('112 son sınırı: 3:00');
  });
  it('sonuç ve sistem gerekçesi etiketleri; sessiz sonuç yalnız cihaz adımında', () => {
    expect(t(resultCode('OFFLINE_SKIPPED'))).toBe('Çevrimdışı, atlandı');
    expect(systemReason('O-SKIP-AWAY')).toBe('O-SKIP-AWAY');
    expect(systemReason('saat çevrimdışı')).toBeNull(); // operatörün serbest metni
    expect(systemReason('O-YOK-BOYLE')).toBeNull();
    expect(isDeviceStep({ target: 'VOICE_DEVICE' })).toBe(true);
    expect(isDeviceStep({ target: 'CONTACT' })).toBe(false);
    expect(t('O-UI-CORROBORATED', { n: 2 })).toBe('2 cihaz doğruladı');
  });
});

describe('devralma (inceleme bulgusu 2)', () => {
  const held = (state: string, lockedBy: string | null, lockUntil: string | null) =>
    ({ ...item('e', 1, '2026-11-10T10:00:00Z', state), lockedBy, lockUntil }) as QueueItem;
  const now = Date.parse('2026-11-10T10:10:00Z');

  it('kilidi dolmuş başka operatördeki (teyitli dahil) olay devralınır', () => {
    expect(canTakeOver(held('CONFIRMED_EMERGENCY', 'op-1', '2026-11-10T10:05:00Z'), 'op-2', now)).toBe(true);
    expect(canTakeOver(held('CONFIRMED_OK', null, null), 'op-2', now)).toBe(true); // amir bıraktı
  });

  it('kilidi taze, benim veya kuyruktaki olay devralınmaz', () => {
    expect(canTakeOver(held('CONTACT_CHAIN', 'op-1', '2026-11-10T10:12:00Z'), 'op-2', now)).toBe(false);
    expect(canTakeOver(held('CONTACT_CHAIN', 'op-2', '2026-11-10T10:05:00Z'), 'op-2', now)).toBe(false);
    expect(canTakeOver(held('OPERATOR_QUEUE', null, null), 'op-2', now)).toBe(false);
  });
});

describe('duyarlı düzen eşikleri', () => {
  it('telefon < 768 ≤ tablet < 1280 ≤ masaüstü', () => {
    expect([320, 390, 767, 768, 820, 1279, 1280, 1920].map(viewportOf)).toEqual([
      'phone',
      'phone',
      'phone',
      'tablet',
      'tablet',
      'tablet',
      'desktop',
      'desktop',
    ]);
  });
});
