import type { CoverageView, DevicePromptView, DeviceSummary } from '@yanimda/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { t } from '../lib/i18n';
import { DeviceStrip } from './Devices';

/**
 * T-089 (docs/07 S7.1) konsol: operatörün "Soru gönder"ine cihazın cevabı cihaz şeridinde (satırda son soru) ve
 * "Cihaz sorusu cevapları" listesinde görünür. Sunucu görüntüsü (react-dom/server); metinler katalogdan.
 */
const NOW = Date.parse('2026-11-11T10:00:00Z');
const iso = (secFromNow: number) => new Date(NOW + secFromNow * 1000).toISOString();
const dev = (id: string, category: DeviceSummary['category'], o: Partial<DeviceSummary> = {}): DeviceSummary => ({
  id,
  kind: category === 'PHONE' ? 'ANDROID_PHONE' : 'WEAROS_WATCH',
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
  voiceOrder: category === 'PHONE' ? 2 : 1,
  voiceOrderManual: false,
  voiceNumberLast2: null,
  ...o,
});
const view: CoverageView = {
  level: 'FULL',
  since: iso(-3600),
  reasons: [],
  capabilities: { sos: true, fall: true, voice: true, location: true },
  devices: [dev('w', 'WATCH', { voiceNumberLast2: '77' }), dev('p', 'PHONE'), dev('k', 'PENDANT', { voiceOrder: 3 })],
};
const prompt = (deviceId: string, o: Partial<DevicePromptView> = {}): DevicePromptView => ({
  deviceId,
  sentAt: iso(-90),
  until: iso(-30),
  delivered: true,
  answer: null,
  answeredAt: null,
  answeredByDeviceId: null,
  ...o,
});
const render = (prompts?: DevicePromptView[]) =>
  renderToStaticMarkup(
    createElement(DeviceStrip, {
      view,
      event: { sourceDeviceIds: [], cancelledByDeviceId: undefined },
      now: NOW,
      prompts,
      mine: true,
      busy: false,
      note: null,
      gap: null,
      onCommand: () => undefined,
    }),
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");

describe('T-089 cihaz sorusunun cevabı (şerit + liste)', () => {
  it('soru yoksa liste ve satır yok', () => {
    const html = render();
    expect(html).not.toContain('data-testid="prompt-answers"');
    expect(html).not.toContain('data-testid="prompt-w"');
    expect(text(html)).toContain(t('O-UI-DEV-VOICE-NUMBER', { last2: '77' })); // cihaz numarasının son iki hanesi
  });

  it('İyiyim, yardım, cevapsız ve bekleyen soru; telefona giden soruyu saat cevapladıysa belirtilir', () => {
    const html = render([
      prompt('w', { answer: 'OK', answeredAt: iso(-60), answeredByDeviceId: 'w' }),
      prompt('p', { answer: 'NO_ANSWER' }),
      prompt('p', { sentAt: iso(-20), until: iso(40), answer: 'OK', answeredAt: iso(-10), answeredByDeviceId: 'w' }),
      prompt('k', { sentAt: iso(-15), until: iso(45), answer: 'HELP', answeredAt: iso(-5), answeredByDeviceId: 'k' }),
    ]);
    const s = text(html);
    expect(html).toContain('data-testid="prompt-answers"');
    expect(s).toContain(t('O-UI-PROMPT-ANSWERS'));
    // Satır: cihazın son sorusu.
    expect(html).toMatch(/data-testid="prompt-w"[^>]*>Saat: &quot;İyiyim&quot; dedi/);
    expect(html).toMatch(/data-testid="prompt-p"[^>]*>Telefon: &quot;İyiyim&quot; dedi/);
    expect(html).toMatch(/data-testid="prompt-k"[^>]*>Kolye: yardım istedi/);
    // Liste: tüm sorular, eskiden yeniye; cevapsız ve başka cihazdan cevap.
    expect(s).toContain('Telefon: cevap vermedi');
    expect(s).toContain(t('O-UI-PROMPT-BY', { device: 'Saat' }));
    expect(html.indexOf('prompt-no_answer')).toBeLessThan(html.indexOf('prompt-help'));
  });

  it('bekleyen soru kalan saniyeyi gösterir; süresi geçen ama sunucunun henüz işaretlemediği soru cevapsız sayılır', () => {
    const waiting = text(render([prompt('w', { sentAt: iso(-10), until: iso(50) })]));
    expect(waiting).toContain(t('O-UI-PROMPT-WAITING', { device: 'Saat', sec: 50 }));
    const late = text(render([prompt('w', { answer: null })]));
    expect(late).toContain('Saat: cevap vermedi');
  });
});
