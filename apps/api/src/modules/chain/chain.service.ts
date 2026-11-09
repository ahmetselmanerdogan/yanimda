import { BadRequestException, ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import {
  type ChainStep,
  type ChainView,
  STEP_RESULTS,
  type StepAssessment,
  type StepResult,
  TOPICS,
} from '@yanimda/contracts';
import { t } from '@yanimda/messages';
import { sql } from 'drizzle-orm';

import { DB, type Db, type Tx } from '../../db/client';
import { type EventRecord, EventService, type OperatorCtx } from '../event/event.service';
import { type EventPersonCard, ProfileService } from '../profile/profile.service';
import { type CallView, TelephonyService } from '../telephony/telephony.service';
import { ChainRepository, currentStep, type Run, view } from './chain.repository';
import { buildSteps, loadProcedures, type ProcedurePack, stepOf } from './procedures';

export const PROCEDURES = Symbol('PROCEDURES');

/** T-024 112 şablon alanları (05 "112 bildirimi"). Bilinmeyen alan katalogdaki "bilinmiyor". */
export interface DispatchScript {
  kind: 'dispatch112';
  code: string;
  fields: Record<'type' | 'name' | 'age' | 'address' | 'conditions' | 'medications' | 'allergies' | 'doorNote', string>;
  text: string;
}

export interface StepResultBody {
  result: StepResult;
  assessment?: StepAssessment;
  note?: string;
  reason?: string;
}
export interface EventWithChain {
  event: EventRecord;
  chain: ChainView | null;
  /** T-050 CPaaS aramaları (numarasız özet). */
  calls: CallView[];
}

const NOTE_MAX = 2000;
const REASON_MAX = 500;
const CALL_112 = 'CALL_112';

const text = (v: unknown, max: number, field: string): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new BadRequestException(`${field} metin olmalı`);
  const s = v.trim();
  if (s.length > max) throw new BadRequestException(`${field} en fazla ${max} karakter`);
  return s || undefined;
};

/**
 * T-021 (D-03, D-04) prosedür zinciri. Olay üstlenilince adımlar oluşur; sonuçlar sırayla yazılır (sıra dışı 409),
 * SKIPPED gerekçe ister. Sonuçlar olay geçişlerini tetikler:
 *  - ilk işlem: OPERATOR_ASSIGNED → CONTACT_CHAIN
 *  - ulaşıldı + "kişi iyi" → CONFIRMED_OK; ulaşıldı + "acil" → CONFIRMED_EMERGENCY (kalan adımlar 112'ye atlanır)
 *  - 112 adımı ulaşıldı → CONFIRMED_EMERGENCY → DISPATCH; 112 ulaşılamadı → yeni 112 adımı (tekrar dene)
 * Her işlem EventService.operate içinde: olay kilidi, sahiplik, operatör kilidinin uzatılması, tek transaction.
 */
