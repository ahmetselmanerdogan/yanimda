import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { safeError } from '../../common/safe-error';
import { DB, type Db, type Tx } from '../../db/client';
import { assignment, auditLog, operator } from '../../db/schema';
import { EventService } from '../event/event.service';
import { ONLINE_WINDOW_SEC } from '../metrics/supervisor.service';
import { callStalenessFromEnv, liveCallSql } from '../telephony/telephony.service';

export const ASSIGNMENT_OPTIONS = Symbol('ASSIGNMENT_OPTIONS');
export interface AssignmentOptions {
  /** Operatörün atanan olayı açması için süre (sn); dolunca olay kuyruğa döner, operatör molaya. */
  acceptSec?: number;
  /** Tur aralığı (ms); 0 = zamanlayıcı yok (testler run() çağırır). */
  everyMs?: number;
}

/** Bir turda bakılan en çok kuyruk olayı (öncelik sırasıyla). */
const QUEUE_SCAN = 200;

/**
 * Otomatik atama (0039). Amir bayrağı `auto_assign` açıkken her turda:
 *  1. Süresi dolan teklifler: olay hâlâ o operatörde ve OPERATOR_ASSIGNED ise kuyruğa döner (O-ASSIGN-MISSED), operatör
 *     molaya alınır (BREAK, status_by 'system'). Bayrak kapansa da bekleyen teklifler sonuçlanır.
 *  2. Kuyruk öncelik (P1 önce), kuyruk başı bayrağı ve yaş sırasıyla; her olay uygun operatörlerin en uzun boşta
 *     kalanına. Uygun: OPERATOR, AVAILABLE, konsolu bağlı (son görülme < ONLINE_WINDOW_SEC), elinde yürüttüğü olay
 *     (OPERATOR_ASSIGNED / CONTACT_CHAIN) ve bekleyen teklif yok, aramada değil. Teyitli / 112'deki olayı izleyen
 *     operatör alabilir ama hiç açık olayı olmayan önce gelir.
 * Uygunluk olayın transaction'ında operatör satırı kilitlenerek yeniden doğrulanır: birden çok API sunucusu aynı anda
 * çalışabilir, aynı operatöre iki olay verilmez. Kabul = operatörün olay üzerindeki ilk eylemi (EventService.operate:
 * üstlen, arama, adım sonucu, kapatma). Okumalar ve sistem işlemleri (kişi kartı, 112 metni, kalp atışı, zincirin
 * yeniden planlanması) `accept: false` ile geçer, kabul sayılmaz.
 */
