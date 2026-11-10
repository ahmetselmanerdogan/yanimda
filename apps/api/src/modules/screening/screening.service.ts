import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { t } from '@yanimda/messages';
import { and, asc, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7, validate as isUuid } from 'uuid';

import { safeError } from '../../common/safe-error';
import { DB, type Db, type Tx } from '../../db/client';
import { auditLog, contact, voiceScreening } from '../../db/schema';
import { EventService } from '../event/event.service';
import type { Rule } from '../event/rules.loader';
import { NEVER_SCREEN, type ScreeningResult, type ScreeningStatus, type VoiceScreener } from '../event/voice-screening';
import { EMPTY_TWIML, sayAndHangupTwiml } from '../telephony/cpaas';
import { TelephonyService } from '../telephony/telephony.service';
import { classifyScreening, type ScreeningConfig } from './classify';

export type ScreeningWebhookKind = 'gather' | 'status';
export const SCREENING_WEBHOOK_KINDS: ScreeningWebhookKind[] = ['gather', 'status'];
export const DEFAULT_SCREEN_TIMEOUT_SEC = 120;
const RING_TIMEOUT_SEC = 25;
const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
/** Kişinin aranacak ucu: önce telefonu, yoksa (LTE) saati. */
const TARGET_ROLES = ['ELDER', 'WATCH'] as const;

type StoredConfig = ScreeningConfig & { phrase: string };

export interface ScreeningStats {
  since: string;
  total: number;
  byResult: Record<ScreeningStatus | 'PENDING' | 'CANCELLED', number>;
  /** Operatör örneklemine alınan OK sonuçları (öğrenme modu, ilk ay). */
  sampled: number;
  /** Örneklem CALLBACK olayı kapanmış olanlar. */
  sampleReviewed: number;
  /** Operatör geri aramasında acil çıkan (ön eleme "iyiyim" dedi ama değildi). */
  sampleFalsePositive: number;
  falsePositiveRate: number | null;
}

/**
 * T-072 (D-12) otomatik sesli ön eleme. Olay motorunun `VoiceScreener` portu: satır olay kilidi altında yazılır,
 * arama commit'ten sonra (transaction boyunca dış istek yok), sonuç webhook'u ya da süre olay motoruna
 * (`resolveScreening`) döner. Numara yalnız arama anında okunur; log'a, audit'e, satıra yazılmaz. Konuşma dökümü
 * saklanmaz, yalnız eşleşen katalog terimi.
 */
