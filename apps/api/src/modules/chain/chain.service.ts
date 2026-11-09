import { BadRequestException, ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import {
  type ChainStep,
  type ChainView,
  STEP_RESULTS,
  type StepAssessment,
  type StepResult,
  TOPICS,
} from '@yanimda/contracts';

import { DB, type Db } from '../../db/client';
import { type EventRecord, EventService, type OperatorCtx } from '../event/event.service';
import { ChainRepository, currentStep, type Run, view } from './chain.repository';
import { buildSteps, loadProcedures, type ProcedurePack, stepOf } from './procedures';

export const PROCEDURES = Symbol('PROCEDURES');

export interface StepResultBody {
  result: StepResult;
  assessment?: StepAssessment;
  note?: string;
  reason?: string;
}
export interface EventWithChain {
  event: EventRecord;
  chain: ChainView | null;
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
  ) {
    this.repo = new ChainRepository(db);
    this.proc = proc ?? loadProcedures();
  }

  async get(id: string): Promise<EventWithChain> {
    const event = await this.events.get(id);
    const run = await this.repo.run(id);
    return { event, chain: run ? view(run) : null };
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

  /** "Ara" (A): sıradaki adımın arama başlangıcı. İlk arama olayı CONTACT_CHAIN'e taşır. */
  call(id: string, n: number, operatorId: string, now?: Date): Promise<EventWithChain> {
    return this.events.operate(
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
        return this.result(c, run);
      },
      { now },
    );
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
    const b = (body ?? {}) as { outcome?: unknown; note?: unknown };
    const note = text(b.note, NOTE_MAX, 'note');
    if (typeof b.outcome !== 'string') throw new BadRequestException('Sonuç zorunlu');
    const outcome = b.outcome;
    return this.events.operate(
      id,
      operatorId,
      async (c) => {
        const run = await this.repo.run(c.ev.id, c.tx);
        await c.finish(outcome, note);
        if (run) await this.skipPending(c, run, operatorId, 'closed');
        return this.result(c, run);
      },
      { now },
    );
  }

  // ---- iç ----

  private result(c: OperatorCtx, run: Run | null): EventWithChain {
    return { event: c.ev, chain: run ? view(run) : null };
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
