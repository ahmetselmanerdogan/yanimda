import type { AdminCoverageMetrics, CoverageView, DeviceSummary, SupervisorCoverageBoard } from '@yanimda/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PersonCard, QueueItem } from '../lib/api';
import { followUpReasonCode, locationLine } from '../lib/devices';
import { t } from '../lib/i18n';
import { CoverageBoardView, CoverageMetricsView, stepLabel } from './CoverageBoard';
import { DeviceStrip } from './Devices';
import { PersonPanel } from './Panels';

/**
 * T-089 / T-085 Kalan (docs/07 S7.1–S7.3) konsol: vücut konumu simgesi, "telefon üzerinden" rozeti, konum yaşı
 * satırı, aynı adreste ikinci kişi, kronik boşluk takibi; amir kapsama panosu listeleri; yönetim kapsama ölçüleri.
 * Sunucu görüntüsü (react-dom/server); metinler katalogdan.
 */
const NOW = Date.parse('2026-11-11T10:00:00Z');
const iso = (secFromNow: number) => new Date(NOW + secFromNow * 1000).toISOString();
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
const dev = (id: string, category: DeviceSummary['category'], o: Partial<DeviceSummary> = {}): DeviceSummary => ({
  id,
  kind: 'SIMULATOR',
  category,
  tier: 'A',
  bodyLocation: null,
  nickname: null,
  online: true,
  lastSeenAt: iso(-60),
  batteryPct: 80,
  charging: false,
  chargingSince: null,
  onBody: category === 'PHONE' ? null : true,
  estimatedHoursLeft: null,
  voiceOrder: null,
  voiceOrderManual: false,
  voiceNumberLast2: null,
  ...o,
});
const view: CoverageView = {
  level: 'FULL',
  since: iso(-3600),
  reasons: [],
  capabilities: { sos: true, fall: true, voice: true, location: true },
  devices: [
    dev('w', 'WATCH', { bodyLocation: 'WRIST_LEFT' }),
    dev('r', 'RING', { tier: 'B', bodyLocation: 'FINGER', bridged: true }),
    dev('p', 'PHONE', { bridged: false }),
  ],
};
const strip = (event: Parameters<typeof DeviceStrip>[0]['event'], followUp: string | null = null) =>
  renderToStaticMarkup(
    createElement(DeviceStrip, {
      view,
      event,
      now: NOW,
      mine: false,
      busy: false,
      note: null,
      gap: null,
      followUp,
      onCommand: () => undefined,
    }),
  );

describe('S7.1 olay ekranı: vücut konumu, telefon üzerinden, konum yaşı', () => {
  it('vücut konumu simgesi (erişilebilir ad katalogdan) ve yalnız köprülü cihazda "telefon üzerinden"', () => {
    const html = strip({ sourceDeviceIds: [], cancelledByDeviceId: undefined });
    expect(html).toContain(`aria-label="${t('O-UI-BODY-WRIST_LEFT')}"`);
    expect(html).toContain('data-testid="body-r"');
    expect(html).not.toContain('data-testid="body-p"');
    expect(html).toContain('data-testid="bridged-r"');
    expect(html).not.toContain('data-testid="bridged-w"');
    expect(html).not.toContain('data-testid="bridged-p"');
    expect(text(html)).toContain(t('O-UI-DEV-VIA-PHONE'));
    expect(html).not.toContain('data-testid="location-line"'); // konum yok
  });

  it('konum satırı: yaş ve kaynak ("4 dk önce, GPS"); anı yoksa olayın açılışı', () => {
    const html = strip({
      sourceDeviceIds: [],
      cancelledByDeviceId: undefined,
      location: { lat: 41, lng: 29, source: 'GPS', at: iso(-240) },
      createdAt: iso(-600),
    });
    expect(text(html)).toContain('Konum: 4 dk önce, GPS');
    expect(locationLine({ source: 'NETWORK' }, iso(-7200), NOW)).toBe('Konum: 2 sa önce, ağ konumu');
    expect(locationLine({ at: iso(-10) }, iso(-60), NOW)).toBe('Konum: az önce, kaynak bilinmiyor');
    expect(locationLine(null, iso(-60), NOW)).toBeNull();
  });

  it('S4.10 kronik boşluk takibi (FOLLOW_UP notu) katalog metniyle; bilinmeyen not gösterilmez', () => {
    const code = followUpReasonCode([{ to: 'CREATED', note: 'COVERAGE_CHRONIC' }]);
    expect(code).toBe('O-UI-FOLLOWUP-COVERAGE_CHRONIC');
    expect(followUpReasonCode([{ to: 'CREATED', note: 'serbest metin' }])).toBeNull();
    const html = strip({ sourceDeviceIds: [], cancelledByDeviceId: undefined }, code);
    expect(text(html)).toContain(t('O-UI-FOLLOWUP-COVERAGE_CHRONIC'));
  });

  it('aynı adreste ikinci kişi: ad ve açık olayına bağlantı; tıbbi bilgisi yok', () => {
    const card: PersonCard = {
      displayName: 'Ayşe',
      age: 81,
      address: 'Gül Sok. 5',
      location: null,
      doorAccessNote: null,
      sameAddress: [
        { protectedPersonId: 'b', displayName: 'Mehmet', openEventId: 'ev-2' },
        { protectedPersonId: 'c', displayName: 'Fatma', openEventId: null },
      ],
      medical: null,
    };
    const item = { person: { displayName: 'Ayşe', age: 81 } } as QueueItem;
    const html = renderToStaticMarkup(
      createElement(PersonPanel, { item, card, mine: true, onOpenEvent: () => undefined }),
    );
    const s = text(html);
    expect(s).toContain(t('O-UI-SAME-ADDRESS', { name: 'Mehmet' }));
    expect(s).toContain(t('O-UI-SAME-ADDRESS', { name: 'Fatma' }));
    expect(html.split(t('O-UI-SAME-ADDRESS-EVENT')).length - 1).toBe(1); // yalnız açık olayı olan
  });
});

