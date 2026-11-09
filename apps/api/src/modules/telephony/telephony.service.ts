import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { type ChainStep, TOPICS } from '@yanimda/contracts';
import { t } from '@yanimda/messages';
import { and, asc, desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db, type Tx } from '../../db/client';
import { auditLog, call, contact } from '../../db/schema';
import { type CpaasProvider, EMPTY_TWIML, sayTwiml, type WebhookUrls } from './cpaas';
import type { RecordingStore } from './recording-store';

export const CPAAS = Symbol('CPAAS');
export const RECORDINGS = Symbol('RECORDINGS');
export const TELEPHONY_ENV = Symbol('TELEPHONY_ENV');

export type CallStatus =
  'queued' | 'ringing' | 'in-progress' | 'completed' | 'busy' | 'no-answer' | 'failed' | 'canceled';
export type SuggestedResult = 'REACHED' | 'NO_ANSWER' | 'BUSY' | 'WRONG_NUMBER';
export type WebhookKind = 'status' | 'dial' | 'agent' | 'recording' | 'announce';
export const WEBHOOK_KINDS: WebhookKind[] = ['status', 'dial', 'agent', 'recording', 'announce'];

/** Konsola giden arama özeti: numara yok. */
export interface CallView {
  id: string;
  stepN: number;
  status: CallStatus;
  answered: boolean;
  suggestedResult: SuggestedResult | null;
  durationSec: number | null;
  recorded: boolean;
  error: string | null;
  createdAt: string;
}

export type ContactRole = 'ELDER' | 'WATCH' | 'CONTACT' | 'NEIGHBOR';
export interface ContactInput {
  role: ContactRole;
  priority?: number;
  displayName?: string;
  phone: string;
}

const RANK: Record<CallStatus, number> = {
  queued: 0,
  ringing: 1,
  'in-progress': 2,
  completed: 3,
  busy: 3,
  'no-answer': 3,
  failed: 3,
  canceled: 3,
};
const ACTIVE: CallStatus[] = ['queued', 'ringing', 'in-progress'];
const E164 = /^\+[1-9]\d{6,14}$/;
/** Adım hedefi → rehber rolü. 112 (EMERGENCY) masa sabit hattından elle (T-052); aile bildirimi arama değil. */
const ROLE_OF: Partial<Record<ChainStep['target'], ContactRole>> = {
  WATCH: 'WATCH',
  ELDER_PHONE: 'ELDER',
  CONTACT: 'CONTACT',
  NEIGHBOR: 'NEIGHBOR',
};

/** Twilio CallStatus / DialCallStatus → bizim durumumuz. */
export function mapStatus(s: string | undefined): CallStatus | null {
  switch (s) {
    case 'queued':
    case 'initiated':
      return 'queued';
    case 'ringing':
      return 'ringing';
    case 'in-progress':
    case 'answered':
      return 'in-progress';
    case 'completed':
    case 'busy':
    case 'no-answer':
    case 'failed':
    case 'canceled':
      return s;
    default:
      return null;
  }
}

/** E-05 (4): arama sonucu adım sonucunu önerir; operatör onaylar. */
export function suggestionFor(status: CallStatus, answered: boolean): SuggestedResult | null {
  switch (status) {
    case 'completed':
      return answered ? 'REACHED' : 'NO_ANSWER';
    case 'busy':
      return 'BUSY';
    case 'no-answer':
      return 'NO_ANSWER';
    case 'failed':
      return 'WRONG_NUMBER';
    default:
      return null;
  }
}

/**
 * T-050 (E-05) giden arama ve kayıt. "Ara" (zincir adımı) → olay kilidi altında `telephony.call` satırı → commit
 * sonrası sağlayıcı araması (transaction boyunca dış istek yok). Webhook'lar (imzalı) durumu ilerletir (geri gitmez),
 * son durumda adım sonucu önerilir. Kayıt hazır olunca indirilir → S3'e (nesne kilidi) → sağlayıcıdan silinir.
 * Numara yalnız arama anında okunur; log'a, audit'e ve call satırına yazılmaz.
 */
@Injectable()
export class TelephonyService {
  private readonly log = new Logger('Telephony');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Optional() @Inject(CPAAS) readonly provider: CpaasProvider | null = null,
    @Optional() @Inject(RECORDINGS) private readonly store: RecordingStore | null = null,
    @Optional() @Inject(TELEPHONY_ENV) private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get enabled() {
    return !!this.provider;
  }

  /** Webhook kök adresi (sağlayıcının erişebildiği, imzada kullanılan). */
  webhookBase(): string {
    return (this.env.CPAAS_WEBHOOK_BASE || `http://127.0.0.1:${this.env.PORT ?? 3000}`).replace(/\/+$/, '');
  }

  urls(callId: string): WebhookUrls {
    const u = (k: WebhookKind) => `${this.webhookBase()}/v1/webhooks/cpaas/${k}?call=${callId}`;
    return {
      status: u('status'),
      dial: u('dial'),
      agent: u('agent'),
      recording: u('recording'),
      announce: u('announce'),
    };
  }

