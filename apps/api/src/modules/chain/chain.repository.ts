import type { ChainStep, ChainView, StepAssessment, StepResult, StepTarget } from '@yanimda/contracts';
import { and, asc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Db, Tx } from '../../db/client';
import { auditLog, chainRun, chainStep } from '../../db/schema';

type Q = Db | Tx;
type StepRow = typeof chainStep.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : undefined);

function toStep(r: StepRow): ChainStep {
  return {
    n: r.n,
    kind: r.kind,
    target: r.target as StepTarget,
    ...(r.contactIndex !== null ? { contactIndex: r.contactIndex } : {}),
    label: r.labelCode,
    ...(r.scriptCode ? { script: r.scriptCode } : {}),
    timeoutSec: r.timeoutSec,
    required: r.required,
    ...(r.autoAnswerSec !== null ? { autoAnswerSec: r.autoAnswerSec } : {}),
    calledAt: iso(r.calledAt),
    result: (r.result as StepResult) ?? undefined,
    assessment: (r.assessment as StepAssessment) ?? undefined,
    note: r.note ?? undefined,
    reason: r.reason ?? undefined,
    operatorId: r.operatorId ?? undefined,
    completedAt: iso(r.completedAt),
    scriptReadAt: iso(r.scriptReadAt),
  };
}

export interface Run {
  id: string;
  procedureVersion: number;
  steps: ChainStep[];
  /** Planlandığı olay türü / test bayrağı; null = 0019 öncesi satır. */
  eventType?: string | null;
  isTest?: boolean | null;
}

export const currentStep = (steps: ChainStep[]) => steps.find((s) => !s.result) ?? null;
export const view = (run: Run): ChainView => ({
  procedureVersion: run.procedureVersion,
  steps: run.steps,
  current: currentStep(run.steps)?.n ?? null,
});

/** chain.chain_run / chain.chain_step erişimi. Yazımlar çağıranın transaction'ında (olay kilidi altında). */
export class ChainRepository {
  constructor(private readonly db: Db) {}

  async run(eventId: string, q: Q = this.db): Promise<Run | null> {
    const [r] = await q.select().from(chainRun).where(eq(chainRun.eventId, eventId));
    if (!r) return null;
    const rows = await q.select().from(chainStep).where(eq(chainStep.runId, r.id)).orderBy(asc(chainStep.n));
    return {
      id: r.id,
      procedureVersion: r.procedureVersion,
      steps: rows.map(toStep),
      eventType: r.eventType,
      isTest: r.isTest,
    };
  }

  async createRun(
    tx: Tx,
    eventId: string,
    meta: { country: string; procedureVersion: number; rulesVersion: number; eventType: string; isTest: boolean },
    steps: ChainStep[],
  ): Promise<Run> {
    const id = uuidv7();
    await tx.insert(chainRun).values({
      id,
      eventId,
      procedureCountry: meta.country,
      procedureVersion: meta.procedureVersion,
      rulesVersion: meta.rulesVersion,
      eventType: meta.eventType,
      isTest: meta.isTest,
    });
    if (steps.length) await tx.insert(chainStep).values(steps.map((s) => this.row(id, s)));
    return { id, procedureVersion: meta.procedureVersion, steps, eventType: meta.eventType, isTest: meta.isTest };
  }

  /** Olay yükseltilince zincirin yeni planını işaretler. */
  async replanned(tx: Tx, runId: string, eventType: string, isTest: boolean): Promise<void> {
    await tx.update(chainRun).set({ eventType, isTest }).where(eq(chainRun.id, runId));
  }

  async appendStep(tx: Tx, runId: string, s: ChainStep): Promise<void> {
    await tx.insert(chainStep).values(this.row(runId, s));
  }

  async updateStep(tx: Tx, runId: string, s: ChainStep): Promise<void> {
    await tx
      .update(chainStep)
      .set({
        calledAt: s.calledAt ? new Date(s.calledAt) : null,
        result: s.result ?? null,
        assessment: s.assessment ?? null,
        note: s.note ?? null,
        reason: s.reason ?? null,
        operatorId: s.operatorId ?? null,
        completedAt: s.completedAt ? new Date(s.completedAt) : null,
        scriptReadAt: s.scriptReadAt ? new Date(s.scriptReadAt) : null,
      })
      .where(and(eq(chainStep.runId, runId), eq(chainStep.n, s.n)));
  }

  /** Adım sonucu denetim kaydı (append-only audit.log). Not metni yazılmaz (PII olabilir). operatorId yoksa SYSTEM. */
  async audit(tx: Tx, eventId: string, operatorId: string | null, action: string, data: Record<string, unknown>) {
    await tx.insert(auditLog).values({
      actorKind: operatorId ? 'OPERATOR' : 'SYSTEM',
      actorId: operatorId,
      action,
      entityType: 'event',
      entityId: eventId,
      data,
    });
  }

  private row(runId: string, s: ChainStep) {
    return {
      runId,
      n: s.n,
      kind: s.kind,
      target: s.target,
      contactIndex: s.contactIndex ?? null,
      labelCode: s.label,
      scriptCode: s.script ?? null,
      timeoutSec: s.timeoutSec,
      required: s.required,
      autoAnswerSec: s.autoAnswerSec ?? null,
    };
  }
}
