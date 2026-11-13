#!/usr/bin/env node
// T-081 Keycloak türetilmiş dosyaları (tek kaynaktan, elle düzenlenmez):
//   1. password-blacklists/yanimda-blacklist.txt — parola kara listesi (ASVS 2.1.7), aşağıdaki kurallardan üretilir.
//   2. themes/yanimda/login/messages/messages_tr.properties ve .../resources/js/strength-i18n.js — giriş teması
//      metinleri (ASVS 2.1.8), packages/messages/tr.json "auth" kanalından.
//
//   node infra/keycloak/generate.mjs            # dosyaları yaz
//   node infra/keycloak/generate.mjs --check    # repodaki dosyalar üretimle aynı mı (CI); farkta çıkış 1
//   node infra/keycloak/generate.mjs --breached <liste.txt> --out <hedef.txt>
//       # ortamda indirilen ihlal listesini (ör. SecLists, MIT) tohum listeyle birleştirir (infra/README.md "Kara liste")
//
// Kara liste yalnız ≥ 12 karakterli girdileri içerir: daha kısası zaten `length(12)` politikasıyla reddedilir.
// Keycloak parolayı küçük harfe çevirip (Java String.toLowerCase, kök yerel ayar) arar: girdiler aynı biçimde
// küçük harfle yazılır (Keycloak 26.0.8'de doğrulandı: "gALATASARAY1905" de reddedilir).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const MIN = 12; // realm passwordPolicy length(12) ile aynı (infra/keycloak/keycloak.test.mjs denetler)
const MAX = 128;

export const paths = {
  blacklist: join(here, 'password-blacklists', 'yanimda-blacklist.txt'),
  properties: join(here, 'themes', 'yanimda', 'login', 'messages', 'messages_tr.properties'),
  i18n: join(here, 'themes', 'yanimda', 'login', 'resources', 'js', 'strength-i18n.js'),
  catalog: join(root, 'packages', 'messages', 'tr.json'),
};

