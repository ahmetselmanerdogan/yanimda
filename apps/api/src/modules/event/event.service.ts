import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { type EventState, type EventType, type KafkaEnvelope, type Signal, TOPICS } from '@yanimda/contracts';
import { v7 as uuidv7 } from 'uuid';

import { bus } from '../../common/bus';
import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { type TimerJob, type TimerKind, TIMERS, type Timers } from '../../common/timers/timers';
import { DB, type Db, type Tx } from '../../db/client';
import { type ActorKind, type EventRecord, EventRepository, type TransitionRecord } from './event.repository';
import { assertTransition } from './event-state-machine';
import { loadRulePack, type Rule, RULE_PACK, ruleFor, type RulePack } from './rules.loader';

export type { EventRecord } from './event.repository';

const SIGNAL_TO_EVENT: Partial<Record<Signal['kind'], EventType>> = {
  SOS: 'SOS',
  FALL: 'FALL',
  INACTIVITY: 'INACTIVITY',
  OFF_BODY: 'WATCH_OFF',
  CALLBACK_REQUEST: 'CALLBACK',
  TEST: 'TEST',
};

/** Olay kaynağı: sinyal veya zamanlayıcı (follow-up). */
interface EventSource {
  protectedPersonId: string;
  sourceId: string;
  location?: Signal['location'];
}

/** Bir transaction içindeki olay değişiklikleri; flush ile tek seferde yazılır. */
interface Uow {
  tx: Tx;
  ev: EventRecord;
  isNew: boolean;
  transitions: TransitionRecord[];
  publishes: { topic: string; payload: unknown }[];
  /** Commit'ten SONRA çalışacak işler (ör. zamanlayıcı iptali). */
  after: (() => Promise<void>)[];
}

