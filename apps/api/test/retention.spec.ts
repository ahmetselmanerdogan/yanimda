import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RETENTION_DEFAULTS, retentionConfigFromEnv, RetentionService } from '../src/modules/privacy/retention.service';
import { createHarness, type Harness } from './support/harness';
import { scanPii } from './support/pii-scan';

/**
 * T-081 ASVS 8.3.8 saklama (docs/security/saklama.md). Kabul:
 *  - süre dolmuş satırlar silinir, süresi dolmamış ve işlenmemiş satırlar kalır
 *  - outbox: yalnız işlenmiş satırlar; DLQ ve ölü side satırları asla (olay kaybı sıfır)
 *  - bildirim: yalnız son durumdakiler; yedeği (fallback_of) saklanan satır silinmez (FK)
 *  - sinyalde konum alanı daha kısa sürede silinir, satır kalır
 *  - audit.log'a dokunulmaz (append-only); temizlik özeti yalnız sayılarla denetime yazılır
 *  - süreler ortamdan; 0 kapatır; güvenlik tabanının altı reddedilir
 */
const DAY = 86_400_000;
const NOW = new Date('2027-06-01T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const PERSON = '0190c1d2-0000-7000-8000-000000000001';

let h: Harness;
let svc: RetentionService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.exec.exec('TRUNCATE device.partner_delivery');
  await h.rows(`INSERT INTO profile.protected_person (id, display_name) VALUES ($1, 'Test')`, [PERSON]);
  svc = new RetentionService(h.db, { ...RETENTION_DEFAULTS, sweepMs: 0 });
});
afterAll(async () => {
  await h.close();
});

