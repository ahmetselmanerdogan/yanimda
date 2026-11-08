import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { type EventState, type EventType, type KafkaEnvelope, type Signal, TOPICS } from '@yanimda/contracts';
import { v7 as uuidv7 } from 'uuid';

import { bus } from '../../common/bus';
import { type TimerJob, type TimerKind, TIMERS, type Timers } from '../../common/timers/timers';
import { assertTransition } from './event-state-machine';
import { loadRulePack, type Rule, RULE_PACK, ruleFor, type RulePack } from './rules.loader';

export interface EventRecord {
  id: string;
  protectedPersonId: string;
  type: EventType;
  priority: number;
  state: EventState;
  createdAt: string;
  devicePromptUntil?: string;
  escalatedAt?: string;
  operatorId?: string;
  confirmedOutcome?: string;
  closedAt?: string;
  closeReason?: string;
  location?: Signal['location'];
  sourceSignalIds: string[];
  isTest: boolean;
  transitions: {
    from?: EventState;
    to: EventState;
    actorKind: 'SYSTEM' | 'USER' | 'OPERATOR';
    actorId?: string;
    at: string;
    note?: string;
  }[];
}

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

/**
 * D-02 olay üretimi, D-03/D-04 kuyruk, D-05 koruma durumu, D-09 zamanlayıcılar (T-013: Timers/BullMQ),
 * D-10 geçiş kaydı (S0: bellek; T-011b: Postgres event.transition).
 */
@Injectable()
export class EventService implements OnModuleInit {
  private readonly log = new Logger('EventService');
  private readonly pack: RulePack;
  private readonly events = new Map<string, EventRecord>();
  private readonly openBySubject = new Map<string, string>(); // protectedPersonId -> açık olay id (tip bazlı değil; T-012 iyileştirir)

  constructor(
    @Inject(TIMERS) private timers: Timers,
    @Optional() @Inject(RULE_PACK) pack?: RulePack,
  ) {
    this.pack = pack ?? loadRulePack();
  }

  onModuleInit() {
    bus.subscribe<Signal>(TOPICS.signalReceived, (e) => this.onSignal(e));
    this.registerTimerHandlers();
    this.log.log(`Kural paketi ${this.pack.country} v${this.pack.version} (${this.pack.rules.length} kural)`);
  }

  /** Zamanlayıcı değiştir (yeniden başlatma benzetimi / testler). */
  useTimers(timers: Timers) {
    this.timers = timers;
    this.registerTimerHandlers();
  }

  all(): EventRecord[] {
    return [...this.events.values()];
  }

  // ---- D-09 zamanlayıcı işleyicileri: GÜNCEL durumu okur, beklenen durumda değilse no-op (yarış güvenli) ----
  private registerTimerHandlers() {
    const expirePrompt = async ({ eventId }: TimerJob) => {
      const ev = this.events.get(eventId);
      if (!ev) return void this.log.warn(`Zamanlayıcı: olay bulunamadı (T-011b öncesi yeniden başlatma?) ${eventId}`);
      if (ev.state === 'DEVICE_PROMPT') this.escalate(ev, 'cevap yok');
    };
    this.timers.on('prompt-expire', expirePrompt);
    this.timers.on('silent-ask-expire', expirePrompt);
    this.timers.on('follow-up', async ({ eventId }) => {
      const src = this.events.get(eventId);
      if (!src) return void this.log.warn(`Takip: kaynak olay bulunamadı ${eventId}`);
      const sourceId = `follow-up:${eventId}`;
      if (this.all().some((e) => e.sourceSignalIds.includes(sourceId))) return; // çift tetiklenme
      await this.create('FOLLOW_UP', { protectedPersonId: src.protectedPersonId, sourceId, location: src.location });
    });
  }

