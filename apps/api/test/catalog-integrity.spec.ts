import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * X-03: packages/messages/tr.json bütünlüğü. Kod öneki kanalı belirler; konsol (O-*) ve aile web (F-WEB-*)
 * anahtarlarının hepsi bu depoda kullanılır (diğer F-/P-/W- anahtarları istemci depolarında, burada denetlenmez).
 */
const ROOT = join(__dirname, '../../..');
const catalog = JSON.parse(readFileSync(join(ROOT, 'packages/messages/tr.json'), 'utf8')) as Record<
  string,
  { channel: string; text: string; action?: string }
>;

const CHANNEL: Record<string, string> = {
  O: 'console',
  F: 'family',
  P: 'phone',
  W: 'watch',
  K: 'auth',
  V: 'voice',
  S: 'sms',
  // İstemciden bağımsız API hata metinleri (Problem `code`, A-ERR-*).
  A: 'api',
};

/**
 * PRD mesaj kataloğundan gelen, ekranda bilerek kullanılmayan anahtarlar. Yeni giriş eklemeden önce metni
 * kullanmayı ya da silmeyi düşün.
 */
const UNUSED_ALLOWED: Record<string, string> = {
  // Konsol yeni olay bandı O-UI-NEW-EVENT/O-UI-NEW-ALARM kullanır; kişinin adı ve semti kuyruk bandında gösterilmez.
  'O-NEW-SOS': 'yerine O-UI-NEW-EVENT',
  // Aile web akışında adımlar kendi eylem metnini kullanır (F-WEB-CHOOSE, F-WEB-CREATE-ACCOUNT, F-WEB-PAY …).
  'F-WEB-CONTINUE': 'adım düğmeleri özel metinli',
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|ya?ml)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(readFileSync(p, 'utf8'));
  }
  return out;
}

describe('mesaj kataloğu bütünlüğü', () => {
  it('her anahtar biçimli, öneki kanalıyla uyumlu, metni boş değil', () => {
    const bad = Object.entries(catalog).filter(
      ([k, v]) =>
        // Sonek dış enum olabilir (Twilio `O-CALL-no-answer`, fatura dönemi `F-WEB-PER-month`).
        !/^[A-Z]-[A-Z0-9_-]+(-[a-z0-9-]+)?$/.test(k) ||
        CHANNEL[k[0]!] !== v.channel ||
        typeof v.text !== 'string' ||
        !v.text.trim() ||
        (v.action !== undefined && !v.action.trim()),
    );
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it('konsol (O-*) ve aile web (F-WEB-*) anahtarları kodda kullanılıyor', () => {
    const src = ['apps/console/src', 'apps/family-web/src', 'apps/api/src', 'packages/rules', 'packages/contracts/src']
      .flatMap((d) => sources(join(ROOT, d)))
      .join('\n');
    const literal = new Set(src.match(/[OF]-[A-Z0-9_-]+/g));
    // `O-TYPE-${type}` gibi dinamik anahtarlar: önek kullanılmış sayılır.
    const prefixes = [...src.matchAll(/([OF]-[A-Z0-9_-]*-)\$\{/g)].map((m) => m[1]!);
    const unused = Object.keys(catalog).filter(
      (k) =>
        (k.startsWith('O-') || k.startsWith('F-WEB-')) &&
        !literal.has(k) &&
        !prefixes.some((p) => k.startsWith(p)) &&
        !(k in UNUSED_ALLOWED),
    );
    expect(unused).toEqual([]);
    // İzin listesi eskimesin: kullanılmaya başlayan anahtar listeden çıkarılmalı.
    expect(Object.keys(UNUSED_ALLOWED).filter((k) => literal.has(k))).toEqual([]);
  });
});
