import { ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { type EventState, type EventType, type KafkaEnvelope, type Signal, TOPICS } from '@yanimda/contracts';
import { v7 as uuidv7 } from 'uuid';

import { bus } from '../../common/bus';
import { assertTransition } from './event-state-machine';
import { loadRulePack, ruleFor, type RulePack } from './rules.loader';

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

/**
 * D-02 olay üretimi, D-03/D-04 kuyruk, D-05 koruma durumu, D-09 zamanlayıcılar (S0: setTimeout; T-013: BullMQ),
 * D-10 geçiş kaydı (S0: bellek; T-011: Postgres event.transition).
 */
@Injectable()
export class EventService implements OnModuleInit {
  private readonly log = new Logger('EventService');
  private pack: RulePack = loadRulePack();
  private readonly events = new Map<string, EventRecord>();
  private readonly openBySubject = new Map<string, string>(); // protectedPersonId -> açık olay id (tip bazlı değil; T-012 iyileştirir)
  private readonly timers = new Map<string, NodeJS.Timeout>();

  onModuleInit() {
    bus.subscribe<Signal>(TOPICS.signalReceived, (e) => this.onSignal(e));
    this.log.log(`Kural paketi ${this.pack.country} v${this.pack.version} (${this.pack.rules.length} kural)`);
  }

  private onSignal(e: KafkaEnvelope<Signal>) {
    const s = e.payload;
    if (s.kind === 'CANCEL' || s.kind === 'OK') return this.onUserAnswer(s);
    if (s.kind === 'ON_BODY') return this.autoCloseWatchOff(s.protectedPersonId);
    if (s.kind === 'BATTERY' && typeof s.value === 'number') {
      if (s.value <= 10) return this.create('BATTERY_LOW', s); // T-012: 20/10 ayrımı ve BATTERY_DEAD zamanlayıcısı
      return;
    }
    const type = SIGNAL_TO_EVENT[s.kind];
    if (!type) return; // HEARTBEAT, HEART_RATE, STEPS, LOCATION: T-010 Timescale'e yazılır
    this.create(type, s);
  }

  private create(type: EventType, s: Signal) {
    const rule = ruleFor(this.pack, type);
    if (!rule) {
      this.log.warn(`Kural yok: ${type}`);
      return;
    }
    if (this.openBySubject.has(s.protectedPersonId)) {
      this.log.log(`Açık olay var, ${type} sinyali eklendi`);
      this.events.get(this.openBySubject.get(s.protectedPersonId)!)!.sourceSignalIds.push(s.idempotencyKey);
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
      sourceSignalIds: [s.idempotencyKey],
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
      this.timers.set(
        ev.id,
        setTimeout(() => this.escalate(ev, 'cevap yok'), win),
      );
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

  private onUserAnswer(s: Signal) {
    const id = this.openBySubject.get(s.protectedPersonId);
    if (!id) return;
    const ev = this.events.get(id)!;
    if (ev.state !== 'DEVICE_PROMPT') return; // ESCALATED sonrası kullanıcı cevabı operatöre not olarak gider (T-013)
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.transition(ev, 'CANCELLED_BY_USER', 'USER', s.deviceId, 'kullanıcı iyiyim dedi');
    this.close(ev, 'FALSE_ALARM', 'kullanıcı iptali', 'SYSTEM');
  }

  private autoCloseWatchOff(subject: string) {
    const id = this.openBySubject.get(subject);
    if (!id) return;
    const ev = this.events.get(id)!;
    if (ev.type !== 'WATCH_OFF') return;
    if (ev.state === 'DEVICE_PROMPT' || ev.state === 'OPERATOR_QUEUE') {
      clearTimeout(this.timers.get(id));
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
