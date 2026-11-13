import { BadRequestException, ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import {
  type ChainStep,
  type ChainView,
  type DevicePromptView,
  type LadderView,
  STEP_RESULTS,
  type StepAssessment,
  type StepResult,
  TOPICS,
  type WelfareReason,
} from '@yanimda/contracts';
import { t } from '@yanimda/messages';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { DB, type Db, type Tx } from '../../db/client';
import { auditLog, contact, devicePrompt } from '../../db/schema';
import { deviceSummaries } from '../event/coverage.service';
import { type EventRecord, EventService, OPERATOR_STATES, type OperatorCtx } from '../event/event.service';
import {
  call112DeadlineSecOf,
  ladderOf,
  loadRulePack,
  RULES,
  type RulesProvider,
  staticRules,
} from '../event/rules.loader';
import { pickKeyHolder } from '../profile/contacts';
import { type EventPersonCard, ProfileService } from '../profile/profile.service';
import { type CallView, TelephonyService } from '../telephony/telephony.service';
import { ChainRepository, currentStep, type Run, view } from './chain.repository';
import {
  autoSkip,
  call112Deadline,
  deviceForStep,
  distanceM,
  dropMissingVoiceSteps,
  isDeviceStep,
  type LadderContext,
  orderForCorroboration,
  voiceTargetOf,
} from './ladder';
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
  /** T-087/T-088: 112 son sınırı, doğrulama ("2 cihaz"), olası acil durum, Apple akışı. */
  ladder: LadderView;
}

