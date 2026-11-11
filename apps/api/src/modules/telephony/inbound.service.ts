import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TOPICS } from '@yanimda/contracts';
import { t } from '@yanimda/messages';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db, type Tx } from '../../db/client';
import { auditLog, type InboundAttempt, inboundCall, operator } from '../../db/schema';
import { loadRulePack, numbersOf, RULES, type RulesProvider, staticRules } from '../event/rules.loader';
import { ONLINE_WINDOW_SEC, type OperatorStatus } from '../metrics/supervisor.service';
import { type CpaasProvider, EMPTY_TWIML, xml } from './cpaas';
import { formatTrNational, normalizePhone } from './numbers';
import type { RecordingStore } from './recording-store';
import { CPAAS, liveCallSql, RECORDINGS, TELEPHONY_ENV, TelephonyService } from './telephony.service';
import { clientIdentity } from './voice-token';

export type InboundKind = 'call' | 'status' | 'dial' | 'agent' | 'wait' | 'leave' | 'recording';
export const INBOUND_KINDS: InboundKind[] = ['call', 'status', 'dial', 'agent', 'wait', 'leave', 'recording'];
/** Numara düzeyindeki geri çağrılar (Twilio numarasının Voice URL'i ve durum geri çağrısı): CallSid ile bulunur. */
export const BY_CALL_SID: InboundKind[] = ['call', 'status'];

export type InboundStatus = 'routing' | 'ringing' | 'queued' | 'connected' | 'completed' | 'abandoned';
const ENDED: InboundStatus[] = ['completed', 'abandoned'];
/** Masa hattı modunda (yazılım telefonu kapalı) çalan uç. */
export const DESK = 'desk';

export interface TelephonyConfig {
  softphone: boolean;
  inbound: boolean;
  /** Masa sabit hattı (ulusal gösterim); 112 geri arama numarası olarak okunur. */
  deskLine: string | null;
  emergencyNumber: string;
}

export interface MyStatus {
  subject: string;
  status: OperatorStatus;
  statusAt: string | null;
}

const HANGUP = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
const say = (text: string) => `<Say language="tr-TR" voice="Polly.Filiz">${xml(text)}</Say>`;
const response = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
const int = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(+v) ? +v : d);
/** Eşzamanlı gelen aramalar aynı operatörü seçmesin: seçim bu kilit altında (transaction sonuna kadar). */
const ROUTING_LOCK = 0x59_4e_42; // "YNB"

type Row = typeof inboundCall.$inferSelect;

/**
 * T-051 kalan (E-05) gelen SOS aramaları. CPaaS numarasına (Twilio numarası ya da SIP trunk → Twilio BYOC) gelen
 * arama `POST /v1/webhooks/cpaas-inbound/call`'a düşer. Arayan rehberdeki saat/telefon numarasıyla eşleşir ve kişinin
 * açık olayı varsa o olayı yürüten operatör (bağlıysa; molada olsa bile) çalar. Yoksa bağlı (WS 90 sn) ve AVAILABLE
 * operatörler sırayla, açık olayı olmayan ve en uzun boşta kalan önce (`INBOUND_RING_SEC`, varsayılan 20 sn). Kimse
 * yoksa arama kuyruğa alınır (`<Enqueue>`); bekleme döngüsü (`wait`) her turda V-INBOUND-WAIT okur ve müsait operatör
 * çıkınca kuyruktan bırakır (`<Leave/>` → `leave` → yeniden yönlendirme). Cevapsız operatör `INBOUND_RETRY_SEC`
 * (30 sn) sonra yeniden denenir. Arayan numara hiçbir yere yazılmaz; yalnız eşleşen kişi ve olay.
 */
