import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dt, mins, sec } from '../Admin';
import { type Api, ApiError, type DispatchView, errorText, type QueueItem } from '../lib/api';
import { action, t } from '../lib/i18n';
import { enablePush } from '../lib/push';
import { DRILL_CHAINS } from '../lib/training';
import { stepLabel } from './CoverageBoard';
import { DispatchPanel, etaInput } from './Dispatch';
import { PersonPanel } from './Panels';
import { optionId, QueueList, revealOption } from './Queue';

/** Ön yüz denetim bulguları (konsol): hata metni, kuyruk klavyesi, katalog dışı metin, prosedür ve SW uyumu. */
const SRC = join(__dirname, '..');
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? files(join(dir, d.name))
      : /\.tsx?$/.test(d.name) && !d.name.endsWith('.test.ts')
        ? [join(dir, d.name)]
        : [],
  );

afterEach(() => vi.unstubAllGlobals());

describe('hata metni (M-2 kalan): tarayıcının İngilizce hatası gösterilmez', () => {
  it('ApiError → katalog metni; fetch TypeError / JSON SyntaxError / DOMException → O-UI-NETWORK', () => {
    expect(errorText(new ApiError(404, 'x', 'F-ERR-PERSON-NOT-FOUND'))).toBe(t('F-ERR-PERSON-NOT-FOUND'));
    expect(errorText(new TypeError('Failed to fetch'))).toBe(t('O-UI-NETWORK'));
    expect(errorText(new SyntaxError('Unexpected token < in JSON at position 0'))).toBe(t('O-UI-NETWORK'));
    expect(errorText('boom')).toBe(t('O-UI-NETWORK'));
    expect(
      t('O-UI-ERROR', { detail: errorText(new TypeError('NetworkError when attempting to fetch resource.')) }),
    ).not.toMatch(/fetch|Network/);
  });
  it('konsol kaynaklarında hata nesnesinin ham `.message`ı ekrana verilmez (yalnız errorText)', () => {
    const offenders = files(SRC)
      .filter((f) => !f.endsWith(join('lib', 'api.ts')))
      .flatMap((f) =>
        [...readFileSync(f, 'utf8').matchAll(/\(e as Error\)\.message|\be\.message\b/g)].map(() => f.slice(SRC.length)),
      );
    expect(offenders).toEqual([]);
  });
});

describe('kuyruk listbox klavyeyle erişilebilir', () => {
  const item = (id: string): QueueItem => ({
    eventId: id,
    type: 'SOS',
    priority: 1,
    state: 'OPERATOR_QUEUE',
    createdAt: '2026-11-11T10:00:00Z',
    escalatedAt: null,
    lockedBy: null,
    lockUntil: null,
    isTest: false,
    person: { displayName: 'Ayşe', age: 80 },
  });
  const render = (selected: string | null) =>
    renderToStaticMarkup(
      createElement(QueueList, {
        items: [item('a'), item('b')],
        selected,
        me: 'op',
        now: Date.parse('2026-11-11T10:01:00Z'),
        onSelect: () => undefined,
      }),
    );
  it('liste Tab sırasında; seçili satır aria-activedescendant ile, satırlar kimlikli', () => {
    const html = render('b');
    expect(html).toMatch(/<ul role="listbox"[^>]*tabindex="0"/);
    expect(html).toContain(`aria-activedescendant="${optionId('b')}"`);
    expect(html).toContain(`id="${optionId('a')}"`);
    expect(html).toContain(`id="${optionId('b')}"`);
    expect(html).not.toContain('tabindex="-1"');
  });
  it('seçim yoksa veya listede değilse aria-activedescendant yok', () => {
    expect(render(null)).not.toContain('aria-activedescendant');
    expect(render('gone')).not.toContain('aria-activedescendant');
  });
  it('klavyeyle seçilen satır görünür alana kaydırılır (en yakın kenar); scrollIntoView yoksa (jsdom) hata yok', () => {
    const calls: unknown[] = [];
    revealOption({ scrollIntoView: (o?: boolean | ScrollIntoViewOptions) => void calls.push(o) });
    expect(calls).toEqual([{ block: 'nearest' }]);
    expect(() => revealOption({} as Element)).not.toThrow();
    expect(() => revealOption(null)).not.toThrow();
  });
});

