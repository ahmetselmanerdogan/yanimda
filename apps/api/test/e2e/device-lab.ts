/**
 * T-045 cihaz laboratuvarı: yerel yığın + Android eşlikçi (emülatör veya USB cihaz, adb) uçtan uca gecikme.
 *
 *   pnpm --filter @yanimda/api exec tsx test/e2e/device-lab.ts
 *
 * Önkoşul: yanimda-android debug APK'sı `-PyanimdaApi=http://10.0.2.2:<STACK_API_PORT>/v1/` ile kurulu, cihaz
 * `adb devices` listesinde. Akış:
 *  1. Yığın (Redis + PGlite + API) — gerçek kural süreleri; kişi + davet kodu (ADMIN_TOKEN).
 *  2. adb ile davet bağlantısı açılır → telefon eşleşir (POST /devices/enroll).
 *  3. Sahte saat (debug FakeWatchReceiver) tanıtılır → telefon saati kaydeder (POST /devices/{id}/companions).
 *  4. LAB_RUNS kez: sahte saat FALL → telefon köprüsü (kalıcı tampon) → POST /signals (telefon token'ı, saat kimliği)
 *     → olay (konsolda DEVICE_PROMPT). Ölçülen: sinyal anı (saat) → API'ye yazılış ve → olay oluşma. Her turdan sonra
 *     CANCEL (saat "iyiyim") olayı kapatır.
 * Çıktı: Markdown tablo + p50/p95 (stdout). Log'da PII yok (kişi adı "Lab").
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

import { startStack, waitFor } from './infra';

const ADB = process.env.ADB ?? `${process.env.ANDROID_HOME ?? `${homedir()}/Library/Android/sdk`}/platform-tools/adb`;
const RUNS = Number(process.env.LAB_RUNS ?? 20);
const PKG = 'app.yanimda.device';
const WATCH = '0a7c4b1e-5d2f-4c3a-9b8e-7f6a5d4c3b2a'; // FakeWatchReceiver.FAKE_WATCH_ID
const ADMIN = 'lab-admin-token';

const SERIAL = process.env.ADB_SERIAL ? ['-s', process.env.ADB_SERIAL] : [];
const adb = (...args: string[]) => execFileSync(ADB, [...SERIAL, ...args], { encoding: 'utf8' });

/**
 * Cihaz saati − bilgisayar saati (ms). Emülatörün saati ana makineden dakikalarca sapabilir; `signal.time` cihazın,
 * `received_at`/`created_at` sunucunun saatiyle yazılır. 7 örneğin en kısa gidiş-dönüşlüsü kullanılır.
 */
function clockSkewMs(): { skew: number; rtt: number } {
  let best = { skew: 0, rtt: Number.POSITIVE_INFINITY };
  for (let i = 0; i < 7; i++) {
    const h1 = Date.now();
    const dev = Number(adb('shell', 'date', '+%s%3N').trim());
    const h2 = Date.now();
    if (h2 - h1 < best.rtt) best = { skew: dev - (h1 + h2) / 2, rtt: h2 - h1 };
  }
  return { skew: Math.round(best.skew), rtt: best.rtt };
}
const broadcast = (action: string, extras: Record<string, string> = {}) =>
  adb(
    'shell',
    'am',
    'broadcast',
    '-n',
    `${PKG}/.debug.FakeWatchReceiver`,
    '-a',
    `${PKG}.debug.${action}`,
    ...Object.entries(extras).flatMap(([k, v]) => ['--es', k, v]),
  );

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