// --- 1. Kara liste ---------------------------------------------------------------------------------------------
// Kaynak: bu projenin kendi kuralları (lisans sorunu yok). Yaygın parola kalıpları: sözcük + yıl/rakam/simge,
// klavye yürüyüşleri, rakam dizileri, tekrarlar; Türkçe yaygın sözcükler (takım, şehir, ad, dini/milli ifade).
const WORDS = [
  'password',
  'passw0rd',
  'p@ssword',
  'p@ssw0rd',
  'parola',
  'parol@',
  'sifre',
  'şifre',
  '$ifre',
  'sifrem',
  'şifrem',
  'parolam',
  'yeniparola',
  'yenisifre',
  'yenişifre',
  'changeme',
  'degistir',
  'değiştir',
  'guvenli',
  'güvenli',
  'qwerty',
  'iloveyou',
  'seniseviyorum',
  'seviyorum',
  'askim',
  'aşkım',
  'sevgilim',
  'canim',
  'canım',
  'bebegim',
  'bebeğim',
  'galatasaray',
  'cimbom',
  'fenerbahce',
  'fenerbahçe',
  'besiktas',
  'beşiktaş',
  'trabzonspor',
  'bursaspor',
  'istanbul',
  'ankara',
  'izmir',
  'antalya',
  'konya',
  'turkiye',
  'türkiye',
  'turkey',
  'ataturk',
  'atatürk',
  'mustafakemal',
  'allah',
  'bismillah',
  'mehmet',
  'mustafa',
  'ahmet',
  'ayse',
  'ayşe',
  'fatma',
  'emine',
  'hatice',
  'zeynep',
  'elif',
  'yusuf',
  'ibrahim',
  'huseyin',
  'hüseyin',
  'hasan',
  'ismail',
  'murat',
  'omer',
  'ömer',
  'annem',
  'babam',
  'anneanne',
  'babaanne',
  'dedem',
  'ailem',
  'yanimda',
  'yanımda',
  'admin',
  'administrator',
  'welcome',
  'hosgeldin',
  'hoşgeldin',
  'letmein',
  'football',
  'futbol',
  'superman',
  'batman',
  'dragon',
  'monkey',
  'sunshine',
  'princess',
  'master',
  'shadow',
  'michael',
  'starwars',
  'whatever',
  'trustno1',
  'internet',
  'computer',
  'bilgisayar',
  'samsung',
  'iphone',
  'google',
  'facebook',
  'instagram',
  'whatsapp',
  'turkcell',
  'vodafone',
  'operator',
  'operatör',
  'keycloak',
  'saglik',
  'sağlık',
  'yardim',
  'yardım',
  'acildurum',
  'abcdef',
  'abc123',
];
const SUFFIXES = [
  '',
  '1',
  '12',
  '123',
  '1234',
  '12345',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  '!',
  '1!',
  '12!',
  '123!',
  '1234!',
  '.',
  '*',
  '?',
  '@',
  '@123',
  '_123',
  '.123',
  '123.',
  '!!',
  '!@#',
  '123*',
  '00',
  '01',
  '007',
  '111',
  '321',
  '4321',
  '54321',
  '654321',
  '987654321',
];
const YEARS = Array.from({ length: 2027 - 1900 }, (_, i) => String(1900 + i));
const WALKS = [
  'qwertyuiop',
  'qwertyuıopğü',
  'asdfghjkl',
  'asdfghjklşi',
  'zxcvbnm',
  'zxcvbnmöç',
  'qwerty',
  'asdfgh',
  'zxcvbn',
  '1qaz2wsx',
  '1qaz2wsx3edc',
  '1qaz2wsx3edc4rfv',
  '1q2w3e4r',
  '1q2w3e4r5t',
  '1q2w3e4r5t6y',
  '1q2w3e4r5t6y7u8i',
  'q1w2e3r4',
  'q1w2e3r4t5',
  'q1w2e3r4t5y6',
  'qazwsx',
  'qazwsxedc',
  'qazwsxedcrfv',
  'qweasdzxc',
  'qwerasdfzxcv',
  'qwertyasdfgh',
  'abcdefghijkl',
  'abcdefghijklmnop',
  'abcd1234',
  'abc123abc123',
  'aaaaaa',
  'zaq12wsx',
];
const PHRASES = [
  'iloveyouforever',
  'seniçokseviyorum',
  'senicokseviyorum',
  'allahbirdir',
  'allahuekber',
  'bismillahirrahmanirrahim',
  'mustafakemalatatürk',
  'mustafakemalataturk',
  'galatasaraysampiyon',
  'galatasarayşampiyon',
  'fenerbahcesampiyon',
  'fenerbahçeşampiyon',
  'besiktassampiyon',
  'beşiktaşşampiyon',
  'trabzonsporsampiyon',
  'canimbenim',
  'canımbenim',
  'herseyinbaşı',
  'hayatgüzel',
  'hayatguzel',
  'nevarnevok',
  'ne mutlu türküm diyene',
  'nemutluturkumdiyene',
  'nemutlutürkümdiyene',
  'correcthorsebatterystaple',
  'thequickbrownfox',
  'letmeinplease',
  'passwordpassword',
  'parolaparola',
  'sifresifre',
  'qwertyqwerty',
  'adminadmin123',
  'administrator1',
  'yanimdayanimda',
];

function digitRuns() {
  const out = [];
  for (let n = MIN; n <= 20; n++) {
    out.push(
      '1234567890'.repeat(3).slice(0, n),
      '0987654321'.repeat(3).slice(0, n),
      '0123456789'.repeat(3).slice(0, n),
    );
    for (let d = 0; d <= 9; d++) out.push(String(d).repeat(n));
    out.push('12'.repeat(n).slice(0, n), '123'.repeat(n).slice(0, n), '1234'.repeat(n).slice(0, n));
    out.push('147258369'.repeat(3).slice(0, n), '159753'.repeat(4).slice(0, n), '112233445566778899'.slice(0, n));
  }
  for (let c = 97; c <= 122; c++) for (let n = MIN; n <= 16; n++) out.push(String.fromCharCode(c).repeat(n));
  return out;
}

