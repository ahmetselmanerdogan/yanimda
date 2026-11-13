import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { safeError } from '../../common/safe-error';
import { DB, type Db, type Tx } from '../../db/client';
import { auditLog } from '../../db/schema';

/**
 * T-081 ASVS 8.3.8 saklama süreleri (docs/security/saklama.md). Gün cinsinden; 0 o sınıfın temizliğini kapatır.
 * Kendi işi olan sınıflar burada değil: görüşme kaydı (RECORDING_RETENTION_DAYS + nesne kilidi), değer verisi
 * (VitalsService.purge, kural paketi `vitals.retention`), audit.log (append-only, silinmez).
 */
export interface RetentionConfig {
  /** signal.signal ham satırı (SIGNAL_RETENTION_DAYS). */
  signalDays: number;
  /** signal.signal payload.location alanı (SIGNAL_LOCATION_RETENTION_DAYS); satır kalır, konum düşer. */
  signalLocationDays: number;
  /** signal.daily_summary (DAILY_SUMMARY_RETENTION_DAYS). */
  dailySummaryDays: number;
  /** event.outbox / outbox_side işlenmiş satırları (OUTBOX_RETENTION_DAYS). DLQ ve ölü side satırı asla. */
  outboxDays: number;
  /** profile.invite / member_invite: süresi dolduktan sonra (INVITE_RETENTION_DAYS). */
  inviteDays: number;
  /** notify.notification son durumdakiler (NOTIFICATION_RETENTION_DAYS). */
  notificationDays: number;
  /** device.partner_delivery nonce kaydı (PARTNER_NONCE_RETENTION_DAYS); imza penceresi ±5 dk. */
  partnerNonceDays: number;
  /** Tarama aralığı (RETENTION_SWEEP_MS); 0 kapatır. */
  sweepMs: number;
}

export const RETENTION_DEFAULTS: RetentionConfig = {
  signalDays: 400,
  signalLocationDays: 30,
  dailySummaryDays: 400,
  outboxDays: 7,
  inviteDays: 30,
  notificationDays: 365,
  partnerNonceDays: 7,
  sweepMs: 6 * 3_600_000,
};

type DayKey = Exclude<keyof RetentionConfig, 'sweepMs'>;

/**
 * Ortam adı ve güvenlik tabanı (0 hariç en az). Taban, o veriyi okuyan kodun en uzun penceresidir:
 * öğrenme 14 gün + şarj öğrenmesi 15 gün + aylık kolye testi → ham sinyal ≥ 35; aile "son konum" 24 saat → ≥ 1;
 * aile günlük özet ekranı 31 gün → ≥ 31; bildirim yedeği / teslim raporu → ≥ 30.
 */
const ENV: Record<DayKey, { env: string; min: number }> = {
  signalDays: { env: 'SIGNAL_RETENTION_DAYS', min: 35 },
  signalLocationDays: { env: 'SIGNAL_LOCATION_RETENTION_DAYS', min: 1 },
  dailySummaryDays: { env: 'DAILY_SUMMARY_RETENTION_DAYS', min: 31 },
  outboxDays: { env: 'OUTBOX_RETENTION_DAYS', min: 1 },
  inviteDays: { env: 'INVITE_RETENTION_DAYS', min: 1 },
  notificationDays: { env: 'NOTIFICATION_RETENTION_DAYS', min: 30 },
  partnerNonceDays: { env: 'PARTNER_NONCE_RETENTION_DAYS', min: 1 },
};