describe('yönetim paneli metinleri katalogdan', () => {
  it('süre birimleri O-UI-SECONDS / O-UI-MINUTES; boş değer ve boş zaman "–"', () => {
    expect(sec(12)).toBe(t('O-UI-SECONDS', { n: 12 }));
    expect(sec(0)).toBe(t('O-UI-SECONDS', { n: 0 }));
    expect(mins(7)).toBe(t('O-UI-MINUTES', { n: 7 }));
    expect(sec(null)).toBe('–');
    expect(mins(undefined)).toBe('–');
    expect(dt(null)).toBe('–');
    expect(dt('2026-11-11T10:00:00Z')).not.toBe('–');
  });
  it("Admin.tsx: birim, öncelik, DLQ, placeholder ve ham sonuç enum'u düz metin değil; zaman `!` ile zorlanmaz", () => {
    const src = readFileSync(join(SRC, 'Admin.tsx'), 'utf8');
    expect(src).not.toMatch(/' sn'|' dk'|\} sn`|\bP\{|DLQ|placeholder="|\$\{c\.result\}|dt\([\w.]+!\)/);
    expect(src).toContain('t(resultCode(c.result as StepResult))');
  });
});

describe('prosedür adımları (procedures.tr.yaml)', () => {
  const procedures = readFileSync(join(SRC, '../../../packages/rules/procedures.tr.yaml'), 'utf8');
  const rules = readFileSync(join(SRC, '../../../packages/rules/tr.yaml'), 'utf8');
  it('her adım türünün kapsama panosunda katalog adı var (NOTIFY_FAMILY dahil)', () => {
    const kinds = [...procedures.matchAll(/^ {2}([A-Z][A-Z0-9_]+):$/gm)].map((m) => m[1]!);
    expect(kinds).toContain('NOTIFY_FAMILY');
    expect(kinds.filter((k) => stepLabel(k) === t('O-UI-UNKNOWN'))).toEqual([]);
    expect(stepLabel('NOTIFY_FAMILY')).toBe(t('O-STEP-NOTIFY'));
  });
  it('tatbikat zincirleri tr.yaml zincirlerinin alt dizisi (sıra aynı, kişiye bağlı adımlar eksik olabilir)', () => {
    const chains = new Map(
      [...rules.matchAll(/- type: (\w+)\n(?:(?!\n {2}- type:)[\s\S])*?\n {4}chain:\s*\[([^\]]*)\]/g)].map((m) => [
        m[1]!,
        m[2]!.split(',').map((s) => s.trim()),
      ]),
    );
    for (const [type, drill] of Object.entries(DRILL_CHAINS)) {
      const real = chains.get(type);
      expect(real, type).toBeDefined();
      let i = 0;
      for (const s of real!) if (s === drill![i]) i++;
      expect(i, `${type}: ${drill!.join(',')} ⊄ ${real!.join(',')}`).toBe(drill!.length);
    }
  });
});

describe('web push: service worker kayıtlı değilse beklemez', () => {
  it("getRegistration() boş → 'unsupported'; izin istenmez, `ready` beklenmez", async () => {
    const requestPermission = vi.fn(async () => 'granted');
    vi.stubGlobal('Notification', { requestPermission, permission: 'default' });
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: async () => undefined, ready: new Promise(() => undefined) },
    });
    const pushConfig = vi.fn(async () => ({ enabled: true, publicKey: 'AQAB' }));
    await expect(enablePush({ pushConfig } as unknown as Api)).resolves.toBe('unsupported');
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe('112 takip metni ve tıbbi özet yükleniyor', () => {
  const view: DispatchView = {
    eventId: 'e1',
    protectedPersonId: 'p1',
    status: 'NOTIFIED',
    notifiedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    notifiedBy: null,
    caseRef: 'K-1',
    etaMin: null,
    hospital: null,
    stages: {},
    arrivalMin: null,
    arrivalLate: true,
    open: true,
    checks: 0,
    timeline: [],
  };
  const panel = (personName?: string) =>
    text(
      renderToStaticMarkup(createElement(DispatchPanel, { api: {} as Api, eventId: 'e1', initial: view, personName })),
    );
  it('takip metninde kişinin adı; ad yoksa "Kişi"', () => {
    expect(panel('Ayşe Yılmaz')).toContain(t('O-SCRIPT-112-FOLLOWUP', { case: 'K-1', name: 'Ayşe Yılmaz', min: 30 }));
    expect(panel()).toContain(t('O-SCRIPT-112-FOLLOWUP', { case: 'K-1', name: t('O-UI-PERSON'), min: 30 }));
  });
  it('kişi kartı yüklenirken "kayıtlı değil" değil "yükleniyor"', () => {
    const render = (card: null | undefined) =>
      text(renderToStaticMarkup(createElement(PersonPanel, { item: null, card, mine: true })));
    expect(render(undefined)).toContain(t('O-UI-MEDICAL-LOADING'));
    expect(render(undefined)).not.toContain(t('O-UI-MEDICAL-NONE'));
    expect(render(null)).toContain(t('O-UI-MEDICAL-NONE'));
  });
  it('kişi kartı yüklenemezse "yükleniyor"da kalmaz: hata ve yeniden dene', () => {
    const html = text(
      renderToStaticMarkup(
        createElement(PersonPanel, {
          item: null,
          card: undefined,
          mine: true,
          cardFailed: true,
          onRetryCard: () => {},
        }),
      ),
    );
    expect(html).toContain(t('O-UI-MEDICAL-FAILED'));
    expect(html).toContain(action('O-UI-MEDICAL-FAILED'));
    expect(html).not.toContain(t('O-UI-MEDICAL-LOADING'));
  });
  it('112 varış süresi girişi sözleşme sınırında (0–600 dk)', () => {
    expect(etaInput('45 dk')).toBe('45');
    expect(etaInput('999')).toBe('600');
    expect(etaInput('6001')).toBe('600');
    expect(etaInput('')).toBe('');
  });
});