export function blacklist() {
  const set = new Set();
  const add = (s) => {
    const len = [...s].length;
    if (len >= MIN && len <= MAX) set.add(s);
  };
  for (const w of [...WORDS, ...WALKS]) {
    for (const s of SUFFIXES) add(w + s);
    for (const y of YEARS) {
      add(w + y);
      add(w + y + '!');
      add(w + '.' + y);
    }
    add(w + w);
    add(w + w + '1');
    add(w + w + '123');
  }
  for (const p of PHRASES) for (const s of ['', '1', '123', '!']) add(p + s);
  for (const d of digitRuns()) add(d);
  return [...new Set([...set].map((s) => s.toLowerCase()))].sort();
}

function blacklistFile(entries) {
  return entries.join('\n') + '\n';
}

// --- 2. Tema metinleri ----------------------------------------------------------------------------------------
// Katalog kodu → Keycloak mesaj anahtarı (temanın FreeMarker şablonlarında msg() ile okunur).
const KC_KEYS = { 'K-PWD-BLACKLISTED': 'invalidPasswordBlacklistedMessage' };
// Katalog kodu → güç göstergesi (password-strength.js) anahtarı.
const METER_KEYS = {
  'K-PWD-STRENGTH-LABEL': 'label',
  'K-PWD-STRENGTH-0': 'level0',
  'K-PWD-STRENGTH-1': 'level1',
  'K-PWD-STRENGTH-2': 'level2',
  'K-PWD-STRENGTH-3': 'level3',
  'K-PWD-STRENGTH-4': 'level4',
  'K-PWD-HINT-LENGTH': 'hintLength',
  'K-PWD-HINT-COMMON': 'hintCommon',
  'K-PWD-HINT-GENERAL': 'hintGeneral',
};
const HEADER =
  'ÜRETİLMİŞ DOSYA — elle düzenlemeyin. Kaynak: packages/messages/tr.json; node infra/keycloak/generate.mjs';

function message(catalog, code) {
  const m = catalog[code];
  if (!m) throw new Error(`Mesaj kataloğunda yok: ${code}`);
  if (m.channel !== 'auth') throw new Error(`${code} kanalı "auth" olmalı (gelen: ${m.channel})`);
  return m.text;
}

// Keycloak mesajları java.text.MessageFormat'tan geçer: tek tırnak çiftlenir. Dosya UTF-8 okunur (Keycloak ≥ 22).
function propertiesFile(catalog) {
  const lines = [`# ${HEADER}`];
  for (const [code, key] of Object.entries(KC_KEYS)) {
    const text = message(catalog, code).replace(/'/g, "''").replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
    lines.push(`# ${code}`, `${key}=${text}`);
  }
  return lines.join('\n') + '\n';
}

function i18nFile(catalog) {
  const strings = {};
  for (const [code, key] of Object.entries(METER_KEYS)) strings[key] = message(catalog, code);
  return `// ${HEADER}\nwindow.YANIMDA_STRENGTH_I18N = ${JSON.stringify({ min: MIN, ...strings }, null, 2)};\n`;
}

export function expected() {
  const catalog = JSON.parse(readFileSync(paths.catalog, 'utf8'));
  return {
    [paths.blacklist]: blacklistFile(blacklist()),
    [paths.properties]: propertiesFile(catalog),
    [paths.i18n]: i18nFile(catalog),
  };
}

function main(argv) {
  const at = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const breached = at('--breached');
  if (breached) {
    const out = at('--out');
    if (!out) throw new Error('--out gerekli');
    const extra = readFileSync(breached, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => [...l].length >= MIN && [...l].length <= MAX && !l.startsWith('#'));
    const merged = new Set(blacklist());
    for (const l of extra) merged.add(l.toLowerCase());
    writeFileSync(out, blacklistFile([...merged].sort()));
    process.stdout.write(`${out}: ${merged.size} girdi (${extra.length} ihlal listesinden)\n`);
    return 0;
  }
  const files = expected();
  if (argv.includes('--check')) {
    const stale = Object.entries(files).filter(([p, c]) => {
      try {
        return readFileSync(p, 'utf8') !== c;
      } catch {
        return true;
      }
    });
    for (const [p] of stale) process.stderr.write(`Güncel değil: ${p} → node infra/keycloak/generate.mjs\n`);
    return stale.length ? 1 : 0;
  }
  for (const [p, c] of Object.entries(files)) writeFileSync(p, c);
  process.stdout.write(`Yazıldı: ${Object.keys(files).length} dosya\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