const count = async (table: string, where = 'true') =>
  Number((await h.rows<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`))[0]!.n);

async function signalAt(at: string, key: string, location = true) {
  const payload = { kind: 'HEARTBEAT', ...(location ? { location: { lat: 41.01, lng: 29.02, accuracyM: 10 } } : {}) };
  await h.rows(
    `INSERT INTO signal.signal (time, device_id, protected_person_id, kind, payload, idempotency_key)
     VALUES ($1, 'dev-1', $2, 'HEARTBEAT', $3, $4)`,
    [at, PERSON, JSON.stringify(payload), key],
  );
}

async function notificationAt(at: string, status: string, id: string, fallbackOf: string | null = null) {
  await h.rows(
    `INSERT INTO notify.notification (id, dedupe_key, code, audience, urgency, protected_person_id, channel,
       recipient_kind, recipient_id, status, created_at, fallback_of)
     VALUES ($1::uuid, $1::text, 'F-DAILY', 'FAMILY', 'INFO', $2, 'PUSH', 'PUSH_TARGET', 'pt-1', $3, $4, $5::uuid)`,
    [id, PERSON, status, at, fallbackOf],
  );
}

describe('saklama temizliği (8.3.8)', () => {
  it('ham sinyal süresi: eski satır silinir, yenisi kalır; konum daha erken düşer', async () => {
    await signalAt(ago(RETENTION_DEFAULTS.signalDays + 1), 'old');
    await signalAt(ago(RETENTION_DEFAULTS.signalLocationDays + 1), 'mid');
    await signalAt(ago(1), 'new');
    const r = await svc.run(NOW);
    expect(r).toMatchObject({ signals: 1, signalLocations: 1 });
    const rows = await h.rows<{ idempotency_key: string; has_loc: boolean }>(
      `SELECT idempotency_key, payload ? 'location' AS has_loc FROM signal.signal ORDER BY time`,
    );
    expect(rows).toEqual([
      { idempotency_key: 'mid', has_loc: false },
      { idempotency_key: 'new', has_loc: true },
    ]);
    // ikinci tur: iş yok (idempotent)
    expect(await svc.run(NOW)).toMatchObject({ signals: 0, signalLocations: 0 });
  });

  it('günlük özet süresi', async () => {
    await h.rows(`INSERT INTO signal.daily_summary (protected_person_id, day) VALUES ($1, $2), ($1, $3)`, [
      PERSON,
      ago(RETENTION_DEFAULTS.dailySummaryDays + 2).slice(0, 10),
      ago(3).slice(0, 10),
    ]);
    expect(await svc.run(NOW)).toMatchObject({ dailySummaries: 1 });
    expect(await count('signal.daily_summary')).toBe(1);
  });

  it('outbox: yalnız işlenmiş ve süresi dolmuş; işlenmemiş, DLQ ve ölü side satırı kalır', async () => {
    const old = ago(RETENTION_DEFAULTS.outboxDays + 1);
    await h.rows(
      `INSERT INTO event.outbox (topic, envelope, created_at, processed_at) VALUES
         ('t', '{}', $1, $1), ('t', '{}', $1, NULL), ('t', '{}', $2, $2)`,
      [old, ago(1)],
    );
    await h.rows(
      `INSERT INTO event.outbox_side (outbox_id, topic, handler, envelope, created_at, processed_at, dead_at) VALUES
         (1, 't', 'a', '{}', $1, $1, NULL), (1, 't', 'b', '{}', $1, NULL, $1), (2, 't', 'a', '{}', $1, NULL, NULL)`,
      [old],
    );
    await h.rows(
      `INSERT INTO event.outbox_dlq (id, topic, envelope, created_at, failed_at, attempts) VALUES (99, 't', '{}', $1, $1, 5)`,
      [ago(1000)],
    );
    expect(await svc.run(NOW)).toMatchObject({ outbox: 1, outboxSide: 1 });
    expect(await count('event.outbox')).toBe(2);
    expect(await count('event.outbox', 'processed_at IS NULL')).toBe(1);
    expect(await count('event.outbox_side')).toBe(2);
    expect(await count('event.outbox_side', 'dead_at IS NOT NULL')).toBe(1);
    expect(await count('event.outbox_dlq')).toBe(1);
  });

  it('davet kodları: süresi dolmuş + bekleme süresi geçmiş (kullanılmış/kullanılmamış) silinir', async () => {
    const old = ago(RETENTION_DEFAULTS.inviteDays + 1);
    await h.rows(
      `INSERT INTO profile.invite (id, protected_person_id, code_hash, expires_at, used_at) VALUES
         (gen_random_uuid(), $1, 'a', $2, NULL), (gen_random_uuid(), $1, 'b', $2, $2),
         (gen_random_uuid(), $1, 'c', $3, NULL)`,
      [PERSON, old, ago(1)],
    );
    await h.rows(
      `INSERT INTO profile.member_invite (id, protected_person_id, code_hash, created_by, expires_at) VALUES
         (gen_random_uuid(), $1, 'a', 'fam-1', $2), (gen_random_uuid(), $1, 'b', 'fam-1', $3)`,
      [PERSON, old, new Date(NOW.getTime() + DAY).toISOString()],
    );
    expect(await svc.run(NOW)).toMatchObject({ invites: 2, memberInvites: 1 });
    expect(await count('profile.invite')).toBe(1);
    expect(await count('profile.member_invite')).toBe(1);
  });

  it('bildirim: yalnız son durumdakiler; saklanan yedeğin asıl satırı silinmez', async () => {
    const old = ago(RETENTION_DEFAULTS.notificationDays + 1);
    const id = (n: number) => `0190c1d2-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;
    await notificationAt(old, 'delivered', id(1));
    await notificationAt(old, 'queued', id(2)); // takılı kalmış: silinmez (dağıtıcı/amir görsün)
    await notificationAt(old, 'sent', id(3));
    await notificationAt(old, 'failed', id(4), id(3)); // yedek de eski: ikisi birlikte silinir
    await notificationAt(old, 'sent', id(5));
    await notificationAt(ago(1), 'delivered', id(6), id(5)); // yedek yeni: asıl kalır
    expect(await svc.run(NOW)).toMatchObject({ notifications: 3 });
    const left = await h.rows<{ id: string }>(`SELECT id::text FROM notify.notification ORDER BY id`);
    expect(left.map((r) => r.id)).toEqual([id(2), id(5), id(6)]);
  });

  it('ortak webhook nonce kaydı (imza penceresi ±5 dk; 1 günden kısa olamaz)', async () => {
    await h.rows(
      `INSERT INTO device.partner_delivery (partner, nonce, received_at) VALUES ('P', 'n1', $1), ('P', 'n2', $2)`,
      [ago(RETENTION_DEFAULTS.partnerNonceDays + 1), ago(0)],
    );
    expect(await svc.run(NOW)).toMatchObject({ partnerNonces: 1 });
    expect(await count('device.partner_delivery')).toBe(1);
  });

  it('audit.log silinmez; özet yalnız sayılarla SYSTEM olarak yazılır (PII yok)', async () => {
    await h.rows(
      `INSERT INTO audit.log (at, actor_kind, action, entity_type, entity_id, data) VALUES ($1, 'OPERATOR', 'x', 'event', 'e', '{}')`,
      [ago(5000)],
    );
    const before = await count('audit.log');
    await signalAt(ago(RETENTION_DEFAULTS.signalDays + 1), 'old');
    await svc.run(NOW);
    expect(await count('audit.log')).toBe(before + 1);
    const [row] = await h.rows<{ actor_kind: string; action: string; data: unknown }>(
      `SELECT actor_kind, action, data FROM audit.log ORDER BY id DESC LIMIT 1`,
    );
    expect(row).toMatchObject({ actor_kind: 'SYSTEM', action: 'privacy.retention_purged' });
    expect(row!.data).toMatchObject({ counts: { signals: 1 } });
    expect(scanPii(JSON.stringify(row))).toEqual([]);
    // iş yoksa denetim satırı da yok
    await svc.run(NOW);
    expect(await count('audit.log')).toBe(before + 1);
  });

  it('0 o sınıfı kapatır', async () => {
    svc = new RetentionService(h.db, { ...RETENTION_DEFAULTS, signalDays: 0, signalLocationDays: 0, sweepMs: 0 });
    await signalAt(ago(5000), 'ancient');
    expect(await svc.run(NOW)).toMatchObject({ signals: 0, signalLocations: 0 });
    expect(await count('signal.signal')).toBe(1);
  });

  it('başka örnek temizlik yaparken (kilit alınamaz) atlanır', async () => {
    await signalAt(ago(RETENTION_DEFAULTS.signalDays + 1), 'old');
    // PGlite tek bağlantıdır (ikinci oturum yok): kilit denemesi taklit edilir; gerçek kilit pg_try_advisory_xact_lock.
    const busy = new RetentionService(h.db, { ...RETENTION_DEFAULTS, sweepMs: 0 });
    busy.tryLock = async () => false;
    expect(await busy.run(NOW)).toBeNull();
    expect(await count('signal.signal')).toBe(1);
    expect(await svc.run(NOW)).toMatchObject({ signals: 1 });
  });
});

