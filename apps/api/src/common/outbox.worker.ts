import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { KafkaEnvelope } from '@yanimda/contracts';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { outbox, outboxDlq, outboxSide } from '../db/schema';
import type { LocalBus } from './bus';
import type { OutboxBus } from './outbox';
import { isTransient } from './problem.filter';
import { safeError, safeErrorDetail } from './safe-error';

export interface OutboxWorkerOptions {
  /** Yoklama aralığı (ms). Aynı süreçteki yazımlar işçiyi zaten anında uyandırır. */
  pollMs?: number;
  batchSize?: number;
  /** Bu kadar kalıcı (geçici olmayan) başarısız denemeden sonra satır event.outbox_dlq'ya taşınır. */
  maxAttempts?: number;
  /** n. başarısızlıktan sonra bekleme (ms). */
  backoffMs?: (attempts: number) => number;
  /**
   * Core: geçici altyapı hatası (isTransient: Postgres bağlantısı/failover, sorgu zaman aşımı, ağ) bu kadar
   * denemeye dek DLQ'ya düşmez (varsayılan 125 ≈ 1 saat). Kalıcı hata sayacını (maxAttempts) tüketmez.
   */
  transientMaxAttempts?: number;
  /** Geçici hatada n. denemeden sonra bekleme (ms); varsayılan üstel, en çok 30 sn (kesinti bitince hızlı toparlanma). */
  transientBackoffMs?: (attempts: number) => number;
  now?: () => Date;
  /** Kira süresi (ms): işçi ölürse başka işçi bu süreden sonra devralır. */
  leaseMs?: number;
  /**
   * Bu süreçte aynı anda işlenen core bölümü sayısı (varsayılan OUTBOX_CONCURRENCY ?? 4). Her bölüm teslimde
   * veritabanı bağlantısı kullanır: DATABASE_POOL_MAX bundan büyük tutulmalı (HTTP istekleri de havuzu paylaşır).
   */
  concurrency?: number;
  /**
   * Rutin toplu tur sırasında bu aralıkla (ms) bekleyen acil iş yoklanır (varsayılan OUTBOX_YIELD_CHECK_MS ?? 500);
   * varsa şerit turu bırakır, bölüm sıranın sonuna döner. 0 = her satırda (testler).
   */
  yieldCheckMs?: number;
}

/** Şeridin toplu turu bırakıp bırakmayacağı: bu bölümde (`own`) veya boştaki başka bölümde acil iş bekliyor mu. */
type ShouldYield = (own: boolean) => Promise<boolean>;

/** Core bölüm sayısı: 0038 migration'daki event.outbox.part ifadesiyle aynı olmalıdır. */
export const OUTBOX_PARTITIONS = 32;
/** Acil diye alınıp teslim edemeyen bölüm bu süre (ms) sonra yeniden acil seçilebilir. */
const STUCK_RETRY_MS = 1000;
/** Bölüm kiraları: id = PART_LEASE_BASE + bölüm. */
const PART_LEASE_BASE = 100;
/** Kira 1: eski tek işçi kirası; bölümlü işçiler onu bu sahiple sonsuza dek tutar (deploy çiti, 0038). */
const FENCE_OWNER = 'partitioned';