@Injectable()
export class AssignmentService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Assignment');
  private readonly acceptSec: number;
  private readonly everyMs: number;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EventService) private readonly events: EventService,
    @Optional() @Inject(ASSIGNMENT_OPTIONS) opts: AssignmentOptions = {},
  ) {
    this.acceptSec = opts.acceptSec ?? Number(process.env.ASSIGN_ACCEPT_SEC ?? 20);
    this.everyMs = opts.everyMs ?? Number(process.env.ASSIGN_EVERY_MS ?? 2000);
  }

  onApplicationBootstrap() {
    if (this.everyMs <= 0) return;
    const tick = () =>
      this.run()
        .catch((e) => this.log.error(`Atama turu başarısız: ${safeError(e)}`))
        .finally(() => (this.timer = setTimeout(tick, this.everyMs)));
    this.timer = setTimeout(tick, this.everyMs);
  }

  onModuleDestroy() {
    clearTimeout(this.timer);
  }

  async enabled(): Promise<boolean> {
    const r = await this.rows<{ enabled: boolean }>(
      sql`SELECT enabled FROM event.supervisor_flag WHERE key = 'auto_assign'`,
    );
    return r[0]?.enabled === true;
  }

  /**
   * Bir tur. `at` verilirse (testler) her zaman o an kullanılır; verilmezse her adım gerçek saati okur: yük altında
   * tur saniyeler sürebilir, teklif anı ve kabul son anı turun başlangıcından değil teklifin yazıldığı andan sayılır.
   */
  async run(at?: Date): Promise<{ assigned: number; missed: number }> {
    const clock = () => at ?? new Date();
    const now = clock();
    // Boşta tek küçük sorgu: bayrak kapalı ve süresi dolan teklif yoksa başka sorgu yok.
    const [st] = await this.rows<{ enabled: boolean; due: boolean }>(sql`
      SELECT coalesce((SELECT enabled FROM event.supervisor_flag WHERE key = 'auto_assign'), false) AS enabled,
             EXISTS (SELECT 1 FROM event.assignment
                     WHERE outcome IS NULL AND expires_at <= ${now.toISOString()}::timestamptz) AS due`);
    const missed = st?.due ? await this.expireOffers(now) : 0;
    if (!st?.enabled) return { assigned: 0, missed };

    const queue = await this.rows<{ id: string }>(sql`
      SELECT id::text AS id FROM event.event WHERE state = 'OPERATOR_QUEUE'
      ORDER BY priority, head_of_queue DESC, created_at LIMIT ${QUEUE_SCAN}`);
    if (!queue.length) return { assigned: 0, missed };
    const ops = await this.candidates(now);
    let assigned = 0;
    let i = 0;
    for (const ev of queue) {
      while (i < ops.length) {
        const op = ops[i]!;
        let checked = false;
        const ok = await this.events.assignAuto(
          ev.id,
          op,
          async (tx) => {
            checked = true;
            return this.reserve(tx, ev.id, op, clock());
          },
          clock(),
        );
        if (ok) {
          assigned++;
          i++;
          break;
        }
        if (!checked) break; // olay artık kuyrukta değil: aynı operatör sıradaki olaya
        i++; // operatör bu arada uygunluğunu yitirdi (başka sunucu atadı, mola, arama)
      }
      if (i >= ops.length) break;
    }
    if (assigned) this.log.log(`${assigned} olay otomatik atandı`);
    return { assigned, missed };
  }

  /** Uygun operatörler: hiç açık olayı olmayan önce, sonra en uzun boşta kalan. */
  private async candidates(now: Date): Promise<string[]> {
    const rows = await this.rows<{ subject: string }>(sql`
      SELECT o.subject FROM identity.operator o
      WHERE ${this.eligible(now)}
      ORDER BY
        EXISTS (SELECT 1 FROM event.event e WHERE e.operator_id = o.subject
                AND e.state IN ('CONFIRMED_OK', 'CONFIRMED_EMERGENCY', 'DISPATCH')),
        greatest(
          o.status_at,
          coalesce((SELECT max(e.closed_at) FROM event.event e WHERE e.operator_id = o.subject), 'epoch')
        ),
        o.subject`);
    return rows.map((r) => r.subject);
  }

  private eligible(now: Date) {
    const online = new Date(now.getTime() - ONLINE_WINDOW_SEC * 1000).toISOString();
    return sql`o.kind = 'OPERATOR' AND o.status = 'AVAILABLE' AND o.last_seen_at > ${online}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM event.event e WHERE e.operator_id = o.subject
                      AND e.state IN ('OPERATOR_ASSIGNED', 'CONTACT_CHAIN'))
      AND NOT EXISTS (SELECT 1 FROM event.assignment a WHERE a.operator_id = o.subject AND a.outcome IS NULL)
      AND NOT EXISTS (SELECT 1 FROM telephony.inbound_call i
                      WHERE i.operator_id = o.subject AND i.status IN ('ringing', 'connected'))
      AND NOT EXISTS (SELECT 1 FROM telephony.call c
                      WHERE c.operator_id = o.subject AND ${liveCallSql(now, callStalenessFromEnv())})`;
  }

  /**
   * Olayın transaction'ında: önce operatör satırını kilitle, SONRA uygunluğu ayrı sorguyla denetle. Tek sorguda
   * (`... AND NOT EXISTS (...) FOR UPDATE`) Postgres kilidi bekledikten sonra yalnız satırın kendi sütunlarını yeniden
   * denetler; alt sorgular eski anlık görüntüyle kalır ve diğer sunucunun az önce yazdığı teklifi görmez (4 API
   * sunuculu ölçümde aynı operatöre üst üste teklif). READ COMMITTED'da ikinci sorgu kilitten sonraki taze görüntüdür.
   */
  private async reserve(tx: Tx, eventId: string, op: string, now: Date): Promise<boolean> {
    await tx.execute(sql`SELECT 1 FROM identity.operator WHERE subject = ${op} FOR UPDATE`);
    const r = (await tx.execute(sql`
      SELECT o.subject FROM identity.operator o WHERE o.subject = ${op} AND ${this.eligible(now)}`)) as unknown as {
      rows: unknown[];
    };
    if (r.rows.length !== 1) return false;
    await tx
      .insert(assignment)
      .values({ eventId, operatorId: op, offeredAt: now, expiresAt: new Date(now.getTime() + this.acceptSec * 1000) });
    return true;
  }

  /** Süresi dolan teklifler; kuyruğa iade edilen sayı. */
  private async expireOffers(now: Date): Promise<number> {
    const due = await this.rows<{ id: number; event_id: string; operator_id: string }>(sql`
      SELECT id, event_id::text AS event_id, operator_id FROM event.assignment
      WHERE outcome IS NULL AND expires_at <= ${now.toISOString()}::timestamptz ORDER BY id`);
    let missed = 0;
    for (const a of due) {
      const back = await this.events.revokeAssignment(a.event_id, a.operator_id, now);
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE event.assignment SET outcome = ${back ? 'MISSED' : 'SUPERSEDED'}, decided_at = ${now.toISOString()}::timestamptz
          WHERE id = ${a.id} AND outcome IS NULL`);
        if (!back) return;
        const moved = await tx
          .update(operator)
          .set({ status: 'BREAK', statusAt: now, statusBy: 'system' })
          .where(sql`${operator.subject} = ${a.operator_id} AND ${operator.status} = 'AVAILABLE'`)
          .returning({ s: operator.subject });
        if (moved.length)
          await tx.insert(auditLog).values({
            actorKind: 'SYSTEM',
            action: 'operator.status',
            entityType: 'operator',
            entityId: a.operator_id,
            data: { status: 'BREAK', reason: 'ASSIGN_MISSED', eventId: a.event_id },
          });
      });
      if (back) missed++;
    }
    return missed;
  }

  private async rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
    return ((await this.db.execute(q)) as unknown as { rows: T[] }).rows;
  }
}