@Injectable()
export class ChainService {
  private readonly repo: ChainRepository;
  private readonly proc: ProcedurePack;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EventService) private readonly events: EventService,
    @Optional() @Inject(PROCEDURES) proc?: ProcedurePack,
    @Optional() @Inject(TelephonyService) private readonly telephony?: TelephonyService,
    @Optional() @Inject(ProfileService) private readonly profile?: ProfileService,
  ) {
    this.repo = new ChainRepository(db);
    this.proc = proc ?? loadProcedures();
  }

  async get(id: string): Promise<EventWithChain> {
    const event = await this.events.get(id);
    const run = await this.repo.run(id);
    return { event, chain: run ? view(run) : null, calls: (await this.telephony?.callsFor(id)) ?? [] };
  }

  claim(id: string, operatorId: string, now?: Date): Promise<EventWithChain> {
    return this.events.operate(id, operatorId, async (c) => this.result(c, await this.ensureRun(c)), {
      claim: true,
      now,
    });
  }

  /** Operatör kilidini uzatır (konsol açıkken periyodik). */
  heartbeat(id: string, operatorId: string, now?: Date): Promise<{ lockUntil?: string }> {
    return this.events.operate(id, operatorId, async (c) => ({ lockUntil: c.ev.lockUntil }), { now });
  }

  /**
   * "Ara" (A): sıradaki adımın arama başlangıcı; ilk arama olayı CONTACT_CHAIN'e taşır. Telefoni açıksa ve adımın
   * numarası kayıtlıysa (112 hariç: masa hattından, T-052) CPaaS araması commit'ten sonra başlatılır (T-050).
   */
  async call(id: string, n: number, operatorId: string, now?: Date): Promise<EventWithChain> {
    let plan: { callId: string; fresh: boolean; timeoutSec: number } | null = null;
    const res = await this.events.operate(
      id,
      operatorId,
      async (c) => {
        const run = await this.ensureRun(c);
        const step = this.current(run, n, c);
        if (!step.calledAt) {
          step.calledAt = c.now.toISOString();
          step.operatorId = operatorId;
          await this.repo.updateStep(c.tx, run.id, step);
        }
        if (c.ev.state === 'OPERATOR_ASSIGNED') c.transition('CONTACT_CHAIN');
        const p = await this.telephony?.prepare(c.tx, {
          eventId: c.ev.id,
          personId: c.ev.protectedPersonId,
          step,
          operatorId,
        });
        if (p) plan = { ...p, timeoutSec: step.timeoutSec };
        return this.result(c, run);
      },
      { now },
    );
    const started = plan as { callId: string; fresh: boolean; timeoutSec: number } | null;
    if (!started?.fresh || !this.telephony) return res;
    await this.telephony.dial(started.callId, started.timeoutSec);
    return { ...res, calls: await this.telephony.callsFor(id) };
  }

  /** Okunan operatör metni (ör. 112 şablonu) için zaman damgası (T-024). */
  scriptRead(id: string, n: number, operatorId: string, now?: Date): Promise<EventWithChain> {
    return this.events.operate(
      id,
      operatorId,
      async (c) => {
        const run = await this.ensureRun(c);
        const step = run.steps.find((s) => s.n === n);
        if (!step) throw new ConflictException('Adım yok');
        step.scriptReadAt = c.now.toISOString();
        await this.repo.updateStep(c.tx, run.id, step);
        return this.result(c, run);
      },
      { now },
    );
  }

  async stepResult(id: string, n: number, operatorId: string, body: unknown, now?: Date): Promise<EventWithChain> {
    const b = this.parseResult(body);
    return this.events.operate(
      id,
      operatorId,
      async (c) => {
        const run = await this.ensureRun(c);
        const step = this.current(run, n, c);
        Object.assign(step, {
          result: b.result,
          assessment: b.assessment,
          note: b.note,
          reason: b.reason,
          operatorId,
          completedAt: c.now.toISOString(),
        });
        await this.repo.updateStep(c.tx, run.id, step);
        if (c.ev.state === 'OPERATOR_ASSIGNED') c.transition('CONTACT_CHAIN');

        if (step.kind === CALL_112) {
          if (b.result === 'REACHED') {
            if (c.ev.state !== 'CONFIRMED_EMERGENCY') c.transition('CONFIRMED_EMERGENCY', '112');
            c.transition('DISPATCH', '112 arandı');
          } else await this.append112(c, run); // 112'ye ulaşılamadı: tekrar denenir
        } else if (b.result === 'REACHED' && b.assessment === 'OK') {
          c.transition('CONFIRMED_OK', `adım ${step.n}`);
          await this.skipPending(c, run, operatorId, 'resolved');
        } else if (b.result === 'REACHED' && b.assessment === 'EMERGENCY') {
          c.transition('CONFIRMED_EMERGENCY', `adım ${step.n}`);
          await this.toEmergency(c, run, operatorId, 'emergency');
        }

        c.publish(TOPICS.chainStepResult, {
          eventId: c.ev.id,
          n: step.n,
          kind: step.kind,
          result: b.result,
          ...(b.assessment ? { assessment: b.assessment } : {}),
          operatorId,
          at: c.now.toISOString(),
        });
        await this.repo.audit(c.tx, c.ev.id, operatorId, 'chain.step.result', {
          n: step.n,
          kind: step.kind,
          result: b.result,
          assessment: b.assessment ?? null,
        });
        return this.result(c, run);
      },
      { now },
    );
  }

  /** Ctrl+1: gerekçeyle doğrudan 112. Kalan adımlar SKIPPED(reason=escalate) olur, olay CONFIRMED_EMERGENCY. */
  async escalate112(id: string, operatorId: string, body: unknown, now?: Date): Promise<EventWithChain> {
    const reason = text((body as { reason?: unknown } | null)?.reason, REASON_MAX, 'reason');
    if (!reason) throw new BadRequestException('Gerekçe zorunlu');
    return this.events.operate(
      id,
      operatorId,
      async (c) => {
        const run = await this.ensureRun(c);
        if (c.ev.state === 'OPERATOR_ASSIGNED' || c.ev.state === 'CONTACT_CHAIN')
          c.transition('CONFIRMED_EMERGENCY', reason);
        else if (c.ev.state !== 'CONFIRMED_EMERGENCY') throw new ConflictException('Bu durumda 112 kısayolu yok');
        await this.toEmergency(c, run, operatorId, 'escalate', reason);
        await this.repo.audit(c.tx, c.ev.id, operatorId, 'chain.escalate_112', {});
        return this.result(c, run);
      },
      { now },
    );
  }

  /** E-07 kapatma: bekleyen adımlar SKIPPED(reason=closed), olay kapanır. */
  async close(id: string, operatorId: string, body: unknown, now?: Date): Promise<EventWithChain> {
    const b = (body ?? {}) as { outcome?: unknown; note?: unknown; followUpAfterHours?: unknown };
    const note = text(b.note, NOTE_MAX, 'note');
    if (typeof b.outcome !== 'string') throw new BadRequestException('Sonuç zorunlu');
    const outcome = b.outcome;
    if (b.followUpAfterHours !== undefined && b.followUpAfterHours !== null && typeof b.followUpAfterHours !== 'number')
      throw new BadRequestException('followUpAfterHours sayı olmalı');
    const hours = typeof b.followUpAfterHours === 'number' ? b.followUpAfterHours : undefined;
    return this.events.operate(
      id,
      operatorId,
      async (c) => {
        const run = await this.repo.run(c.ev.id, c.tx);
        await c.finish(outcome, note, hours);
        if (run) await this.skipPending(c, run, operatorId, 'closed');
        return this.result(c, run);
      },
      { now },
    );
  }

  /**
   * GET /events/{id}/script?kind=dispatch112 — 112'ye okunacak metin, olay ve kişi bilgisiyle doldurulur. Yalnız olayı
   * yürüten operatöre (sağlık verisi yalnız olay anında çözülür); erişim audit.log'a yazılır (içerik yazılmaz).
   * Tıbbi alanlar (hastalık, ilaç, alerji, kapı notu, adres) T-040 profil/sağlık şeması gelene kadar "bilinmiyor";
   * adres yoksa olay konumu (enlem, boylam).
   */
  async dispatchScript(id: string, operatorId: string, kind: unknown, now?: Date): Promise<DispatchScript> {
    if (kind !== 'dispatch112') throw new BadRequestException('Bilinmeyen şablon');
    return this.events.operate(
      id,
      operatorId,
      async (c) => {
        const card = await this.cardOf(c, operatorId, 'dispatch112');
        const basic = card ? null : await personOf(c.tx, c.ev.protectedPersonId);
        const unknown = t('O-UI-UNKNOWN');
        const join = (xs: string[] | undefined) => (xs?.length ? xs.join(', ') : unknown);
        const loc = c.ev.location ?? card?.location ?? null;
        const coords = loc ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : null;
        const age = card ? card.age : basic?.birthYear ? c.now.getUTCFullYear() - basic.birthYear : null;
        const fields: DispatchScript['fields'] = {
          type: t(`O-TYPE-${c.ev.type}`),
          name: (card ?? basic)?.displayName ?? unknown,
          age: age !== null ? String(age) : unknown,
          address: (card?.address && coords ? `${card.address} (${coords})` : (card?.address ?? coords)) ?? unknown,
          conditions: join(card?.medical?.conditions),
          medications: join(card?.medical?.medications),
          allergies: join(card?.medical?.allergies),
          doorNote: card?.doorAccessNote ?? unknown,
        };
        await this.repo.audit(c.tx, c.ev.id, operatorId, 'event.script_viewed', { kind });
        return { kind: 'dispatch112', code: 'O-SCRIPT-112', fields, text: t('O-SCRIPT-112', 'tr', fields) };
      },
      { now },
    );
  }

  /**
   * GET /v1/events/{id}/person — olayı yürüten operatöre kişi kartı (adres, kapı notu, tıbbi özet). Sağlık verisi
   * yalnız burada ve 112 şablonunda çözülür; her çözüm denetim kaydına yazılır. Profil yoksa null.
   */
  async personCard(id: string, operatorId: string, now?: Date): Promise<EventPersonCard | null> {
    return this.events.operate(id, operatorId, (c) => this.cardOf(c, operatorId, 'event_card'), { now });
  }

  // ---- iç ----

  private async cardOf(c: OperatorCtx, operatorId: string, purpose: string) {
    if (!this.profile) return null;
    return this.profile.eventCard(c.tx, c.ev.protectedPersonId, { eventId: c.ev.id, operatorId, purpose }, c.now);
  }

  private async result(c: OperatorCtx, run: Run | null): Promise<EventWithChain> {
    return { event: c.ev, chain: run ? view(run) : null, calls: (await this.telephony?.callsFor(c.ev.id, c.tx)) ?? [] };
  }

  private async ensureRun(c: OperatorCtx): Promise<Run> {
    const existing = await this.repo.run(c.ev.id, c.tx);
    if (existing) return existing;
    const steps = c.rule ? buildSteps(c.rule, c.ev.isTest, this.proc) : [];
    return this.repo.createRun(
      c.tx,
      c.ev.id,
      { country: this.proc.country, procedureVersion: this.proc.version, rulesVersion: c.rulesVersion },
      steps,
    );
  }

  private current(run: Run, n: number, c: OperatorCtx): ChainStep {
    const step = currentStep(run.steps);
    if (!step || step.n !== n) throw new ConflictException('Sıra dışı adım');
    const ok =
      c.ev.state === 'OPERATOR_ASSIGNED' ||
      c.ev.state === 'CONTACT_CHAIN' ||
      (c.ev.state === 'CONFIRMED_EMERGENCY' && step.kind === CALL_112);
    if (!ok) throw new ConflictException('Bu durumda adım işlenemez');
    return step;
  }

  private async skipPending(c: OperatorCtx, run: Run, operatorId: string, reason: string, note?: string) {
    for (const s of run.steps.filter((x) => !x.result)) await this.skip(c, run, s, operatorId, reason, note);
  }

  private async skip(c: OperatorCtx, run: Run, s: ChainStep, operatorId: string, reason: string, note?: string) {
    Object.assign(s, { result: 'SKIPPED', reason, note, operatorId, completedAt: c.now.toISOString() });
    await this.repo.updateStep(c.tx, run.id, s);
  }

  /** Acil: 112 dışındaki bekleyen adımlar atlanır; bekleyen 112 adımı yoksa eklenir (test olayı dahil). */
  private async toEmergency(c: OperatorCtx, run: Run, operatorId: string, reason: string, note?: string) {
    for (const s of run.steps.filter((x) => !x.result && x.kind !== CALL_112))
      await this.skip(c, run, s, operatorId, reason, note);
    if (!run.steps.some((x) => !x.result && x.kind === CALL_112)) await this.append112(c, run);
  }

  private async append112(c: OperatorCtx, run: Run) {
    const step = stepOf(CALL_112, (run.steps.at(-1)?.n ?? 0) + 1, c.rule, this.proc);
    await this.repo.appendStep(c.tx, run.id, step);
    run.steps.push(step);
  }

  private parseResult(body: unknown): StepResultBody {
    const b = (body ?? {}) as Record<string, unknown>;
    if (!STEP_RESULTS.includes(b.result as StepResult)) throw new BadRequestException('Geçersiz sonuç');
    const result = b.result as StepResult;
    if (b.assessment !== undefined && b.assessment !== 'OK' && b.assessment !== 'EMERGENCY')
      throw new BadRequestException('Geçersiz değerlendirme');
    if (b.assessment !== undefined && result !== 'REACHED')
      throw new BadRequestException('Değerlendirme yalnız ulaşılınca');
    const reason = text(b.reason, REASON_MAX, 'reason');
    if (result === 'SKIPPED' && !reason) throw new BadRequestException('Atlama gerekçe ister');
    return {
      result,
      ...(b.assessment ? { assessment: b.assessment as StepAssessment } : {}),
      ...(text(b.note, NOTE_MAX, 'note') ? { note: text(b.note, NOTE_MAX, 'note') } : {}),
      ...(reason ? { reason } : {}),
    };
  }
}

async function personOf(tx: Tx, id: string): Promise<{ displayName: string; birthYear: number | null } | null> {
  const r = (await tx.execute(
    sql`SELECT display_name, birth_year FROM profile.protected_person WHERE id::text = ${id}`,
  )) as unknown as { rows: { display_name: string; birth_year: number | null }[] };
  const row = r.rows[0];
  return row ? { displayName: row.display_name, birthYear: row.birth_year } : null;
}