/**
 * T-010 OutboxWorker: event.outbox'taki işlenmemiş satırları id sırasıyla süreç içi abonelere (LocalBus) verir.
 *
 * İki şerit (inceleme bulgusu 3): core aboneler (olay motoru, kuyruk/aile ekranı, bildirim planı) outbox satırını
 * doğrudan alır; side aboneler (SLA metriği, faturalama, yanlış alarm kaydı) için satır işaretlenirken aynı
 * transaction'da event.outbox_side'a abone başına bir satır yazılır ve ayrı döngü (kira id = 2) teslim eder. Böylece
 * yavaş/bozuk istatistik abonesi SOS'u bekletmez; side'da hata yalnız o abonenin kuyruğunu durdurur.
 *
 * - Sıra kişi başınadır (0038): satır kişiye göre OUTBOX_PARTITIONS bölümden birine düşer (event.outbox.part). Her
 *   bölümde tek aktif işçi (kira id 100 + bölüm); bölümler aynı süreçte `concurrency` kadar paralel, birden çok API
 *   örneğinde örnekler arasında dağılır. Başarısız satır kendi bölümünün başında bekler; arkasındakiler ondan önce
 *   teslim edilmez (FALL'dan önce CANCEL işlenmesin); başka kişiler (aynı bölümde bile) beklemez.
 * - Öncelik: rutin ölçüm dışındaki satır acildir (event.outbox.urgent). Acil satırı olan bölüm önce seçilir (turda
 *   boşalmış olsa da) ve bölümde o kişinin satırları (öncekiler dahil, sırasıyla) önce teslim edilir. Rutin toplu tur
 *   sırasında yieldCheckMs aralıkla acil iş yoklanır; varsa şerit turu bırakır (aşırı yükte SOS p95 15–27 sn → <1 sn,
 *   docs/test-reports/2026-11-14-sos-asiri-yuk.md).
 * - Kira 1 deploy çitidir: bölümlü işçi onu alamazsa (eski sürüm genel FIFO'yla çalışıyor) teslim etmez.
 * - Kira satır başına değil, süresinin üçte biri geçince yenilenir (satır başına bir sorgu daha az).
 * - Yeniden deneme: üstel geri çekilme; `maxAttempts` (5) kalıcı hatadan sonra outbox_dlq'ya taşınır, kuyruk ilerler.
 *   Geçici altyapı hatası (denetim bulgusu: kısa veritabanı kesintisinde FALL DLQ'ya düşmesin) ayrı sayılır
 *   (transient_attempts): en çok 30 sn geri çekilmeyle ~1 saat denenir, sonra DLQ (yanlış sınıflanmış kalıcı hata
 *   core şeridini sonsuza dek tıkamasın). Bekleyen satır OutboxStalled uyarısını tetikler.
 * - last_error yalnız hata adı + kodu (safeErrorDetail): Drizzle mesajındaki sorgu parametreleri PII içerebilir.
 * - En az bir kez teslim: teslim ile işaretleme arasında süreç ölürse satır yeniden teslim edilir.
 * - Teslim transaction dışında: aboneler kendi transaction'larını açar, işçi bağlantı tutmaz (havuz 1 olsa da çalışır).
 * - Çoklu API örneğinde bir bölümün kirası tek örnektedir; işçi ölürse kira leaseMs sonra düşer.
 *   (BullMQ zamanlayıcıları T-013'te; Kafka v2.0'da bu işçinin yerini alır.)
 */