/** Merdiven için kişi bilgisi (numara ve tıbbi veri yok). */
interface PersonFacts {
  impaired: boolean;
  home: { lat: number; lng: number } | null;
  timezone: string;
  keyHolders: { hasKey: boolean; arrivalMin: number | null; reachableHours: string | null }[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  private readonly rules: RulesProvider;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EventService) private readonly events: EventService,
    @Optional() @Inject(PROCEDURES) proc?: ProcedurePack,
    @Optional() @Inject(TelephonyService) private readonly telephony?: TelephonyService,
    @Optional() @Inject(ProfileService) private readonly profile?: ProfileService,
    @Optional() @Inject(RULES) rules?: RulesProvider,
  ) {
    this.repo = new ChainRepository(db);
    this.proc = proc ?? loadProcedures();
    this.rules = rules ?? staticRules(loadRulePack());
  }

  async get(id: string): Promise<EventWithChain> {
    await this.replanIfStale(id);
    const event = await this.events.get(id);
    const run = await this.repo.run(id);
    return {
      event,
      chain: run ? view(run) : null,
      calls: (await this.telephony?.callsFor(id)) ?? [],
      ladder: await this.ladderView(this.db, event, run),
    };
  }

  /** Üstlenme: zincir oluşur; çevrimdışı / uygulanamaz ilk adımlar sistemce atlanır (T-087). */
  claim(id: string, operatorId: string, now?: Date): Promise<EventWithChain> {
    return this.events.operate(
      id,
      operatorId,
      async (c) => {
        const run = await this.ensureRun(c);
        await this.advance(c, run);
        return this.result(c, run);
      },
      { claim: true, now },
    );
  }

  /** Operatör kilidini uzatır (konsol açıkken periyodik). */
  heartbeat(id: string, operatorId: string, now?: Date): Promise<{ lockUntil?: string }> {
    return this.events.operate(id, operatorId, async (c) => ({ lockUntil: c.ev.lockUntil }), { now, accept: false });
  }

  /**
   * "Ara" (A): sıradaki adımın arama başlangıcı; ilk arama olayı CONTACT_CHAIN'e taşır. Telefoni açıksa ve adımın
   * numarası kayıtlıysa (112 hariç: masa hattından, T-052) CPaaS araması commit'ten sonra başlatılır (T-050).
   */
  async call(id: string, n: number, operatorId: string, now?: Date): Promise<EventWithChain> {
    await this.replanIfStale(id, now);
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
        // T-087 (S5.2): sesli cihaz adımı sırası gelen cihazı kendi numarasından arar (1. / 2. sesli cihaz, telefon);
        // "en iyi cihaza yeniden" doğrulayan veya sesli arama sırasında ilk çevrimiçi sesli cihaz. Cihazın numarası
        // yoksa rehberdeki rol numarası (saat / telefon; rehberde tek saat numarası olduğundan 2. cihaz kendi
        // numarası olmadan CPaaS'la aranmaz).
        const dev =
          isDeviceStep(step) && this.telephony?.enabled
            ? deviceForStep(step, await this.ladderContext(c.tx, c.ev, c.now), corroboratorOf(c.ev))
            : undefined;
        const voice = step.target === 'VOICE_DEVICE' && dev ? (voiceTargetOf(dev) ?? undefined) : undefined;
        const p = await this.telephony?.prepare(c.tx, {
          eventId: c.ev.id,
          personId: c.ev.protectedPersonId,
          step,
          operatorId,
          ...(voice ? { voice } : {}),
          ...(dev ? { deviceId: dev.id } : {}),
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
    await this.replanIfStale(id, now);
    return this.events.operate(
      id,
      operatorId,
      async (c) => {
        const run = await this.ensureRun(c);
        const step = this.current(run, n, c);
        // T-087 (S5.1): "bağlandı, ses yok" yalnız sesli cihaz aramasında (otomatik cevap) anlamlıdır.
        if (b.result === 'SILENT' && !isDeviceStep(step))
          throw new BadRequestException('Sessiz sonuç yalnız cihaz aramasında');
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
        } else if (b.result === 'SILENT') {
          // S5.1: otomatik cevaplı arama 20 sn sessiz → "cevap yok" değil, olası acil durum (işitme/konuşma güçlüğü
          // varsa yalnız "ulaşılamadı"; S5.9). Zincir sürer, konsol uyarır; 112 kararı operatörün (S5.8).
          if (!(await this.personFacts(c.tx, c.ev.protectedPersonId)).impaired) {
            await this.repo.audit(c.tx, c.ev.id, operatorId, 'chain.possible_emergency', {
              n: step.n,
              kind: step.kind,
            });
            c.publish(TOPICS.eventUpdated, { eventId: c.ev.id, reason: 'POSSIBLE_EMERGENCY', n: step.n });
          }
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
        await this.advance(c, run);
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
    const b = (body ?? {}) as {
      outcome?: unknown;
      note?: unknown;
      followUpAfterHours?: unknown;
      notified112?: unknown;
    };
    const note = text(b.note, NOTE_MAX, 'note');
    if (typeof b.outcome !== 'string') throw new BadRequestException('Sonuç zorunlu');
    const outcome = b.outcome;
    if (b.followUpAfterHours !== undefined && b.followUpAfterHours !== null && typeof b.followUpAfterHours !== 'number')
      throw new BadRequestException('followUpAfterHours sayı olmalı');
    const hours = typeof b.followUpAfterHours === 'number' ? b.followUpAfterHours : undefined;
    if (b.notified112 !== undefined && typeof b.notified112 !== 'boolean')
      throw new BadRequestException('notified112 true/false');
    const notified112 = b.notified112 === true;
    return this.events.operate(
      id,
      operatorId,
      async (c) => {
        const run = await this.repo.run(c.ev.id, c.tx);
        await c.finish(outcome, note, hours, notified112);
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
      { now, accept: false },
    );
  }

  /**
   * GET /v1/events/{id}/person — olayı yürüten operatöre kişi kartı (adres, kapı notu, tıbbi özet). Sağlık verisi
   * yalnız burada ve 112 şablonunda çözülür; her çözüm denetim kaydına yazılır. Profil yoksa null.
   */
  async personCard(id: string, operatorId: string, now?: Date): Promise<EventPersonCard | null> {
    return this.events.operate(id, operatorId, (c) => this.cardOf(c, operatorId, 'event_card'), {
      now,
      accept: false,
    });
  }

  // ---- iç ----

  private async cardOf(c: OperatorCtx, operatorId: string, purpose: string) {
    if (!this.profile) return null;
    return this.profile.eventCard(c.tx, c.ev.protectedPersonId, { eventId: c.ev.id, operatorId, purpose }, c.now);
  }

  private async result(c: OperatorCtx, run: Run | null): Promise<EventWithChain> {
    return {
      event: c.ev,
      chain: run ? view(run) : null,
      calls: (await this.telephony?.callsFor(c.ev.id, c.tx)) ?? [],
      ladder: await this.ladderView(c.tx, c.ev, run),
    };
  }

  // ---- T-087 merdiven ----

  /** Kişi bilgisi: işitme/konuşma güçlüğü, ev konumu, saat dilimi, anahtar sahipleri (numarasız). */
  private async personFacts(q: Db | Tx, personId: string): Promise<PersonFacts> {
    const r = UUID.test(personId)
      ? ((await q.execute(sql`
          SELECT hearing_speech_impaired AS impaired, lat, lng, timezone
          FROM profile.protected_person WHERE id = ${personId}::uuid`)) as unknown as {
          rows: { impaired: boolean; lat: number | null; lng: number | null; timezone: string }[];
        })
      : { rows: [] };
    const p = r.rows[0];
    const keyHolders = await q
      .select({ hasKey: contact.hasKey, arrivalMin: contact.arrivalMin, reachableHours: contact.reachableHours })
      .from(contact)
      .where(and(eq(contact.protectedPersonId, personId), eq(contact.hasKey, true)));
    return {
      impaired: !!p?.impaired,
      home: p && p.lat !== null && p.lng !== null ? { lat: p.lat, lng: p.lng } : null,
      timezone: p?.timezone ?? 'Europe/Istanbul',
      keyHolders,
    };
  }

  private async ladderContext(q: Db | Tx, ev: EventRecord, now: Date): Promise<LadderContext> {
    const pack = this.rules.current();
    const params = ladderOf(pack);
    const facts = await this.personFacts(q, ev.protectedPersonId);
    const loc = ev.location;
    return {
      now,
      devices: await deviceSummaries(q, pack, ev.protectedPersonId, now),
      impaired: facts.impaired,
      awayFromHome: !!(loc && facts.home && distanceM(loc, facts.home) > params.awayFromHomeM),
      hasKeyHolder: !!pickKeyHolder(facts.keyHolders, now, facts.timezone),
    };
  }

  /**
   * Sıradaki adım(lar) sistemce atlanabiliyorsa atlanır (S5.1 çevrimdışı cihaz, S5.5 evden uzak, S5.6 anahtar sahibi
   * yok, S5.9 işitme/konuşma güçlüğü). Operatör yalnız aranabilir adımı görür; her atlama kayıtlı (SYSTEM).
   */
  private async advance(c: OperatorCtx, run: Run) {
    if (c.ev.state !== 'OPERATOR_ASSIGNED' && c.ev.state !== 'CONTACT_CHAIN') return;
    let ctx: LadderContext | undefined;
    for (let step = currentStep(run.steps); step; step = currentStep(run.steps)) {
      ctx ??= await this.ladderContext(c.tx, c.ev, c.now);
      const skip = autoSkip(
        step,
        run.steps.filter((s) => s.result),
        ctx,
      );
      if (!skip) return;
      Object.assign(step, { result: skip.result, reason: skip.reason, completedAt: c.now.toISOString() });
      await this.repo.updateStep(c.tx, run.id, step);
      c.publish(TOPICS.chainStepResult, {
        eventId: c.ev.id,
        n: step.n,
        kind: step.kind,
        result: skip.result,
        reason: skip.reason,
        operatorId: null,
        at: c.now.toISOString(),
      });
      await this.repo.audit(c.tx, c.ev.id, null, 'chain.step.auto_skipped', {
        n: step.n,
        kind: step.kind,
        result: skip.result,
        reason: skip.reason,
      });
    }
  }

  /**
   * Olay türünün adımları: P1'de sesli cihaz adımları otomatik cevap süresini taşır (yanınızdayız aramasında asla;
   * S5.8); doğrulanmış düşmede doğrulayan cihaz önce aranır (S3.3).
   */
  private async plan(c: OperatorCtx): Promise<ChainStep[]> {
    if (!c.rule) return [];
    const { autoAnswerSec } = ladderOf(this.rules.current());
    const devices = await deviceSummaries(c.tx, this.rules.current(), c.ev.protectedPersonId, c.now);
    // S5.2: "2. sesli cihaz" yalnız kişinin ikinci sesli giyilebilir cihazı varsa.
    let steps = dropMissingVoiceSteps(buildSteps(c.rule, c.ev.isTest, this.proc), devices);
    if (c.rule.priority === 1 && autoAnswerSec > 0)
      steps = steps.map((s) => (isDeviceStep(s) ? { ...s, autoAnswerSec } : s));
    const by = corroboratorOf(c.ev);
    if (by) {
      const d = devices.find((x) => x.id === by);
      steps = orderForCorroboration(steps, d ? voiceTargetOf(d) : null);
    }
    return steps;
  }

  /** Konsol özeti: 112 son sınırı (kuyruğa düşüşten), doğrulama, olası acil durum, Apple akışı. */
  private async ladderView(q: Db | Tx, ev: EventRecord, run: Run | null): Promise<LadderView> {
    const sec = ev.isTest ? null : call112DeadlineSecOf(this.rules.current(), ev.type);
    const impaired = (await this.personFacts(q, ev.protectedPersonId)).impaired;
    return {
      call112DeadlineAt: call112Deadline(ev, sec),
      call112DeadlineSec: sec,
      corroborated: !!ev.corroboratedAt,
      sourceDeviceCount: ev.sourceDeviceIds.length,
      cancelledByDeviceId: ev.cancelledByDeviceId ?? null,
      possibleEmergency: !impaired && !!run?.steps.some((s) => s.result === 'SILENT'),
      hearingSpeechImpaired: impaired,
      platformSosFlow: await platformSosFlow(q, ev.sourceSignalIds),
      welfareReason: ev.type === 'WELFARE_CHECK' ? await welfareReasonOf(q, ev.id) : null,
      prompts: await promptsOf(q, ev.id, new Date()),
    };
  }

  /**
   * Olay operatördeyken yükseltildiyse (ör. üstlenilmiş TEST'e SOS) zincir, olayı tutan operatör adına AYRI bir
   * transaction'da yeniden planlanır. Uçtan uca bulgu (2026-11-13): yeniden planlama yalnız adım işleminin içinde
   * yapılıyordu; konsol eski adım numarasını gönderince 409 ile birlikte geri alınıyor, operatör zinciri hiç
   * ilerletemiyor ve GET eski TEST metnini gösteriyordu. Eş zamanlı devralma / kapanışta sessizce geçilir.
   */
  private async replanIfStale(id: string, now?: Date): Promise<void> {
    const run = await this.repo.run(id);
    if (!run?.eventType) return;
    const ev = await this.events.get(id).catch(() => null);
    if (!ev?.operatorId || !OPERATOR_STATES.has(ev.state)) return;
    if (run.eventType === ev.type && run.isTest === ev.isTest) return;
    await this.events
      .operate(
        id,
        ev.operatorId,
        async (c) => {
          const r = await this.ensureRun(c);
          await this.advance(c, r);
          return null;
        },
        { now, accept: false },
      )
      .catch((e: unknown) => {
        if (!(e instanceof ConflictException)) throw e;
      });
  }

  private async ensureRun(c: OperatorCtx): Promise<Run> {
    const existing = await this.repo.run(c.ev.id, c.tx);
    if (existing) {
      const stale = existing.eventType && (existing.eventType !== c.ev.type || existing.isTest !== c.ev.isTest);
      return stale ? this.replan(c, existing) : existing;
    }
    const steps = await this.plan(c);
    return this.repo.createRun(
      c.tx,
      c.ev.id,
      {
        country: this.proc.country,
        procedureVersion: this.proc.version,
        rulesVersion: c.rulesVersion,
        eventType: c.ev.type,
        isTest: c.ev.isTest,
      },
      steps,
    );
  }

  /**
   * Olay yükseltildi (ör. TEST'e SOS geldi): eski planın bekleyen adımları 'upgraded' ile atlanır, yeni türün planı
   * (gerçek olay → 112 dahil) arkasına eklenir. Tamamlanmış adımlar ve sonuçları korunur.
   */
  private async replan(c: OperatorCtx, run: Run): Promise<Run> {
    for (const s of run.steps.filter((x) => !x.result)) {
      Object.assign(s, { result: 'SKIPPED', reason: 'upgraded', completedAt: c.now.toISOString() });
      await this.repo.updateStep(c.tx, run.id, s);
    }
    const base = run.steps.at(-1)?.n ?? 0;
    const fresh = (await this.plan(c)).map((s, i) => ({ ...s, n: base + i + 1 }));
    for (const s of fresh) await this.repo.appendStep(c.tx, run.id, s);
    await this.repo.replanned(c.tx, run.id, c.ev.type, c.ev.isTest);
    return { ...run, steps: [...run.steps, ...fresh], eventType: c.ev.type, isTest: c.ev.isTest };
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

/** T-087: YERİNDE KONTROL nedeni (olay açılırken / yükseltilirken denetime yazılır). */
async function welfareReasonOf(q: Db | Tx, eventId: string): Promise<WelfareReason | null> {
  const [a] = await q
    .select({ data: auditLog.data })
    .from(auditLog)
    .where(and(eq(auditLog.entityId, eventId), eq(auditLog.action, 'event.welfare_raised')))
    .orderBy(desc(auditLog.id))
    .limit(1);
  return ((a?.data as { reason?: WelfareReason } | null)?.reason as WelfareReason | undefined) ?? null;
}

/** T-089: operatörün cihaz soruları ve cevapları; cevapsız ve süresi geçmiş soru NO_ANSWER. */
async function promptsOf(q: Db | Tx, eventId: string, now: Date): Promise<DevicePromptView[]> {
  const rows = await q
    .select()
    .from(devicePrompt)
    .where(eq(devicePrompt.eventId, eventId))
    .orderBy(asc(devicePrompt.sentAt));
  return rows.map((r) => ({
    deviceId: r.deviceId,
    sentAt: r.sentAt.toISOString(),
    until: r.until.toISOString(),
    delivered: r.delivered,
    answer: (r.answer as 'OK' | 'HELP' | null) ?? (r.until <= now ? 'NO_ANSWER' : null),
    answeredAt: r.answeredAt?.toISOString() ?? null,
    answeredByDeviceId: r.answeredBy ?? null,
  }));
}

/** S3.3: doğrulayan cihaz (alarmı açandan sonraki ilk farklı cihaz); doğrulanmamışsa null. */
const corroboratorOf = (ev: EventRecord) => (ev.corroboratedAt ? (ev.sourceDeviceIds[1] ?? null) : null);

/** S5.7: olayın sinyallerinden biri kaynağın kendi SOS akışını (ör. Apple düşme → 112) çalıştırdığını bildirdi mi. */
async function platformSosFlow(q: Db | Tx, keys: string[]): Promise<boolean> {
  if (!keys.length) return false;
  const list = sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  );
  const r = (await q.execute(sql`
    SELECT 1 FROM signal.signal
    WHERE idempotency_key IN (${list}) AND payload->'payload'->>'platformSosFlow' = 'true'
    LIMIT 1`)) as unknown as { rows: unknown[] };
  return r.rows.length > 0;
}

async function personOf(tx: Tx, id: string): Promise<{ displayName: string; birthYear: number | null } | null> {
  const r = (await tx.execute(
    sql`SELECT display_name, birth_year FROM profile.protected_person WHERE id::text = ${id}`,
  )) as unknown as { rows: { display_name: string; birth_year: number | null }[] };
  const row = r.rows[0];
  return row ? { displayName: row.display_name, birthYear: row.birth_year } : null;
}