const pgCode = (e: unknown) =>
  (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;

/**
 * D-02 olay üretimi, D-03/D-04 kuyruk, D-09 zamanlayıcılar (Timers/BullMQ), D-10 geçiş kaydı (T-011b).
 *
 * Kalıcılık (T-011b): olay event.event'te, geçişler event.transition'da. Her işlem tek transaction'da:
 * olay satırı FOR UPDATE kilitlenir → durum değişir → geçiş + audit.log + outbox (event.*) yazılır → commit.
 * Bellekte durum tutulmaz; yeni süreç aynı olayları görür.
 *
 * Zamanlayıcılar commit'ten ÖNCE kurulur: commit başarısız olursa geride kalan iş olayı bulamaz ve no-op olur;
 * tersi (commit oldu, iş kurulamadı) olmaz. Ayrıca periyodik tarama süresi geçmiş cihaz sorularını yükseltir.
 */
@Injectable()
export class EventService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('EventService');
  private readonly pack: RulePack;
  private readonly repo: EventRepository;
  private sweepTimer?: NodeJS.Timeout;
  private unsubscribe?: () => void;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Inject(TIMERS) private readonly timers: Timers,
    @Optional() @Inject(RULE_PACK) pack?: RulePack,
  ) {
    this.pack = pack ?? loadRulePack();
    this.repo = new EventRepository(db);
  }

  onModuleInit() {
    this.unsubscribe = bus.subscribe<Signal>(TOPICS.signalReceived, (e) => this.onSignal(e));
    this.registerTimerHandlers();
    this.log.log(`Kural paketi ${this.pack.country} v${this.pack.version} (${this.pack.rules.length} kural)`);
  }

  onApplicationBootstrap() {
    const every = Number(process.env.EVENT_SWEEP_MS ?? 30_000);
    if (every > 0) {
      const tick = () =>
        this.recoverOverdue()
          .catch((e) => this.log.error(`Tarama başarısız: ${safeError(e)}`))
          .finally(() => (this.sweepTimer = setTimeout(tick, every)));
      void tick();
    }
  }

  onModuleDestroy() {
    clearTimeout(this.sweepTimer);
    this.unsubscribe?.();
  }

  // ---- Okuma ----
  async get(id: string): Promise<EventRecord> {
    const ev = await this.repo.get(id);
    if (!ev) throw new NotFoundException('Olay yok');
    return ev;
  }
  queue(): Promise<EventRecord[]> {
    return this.repo.queue();
  }
  all(): Promise<EventRecord[]> {
    return this.repo.all();
  }

  // ---- D-09 zamanlayıcı işleyicileri: GÜNCEL durumu kilitli okur, beklenen durumda değilse no-op ----
  private registerTimerHandlers() {
    const expirePrompt = async ({ eventId }: TimerJob) => {
      const found = await this.withEvent(eventId, async (u) => {
        if (u.ev.state === 'DEVICE_PROMPT') this.escalate(u, 'cevap yok');
      });
      if (found === null) this.log.warn(`Zamanlayıcı: olay bulunamadı ${eventId}`);
    };
    this.timers.on('prompt-expire', expirePrompt);
    this.timers.on('silent-ask-expire', expirePrompt);
    this.timers.on('follow-up', async ({ eventId }) => {
      const src = await this.repo.get(eventId);
      if (!src) return void this.log.warn(`Takip: kaynak olay bulunamadı ${eventId}`);
      await this.create('FOLLOW_UP', {
        protectedPersonId: src.protectedPersonId,
        sourceId: `follow-up:${eventId}`,
        location: src.location,
      });
    });
  }

  /** Süresi (+ pay) geçmiş DEVICE_PROMPT olaylarını yükseltir. Yükseltilen olay sayısını döner. */
  async recoverOverdue(graceMs = Number(process.env.EVENT_SWEEP_GRACE_MS ?? 20_000)): Promise<number> {
    let n = 0;
    for (const id of await this.repo.overduePromptIds(new Date(Date.now() - graceMs))) {
      await this.withEvent(id, async (u) => {
        if (u.ev.state !== 'DEVICE_PROMPT') return;
        this.escalate(u, 'cevap yok (tarama)');
        n++;
      });
    }
    if (n) this.log.warn(`Tarama: ${n} gecikmiş cihaz sorusu yükseltildi`);
    return n;
  }

  private promptKind(rule: Rule): TimerKind {
    return rule.devicePrompt?.silent ? 'silent-ask-expire' : 'prompt-expire';
  }

  // ---- Sinyal işleme (outbox → bus) ----
  private async onSignal(e: KafkaEnvelope<Signal>) {
    const s = e.payload;
    const src: EventSource = {
      protectedPersonId: s.protectedPersonId,
      sourceId: s.idempotencyKey,
      location: s.location,
    };
    if (s.kind === 'CANCEL' || s.kind === 'OK') return this.onUserAnswer(s);
    if (s.kind === 'ON_BODY') return this.autoCloseWatchOff(s.protectedPersonId);
    if (s.kind === 'BATTERY' && typeof s.value === 'number') {
      if (s.value <= 10) return this.create('BATTERY_LOW', src); // T-012: 20/10 ayrımı ve BATTERY_DEAD zamanlayıcısı
      return;
    }
    const type = SIGNAL_TO_EVENT[s.kind];
    if (!type) return; // HEARTBEAT, HEART_RATE, STEPS, LOCATION: yalnız signal.signal
    return this.create(type, src);
  }

  private async create(type: EventType, s: EventSource, retry = true): Promise<void> {
    const rule = ruleFor(this.pack, type);
    if (!rule) return void this.log.warn(`Kural yok: ${type}`);
    try {
      await this.db.transaction(async (tx) => {
        // Outbox en az bir kez teslim eder: aynı kaynak ikinci kez olay açmasın.
        if (await this.repo.hasSource(tx, s.sourceId)) return;
        const open = await this.repo.findOpenForUpdate(tx, s.protectedPersonId);
        if (open) {
          this.log.log(`Açık olay var, ${type} kaynağı olaya eklendi`); // T-012: SOS önceliği yükseltir
          await this.repo.appendSource(tx, open.id, s.sourceId);
          return;
        }
        const now = new Date().toISOString();
        const u: Uow = {
          tx,
          isNew: true,
          transitions: [],
          publishes: [],
          after: [],
          ev: {
            id: uuidv7(),
            protectedPersonId: s.protectedPersonId,
            type,
            priority: rule.priority,
            state: 'CREATED',
            createdAt: now,
            location: s.location ?? undefined,
            sourceSignalIds: [s.sourceId],
            isTest: type === 'TEST',
            transitions: [],
          },
        };
        u.publishes.push({ topic: TOPICS.eventCreated, payload: u.ev });
        this.transition(u, 'CREATED', 'SYSTEM');
        if (rule.devicePrompt?.enabled) {
          const win = (rule.devicePrompt.windowSec ?? 60) * 1000;
          u.ev.devicePromptUntil = new Date(Date.now() + win).toISOString();
          this.transition(
            u,
            'DEVICE_PROMPT',
            'SYSTEM',
            undefined,
            `prompt ${rule.devicePrompt.tts ?? ''} ${win / 1000}s`,
          );
          await this.flush(u);
          await this.timers.schedule(u.ev.id, this.promptKind(rule), win); // commit'ten önce (bkz. sınıf notu)
        } else {
          this.escalate(u, 'cihaz sorusu yok');
          await this.flush(u);
        }
      });
    } catch (e) {
      // Eş zamanlı ikinci açık olay tekil indekse takıldı → bir kez daha dene (bu kez açık olaya eklenir).
      if (retry && pgCode(e) === '23505') return this.create(type, s, false);
      throw e;
    }
  }

  private escalate(u: Uow, note: string) {
    if (u.ev.state !== 'CREATED' && u.ev.state !== 'DEVICE_PROMPT') return;
    u.ev.escalatedAt = new Date().toISOString();
    this.transition(u, 'ESCALATED', 'SYSTEM', undefined, note);
    this.transition(u, 'OPERATOR_QUEUE', 'SYSTEM');
    this.log.warn(`KUYRUK: ${u.ev.type} P${u.ev.priority} olay=${u.ev.id}`);
  }

  private async onUserAnswer(s: Signal) {
    await this.withOpenEvent(s.protectedPersonId, async (u) => {
      if (u.ev.state !== 'DEVICE_PROMPT') return; // ESCALATED sonrası kullanıcı cevabı operatöre not olarak gider
      this.transition(u, 'CANCELLED_BY_USER', 'USER', s.deviceId, 'kullanıcı iyiyim dedi');
      this.close(u, 'FALSE_ALARM', 'kullanıcı iptali', 'SYSTEM');
      const rule = ruleFor(this.pack, u.ev.type);
      if (rule) u.after.push(() => this.timers.cancel(u.ev.id, this.promptKind(rule)));
    });
  }

  private async autoCloseWatchOff(subject: string) {
    await this.withOpenEvent(subject, async (u) => {
      if (u.ev.type !== 'WATCH_OFF') return;
      if (u.ev.state !== 'DEVICE_PROMPT' && u.ev.state !== 'OPERATOR_QUEUE') return;
      if (u.ev.state === 'DEVICE_PROMPT') this.transition(u, 'CANCELLED_BY_USER', 'USER', undefined, 'saat takıldı');
      else {
        this.transition(u, 'OPERATOR_ASSIGNED', 'SYSTEM');
        this.transition(u, 'CONFIRMED_OK', 'SYSTEM', undefined, 'saat takıldı');
      }
      this.close(u, 'OK', 'saat takıldı', 'SYSTEM');
      u.after.push(async () => {
        await this.timers.cancel(u.ev.id, 'watch-off-remind');
        await this.timers.cancel(u.ev.id, 'watch-off-operator');
      });
    });
  }

  // ---- Konsol tarafı (E-02, E-07) ----
  async claim(id: string, operatorId: string): Promise<EventRecord> {
    const ev = await this.withEvent(id, async (u) => {
      if (u.ev.state === 'OPERATOR_ASSIGNED' && u.ev.operatorId !== operatorId)
        throw new ConflictException('Başka operatör üstlendi');
      if (u.ev.state === 'OPERATOR_QUEUE') {
        u.ev.operatorId = operatorId;
        this.transition(u, 'OPERATOR_ASSIGNED', 'OPERATOR', operatorId);
      }
      return u.ev;
    });
    if (!ev) throw new NotFoundException('Olay yok');
    return ev;
  }

  async closeByOperator(id: string, operatorId: string, outcome: string, note?: string): Promise<EventRecord> {
    const ev = await this.withEvent(id, async (u) => {
      if (u.ev.operatorId !== operatorId) throw new ConflictException('Olay sizde değil');
      const confirmed: EventState = outcome === 'EMERGENCY' ? 'CONFIRMED_EMERGENCY' : 'CONFIRMED_OK';
      if (u.ev.state === 'OPERATOR_ASSIGNED' || u.ev.state === 'CONTACT_CHAIN')
        this.transition(u, confirmed, 'OPERATOR', operatorId, note);
      if (confirmed === 'CONFIRMED_EMERGENCY') this.transition(u, 'DISPATCH', 'OPERATOR', operatorId);
      this.close(u, outcome, note ?? '', 'OPERATOR', operatorId);
      const hours = ruleFor(this.pack, u.ev.type)?.followUpAfterHours;
      if (confirmed === 'CONFIRMED_EMERGENCY' && hours)
        await this.timers.schedule(u.ev.id, 'follow-up', hours * 3600 * 1000); // commit'ten önce
      return u.ev;
    });
    if (!ev) throw new NotFoundException('Olay yok');
    return ev;
  }

  // ---- Birim iş (unit of work) ----

  /** Olayı kilitleyip fn'i çalıştırır, değişiklikleri tek transaction'da yazar. Olay yoksa null. */
  private async withEvent<T>(id: string, fn: (u: Uow) => Promise<T>): Promise<T | null | undefined> {
    return this.unitOfWork((tx) => this.repo.findForUpdate(tx, id), fn);
  }

  private async withOpenEvent<T>(protectedPersonId: string, fn: (u: Uow) => Promise<T>) {
    return this.unitOfWork((tx) => this.repo.findOpenForUpdate(tx, protectedPersonId), fn);
  }

  private async unitOfWork<T>(
    load: (tx: Tx) => Promise<EventRecord | null>,
    fn: (u: Uow) => Promise<T>,
  ): Promise<T | null | undefined> {
    const after: Uow['after'] = [];
    const result = await this.db.transaction(async (tx) => {
      const ev = await load(tx);
      if (!ev) return null;
      const u: Uow = { tx, ev, isNew: false, transitions: [], publishes: [], after };
      const r = await fn(u);
      await this.flush(u);
      return r;
    });
    for (const a of after) await a().catch((e) => this.log.warn(`Commit sonrası iş başarısız: ${safeError(e)}`));
    return result;
  }

  private close(u: Uow, outcome: string, reason: string, actorKind: 'SYSTEM' | 'OPERATOR', actorId?: string) {
    u.ev.confirmedOutcome = outcome;
    u.ev.closedAt = new Date().toISOString();
    u.ev.closeReason = reason;
    this.transition(u, 'CLOSED', actorKind, actorId, reason);
    u.publishes.push({ topic: TOPICS.eventClosed, payload: u.ev });
  }

  private transition(u: Uow, to: EventState, actorKind: ActorKind, actorId?: string, note?: string) {
    const from = u.transitions.length || !u.isNew || u.ev.transitions.length ? u.ev.state : undefined;
    if (from) assertTransition(from, to);
    u.ev.state = to;
    const t: TransitionRecord = { id: uuidv7(), from, to, actorKind, actorId, at: new Date().toISOString(), note };
    u.ev.transitions.push(t);
    u.transitions.push(t);
    u.publishes.push({ topic: TOPICS.eventTransitioned, payload: { eventId: u.ev.id, from, to, note } });
  }

  /** Olay satırı + geçişler + audit + outbox — çağıranın transaction'ında. */
  private async flush(u: Uow) {
    if (u.isNew) {
      await this.repo.insert(u.tx, u.ev);
      u.isNew = false;
    } else if (u.transitions.length || u.publishes.length) await this.repo.update(u.tx, u.ev);
    await this.repo.insertTransitions(u.tx, u.ev.id, u.transitions);
    for (const p of u.publishes) {
      const payload = p.payload === u.ev ? { ...u.ev, transitions: undefined } : p.payload;
      await this.outbox.publish(
        p.topic,
        {
          eventId: uuidv7(),
          type: p.topic,
          version: 1,
          occurredAt: new Date().toISOString(),
          countryCode: this.pack.country,
          subjectUserId: u.ev.protectedPersonId,
          payload,
        },
        u.tx,
      );
    }
    u.transitions = [];
    u.publishes = [];
  }
}