describe('S7.2 amir kapsama panosu', () => {
  const board: SupervisorCoverageBoard = {
    at: iso(0),
    noneAwake: [{ protectedPersonId: 'a', name: 'Ali', since: iso(-3600), awakeMin: 60, reasons: ['PHONE_OFFLINE'] }],
    chronic: [{ protectedPersonId: 'c', name: 'Cem', protectedPct: 41.5, chronicSince: iso(-86400), toleranceMin: 30 }],
    offlineBridges: [{ protectedPersonId: 'e', name: 'Ece', phoneSeenAt: iso(-3600), bridgedDevices: 2 }],
    unreachable: {
      days7: [
        {
          step: 'CALL_CONTACT:1',
          attempted: 4,
          reached: 1,
          unreached: 3,
          offlineSkipped: 0,
          unreachableRate: 0.75,
          stalledHere: 2,
        },
      ],
      days30: [],
    },
    unclaimedP1: [{ eventId: 'e1', eventType: 'SOS', at: iso(-1800), acked: false }],
    dispatch112: [{ eventId: 'e2', eventType: 'INACTIVITY', notifiedAt: iso(-7200), status: 'NOTIFIED', name: 'Cem' }],
  };
  it('listeler katalog metinleriyle; adım adı katalogdan; boş liste "kayıt yok"', () => {
    const s = text(renderToStaticMarkup(createElement(CoverageBoardView, { board, now: NOW })));
    expect(s).toContain(t('O-UI-SUP-NONE-ROW', { name: 'Ali', n: 60 }));
    expect(s).toContain(t('O-UI-SUP-CHRONIC-ROW', { name: 'Cem', pct: '%42' }));
    expect(s).toContain(t('O-UI-SUP-CHRONIC-PLAN'));
    expect(s).toContain(t('O-UI-SUP-TOLERANCE', { n: 30 }));
    expect(s).toContain(t('O-UI-SUP-BRIDGE-ROW', { name: 'Ece', seen: '1 sa önce', n: 2 }));
    expect(s).toContain(`${stepLabel('CALL_CONTACT:1')} 4 %75 2`);
    expect(stepLabel('CALL_CONTACT:1')).toBe('1. yakını ara');
    expect(stepLabel('CALL_MARS')).toBe(t('O-UI-UNKNOWN'));
    expect(s).toContain(t('O-UI-SUP-NOT-ACKED'));
    expect(s).toContain(t('O-TYPE-INACTIVITY'));
    expect(s).toContain(t('O-UI-SUP-EMPTY')); // 30 günlük tablo boş
  });
});

describe('S7.3 yönetim kapsama ölçüleri', () => {
  it('toplamlar tabloda; kişi adı yok', () => {
    const m: AdminCoverageMetrics = {
      days: 30,
      from: iso(-30 * 86400),
      to: iso(0),
      coverage: {
        personDays: 120,
        avgProtectedPct: 91.4,
        medianProtectedPct: 95,
        belowTargetShare: 0.083,
        buckets: [{ label: '95+', n: 60 }],
      },
      falseAlarms: [{ model: 'WEAROS_WATCH', appVersion: '1.4.0', events: 12, falseAlarms: 3, rate: 0.25 }],
      latency: [{ tier: 'A', adapter: 'WEAROS_WATCH', signals: 900, p50Sec: 1.2, p95Sec: 4.8 }],
      charging: { sessions: 40, worn: 38, medianToWearMin: 9, p90ToWearMin: 31, beforeReminderShare: 0.7 },
      eventsPer100PersonDays: { SOS: 1.7 },
      battery: [{ model: 'WEAROS_WATCH', devices: 4, deviceDays: 110, medianDailyDrainPct: 38 }],
    };
    const s = text(renderToStaticMarkup(createElement(CoverageMetricsView, { m })));
    expect(s).toContain(t('O-UI-ADM-COV-SUMMARY', { avg: '%91', median: '%95', below: '%8', n: 120 }));
    expect(s).toContain('WEAROS_WATCH 1.4.0 12 %25');
    expect(s).toContain(t('O-UI-SUP-SECONDS', { n: 4.8 }));
    expect(s).toContain(t('O-UI-ADM-COV-CHARGING-ROW', { n: 40, median: 9, p90: 31, early: '%70' }));
    expect(s).toContain(`${t('O-TYPE-SOS')} 1.7`);
    expect(s).toContain('WEAROS_WATCH 4 %38');
  });
});