  /** Operatörün ucu: T-051'e kadar masa hattı (CPAAS_AGENT_NUMBER); sonra yazılım telefonu (client:<operatör>). */
  agentFor(_operatorId: string): string | null {
    return this.env.CPAAS_AGENT_NUMBER || null;
  }

  // ---- rehber (asgari; tam profil T-040) ----

  async setContacts(personId: string, input: unknown): Promise<{ count: number }> {
    if (!Array.isArray(input) || input.length > 20) throw new BadRequestException('En fazla 20 numara');
    const rows = input.map((x: Partial<ContactInput>, i) => {
      if (!x || !['ELDER', 'WATCH', 'CONTACT', 'NEIGHBOR'].includes(x.role as string))
        throw new BadRequestException(`#${i}: rol geçersiz`);
      if (typeof x.phone !== 'string' || !E164.test(x.phone))
        throw new BadRequestException(`#${i}: numara E.164 olmalı`);
      const priority = x.priority ?? 1;
      if (!Number.isInteger(priority) || priority < 1) throw new BadRequestException(`#${i}: öncelik geçersiz`);
      return {
        id: uuidv7(),
        protectedPersonId: personId,
        role: x.role as ContactRole,
        priority,
        displayName: typeof x.displayName === 'string' ? x.displayName.slice(0, 100) : null,
        phoneE164: x.phone,
      };
    });
    await this.db.transaction(async (tx) => {
      await tx.delete(contact).where(eq(contact.protectedPersonId, personId));
      if (rows.length) await tx.insert(contact).values(rows);
      await tx.insert(auditLog).values({
        actorKind: 'OPERATOR',
        action: 'profile.contacts_set',
        entityType: 'protected_person',
        entityId: personId,
        data: { count: rows.length },
      });
    });
    return { count: rows.length };
  }

  private async contactFor(q: Db | Tx, personId: string, step: ChainStep) {
    const role = ROLE_OF[step.target];
    if (!role) return null;
    const [c] = await q
      .select()
      .from(contact)
      .where(
        and(
          eq(contact.protectedPersonId, personId),
          eq(contact.role, role),
          eq(contact.priority, step.contactIndex ?? 1),
        ),
      )
      .limit(1);
    return c ?? null;
  }

  // ---- arama ----

  /**
   * Olay kilidi altında (çağıranın transaction'ı): adım aranabiliyorsa `queued` satırı yazar ve kimliği döner.
   * Aynı adımda süren arama varsa onu döner (çift "Ara" yeni arama açmaz). Aranamıyorsa null (yalnız arama zamanı).
   */
  async prepare(
    tx: Tx,
    p: { eventId: string; personId: string; step: ChainStep; operatorId: string },
  ): Promise<{ callId: string; fresh: boolean } | null> {
    if (!this.provider) return null;
    const c = await this.contactFor(tx, p.personId, p.step);
    if (!c) return null;
    const [last] = await tx
      .select()
      .from(call)
      .where(and(eq(call.eventId, p.eventId), eq(call.stepN, p.step.n)))
      .orderBy(desc(call.createdAt))
      .limit(1);
    if (last && ACTIVE.includes(last.status as CallStatus)) return { callId: last.id, fresh: false };
    const id = uuidv7();
    await tx.insert(call).values({
      id,
      eventId: p.eventId,
      stepN: p.step.n,
      operatorId: p.operatorId,
      contactId: c.id,
      provider: this.provider.name,
    });
    await tx.insert(auditLog).values({
      actorKind: 'OPERATOR',
      actorId: p.operatorId,
      action: 'telephony.call.started',
      entityType: 'event',
      entityId: p.eventId,
      data: { callId: id, step: p.step.n, role: c.role },
    });
    return { callId: id, fresh: true };
  }