/** Ortamdan okur. Geçersiz veya tabanın altındaki değer açılışı durdurur (sessizce kısa süreyle veri silinmesin). */
export function retentionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  const cfg = { ...RETENTION_DEFAULTS };
  for (const [key, { env: name, min }] of Object.entries(ENV) as [DayKey, { env: string; min: number }][]) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} tam sayı (gün, ≥ 0) olmalı`);
    if (n > 0 && n < min) throw new Error(`${name} en az ${min} gün olmalı (0 = kapalı)`);
    cfg[key] = n;
  }
  const sweep = env.RETENTION_SWEEP_MS;
  if (sweep !== undefined && sweep !== '') {
    const n = Number(sweep);
    if (!Number.isInteger(n) || n < 0) throw new Error('RETENTION_SWEEP_MS tam sayı (ms, ≥ 0) olmalı');
    cfg.sweepMs = n;
  }
  return cfg;
}

export const RETENTION_CONFIG = Symbol('RETENTION_CONFIG');

export interface RetentionReport {
  signals: number;
  signalLocations: number;
  dailySummaries: number;
  outbox: number;
  outboxSide: number;
  invites: number;
  memberInvites: number;
  notifications: number;
  partnerNonces: number;
}

const DAY_MS = 86_400_000;
/** Tek ifadede en çok bu kadar satır (sorgu zaman aşımı 30 sn); tur başına sınıf başına en çok BATCH × MAX_BATCHES. */
const BATCH = 5_000;
const MAX_BATCHES = 200;
type Rows = { rows: unknown[] };

/**
 * T-081 (8.3.8) saklama temizliği. Diğer taramalarla aynı desen (süreç içi zamanlayıcı, `*_SWEEP_MS`); birden çok API
 * örneğinde tek örnek çalışır (transaction'a bağlı advisory lock; alınamazsa tur atlanır). Silmeler idempotent ve
 * parçalı (her ifade ≤ BATCH satır). Tur sonunda iş yapıldıysa audit.log'a yalnız sayılar yazılır (kimlik, içerik yok).
 */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  /** Sabit, uygulamaya özgü advisory lock anahtarı (migrate.ts 4_200_101). */
  static readonly LOCK_KEY = 4_200_181;
  private readonly log = new Logger('Retention');
  private readonly cfg: RetentionConfig;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(RETENTION_CONFIG) cfg?: RetentionConfig,
  ) {
    this.cfg = cfg ?? retentionConfigFromEnv();
  }

  onApplicationBootstrap() {
    const every = this.cfg.sweepMs;
    if (every <= 0) return;
    const tick = () =>
      this.run()
        .catch((e) => this.log.error(`Saklama temizliği başarısız: ${safeError(e)}`))
        .finally(() => {
          this.timer = setTimeout(tick, every);
          this.timer.unref();
        });
    // Açılışta değil: dağıtım anındaki yükü artırmasın.
    this.timer = setTimeout(tick, Math.min(every, 10 * 60_000));
    this.timer.unref();
  }

  onModuleDestroy() {
    clearTimeout(this.timer);
  }

  /** Başka örnek turdaysa false (testte taklit edilir). */
  async tryLock(tx: Tx): Promise<boolean> {
    const r = (await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${RetentionService.LOCK_KEY}) AS ok`,
    )) as unknown as { rows: { ok: boolean }[] };
    return r.rows[0]?.ok === true;
  }

  /** Bir tur. Kilit alınamazsa null. */
  async run(now = new Date()): Promise<RetentionReport | null> {
    const c = this.cfg;
    const cut = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
    return this.db.transaction(async (tx) => {
      if (!(await this.tryLock(tx))) return null;
      const r: RetentionReport = {
        signals: 0,
        signalLocations: 0,
        dailySummaries: 0,
        outbox: 0,
        outboxSide: 0,
        invites: 0,
        memberInvites: 0,
        notifications: 0,
        partnerNonces: 0,
      };
      if (c.signalDays > 0) {
        const t = cut(c.signalDays);
        r.signals = await batched(
          tx,
          sql`DELETE FROM signal.signal WHERE (idempotency_key, time) IN (
                SELECT idempotency_key, time FROM signal.signal WHERE time < ${t}::timestamptz LIMIT ${BATCH})
              RETURNING 1`,
        );
      }
      if (c.signalLocationDays > 0) {
        // Konum, olayın kendisinde (event.location) ayrıca saklanır; ham sinyaldeki iz kısa tutulur.
        const t = cut(c.signalLocationDays);
        r.signalLocations = await batched(
          tx,
          sql`UPDATE signal.signal SET payload = payload - 'location' WHERE (idempotency_key, time) IN (
                SELECT idempotency_key, time FROM signal.signal
                WHERE time < ${t}::timestamptz AND payload->'location' IS NOT NULL LIMIT ${BATCH})
              RETURNING 1`,
        );
      }
      if (c.dailySummaryDays > 0) {
        const t = cut(c.dailySummaryDays);
        r.dailySummaries = await batched(
          tx,
          sql`DELETE FROM signal.daily_summary WHERE (protected_person_id, day) IN (
                SELECT protected_person_id, day FROM signal.daily_summary
                WHERE day < (${t}::timestamptz)::date LIMIT ${BATCH})
              RETURNING 1`,
        );
      }
      if (c.outboxDays > 0) {
        const t = cut(c.outboxDays);
        // Yalnız teslim edilmiş satırlar: işlenmemiş, DLQ (event.outbox_dlq) ve ölü side satırı (dead_at) kalır.
        r.outbox = await batched(
          tx,
          sql`DELETE FROM event.outbox WHERE id IN (
                SELECT id FROM event.outbox WHERE processed_at < ${t}::timestamptz LIMIT ${BATCH})
              RETURNING 1`,
        );
        r.outboxSide = await batched(
          tx,
          sql`DELETE FROM event.outbox_side WHERE id IN (
                SELECT id FROM event.outbox_side
                WHERE processed_at < ${t}::timestamptz AND dead_at IS NULL LIMIT ${BATCH})
              RETURNING 1`,
        );
      }
      if (c.inviteDays > 0) {
        const t = cut(c.inviteDays);
        r.invites = await batched(
          tx,
          sql`DELETE FROM profile.invite WHERE id IN (
                SELECT id FROM profile.invite WHERE expires_at < ${t}::timestamptz LIMIT ${BATCH})
              RETURNING 1`,
        );
        r.memberInvites = await batched(
          tx,
          sql`DELETE FROM profile.member_invite WHERE id IN (
                SELECT id FROM profile.member_invite WHERE expires_at < ${t}::timestamptz LIMIT ${BATCH})
              RETURNING 1`,
        );
      }
      if (c.notificationDays > 0) {
        const t = cut(c.notificationDays);
        // Yedek bildirim (fallback_of) asıl satırı referanslar: önce referanssız olanlar silinir, asıl satır bir
        // sonraki parçada boşalır. Yedeği saklanan (yeni / son durumda olmayan) asıl satır hiç silinmez.
        r.notifications = await batched(
          tx,
          sql`DELETE FROM notify.notification WHERE id IN (
                SELECT n.id FROM notify.notification n
                WHERE n.created_at < ${t}::timestamptz AND n.status IN ('sent', 'delivered', 'failed')
                  AND NOT EXISTS (SELECT 1 FROM notify.notification c WHERE c.fallback_of = n.id)
                LIMIT ${BATCH})
              RETURNING 1`,
          true,
        );
      }
      if (c.partnerNonceDays > 0) {
        const t = cut(c.partnerNonceDays);
        r.partnerNonces = await batched(
          tx,
          sql`DELETE FROM device.partner_delivery WHERE (partner, nonce) IN (
                SELECT partner, nonce FROM device.partner_delivery WHERE received_at < ${t}::timestamptz LIMIT ${BATCH})
              RETURNING 1`,
        );
      }
      const total = Object.values(r).reduce((a, b) => a + b, 0);
      if (total > 0) {
        await tx.insert(auditLog).values({
          actorKind: 'SYSTEM',
          actorId: null,
          action: 'privacy.retention_purged',
          entityType: 'retention',
          entityId: now.toISOString().slice(0, 10),
          data: { counts: r, days: daysOf(c) },
        });
        this.log.log(
          `Saklama temizliği: ${Object.entries(r)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}`,
        );
      }
      return r;
    });
  }
}

/**
 * Parçalı çalıştırma: ifade BATCH'ten az satır etkileyince (ya da `untilEmpty` iken 0) durur. Tur başına üst sınır
 * MAX_BATCHES; kalanı sonraki tura kalır.
 */
async function batched(tx: Tx, stmt: SQL, untilEmpty = false): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = ((await tx.execute(stmt)) as unknown as Rows).rows.length;
    total += n;
    if (n === 0 || (!untilEmpty && n < BATCH)) break;
  }
  return total;
}

const daysOf = (c: RetentionConfig) => {
  const { sweepMs: _sweep, ...days } = c;
  return days;
};
