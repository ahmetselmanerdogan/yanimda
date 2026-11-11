// Sahte cihaz kütüphanesi (CLI, uçtan uca ve kaos testleri ortak kullanır).
// Gerçek cihaz gibi davranır (A-09): sinyal sıralı tampona girer; ağ hatası, 5xx veya 429'da aynı idempotencyKey ile
// üstel geri çekilmeyle (Retry-After'a uyarak) yeniden gönderilir; 202 alınca tampondan çıkar. Sunucu sinyali
// açıkça reddederse (yanıttaki `rejected` listesinde, D-01) kalıcı hatadır, atılır. Başka 4xx (≠429): alarm sinyali
// (SOS, FALL …) atılmaz, geri çekilerek yeniden denenir (token yenilenince/sunucu düzelince teslim edilir); alarm
// olmayan sinyal atılır.
import { readFileSync } from 'node:fs';

import YAML from 'yaml';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** apps/api common/rate-limit ALARM_KINDS ile aynı küme: kaybı can güvenliğini etkileyen sinyaller. */
export const ALARM_KINDS = new Set(['SOS', 'FALL', 'INACTIVITY', 'CANCEL', 'OK', 'CALLBACK_REQUEST']);

/** Yanıt gövdesinde bu partinin `index` sıradaki sinyali açıkça reddedildi mi (202 veya 400/403 Problem)? */
export const rejectionOf = (body, index) =>
  Array.isArray(body?.rejected) ? body.rejected.find((r) => r?.index === index) : undefined;

export function createDevice({
  api = process.env.API_URL ?? 'http://localhost:3000/v1',
  person = '00000000-0000-0000-0000-000000000001',
  device = '00000000-0000-0000-0000-00000000d001',
  // T-041 cihaz token'ı (POST /v1/devices/enroll). Yoksa token'sız: API yalnız simülatör açıkken kabul eder.
  token = process.env.DEVICE_TOKEN || undefined,
  log = console.log,
  maxBackoffMs = 300_000,
  minBackoffMs = 2_000,
} = {}) {
  const queue = []; // sıralı tampon (Room signal_queue benzeri)
  const stats = { sent: 0, delivered: 0, retries: 0, failed: 0, duplicates: 0 };
  let flushing = null;

  const base = (kind, extra = {}) => ({
    schemaVersion: 1,
    idempotencyKey: `${device}:${Date.now()}:${kind}:${Math.random().toString(36).slice(2, 8)}`,
    deviceId: device,
    protectedPersonId: person,
    kind,
    occurredAt: new Date().toISOString(),
    location: { lat: 40.9873, lng: 29.0291, accuracyM: 12, source: 'GPS' },
    device: { batteryPct: 63, onWrist: true, connectivity: 'BLE', appVersion: 'sim-0.1' },
    ...extra,
  });

  async function post(signals) {
    const res = await fetch(`${api}/signals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(signals),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* boş gövde */
    }
    return { status: res.status, retryAfter: Number(res.headers.get('retry-after') ?? 0), body };
  }

  /** Tampondaki sinyalleri sırayla teslim eder; teslim edilemezse geri çekilip yeniden dener. */
  function flush() {
    flushing ??= (async () => {
      let backoff = minBackoffMs;
      while (queue.length) {
        const s = queue[0];
        let r;
        try {
          r = await post([s]);
        } catch (e) {
          r = { status: 0, error: e?.cause?.code ?? e?.message };
        }
        const rejected = rejectionOf(r.body, 0);
        if (r.status === 202 && rejected) {
          queue.shift();
          stats.failed++;
          log(`${s.kind} -> reddedildi (${rejected.reason}, atıldı)`);
          continue;
        }
        if (r.status === 202) {
          queue.shift();
          stats.delivered++;
          stats.duplicates += r.body?.duplicates ?? 0;
          backoff = minBackoffMs;
          log(`${s.kind} -> 202${r.body?.duplicates ? ' (tekrar)' : ''}`);
          continue;
        }
        if (r.status >= 400 && r.status < 500 && r.status !== 429 && (rejected || !ALARM_KINDS.has(s.kind))) {
          queue.shift();
          stats.failed++;
          log(`${s.kind} -> ${r.status}${rejected ? ` ${rejected.reason}` : ''} (kalıcı hata, atıldı)`);
          continue;
        }
        stats.retries++;
        const wait = Math.max(backoff, r.retryAfter * 1000);
        log(
          `${s.kind} -> ${r.status || r.error} (tamponda ${queue.length}, ${Math.round(wait / 1000)} sn sonra yeniden)`,
        );
        await sleep(wait);
        backoff = Math.min(backoff * 2, maxBackoffMs);
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  /** Sinyali tampona ekler ve teslimi başlatır; teslim (veya kalıcı hata) olunca çözülür. */
  async function send(kind, extra = {}) {
    const s = base(kind, extra);
    queue.push(s);
    stats.sent++;
    await flush();
    return s;
  }

  async function scenario(doc, { timeScale = 1 } = {}) {
    log(`Senaryo: ${doc.name}`);
    const sent = [];
    for (const step of doc.steps) {
      if (step.wait) {
        log(`  bekle ${step.wait * timeScale}s`);
        await sleep(step.wait * timeScale * 1000);
        continue;
      }
      sent.push(await send(step.kind, step.extra ?? {}));
    }
    return sent;
  }

  return { base, send, flush, scenario, stats, pending: () => queue.length };
}

export const loadScenario = (file) => YAML.parse(readFileSync(file, 'utf8'));