  /** Commit'ten sonra: sağlayıcıyı ara. Hata olursa arama `failed` olur (olay akışı etkilenmez). */
  async dial(callId: string, timeoutSec: number): Promise<void> {
    if (!this.provider) return;
    const [row] = await this.db.select().from(call).where(eq(call.id, callId));
    if (!row || row.providerCallId) return;
    try {
      const agent = this.agentFor(row.operatorId);
      if (!agent) throw new Error('Operatör hattı tanımlı değil (CPAAS_AGENT_NUMBER)');
      const [c] = row.contactId ? await this.db.select().from(contact).where(eq(contact.id, row.contactId)) : [];
      if (!c) throw new Error('Numara bulunamadı');
      const { providerCallId } = await this.provider.call({
        callId,
        to: c.phoneE164,
        agent,
        timeoutSec,
        urls: this.urls(callId),
      });
      await this.db.update(call).set({ providerCallId, updatedAt: new Date() }).where(eq(call.id, callId));
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`Arama başlatılamadı (call=${callId}): ${safeError(e)}`);
      await this.update(callId, (r) => ({ ...r, status: 'failed', error: msg.slice(0, 200) }));
    }
  }

  async callsFor(eventId: string, q: Db | Tx = this.db): Promise<CallView[]> {
    const rows = await q.select().from(call).where(eq(call.eventId, eventId)).orderBy(asc(call.createdAt));
    return rows.map((r) => ({
      id: r.id,
      stepN: r.stepN,
      status: r.status as CallStatus,
      answered: r.answered,
      suggestedResult: (r.suggestedResult as SuggestedResult) ?? null,
      durationSec: r.durationSec,
      recorded: !!r.recordingRef,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ---- webhook ----

  /** İmza denetimi denetleyicide. Dönen metin TwiML (anons / boş yanıt). */
  async webhook(kind: WebhookKind, callId: string, p: Record<string, string>): Promise<string> {
    if (kind === 'announce') return sayTwiml(t('V-CALL-RECORDED'));
    const [row] = await this.db.select({ id: call.id }).from(call).where(eq(call.id, callId));
    if (!row) return EMPTY_TWIML; // bilinmeyen arama: sağlayıcı yeniden denemesin
    if (kind === 'recording') {
      if (p.RecordingStatus === 'completed' && p.RecordingSid) await this.storeRecording(callId, p.RecordingSid);
      return EMPTY_TWIML;
    }
    if (kind === 'agent') {
      const s = mapStatus(p.CallStatus);
      // Operatör ucu açılmadıysa aranan hiç aranmaz.
      if (s && s !== 'completed' && RANK[s] === 3)
        await this.update(callId, (r) => (r.status === 'queued' ? { ...r, status: 'failed', error: 'agent' } : r));
      return EMPTY_TWIML;
    }
    const status = mapStatus(kind === 'dial' ? p.DialCallStatus : p.CallStatus);
    if (!status) return EMPTY_TWIML;
    const dur = Number(kind === 'dial' ? p.DialCallDuration : p.CallDuration);
    await this.update(callId, (r) => {
      if (RANK[status] < RANK[r.status as CallStatus] || RANK[r.status as CallStatus] === 3) return r; // geri gitmez
      const answered = r.answered || status === 'in-progress' || (kind === 'dial' && status === 'completed');
      return {
        ...r,
        status,
        answered,
        suggestedResult: suggestionFor(status, answered),
        durationSec: Number.isFinite(dur) && dur >= 0 ? dur : r.durationSec,
      };
    });
    return EMPTY_TWIML;
  }

  private async update(callId: string, fn: (r: typeof call.$inferSelect) => typeof call.$inferSelect): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(call).where(eq(call.id, callId)).for('update');
      if (!r) return;
      const n = fn(r);
      if (n === r) return;
      await tx
        .update(call)
        .set({
          status: n.status,
          answered: n.answered,
          suggestedResult: n.suggestedResult,
          durationSec: n.durationSec,
          error: n.error,
          updatedAt: new Date(),
        })
        .where(eq(call.id, callId));
      if (n.status !== r.status)
        await tx.insert(auditLog).values({
          actorKind: 'SYSTEM',
          action: 'telephony.call.status',
          entityType: 'event',
          entityId: r.eventId,
          data: { callId, status: n.status, suggested: n.suggestedResult },
        });
      await this.outbox.publish(
        TOPICS.eventUpdated,
        {
          eventId: uuidv7(),
          type: TOPICS.eventUpdated,
          version: 1,
          occurredAt: new Date().toISOString(),
          countryCode: this.env.COUNTRY_CODE ?? 'TR',
          subjectUserId: r.eventId,
          payload: { eventId: r.eventId, call: { id: callId, status: n.status } },
        },
        tx,
      );
    });
  }

  /** Kayıt: indir → depo (nesne kilidi) → sağlayıcıdan sil. Depo yoksa sağlayıcıda bırakılır (kayıp olmasın). */
  private async storeRecording(callId: string, recordingId: string) {
    const [r] = await this.db.select().from(call).where(eq(call.id, callId));
    if (!r || r.recordingRef || !this.provider) return;
    if (!this.store) {
      this.log.warn(`Kayıt deposu yok (S3_*): kayıt sağlayıcıda bırakıldı (call=${callId})`);
      await this.db.update(call).set({ recordingProviderId: recordingId }).where(eq(call.id, callId));
      return;
    }
    const country = (this.env.COUNTRY_CODE ?? 'TR').toLowerCase();
    const key = `recordings/${country}/${r.eventId}/${callId}.mp3`;
    const body = await this.provider.fetchRecording(recordingId);
    await this.store.put(key, body, 'audio/mpeg');
    await this.db
      .update(call)
      .set({ recordingRef: key, recordingProviderId: recordingId, updatedAt: new Date() })
      .where(eq(call.id, callId));
    await this.db.insert(auditLog).values({
      actorKind: 'SYSTEM',
      action: 'telephony.recording.stored',
      entityType: 'event',
      entityId: r.eventId,
      data: { callId, key, bytes: body.length },
    });
    await this.provider.deleteRecording(recordingId).catch((e) => {
      this.log.warn(`Sağlayıcıdan kayıt silinemedi (call=${callId}): ${safeError(e)}`);
    });
  }
}