@Injectable()
export class ScreeningService implements VoiceScreener, OnModuleInit {
  private readonly log = new Logger('Screening');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TelephonyService) private readonly tel: TelephonyService,
    @Inject(EventService) private readonly events: EventService,
  ) {}

  onModuleInit() {
    this.events.useScreener(this);
  }

  urls(id: string) {
    const u = (k: ScreeningWebhookKind) => `${this.tel.webhookBase()}/v1/webhooks/screening/${k}?s=${id}`;
    return { gather: u('gather'), status: u('status') };
  }

  // ---- VoiceScreener ----

  async prepare(tx: Tx, p: { eventId: string; protectedPersonId: string; type: Rule['type']; rule: Rule }) {
    const provider = this.tel.provider;
    const cfg = p.rule.autoVoiceScreening;
    if (!provider || !cfg?.enabled || NEVER_SCREEN.has(p.type)) return null;
    const timeoutSec = cfg.timeoutSec ?? DEFAULT_SCREEN_TIMEOUT_SEC;
    const [prev] = await tx
      .select({ status: voiceScreening.status })
      .from(voiceScreening)
      .where(eq(voiceScreening.eventId, p.eventId));
    if (prev) return prev.status === 'PENDING' ? { timeoutSec, fresh: false } : null;
    const target = await this.target(tx, p.protectedPersonId);
    if (!target) {
      this.log.log(`Ön eleme yapılmadı: kişinin numarası yok (olay=${p.eventId})`);
      return null;
    }
    const config: StoredConfig = {
      phrase: cfg.phrase,
      acceptIf: cfg.acceptIf,
      helpIf: cfg.helpIf ?? [],
      acceptDigits: cfg.acceptDigits ?? ['1'],
      ...(cfg.minConfidence !== undefined ? { minConfidence: cfg.minConfidence } : {}),
    };
    await tx.insert(voiceScreening).values({
      id: uuidv7(),
      eventId: p.eventId,
      protectedPersonId: p.protectedPersonId,
      eventType: p.type,
      contactId: target,
      provider: provider.name,
      config,
    });
    return { timeoutSec, fresh: true };
  }

  async dial(eventId: string): Promise<void> {
    try {
      const provider = this.tel.provider;
      const [row] = await this.db.select().from(voiceScreening).where(eq(voiceScreening.eventId, eventId));
      if (!row || row.status !== 'PENDING' || row.providerCallId) return;
      if (!provider) throw new Error('Telefoni kapalı');
      const [c] = row.contactId ? await this.db.select().from(contact).where(eq(contact.id, row.contactId)) : [];
      if (!c) throw new Error('Numara bulunamadı');
      const cfg = row.config as StoredConfig;
      const { providerCallId } = await provider.screenCall({
        screeningId: row.id,
        to: c.phoneE164,
        ask: t(cfg.phrase),
        hints: [...cfg.acceptIf, ...(cfg.helpIf ?? [])],
        digits: 1,
        ringTimeoutSec: RING_TIMEOUT_SEC,
        urls: this.urls(row.id),
      });
      await this.db.update(voiceScreening).set({ providerCallId }).where(eq(voiceScreening.id, row.id));
    } catch (e) {
      this.log.warn(`Ön eleme araması başlatılamadı (olay=${eventId}): ${safeError(e)}`);
      await this.events
        .resolveScreening(eventId, { status: 'FAILED', reason: 'DIAL' })
        .catch((err) => this.log.error(`Ön eleme sonucu yazılamadı (olay=${eventId}): ${safeError(err)}`));
    }
  }

  async finish(tx: Tx, eventId: string, r: ScreeningResult, sampled: boolean): Promise<boolean> {
    const [row] = await tx
      .update(voiceScreening)
      .set({
        status: r.status,
        reason: r.reason ?? null,
        input: r.input ?? null,
        matched: r.matched ?? null,
        confidence: r.confidence ?? null,
        sampled,
        finishedAt: new Date(),
      })
      .where(and(eq(voiceScreening.eventId, eventId), eq(voiceScreening.status, 'PENDING')))
      .returning({ id: voiceScreening.id });
    if (!row) return false;
    await tx.insert(auditLog).values({
      actorKind: 'SYSTEM',
      action: 'event.voice_screening_result',
      entityType: 'event',
      entityId: eventId,
      data: {
        screeningId: row.id,
        status: r.status,
        input: r.input ?? null,
        matched: r.matched ?? null,
        sampled,
        ...(r.reason ? { reason: r.reason } : {}),
      },
    });
    return true;
  }

  async abort(eventId: string): Promise<void> {
    try {
      const [row] = await this.db
        .update(voiceScreening)
        .set({ status: 'CANCELLED', finishedAt: new Date() })
        .where(and(eq(voiceScreening.eventId, eventId), eq(voiceScreening.status, 'PENDING')))
        .returning({ id: voiceScreening.id });
      if (!row) return;
      await this.db.insert(auditLog).values({
        actorKind: 'SYSTEM',
        action: 'event.voice_screening_result',
        entityType: 'event',
        entityId: eventId,
        data: { screeningId: row.id, status: 'CANCELLED' },
      });
      await this.hangup(eventId);
    } catch (e) {
      this.log.warn(`Ön eleme iptal edilemedi (olay=${eventId}): ${safeError(e)}`);
    }
  }

  async hangup(eventId: string): Promise<void> {
    try {
      const [row] = await this.db.select().from(voiceScreening).where(eq(voiceScreening.eventId, eventId));
      if (!row?.providerCallId || (row.callStatus && TERMINAL.has(row.callStatus)) || !this.tel.provider) return;
      await this.tel.provider.hangup(row.providerCallId);
    } catch (e) {
      this.log.warn(`Ön eleme araması kapatılamadı (olay=${eventId}): ${safeError(e)}`);
    }
  }

  // ---- webhook (imza denetimi denetleyicide) ----

  /** gather: cevap → sınıflandırma → olay motoru; yanıt sonuca göre katalog metni + kapat. status: arama durumu. */
  async webhook(kind: ScreeningWebhookKind, id: string, p: Record<string, string>): Promise<string> {
    const [row] = isUuid(id) ? await this.db.select().from(voiceScreening).where(eq(voiceScreening.id, id)) : [];
    if (!row) return EMPTY_TWIML; // bilinmeyen: sağlayıcı yeniden denemesin
    if (kind === 'status') {
      const st = p.CallStatus;
      if (!st || (row.callStatus && TERMINAL.has(row.callStatus))) return EMPTY_TWIML;
      await this.db.update(voiceScreening).set({ callStatus: st }).where(eq(voiceScreening.id, row.id));
      // Gather sonucu gelmeden arama bitti: açılmadı, meşgul, hata ya da açıp sessiz kapattı.
      if (TERMINAL.has(st) && row.status === 'PENDING')
        await this.events.resolveScreening(row.eventId, {
          status: st === 'failed' ? 'FAILED' : 'NO_ANSWER',
          reason: `CALL_${st.toUpperCase().replace('-', '_')}`,
        });
      return EMPTY_TWIML;
    }
    const r = classifyScreening(p, row.config as StoredConfig);
    await this.events.resolveScreening(row.eventId, r);
    return sayAndHangupTwiml(t(r.status === 'OK' ? 'V-SCREEN-OK' : 'V-SCREEN-HELP'));
  }

  // ---- ölçüm (T-072 adım 3) ----

  /** Sonuç dağılımı ve operatör örnekleminden yanlış pozitif (ön eleme "iyiyim", geri arama acil). */
  async stats(since: Date): Promise<ScreeningStats> {
    const r = (await this.db.execute(sql`
      SELECT s.status, s.sampled, e.state AS cb_state, e.confirmed_outcome AS cb_outcome
      FROM event.voice_screening s
      LEFT JOIN LATERAL (
        SELECT state, confirmed_outcome FROM event.event
        WHERE s.sampled AND ('voice-screen-sample:' || s.event_id::text) = ANY(source_signal_ids)
        LIMIT 1
      ) e ON true
      WHERE s.created_at >= ${since}`)) as unknown as {
      rows: { status: string; sampled: boolean; cb_state: string | null; cb_outcome: string | null }[];
    };
    const byResult = { OK: 0, HELP: 0, UNCLEAR: 0, NO_ANSWER: 0, FAILED: 0, PENDING: 0, CANCELLED: 0 };
    let sampled = 0;
    let reviewed = 0;
    let fp = 0;
    for (const x of r.rows) {
      byResult[x.status as keyof typeof byResult]++;
      if (!x.sampled) continue;
      sampled++;
      if (x.cb_state === 'CLOSED') {
        reviewed++;
        if (x.cb_outcome === 'EMERGENCY') fp++;
      }
    }
    return {
      since: since.toISOString(),
      total: r.rows.length,
      byResult,
      sampled,
      sampleReviewed: reviewed,
      sampleFalsePositive: fp,
      falsePositiveRate: reviewed ? fp / reviewed : null,
    };
  }

  private async target(tx: Tx, personId: string): Promise<string | null> {
    for (const role of TARGET_ROLES) {
      const [c] = await tx
        .select({ id: contact.id })
        .from(contact)
        .where(and(eq(contact.protectedPersonId, personId), eq(contact.role, role)))
        .orderBy(asc(contact.priority))
        .limit(1);
      if (c) return c.id;
    }
    return null;
  }
}