async function main() {
  const st = await startStack({
    apiPort: Number(process.env.STACK_API_PORT ?? 3300),
    env: { ADMIN_TOKEN: ADMIN, OPERATOR_CALLER_IDS: '+15555215556', OPERATOR_DISPLAY_NAME: 'Lab' },
  });
  const headers = { 'x-admin-token': ADMIN, 'content-type': 'application/json' };
  const post = async <T>(path: string, body: unknown = {}) => {
    const r = await fetch(`${st.api.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  };
  try {
    const person = await post<{ id: string }>('/protected-persons', {
      displayName: 'Lab',
      timezone: 'Europe/Istanbul',
    });
    const { code } = await post<{ code: string }>(`/protected-persons/${person.id}/invite`);
    // Önceki koşudan kalan eşleşme/tampon silinir (LAB_RESET=0 ile atlanır); kurulum sihirbazı izinleri kendisi ister.
    if (process.env.LAB_RESET !== '0') adb('shell', 'pm', 'clear', PKG);
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `yanimda://invite/${code}`, PKG);
    const [phone] = await waitFor(
      async () => {
        const r = await st.query<{ id: string }>(
          `SELECT id FROM device.device WHERE protected_person_id = $1 AND kind = 'ANDROID_PHONE'`,
          [person.id],
        );
        return r.length ? r : null;
      },
      90_000,
      'telefon eşleşmesi',
    );
    console.error(`eşleşti: telefon ${phone!.id.slice(0, 8)}…`);
    broadcast('FAKE_WATCH_HELLO');
    await waitFor(
      async () =>
        (await st.query(`SELECT 1 FROM device.device WHERE id = $1 AND protected_person_id = $2`, [WATCH, person.id]))
          .length > 0,
      60_000,
      'saat kaydı (companions)',
    );
    console.error('saat telefon üzerinden kaydedildi');

    const clock = clockSkewMs();
    console.error(`cihaz saat farkı ${clock.skew} ms (ölçüm belirsizliği ±${Math.ceil(clock.rtt / 2)} ms)`);
    const rows: { i: number; toApi: number; toEvent: number }[] = [];
    for (let i = 1; i <= RUNS; i++) {
      const key = `${WATCH}:${Date.now()}:FALL:lab${i}`;
      broadcast('FAKE_WATCH_SIGNAL', { kind: 'FALL', key });
      const [sig] = await waitFor(
        async () => {
          const r = await st.query<{ time: Date; received_at: Date; source: { kind?: string } }>(
            `SELECT time, received_at, payload->'source' AS source FROM signal.signal WHERE idempotency_key = $1`,
            [key],
          );
          return r.length ? r : null;
        },
        30_000,
        `sinyal ${i}`,
      );
      const [ev] = await waitFor(
        async () => {
          const r = await st.query<{ id: string; created_at: Date }>(
            `SELECT id, created_at FROM event.event WHERE source_signal_ids[1] = $1`,
            [key],
          );
          return r.length ? r : null;
        },
        30_000,
        `olay ${i}`,
      );
      if (sig!.source?.kind !== 'WEAROS_WATCH')
        throw new Error(`köprü sinyali saat adaptöründen geçmedi: ${sig!.source?.kind}`);
      const t0 = new Date(sig!.time).getTime() - clock.skew; // cihaz anı → sunucu saatine
      rows.push({
        i,
        toApi: new Date(sig!.received_at).getTime() - t0,
        toEvent: new Date(ev!.created_at).getTime() - t0,
      });
      broadcast('FAKE_WATCH_SIGNAL', { kind: 'CANCEL', source: key });
      try {
        await waitFor(
          async () =>
            (await st.query(`SELECT 1 FROM event.event WHERE id = $1 AND state = 'CLOSED'`, [ev!.id])).length > 0,
          30_000,
          `olay ${i} kapanışı`,
        );
      } catch (e) {
        const tr = await st.query<{ from_state: string; to_state: string; note: string }>(
          `SELECT from_state, to_state, note FROM event.transition WHERE event_id = $1 ORDER BY seq`,
          [ev!.id],
        );
        console.error(`olay ${i} geçişleri: ${tr.map((t) => `${t.from_state}→${t.to_state} (${t.note})`).join(', ')}`);
        throw e;
      }
      // D-07: 3. kullanıcı iptalinde kişiye "eşik görüşmesi" (CALLBACK) açılır; kişi başına tek açık olay olduğundan
      // sonraki FALL ona eklenir. Laboratuvar kayıt düzeni: düşme dışı açık olaylar turlar arasında kapatılır.
      await st.query(
        `UPDATE event.event SET state = 'CLOSED', closed_at = now(), close_reason = 'lab' WHERE protected_person_id = $1 AND state <> 'CLOSED'`,
        [person.id],
      );
    }
    const dup = await st.query<{ n: number }>(
      `SELECT count(*)::int - count(DISTINCT idempotency_key)::int AS n FROM signal.signal WHERE device_id = $1`,
      [WATCH],
    );
    const api = rows.map((r) => r.toApi);
    const evt = rows.map((r) => r.toEvent);
    console.log('| # | saat → API (ms) | saat → olay (ms) |\n| --- | --- | --- |');
    for (const r of rows) console.log(`| ${r.i} | ${r.toApi} | ${r.toEvent} |`);
    console.log(
      `\nTur: ${rows.length} · saat→API p50 ${pct(api, 50)} ms, p95 ${pct(api, 95)} ms, maks ${Math.max(...api)} ms · ` +
        `saat→olay p50 ${pct(evt, 50)} ms, p95 ${pct(evt, 95)} ms, maks ${Math.max(...evt)} ms · çift sinyal: ${dup[0]!.n} · ` +
        `saat farkı düzeltmesi ${clock.skew} ms (±${Math.ceil(clock.rtt / 2)} ms)`,
    );
  } finally {
    await st.close();
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