@Injectable()
export class InboundService {
  private readonly log = new Logger('Inbound');
  private readonly rules: RulesProvider;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Inject(TelephonyService) private readonly tel: TelephonyService,
    @Optional() @Inject(CPAAS) readonly provider: CpaasProvider | null = null,
    @Optional() @Inject(RECORDINGS) private readonly store: RecordingStore | null = null,
    @Optional() @Inject(TELEPHONY_ENV) private readonly env: NodeJS.ProcessEnv = process.env,
    @Optional() @Inject(RULES) rules?: RulesProvider,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
  }

  private get ringSec() {
    return int(this.env.INBOUND_RING_SEC, 20);
  }
  private get retrySec() {
    return int(this.env.INBOUND_RETRY_SEC, 30);
  }
  private get pauseSec() {
    return int(this.env.INBOUND_WAIT_PAUSE_SEC, 8);
  }
  private get queueName() {
    return `yanimda-inbound-${(this.env.COUNTRY_CODE ?? 'TR').toLowerCase()}`;
  }

  urls(id: string) {
    const u = (k: InboundKind) => `${this.tel.webhookBase()}/v1/webhooks/cpaas-inbound/${k}?call=${id}`;
    return { dial: u('dial'), agent: u('agent'), wait: u('wait'), leave: u('leave'), recording: u('recording') };
  }

  /** `GET /v1/telephony/config`: konsolun 112 adımı ve telefon barı için (sır yok). */
  config(): TelephonyConfig {
    const desk = this.env.CPAAS_AGENT_NUMBER;
    return {
      softphone: this.tel.softphone,
      inbound: !!this.provider,
      deskLine: desk ? formatTrNational(desk) : null,
      emergencyNumber: numbersOf(this.rules.current()).emergency,
    };
  }

  /** `GET /v1/operators/me`: kayıt yoksa varsayılan AVAILABLE. */
  async operatorStatus(subject: string): Promise<MyStatus> {
    const [r] = await this.db.select().from(operator).where(eq(operator.subject, subject));
    return {
      subject,
      status: (r?.status as OperatorStatus) ?? 'AVAILABLE',
      statusAt: r ? r.statusAt.toISOString() : null,
    };
  }

  // ---- webhook ----

  /** İmza denetimi denetleyicide. `call`/`status` CallSid ile, diğerleri `?call=<kimlik>` ile. Dönen metin TwiML. */
  async webhook(
    kind: InboundKind,
    id: string | undefined,
    p: Record<string, string>,
    now = new Date(),
  ): Promise<string> {
    if (kind === 'call') return this.onCall(p, now);
    if (kind === 'status') return this.onStatus(p, now);
    const r = id ? await this.row(id) : undefined;
    if (!r) return EMPTY_TWIML; // bilinmeyen arama: sağlayıcı yeniden denemesin
    switch (kind) {
      case 'dial':
        return this.onDial(r, p, now);
      case 'agent':
        return this.onAgent(r, p, now);
      case 'wait':
        if (ENDED.includes(r.status as InboundStatus)) return HANGUP;
        if (await this.pick(this.db, r, now)) return response('<Leave/>');
        return response(`${say(t('V-INBOUND-WAIT'))}<Pause length="${this.pauseSec}"/>`);
      case 'leave':
        if (p.QueueResult === 'hangup') {
          await this.end(r, 'abandoned', now);
          return HANGUP;
        }
        if (ENDED.includes(r.status as InboundStatus)) return HANGUP;
        if (p.QueueResult === 'bridged') return EMPTY_TWIML;
        return response(await this.route(r.id, now));
      case 'recording':
        if (p.RecordingStatus === 'completed' && p.RecordingSid) await this.storeRecording(r, p.RecordingSid);
        return EMPTY_TWIML;
      default:
        return EMPTY_TWIML;
    }
  }

  private async row(id: string, q: Db | Tx = this.db): Promise<Row | undefined> {
    const [r] = await q.select().from(inboundCall).where(eq(inboundCall.id, id));
    return r;
  }

  /** Yeni gelen arama: kayıt anonsu + yönlendirme. Sağlayıcı aynı CallSid'i yeniden gönderirse aynı satır. */
  private async onCall(p: Record<string, string>, now: Date): Promise<string> {
    if (!p.CallSid || !this.provider) return HANGUP;
    const provider = this.provider.name;
    const found = await this.bySid(p.CallSid);
    if (found) return response(await this.resume(found));
    const m = await this.match(p.From);
    const id = uuidv7();
    const [ins] = await this.db
      .insert(inboundCall)
      .values({ id, provider, providerCallId: p.CallSid, protectedPersonId: m.personId, eventId: m.eventId })
      .onConflictDoNothing()
      .returning();
    if (!ins) {
      const again = await this.bySid(p.CallSid);
      return again ? response(await this.resume(again)) : HANGUP;
    }
    await this.audit(ins, 'telephony.inbound.received', { matched: !!m.personId, event: !!m.eventId });
    return response(say(t('V-CALL-RECORDED')) + (await this.route(id, now)));
  }

  private async bySid(sid: string): Promise<Row | undefined> {
    const [r] = await this.db
      .select()
      .from(inboundCall)
      .where(and(eq(inboundCall.provider, this.provider!.name), eq(inboundCall.providerCallId, sid)));
    return r;
  }

  /** Tekrar teslimde mevcut durumun TwiML'i (yeni deneme açmadan). */
  private async resume(r: Row): Promise<string> {
    if (r.status === 'ringing' && r.operatorId) return this.dialTwiml(r, r.operatorId);
    if (r.status === 'queued') return this.enqueueTwiml(r.id);
    if (r.status === 'routing') return this.route(r.id, new Date());
    return '<Hangup/>';
  }

  /** Arayan → rehberde saat (WATCH) ya da kişinin telefonu (ELDER) → açık olayı (varsa en yenisi). */
  private async match(from: string | undefined): Promise<{ personId: string | null; eventId: string | null }> {
    const e164 = normalizePhone(from);
    if (!e164) return { personId: null, eventId: null };
    const res = (await this.db.execute(sql`
      SELECT c.protected_person_id AS person, e.id AS event
      FROM profile.contact c
      LEFT JOIN event.event e ON e.protected_person_id = c.protected_person_id
        AND e.state NOT IN ('CLOSED', 'CANCELLED_BY_USER')
      WHERE c.phone_e164 = ${e164} AND c.role IN ('WATCH', 'ELDER')
      ORDER BY (e.id IS NULL), e.created_at DESC
      LIMIT 1`)) as unknown as { rows: { person: string; event: string | null }[] };
    const r = res.rows[0];
    return { personId: r?.person ?? null, eventId: r?.event ?? null };
  }

  /**
   * Sıradaki operatörü seç ve çaldır; kimse yoksa kuyruğa al. Seçim tek kilit altında (eşzamanlı iki arama aynı
   * operatöre düşmez: çalan/bağlı operatör meşgul sayılır). Dönen TwiML parçası (`<Response>` içi).
   */
  private async route(id: string, now: Date): Promise<string> {
    const out = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROUTING_LOCK})`);
      const [r] = await tx.select().from(inboundCall).where(eq(inboundCall.id, id)).for('update');
      if (!r || ENDED.includes(r.status as InboundStatus)) return null;
      const target = await this.pick(tx, r, now);
      if (target) {
        const attempts: InboundAttempt[] = [...r.attempts, { op: target, at: now.toISOString(), result: 'ringing' }];
        await tx
          .update(inboundCall)
          .set({ status: 'ringing', operatorId: target, attempts, updatedAt: now })
          .where(eq(inboundCall.id, id));
        await this.audit(r, 'telephony.inbound.ringing', { operatorId: target, attempt: attempts.length }, tx);
        return { ...r, status: 'ringing', operatorId: target };
      }
      await tx
        .update(inboundCall)
        .set({ status: 'queued', operatorId: null, queuedAt: r.queuedAt ?? now, updatedAt: now })
        .where(eq(inboundCall.id, id));
      if (r.status !== 'queued') await this.audit(r, 'telephony.inbound.queued', {}, tx);
      return { ...r, status: 'queued', operatorId: null };
    });
    if (!out) return '<Hangup/>';
    return out.status === 'ringing' ? this.dialTwiml(out, out.operatorId!) : this.enqueueTwiml(id);
  }

  /**
   * Aday: (1) olayı yürüten operatör — bağlı, çevrim dışı değil, meşgul değil; (2) bağlı ve AVAILABLE operatörler
   * (amir değil), açık olayı olmayanlar önce, sonra en uzun boşta kalan (durum değişimi, son gelen arama bitişi, son
   * giden arama — hangisi yeniyse). Son `INBOUND_RETRY_SEC` içinde denenen ve aramada olan atlanır.
   */
  private async pick(q: Db | Tx, r: Row, now: Date): Promise<string | null> {
    const recent = new Set(
      r.attempts.filter((a) => now.getTime() - Date.parse(a.at) < this.retrySec * 1000).map((a) => a.op),
    );
    const busy = (op: string | SQL) => sql`(
      EXISTS (SELECT 1 FROM telephony.inbound_call i
              WHERE i.operator_id = ${op} AND i.status IN ('ringing', 'connected') AND i.id <> ${r.id})
      OR EXISTS (SELECT 1 FROM telephony.call c
                 WHERE c.operator_id = ${op} AND ${liveCallSql(now, this.tel.staleness)}))`;
    const rows = async <T>(s: SQL) => ((await q.execute(s)) as unknown as { rows: T[] }).rows;

    if (!this.tel.softphone) {
      if (!this.env.CPAAS_AGENT_NUMBER || recent.has(DESK)) return null;
      const [b] = await rows<{ busy: boolean }>(sql`SELECT ${busy(DESK)} AS busy`);
      return b?.busy ? null : DESK;
    }
    const online = new Date(now.getTime() - ONLINE_WINDOW_SEC * 1000).toISOString();
    if (r.eventId) {
      const [owner] = await rows<{ subject: string }>(sql`
        SELECT o.subject FROM event.event e JOIN identity.operator o ON o.subject = e.operator_id
        WHERE e.id = ${r.eventId} AND e.state NOT IN ('CLOSED', 'CANCELLED_BY_USER')
          AND o.status <> 'OFFLINE' AND o.last_seen_at > ${online}::timestamptz AND NOT ${busy(sql`o.subject`)}`);
      if (owner && !recent.has(owner.subject)) return owner.subject;
    }
    const skip = recent.size
      ? sql`AND o.subject NOT IN (${sql.join(
          [...recent].map((s) => sql`${s}`),
          sql`, `,
        )})`
      : sql``;
    const [next] = await rows<{ subject: string }>(sql`
      SELECT o.subject FROM identity.operator o
      WHERE o.kind = 'OPERATOR' AND o.status = 'AVAILABLE' AND o.last_seen_at > ${online}::timestamptz
        ${skip} AND NOT ${busy(sql`o.subject`)}
      ORDER BY
        EXISTS (SELECT 1 FROM event.event e WHERE e.operator_id = o.subject
                AND e.state IN ('OPERATOR_ASSIGNED', 'CONTACT_CHAIN', 'CONFIRMED_OK', 'CONFIRMED_EMERGENCY', 'DISPATCH')),
        greatest(
          o.status_at,
          coalesce((SELECT max(i.ended_at) FROM telephony.inbound_call i WHERE i.operator_id = o.subject), 'epoch'),
          coalesce((SELECT max(c.updated_at) FROM telephony.call c WHERE c.operator_id = o.subject), 'epoch')
        ),
        o.subject
      LIMIT 1`);
    return next?.subject ?? null;
  }

  private dialTwiml(r: Pick<Row, 'id' | 'eventId'>, target: string): string {
    const u = this.urls(r.id);
    const dial =
      `<Dial timeout="${this.ringSec}" action="${xml(u.dial)}" record="record-from-answer-dual"` +
      ` recordingStatusCallback="${xml(u.recording)}" recordingStatusCallbackEvent="completed">`;
    const cb = `statusCallback="${xml(u.agent)}" statusCallbackEvent="answered completed"`;
    if (target === DESK) {
      const byoc = this.env.TWILIO_BYOC_TRUNK_SID ? ` byoc="${xml(this.env.TWILIO_BYOC_TRUNK_SID)}"` : '';
      return `${dial}<Number${byoc} ${cb}>${xml(this.env.CPAAS_AGENT_NUMBER ?? '')}</Number></Dial>`;
    }
    const params =
      `<Parameter name="inboundId" value="${r.id}"/>` +
      (r.eventId ? `<Parameter name="eventId" value="${r.eventId}"/>` : '');
    return `${dial}<Client ${cb}><Identity>${xml(clientIdentity(target))}</Identity>${params}</Client></Dial>`;
  }

  private enqueueTwiml(id: string): string {
    const u = this.urls(id);
    return (
      `<Enqueue action="${xml(u.leave)}" waitUrl="${xml(u.wait)}" waitUrlMethod="POST">` +
      `${xml(this.queueName)}</Enqueue>`
    );
  }

  /** `<Dial action>`: cevaplanıp biten görüşme kapanır; cevapsız/meşgul/hatada sıradaki operatör. */
  private async onDial(r: Row, p: Record<string, string>, now: Date): Promise<string> {
    if (ENDED.includes(r.status as InboundStatus)) return HANGUP;
    const s = p.DialCallStatus;
    if (s === 'completed' || s === 'answered' || r.status === 'connected') {
      const dur = Number(p.DialCallDuration);
      await this.end(r, 'completed', now, Number.isFinite(dur) && dur >= 0 ? dur : null);
      return HANGUP;
    }
    const result = (['no-answer', 'busy', 'failed', 'canceled'] as const).find((x) => x === s) ?? 'failed';
    await this.markAttempt(r, result, now);
    if (p.CallStatus === 'completed') {
      // Arayan çalarken kapattı.
      await this.end(r, 'abandoned', now);
      return HANGUP;
    }
    return response(await this.route(r.id, now));
  }

  /** Operatör bacağının durumu (`<Client>`/`<Number>` statusCallback): açınca bağlı. */
  private async onAgent(r: Row, p: Record<string, string>, now: Date): Promise<string> {
    if (p.CallStatus !== 'in-progress' && p.CallStatus !== 'answered') return EMPTY_TWIML;
    if (r.status !== 'ringing') return EMPTY_TWIML;
    const attempts = r.attempts.map((a, i) =>
      i === r.attempts.length - 1 ? { ...a, result: 'answered' as const, at: now.toISOString() } : a,
    );
    await this.db
      .update(inboundCall)
      .set({ status: 'connected', answeredAt: now, attempts, updatedAt: now })
      .where(eq(inboundCall.id, r.id));
    await this.audit(r, 'telephony.inbound.answered', { operatorId: r.operatorId, attempt: attempts.length });
    await this.publish(r, 'connected');
    return EMPTY_TWIML;
  }

  /** Numara düzeyi durum geri çağrısı: arayan kapattı → bağlıysa bitti, değilse vazgeçti. */
  private async onStatus(p: Record<string, string>, now: Date): Promise<string> {
    if (!p.CallSid || !this.provider) return EMPTY_TWIML;
    const r = await this.bySid(p.CallSid);
    if (!r || ENDED.includes(r.status as InboundStatus)) return EMPTY_TWIML;
    if (!['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(p.CallStatus ?? '')) return EMPTY_TWIML;
    await this.end(r, r.status === 'connected' ? 'completed' : 'abandoned', now);
    return EMPTY_TWIML;
  }

  private async markAttempt(r: Row, result: InboundAttempt['result'], now: Date) {
    if (!r.attempts.length) return;
    const attempts = r.attempts.map((a, i) =>
      i === r.attempts.length - 1 && a.result === 'ringing' ? { ...a, result, at: now.toISOString() } : a,
    );
    await this.db.update(inboundCall).set({ attempts, updatedAt: now }).where(eq(inboundCall.id, r.id));
    r.attempts = attempts;
  }

  private async end(r: Row, status: 'completed' | 'abandoned', now: Date, durationSec: number | null = null) {
    const ended = await this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(inboundCall).where(eq(inboundCall.id, r.id)).for('update');
      if (!cur || ENDED.includes(cur.status as InboundStatus)) return false;
      const attempts = cur.attempts.map((a, i) =>
        i === cur.attempts.length - 1 && a.result === 'ringing'
          ? { ...a, result: status === 'completed' ? ('answered' as const) : ('canceled' as const) }
          : a,
      );
      await tx
        .update(inboundCall)
        .set({
          status,
          endedAt: now,
          attempts,
          durationSec: durationSec ?? cur.durationSec,
          ...(status === 'completed' && !cur.answeredAt ? { answeredAt: now } : {}),
          updatedAt: now,
        })
        .where(eq(inboundCall.id, r.id));
      await this.audit(
        cur,
        status === 'completed' ? 'telephony.inbound.ended' : 'telephony.inbound.abandoned',
        { operatorId: cur.operatorId, durationSec: durationSec ?? cur.durationSec, attempts: attempts.length },
        tx,
      );
      return true;
    });
    if (ended) await this.publish(r, status);
  }

  /** Kayıt: indir → depo → sağlayıcıdan sil (depo yoksa sağlayıcıda bırakılır). */
  private async storeRecording(r: Row, recordingId: string) {
    if (!this.provider || r.recordingProviderId === recordingId) return;
    if (!this.store) {
      this.log.warn(`Kayıt deposu yok (S3_*): gelen arama kaydı sağlayıcıda bırakıldı (inbound=${r.id})`);
      await this.db.update(inboundCall).set({ recordingProviderId: recordingId }).where(eq(inboundCall.id, r.id));
      return;
    }
    const country = (this.env.COUNTRY_CODE ?? 'TR').toLowerCase();
    const key = r.eventId
      ? `recordings/${country}/${r.eventId}/inbound-${r.id}.mp3`
      : `recordings/${country}/inbound/${r.id}.mp3`;
    const body = await this.provider.fetchRecording(recordingId);
    await this.store.put(key, body, 'audio/mpeg');
    await this.db
      .update(inboundCall)
      .set({ recordingRef: key, recordingProviderId: recordingId, updatedAt: new Date() })
      .where(eq(inboundCall.id, r.id));
    await this.audit(r, 'telephony.recording.stored', { key, bytes: body.length });
    await this.provider.deleteRecording(recordingId).catch((e) => {
      this.log.warn(`Sağlayıcıdan kayıt silinemedi (inbound=${r.id}): ${safeError(e)}`);
    });
  }

  private async audit(r: Row, action: string, data: Record<string, unknown>, q: Db | Tx = this.db) {
    await q.insert(auditLog).values({
      actorKind: 'SYSTEM',
      action,
      entityType: r.eventId ? 'event' : 'inbound_call',
      entityId: r.eventId ?? r.id,
      data: { inboundId: r.id, ...data },
    });
  }

  /** Olaya bağlı gelen aramanın durumu konsola (olay güncellendi). */
  private async publish(r: Row, status: InboundStatus) {
    if (!r.eventId) return;
    const eventId = r.eventId;
    await this.db.transaction((tx) =>
      this.outbox.publish(
        TOPICS.eventUpdated,
        {
          eventId: uuidv7(),
          type: TOPICS.eventUpdated,
          version: 1,
          occurredAt: new Date().toISOString(),
          countryCode: this.env.COUNTRY_CODE ?? 'TR',
          subjectUserId: eventId,
          payload: { eventId, inbound: { id: r.id, status } },
        },
        tx,
      ),
    );
  }
}