  private promptKind(rule: Rule): TimerKind {
    return rule.devicePrompt?.silent ? 'silent-ask-expire' : 'prompt-expire';
  }

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
    if (!type) return; // HEARTBEAT, HEART_RATE, STEPS, LOCATION: T-010 Timescale'e yazılır
    return this.create(type, src);
  }

  private async create(type: EventType, s: EventSource) {
    const rule = ruleFor(this.pack, type);
    if (!rule) {
      this.log.warn(`Kural yok: ${type}`);
      return;
    }
    if (this.openBySubject.has(s.protectedPersonId)) {
      this.log.log(`Açık olay var, ${type} sinyali eklendi`);
      this.events.get(this.openBySubject.get(s.protectedPersonId)!)!.sourceSignalIds.push(s.sourceId);
      return;
    }
    const ev: EventRecord = {
      id: uuidv7(),
      protectedPersonId: s.protectedPersonId,
      type,
      priority: rule.priority,
      state: 'CREATED',
      createdAt: new Date().toISOString(),
      location: s.location ?? undefined,
      sourceSignalIds: [s.sourceId],
      isTest: type === 'TEST',
      transitions: [{ to: 'CREATED', actorKind: 'SYSTEM', at: new Date().toISOString() }],
    };
    this.events.set(ev.id, ev);
    this.openBySubject.set(s.protectedPersonId, ev.id);
    this.publish(TOPICS.eventCreated, ev);
    if (rule.devicePrompt?.enabled) {
      const win = (rule.devicePrompt.windowSec ?? 60) * 1000;
      ev.devicePromptUntil = new Date(Date.now() + win).toISOString();
      this.transition(ev, 'DEVICE_PROMPT', 'SYSTEM', undefined, `prompt ${rule.devicePrompt.tts ?? ''} ${win / 1000}s`);
      await this.timers.schedule(ev.id, this.promptKind(rule), win);
    } else {
      this.escalate(ev, 'cihaz sorusu yok');
    }
  }

  private escalate(ev: EventRecord, note: string) {
    if (ev.state !== 'CREATED' && ev.state !== 'DEVICE_PROMPT') return;
    ev.escalatedAt = new Date().toISOString();
    this.transition(ev, 'ESCALATED', 'SYSTEM', undefined, note);
    this.transition(ev, 'OPERATOR_QUEUE', 'SYSTEM');
    this.log.warn(`KUYRUK: ${ev.type} P${ev.priority} olay=${ev.id}`);
  }

  private async onUserAnswer(s: Signal) {
    const id = this.openBySubject.get(s.protectedPersonId);
    if (!id) return;
    const ev = this.events.get(id)!;
    if (ev.state !== 'DEVICE_PROMPT') return; // ESCALATED sonrası kullanıcı cevabı operatöre not olarak gider
    // Önce durum (senkron), sonra iş silme: arada tetiklenen iş durumu DEVICE_PROMPT görmez → no-op.
    this.transition(ev, 'CANCELLED_BY_USER', 'USER', s.deviceId, 'kullanıcı iyiyim dedi');
    this.close(ev, 'FALSE_ALARM', 'kullanıcı iptali', 'SYSTEM');
    const rule = ruleFor(this.pack, ev.type);
    if (rule) await this.timers.cancel(ev.id, this.promptKind(rule));
  }

  private autoCloseWatchOff(subject: string) {
    const id = this.openBySubject.get(subject);
    if (!id) return;
    const ev = this.events.get(id)!;
    if (ev.type !== 'WATCH_OFF') return;
    if (ev.state === 'DEVICE_PROMPT' || ev.state === 'OPERATOR_QUEUE') {
      void this.timers.cancel(id, 'watch-off-remind');
      void this.timers.cancel(id, 'watch-off-operator');
      if (ev.state === 'DEVICE_PROMPT') this.transition(ev, 'CANCELLED_BY_USER', 'USER', undefined, 'saat takıldı');
      else {
        this.transition(ev, 'OPERATOR_ASSIGNED', 'SYSTEM');
        this.transition(ev, 'CONFIRMED_OK', 'SYSTEM', undefined, 'saat takıldı');
      }
      this.close(ev, 'OK', 'saat takıldı', 'SYSTEM');
    }
  }

  // ---- Konsol tarafı (E-02, E-07) ----
  queue(): EventRecord[] {
    return [...this.events.values()]
      .filter((e) => e.state === 'OPERATOR_QUEUE' || e.state === 'OPERATOR_ASSIGNED')
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  }
  claim(id: string, operatorId: string) {
    const ev = this.get(id);
    if (ev.state === 'OPERATOR_ASSIGNED' && ev.operatorId !== operatorId)
      throw new ConflictException('Başka operatör üstlendi');
    if (ev.state === 'OPERATOR_QUEUE') {
      ev.operatorId = operatorId;
      this.transition(ev, 'OPERATOR_ASSIGNED', 'OPERATOR', operatorId);
    }
    return ev;
  }
  closeByOperator(id: string, operatorId: string, outcome: string, note?: string) {
    const ev = this.get(id);
    if (ev.operatorId !== operatorId) throw new ConflictException('Olay sizde değil');
    const confirmed: EventState = outcome === 'EMERGENCY' ? 'CONFIRMED_EMERGENCY' : 'CONFIRMED_OK';
    if (ev.state === 'OPERATOR_ASSIGNED' || ev.state === 'CONTACT_CHAIN')
      this.transition(ev, confirmed, 'OPERATOR', operatorId, note);
    if (confirmed === 'CONFIRMED_EMERGENCY') this.transition(ev, 'DISPATCH', 'OPERATOR', operatorId);
    this.close(ev, outcome, note ?? '', 'OPERATOR', operatorId);
    const hours = ruleFor(this.pack, ev.type)?.followUpAfterHours;
    if (confirmed === 'CONFIRMED_EMERGENCY' && hours)
      void this.timers.schedule(ev.id, 'follow-up', hours * 3600 * 1000);
    return ev;
  }
  get(id: string) {
    const ev = this.events.get(id);
    if (!ev) throw new NotFoundException('Olay yok');
    return ev;
  }

  private close(ev: EventRecord, outcome: string, reason: string, actorKind: 'SYSTEM' | 'OPERATOR', actorId?: string) {
    ev.confirmedOutcome = outcome;
    ev.closedAt = new Date().toISOString();
    ev.closeReason = reason;
    this.transition(ev, 'CLOSED', actorKind, actorId, reason);
    this.openBySubject.delete(ev.protectedPersonId);
    this.publish(TOPICS.eventClosed, ev);
  }
  private transition(
    ev: EventRecord,
    to: EventState,
    actorKind: 'SYSTEM' | 'USER' | 'OPERATOR',
    actorId?: string,
    note?: string,
  ) {
    const from = ev.state;
    assertTransition(from, to);
    ev.state = to;
    ev.transitions.push({ from, to, actorKind, actorId, at: new Date().toISOString(), note });
    this.publish(TOPICS.eventTransitioned, { eventId: ev.id, from, to, note });
  }
  private publish(topic: string, payload: unknown) {
    bus.publish(topic, {
      eventId: uuidv7(),
      type: topic,
      version: 1,
      occurredAt: new Date().toISOString(),
      countryCode: this.pack.country,
      subjectUserId: (payload as { protectedPersonId?: string }).protectedPersonId ?? 'n/a',
      payload,
    });
  }
}