export class OutboxWorker {
  private readonly log = new Logger('OutboxWorker');
  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempts: number) => number;
  private readonly transientMaxAttempts: number;
  private readonly transientBackoffMs: (attempts: number) => number;
  private readonly now: () => Date;
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  private again = false;
  private sideTimer?: NodeJS.Timeout;
  private sideRunning?: Promise<number>;
  private sideAgain = false;
  private stopped = true;
  private lastErrLog = 0;
  private unsubscribe?: () => void;
  private readonly leaseMs: number;
  private readonly concurrency: number;
  private readonly yieldCheckMs: number;
  private fenced = false;
  /** stop() sonrası süren core turu yeni bölüm almaz (zarif kapanış). Doğrudan drain() çağrılarını etkilemez. */
  private halted = false;
  /** Bölüm kirasının son alındığı / yenilendiği an (ms). */
  private readonly leasedAt = new Map<number, number>();
  readonly owner = `${process.pid}-${randomUUID()}`;

  constructor(
    private readonly db: Db,
    private readonly bus: LocalBus,
    private readonly outboxBus?: OutboxBus,
    opts: OutboxWorkerOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? Number(process.env.OUTBOX_POLL_MS ?? 1000);
    this.batchSize = opts.batchSize ?? 100;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffMs = opts.backoffMs ?? ((n) => Math.min(1000 * 2 ** n, 60_000));
    this.transientMaxAttempts = opts.transientMaxAttempts ?? 125;
    this.transientBackoffMs = opts.transientBackoffMs ?? ((n) => Math.min(1000 * 2 ** n, 30_000));
    this.now = opts.now ?? (() => new Date());
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.concurrency = Math.max(1, opts.concurrency ?? Number(process.env.OUTBOX_CONCURRENCY ?? 4));
    this.yieldCheckMs = Math.max(0, opts.yieldCheckMs ?? Number(process.env.OUTBOX_YIELD_CHECK_MS ?? 500));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.halted = false;
    this.unsubscribe = this.outboxBus?.onCommitted(() => this.kick());
    this.schedule(0);
    this.scheduleSide(0);
  }

  stop(): void {
    this.stopped = true;
    this.halted = true;
    this.unsubscribe?.();
    clearTimeout(this.timer);
    clearTimeout(this.sideTimer);
  }

  /** Bekleyen bir tur yoksa hemen boşalt; tur sürüyorsa bitince bir tur daha. */
  kick(): void {
    if (this.stopped) return;
    if (this.running) this.again = true;
    else this.schedule(0);
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private kickSide(): void {
    if (this.stopped) return;
    if (this.sideRunning) this.sideAgain = true;
    else this.scheduleSide(0);
  }

  private scheduleSide(ms: number) {
    clearTimeout(this.sideTimer);
    this.sideTimer = setTimeout(() => void this.sideTick(), ms);
  }

  private async sideTick() {
    try {
      await this.drainSide();
    } catch (e) {
      if (Date.now() - this.lastErrLog > 30_000) {
        this.log.error(`Outbox side turu başarısız (30 sn'de bir raporlanır): ${safeError(e)}`);
        this.lastErrLog = Date.now();
      }
    }
    if (this.stopped) return;
    if (this.sideAgain) {
      this.sideAgain = false;
      this.scheduleSide(0);
    } else this.scheduleSide(this.pollMs);
  }

  private async tick() {
    try {
      if ((await this.drainCore()) > 0) this.kickSide();
    } catch (e) {
      if (Date.now() - this.lastErrLog > 30_000) {
        this.log.error(`Outbox turu başarısız (30 sn'de bir raporlanır): ${safeError(e)}`);
        this.lastErrLog = Date.now();
      }
    }
    if (this.stopped) return;
    if (this.again) {
      this.again = false;
      this.schedule(0);
    } else this.schedule(this.pollMs);
  }

  /**
   * Testler / tek seferlik boşaltma: core ve side kuyrukları, ikisi de boşalana kadar (side abonesi yeni core satırı
   * yazabilir). Teslim edilen core satır sayısını döner. Üretimde iki döngü ayrı çalışır (start).
   */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const core = await this.drainCore();
      const side = await this.drainSide();
      total += core;
      if (!core && !side) return total;
    }
  }

  /**
   * Core: bekleyen bölümler `concurrency` şeritte paralel; her bölümden bir toplu tur, sürüyorsa bölüm sıranın sonuna.
   * Her toplu turdan önce acil satırı olan bölüm (bu turda henüz bitmemiş) sıranın önüne alınır: teslim sürerken gelen
   * SOS, binlerce rutin satırın bitmesini beklemez. Teslim edilen satır sayısı. Eş zamanlı çağrılar aynı turu paylaşır.
   */
  drainCore(): Promise<number> {
    this.running ??= (async () => {
      try {
        if (!(await this.fence())) return 0;
        const queue = await this.pendingParts();
        const busy = new Set<number>();
        const done = new Set<number>();
        /** Acil diye alınıp hiç teslim edemeyen bölüm (kira başka işçide, anahtar geri çekilmede): STUCK_RETRY_MS
         * boyunca tekrar acil seçilmez (şerit aynı bölümü boşuna döndürmesin), sonra yeniden denenir. Turun sonuna
         * dek bırakılsaydı iki API'de her iki işçi de bölümü bırakıp SOS'u turların sonuna bırakabiliyordu. */
        const stuckUntil = new Map<number, number>();
        const stuck = { has: (p: number) => (stuckUntil.get(p) ?? 0) > Date.now() };
        const free = (p: number) => !busy.has(p) && !done.has(p);
        const next = async (): Promise<number | undefined> => {
          if (this.halted) return undefined;
          // Acil bölüm bu turda boşalmış (done) olsa da yeniden alınır: aşırı yükte tur bitmez (bölümler hep dolu),
          // bölümü erken biten kişinin SOS'u turun sonunu beklerdi (ölçüm: p95 18–37 sn).
          let p = (await this.urgentParts()).find((x) => !busy.has(x) && !stuck.has(x));
          if (p !== undefined) {
            const i = queue.indexOf(p);
            if (i >= 0) queue.splice(i, 1);
          } else
            while (p === undefined && queue.length) {
              const q = queue.shift()!;
              if (free(q)) p = q;
            }
          if (this.halted) return undefined;
          if (p !== undefined) busy.add(p); // await'ten sonra eşzamanlı: iki şerit aynı bölümü alamaz
          return p;
        };
        let total = 0;
        const lane = async () => {
          for (let p = await next(); p !== undefined; p = await next()) {
            const part = p;
            // Rutin tur sırasında acil iş: bu bölümde (yeni gelmiş, turun sonunda kalırdı) veya boştaki başka bölümde.
            const shouldYield: ShouldYield = async (own) =>
              (await this.urgentParts()).some((x) => (x === part ? own : !busy.has(x) && !stuck.has(x)));
            try {
              const { delivered, more } = await this.drainPart(p, shouldYield);
              total += delivered;
              if (!delivered) stuckUntil.set(p, Date.now() + STUCK_RETRY_MS);
              if (more) queue.push(p);
              else done.add(p);
            } finally {
              busy.delete(p);
            }
          }
        };
        await Promise.all(Array.from({ length: this.concurrency }, lane));
        return total;
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** Deploy çiti: kira 1'i FENCE_OWNER ile sonsuza dek alır. Eski tek işçi tutuyorsa false (bu tur teslim yok). */
  private async fence(): Promise<boolean> {
    if (this.fenced) return true;
    const r = (await this.db.execute(sql`
      INSERT INTO event.outbox_lease (id, owner, until) VALUES (1, ${FENCE_OWNER}, 'infinity')
      ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, until = EXCLUDED.until
      WHERE event.outbox_lease.until < now() OR event.outbox_lease.owner = EXCLUDED.owner
      RETURNING owner`)) as unknown as { rows: unknown[] };
    this.fenced = r.rows.length === 1;
    return this.fenced;
  }

  /** İşlenmemiş satırı olan bölümler, acil satırı olanlar önce (tek gidiş-dönüş; kısmi indeks yoklamaları). */
  private async pendingParts(): Promise<number[]> {
    const r = (await this.db.execute(sql`
      SELECT p FROM generate_series(0, ${OUTBOX_PARTITIONS - 1}) AS p
      WHERE EXISTS (SELECT 1 FROM event.outbox o WHERE o.part = p AND o.processed_at IS NULL)
      ORDER BY EXISTS (SELECT 1 FROM event.outbox o WHERE o.part = p AND o.processed_at IS NULL AND o.urgent) DESC, p`)) as unknown as {
      rows: { p: number }[];
    };
    return r.rows.map((x) => Number(x.p));
  }

  /** Şu an teslim edilebilir acil satırı olan bölümler, en eski acil satır önce (outbox_urgent_pending). */
  private async urgentParts(): Promise<number[]> {
    const rows = await this.db
      .select({ p: outbox.part })
      .from(outbox)
      .where(and(isNull(outbox.processedAt), eq(outbox.urgent, true), lte(outbox.nextAttemptAt, this.now())))
      .groupBy(outbox.part)
      .orderBy(sql`min(${outbox.id})`);
    return rows.map((x) => Number(x.p));
  }

  /** Bir bölümden bir toplu tur (kirası başka işçideyse boş). */
  private async drainPart(p: number, shouldYield?: ShouldYield): Promise<{ delivered: number; more: boolean }> {
    const id = PART_LEASE_BASE + p;
    if (!(await this.acquireLease(id))) return { delivered: 0, more: false };
    this.leasedAt.set(p, Date.now());
    try {
      return await this.drainBatch(p, shouldYield);
    } finally {
      this.leasedAt.delete(p);
      await this.releaseLease(id).catch(() => undefined);
    }
  }

  /** Kira süresinin üçte biri geçtiyse yeniler; kira kaybedildiyse false. */
  private async keepLease(p: number): Promise<boolean> {
    const at = this.leasedAt.get(p) ?? 0;
    if (Date.now() - at < this.leaseMs / 3) return true;
    if (!(await this.acquireLease(PART_LEASE_BASE + p))) return false;
    this.leasedAt.set(p, Date.now());
    return true;
  }

  /** Kirayı alır veya (kendisindeyse) yeniler. Başka canlı işçideyse false. */
  private async acquireLease(id: number): Promise<boolean> {
    const r = (await this.db.execute(sql`
      INSERT INTO event.outbox_lease (id, owner, until)
      VALUES (${id}, ${this.owner}, now() + make_interval(secs => ${this.leaseMs / 1000}))
      ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, until = EXCLUDED.until
      WHERE event.outbox_lease.until < now() OR event.outbox_lease.owner = EXCLUDED.owner
      RETURNING owner`)) as unknown as { rows: unknown[] };
    return r.rows.length === 1;
  }

  private async releaseLease(id: number): Promise<void> {
    await this.db.execute(
      sql`UPDATE event.outbox_lease SET until = '-infinity' WHERE id = ${id} AND owner = ${this.owner}`,
    );
  }

  /**
   * Bölümden bir toplu tur. Önce acil satırı olan anahtarlar: o anahtarların bekleyen bütün satırları (acil satırdan
   * önceki rutin satırlar dahil) id sırasıyla; böylece kişinin sırası bozulmadan alarm öne geçer. Acil iş yoksa (veya
   * hepsi bekliyorsa) bölümün satırları id sırasıyla. Takılan (geri çekilmedeki) anahtarın arkasındaki satırları bu turda
   * atlanır; başka anahtarlar ilerler. Rutin tur sırasında acil iş belirirse (`shouldYield`) tur bırakılır, bölüm
   * sıranın sonuna döner (`more`).
   */
  private async drainBatch(p: number, shouldYield?: ShouldYield): Promise<{ delivered: number; more: boolean }> {
    const pending = and(eq(outbox.part, p), isNull(outbox.processedAt));
    const blocked = new Set<string>();
    let delivered = 0;
    const keys = (
      await this.db
        .selectDistinct({ k: outbox.pkey })
        .from(outbox)
        .where(and(pending, eq(outbox.urgent, true)))
        .limit(this.batchSize)
    ).map((r) => r.k);
    if (keys.length) {
      const rows = await this.db
        .select()
        .from(outbox)
        .where(and(pending, inArray(outbox.pkey, keys)))
        .orderBy(asc(outbox.id))
        .limit(this.batchSize);
      const r = await this.deliverRows(p, rows, blocked);
      if (r.lost) return { delivered: r.delivered, more: false };
      if (r.delivered > 0) return { delivered: r.delivered, more: true };
    }
    // Bölümün acil anahtarları takılıysa (geri çekilmede) kendi acil satırı turu bıraktırmaz: bırakılan tur yeniden
    // aynı takılı anahtarı bulurdu.
    const own = !keys.length;
    const rows = await this.db.select().from(outbox).where(pending).orderBy(asc(outbox.id)).limit(this.batchSize);
    const r = await this.deliverRows(p, rows, blocked, shouldYield && (() => shouldYield(own)));
    delivered += r.delivered;
    if (r.yielded) return { delivered, more: true };
    return { delivered, more: !r.lost && r.delivered > 0 && rows.length === this.batchSize };
  }

  /**
   * Teslim transaction DIŞINDA yapılır: aboneler (ör. EventService) kendi transaction'larını açabilir;
   * işçi bağlantı tutmaz. Teslim ile işaretleme arasında süreç ölürse satır yeniden teslim edilir (en az bir kez).
   * Anahtarın satırı geri çekilmedeyse veya başarısız olursa o anahtar `blocked`'a girer: arkasındaki satırları
   * ondan önce teslim edilmez (FALL'dan önce CANCEL işlenmesin). `shouldYield` verilirse en az bir satır teslim
   * edildikten sonra yieldCheckMs aralıkla yoklanır; acil iş bekliyorsa tur bırakılır (`yielded`).
   */
  private async deliverRows(
    p: number,
    rows: (typeof outbox.$inferSelect)[],
    blocked: Set<string>,
    shouldYield?: () => Promise<boolean>,
  ): Promise<{ delivered: number; lost: boolean; yielded?: boolean }> {
    let delivered = 0;
    let checkedAt = Date.now();
    for (const row of rows) {
      if (blocked.has(row.pkey)) continue;
      if (shouldYield && delivered > 0 && Date.now() - checkedAt >= this.yieldCheckMs) {
        checkedAt = Date.now();
        if (await shouldYield()) return { delivered, lost: false, yielded: true };
      }
      if (!(await this.keepLease(p))) return { delivered, lost: true }; // kira kaybedildi (çok uzun tur)
      const now = this.now();
      if (row.nextAttemptAt > now) {
        blocked.add(row.pkey); // anahtarın baştaki satırı geri çekilmede: sıra korunur
        continue;
      }
      try {
        await this.bus.deliver(row.topic, row.envelope as KafkaEnvelope<unknown>, 'core');
        const side = this.bus.sideNames(row.topic, row.envelope as KafkaEnvelope<unknown>);
        await this.db.transaction(async (tx) => {
          const marked = await tx
            .update(outbox)
            .set({ processedAt: now })
            .where(and(eq(outbox.id, row.id), isNull(outbox.processedAt)))
            .returning({ id: outbox.id });
          if (marked.length && side.length)
            await tx
              .insert(outboxSide)
              .values(side.map((handler) => ({ outboxId: row.id, topic: row.topic, handler, envelope: row.envelope })))
              .onConflictDoNothing();
        });
        delivered++;
      } catch (e) {
        const transient = isTransient(e);
        const attempts = row.attempts + (transient ? 0 : 1);
        const transientAttempts = row.transientAttempts + (transient ? 1 : 0);
        const lastError = `${transient ? '[geçici] ' : ''}${safeErrorDetail(e)}`.slice(0, 1000);
        if (transient ? transientAttempts >= this.transientMaxAttempts : attempts >= this.maxAttempts) {
          const total = attempts + transientAttempts;
          await this.db.transaction(async (tx) => {
            await tx.insert(outboxDlq).values({
              id: row.id,
              topic: row.topic,
              envelope: row.envelope,
              createdAt: row.createdAt,
              failedAt: now,
              attempts: total,
              lastError,
            });
            await tx.delete(outbox).where(and(eq(outbox.id, row.id), isNull(outbox.processedAt)));
          });
          this.log.error(`Outbox #${row.id} (${row.topic}) ${total} denemede başarısız (${lastError}) → outbox_dlq`);
          continue;
        }
        const wait = transient ? this.transientBackoffMs(transientAttempts) : this.backoffMs(attempts);
        await this.db
          .update(outbox)
          .set({ attempts, transientAttempts, lastError, nextAttemptAt: new Date(now.getTime() + wait) })
          .where(eq(outbox.id, row.id));
        const n = transient ? `${transientAttempts}/${this.transientMaxAttempts}` : `${attempts}/${this.maxAttempts}`;
        this.log.warn(`Outbox #${row.id} (${row.topic}) teslim edilemedi (${lastError}), deneme ${n}`);
        blocked.add(row.pkey);
      }
    }
    return { delivered, lost: false };
  }

  /** Side: abone başına sıralı teslim; teslim edilen satır sayısı. Eş zamanlı çağrılar aynı turu paylaşır. */
  drainSide(): Promise<number> {
    this.sideRunning ??= (async () => {
      try {
        if (!(await this.acquireLease(2))) return 0;
        try {
          let total = 0;
          for (;;) {
            const { delivered, more } = await this.drainSideBatch();
            total += delivered;
            if (!more) return total;
          }
        } finally {
          await this.releaseLease(2).catch(() => undefined);
        }
      } finally {
        this.sideRunning = undefined;
      }
    })();
    return this.sideRunning;
  }

  /**
   * Bekleyen side satırları id sırasıyla; bir abonenin satırı başarısız / geri çekilmedeyse o abonenin arkasındaki
   * satırları bu turda atlanır (abone başına sıra), diğer aboneler ilerler. maxAttempts sonra dead_at (abone DLQ).
   */
  private async drainSideBatch(): Promise<{ delivered: number; more: boolean }> {
    const rows = await this.db
      .select()
      .from(outboxSide)
      .where(and(isNull(outboxSide.processedAt), isNull(outboxSide.deadAt)))
      .orderBy(asc(outboxSide.id))
      .limit(this.batchSize);
    const blocked = new Set<string>();
    let delivered = 0;
    for (const row of rows) {
      if (blocked.has(row.handler)) continue;
      if (!(await this.acquireLease(2))) return { delivered, more: false };
      const now = this.now();
      if (row.nextAttemptAt > now) {
        blocked.add(row.handler);
        continue;
      }
      try {
        await this.bus.deliverSide(row.handler, row.topic, row.envelope as KafkaEnvelope<unknown>);
        await this.db.update(outboxSide).set({ processedAt: now }).where(eq(outboxSide.id, row.id));
        delivered++;
      } catch (e) {
        const attempts = row.attempts + 1;
        const lastError = safeErrorDetail(e).slice(0, 1000);
        if (attempts >= this.maxAttempts) {
          await this.db.update(outboxSide).set({ attempts, lastError, deadAt: now }).where(eq(outboxSide.id, row.id));
          this.log.error(`Outbox side #${row.id} (${row.topic} → ${row.handler}) ${attempts} denemede başarısız → DLQ`);
          continue;
        }
        await this.db
          .update(outboxSide)
          .set({ attempts, lastError, nextAttemptAt: new Date(now.getTime() + this.backoffMs(attempts)) })
          .where(eq(outboxSide.id, row.id));
        this.log.warn(`Outbox side #${row.id} (${row.topic} → ${row.handler}) teslim edilemedi, deneme ${attempts}`);
        blocked.add(row.handler);
      }
    }
    return { delivered, more: rows.length === this.batchSize && delivered > 0 };
  }
}