describe('saklama yapılandırması', () => {
  it('varsayılanlar; ortam değeri; 0 kapatır', () => {
    expect(retentionConfigFromEnv({})).toEqual(RETENTION_DEFAULTS);
    expect(retentionConfigFromEnv({ SIGNAL_RETENTION_DAYS: '90', OUTBOX_RETENTION_DAYS: '0' })).toMatchObject({
      signalDays: 90,
      outboxDays: 0,
    });
  });
  it('geçersiz veya güvenlik tabanının altındaki değer açılışta reddedilir', () => {
    expect(() => retentionConfigFromEnv({ SIGNAL_RETENTION_DAYS: 'abc' })).toThrow(/SIGNAL_RETENTION_DAYS/);
    expect(() => retentionConfigFromEnv({ SIGNAL_RETENTION_DAYS: '-1' })).toThrow(/SIGNAL_RETENTION_DAYS/);
    // öğrenme (14 gün) ve şarj öğrenmesi (15 gün) ham sinyal okur
    expect(() => retentionConfigFromEnv({ SIGNAL_RETENTION_DAYS: '10' })).toThrow(/en az/);
    // aile "son konum" 24 saat
    expect(() => retentionConfigFromEnv({ SIGNAL_LOCATION_RETENTION_DAYS: '0.5' })).toThrow();
    expect(() => retentionConfigFromEnv({ PARTNER_NONCE_RETENTION_DAYS: '0' })).not.toThrow();
  });
});
