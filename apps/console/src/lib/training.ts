import type { ChainStep, CoverageView, EventState, EventType, StepTarget } from '@yanimda/contracts';

import {
  type Api,
  ApiError,
  CALL_ACTIVE,
  type CallView,
  type CloseOutcome,
  type DispatchScript,
  type EventRecord,
  type EventWithChain,
  type OperatorStatus,
  type PersonCard,
  type QueueItem,
  type StepResultBody,
} from './api';
import type { Backend } from './backend';
import { t } from './i18n';
import type { LiveHandlers, ServerMessage } from './live';

/**
 * T-026 eğitim modu (05 "tatbikat"): `?training=1`. Konsol yerel, sahte olaylarla çalışır; ağ isteği yapılmaz,
 * gerçek API'ye hiçbir şey yazılmaz. Üretim derlemesinde (import.meta.env.PROD) her zaman kapalıdır.
 * Zincir kuralları sunucudakiyle aynı mantığı izler (sıra, atlama gerekçesi, 112 kısayolu, kapatma sonuçları).
 */
export { trainingRequested } from './training-flag';

const STEP: Record<string, { label: string; script?: string; target: StepTarget; timeoutSec: number }> = {
  CALL_WATCH: { label: 'O-STEP-WATCH', script: 'O-SCRIPT-ELDER', target: 'WATCH', timeoutSec: 15 },
  CALL_PHONE: { label: 'O-STEP-PHONE', script: 'O-SCRIPT-ELDER', target: 'ELDER_PHONE', timeoutSec: 15 },
  CALL_CONTACT: { label: 'O-STEP-CONTACT', script: 'O-SCRIPT-CONTACT', target: 'CONTACT', timeoutSec: 25 },
  CALL_NEIGHBOR: { label: 'O-STEP-NEIGHBOR', script: 'O-SCRIPT-NEIGHBOR', target: 'NEIGHBOR', timeoutSec: 25 },
  CALL_112: { label: 'O-STEP-112', script: 'O-SCRIPT-112', target: 'EMERGENCY', timeoutSec: 0 },
};
/** packages/rules/tr.yaml zincirleriyle aynı (tatbikatta kullanılan tipler). */
const CHAINS: Partial<Record<EventType, string[]>> = {
  SOS: ['CALL_WATCH', 'CALL_PHONE', 'CALL_CONTACT:1', 'CALL_112'],
  FALL: ['CALL_WATCH', 'CALL_PHONE', 'CALL_CONTACT:1', 'CALL_CONTACT:2', 'CALL_NEIGHBOR', 'CALL_112'],
  INACTIVITY: ['CALL_PHONE', 'CALL_WATCH', 'CALL_CONTACT:1', 'CALL_NEIGHBOR', 'CALL_112'],
};
const PRIORITY: Partial<Record<EventType, number>> = { SOS: 1, FALL: 1, INACTIVITY: 2 };
const OPEN: EventState[] = ['OPERATOR_ASSIGNED', 'CONTACT_CHAIN', 'CONFIRMED_OK', 'CONFIRMED_EMERGENCY', 'DISPATCH'];

const step = (entry: string, n: number): ChainStep => {
  const [kind, idx] = entry.split(':') as [string, string | undefined];
  const k = STEP[kind]!;
  return {
    n,
    kind,
    target: k.target,
    label: k.label,
    script: k.script,
    timeoutSec: k.timeoutSec,
    required: true,
    ...(idx ? { contactIndex: Number(idx) } : {}),
  };
};

interface Drill {
  ev: EventRecord;
  steps: ChainStep[];
  person: { displayName: string; age: number };
  /** T-051 tatbikat araması: "Ara" → çalıyor → (ringMs) görüşme; operatör bitirince "Ulaşıldı" önerilir. */
  calls: CallView[];
}

export class TrainingSim {
  private readonly drills = new Map<string, Drill>();
  private listener?: LiveHandlers;
  private seq = 0;
  private timer?: ReturnType<typeof setInterval>;
  private status: OperatorStatus = 'AVAILABLE';

  constructor(
    private readonly me = 'egitim',
    private readonly ringMs = 1500,
  ) {}

  /** Başlangıç olayları + belirli aralıkla yeni olay (0 = kapalı). */
  start(everyMs = 45_000, initial: EventType[] = ['SOS', 'FALL', 'INACTIVITY']) {
    for (const type of initial) this.spawn(type);
    if (everyMs > 0)
      this.timer = setInterval(() => this.spawn((['SOS', 'FALL', 'INACTIVITY'] as const)[this.seq % 3]!), everyMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  spawn(type: EventType): string {
    const n = ++this.seq;
    const now = new Date().toISOString();
    const id = `egitim-${n}`;
    const ev: EventRecord = {
      id,
      protectedPersonId: `egitim-kisi-${n}`,
      type,
      priority: PRIORITY[type] ?? 3,
      state: 'OPERATOR_QUEUE',
      createdAt: now,
      escalatedAt: now,
      isTest: false,
      location: { lat: 41.0 + n / 1000, lng: 29.0 + n / 1000 },
      transitions: [
        { to: 'CREATED', actorKind: 'SYSTEM', at: now },
        { from: 'CREATED', to: 'ESCALATED', actorKind: 'SYSTEM', at: now },
        { from: 'ESCALATED', to: 'OPERATOR_QUEUE', actorKind: 'SYSTEM', at: now },
      ],
    };
    const drill = {
      ev,
      steps: [],
      calls: [],
      person: { displayName: t('O-UI-TRAINING-PERSON', { n }), age: 70 + (n % 20) },
    };
    this.drills.set(id, drill);
    this.emit({ type: 'upsert', item: this.item(drill) });
    return id;
  }

  connect(h: LiveHandlers): () => void {
    this.listener = h;
    h.onStatus(true);
    h.onMessage({ type: 'ready', user: { sub: this.me, roles: ['OPERATOR'] } });
    const items = [...this.drills.values()].filter((d) => d.ev.state !== 'CLOSED').map((d) => this.item(d));
    h.onMessage({ type: 'snapshot', items, total: items.length });
    return () => {
      if (this.listener === h) this.listener = undefined;
    };
  }

  readonly api: Api = {
    queue: async () => {
      const items = [...this.drills.values()].filter((d) => d.ev.state !== 'CLOSED').map((d) => this.item(d));
      return { items, total: items.length };
    },
    event: async (id) => this.view(this.get(id)),
    claim: async (id) => {
      const d = this.get(id);
      if (d.ev.state === 'OPERATOR_QUEUE') {
        d.ev.operatorId = this.me;
        this.go(d, 'OPERATOR_ASSIGNED');
        if (!d.steps.length) d.steps = (CHAINS[d.ev.type] ?? ['CALL_PHONE']).map((e, i) => step(e, i + 1));
      } else if (d.ev.operatorId !== this.me) throw new ApiError(409, 'Başka operatör üstlendi');
      return this.changed(d);
    },
    heartbeat: async () => ({}),
    call: async (id, n) => {
      const d = this.mine(id);
      const s = this.current(d, n);
      s.calledAt ??= new Date().toISOString();
      if (d.ev.state === 'OPERATOR_ASSIGNED') this.go(d, 'CONTACT_CHAIN');
      if (s.target !== 'EMERGENCY' && !d.calls.some((c) => c.stepN === n && CALL_ACTIVE.includes(c.status)))
        this.ring(d, n);
      return this.changed(d);
    },
    scriptRead: async (id, n) => {
      const d = this.mine(id);
      const s = d.steps.find((x) => x.n === n);
      if (s) s.scriptReadAt = new Date().toISOString();
      return this.view(d);
    },
    result: async (id, n, b: StepResultBody) => {
      const d = this.mine(id);
      const s = this.current(d, n);
      if (b.result === 'SKIPPED' && !b.reason?.trim()) throw new ApiError(400, 'Atlama gerekçe ister');
      for (const c of d.calls.filter((x) => x.stepN === n)) this.end(c);
      Object.assign(s, {
        result: b.result,
        assessment: b.assessment,
        note: b.note,
        reason: b.reason,
        completedAt: new Date().toISOString(),
      });
      if (d.ev.state === 'OPERATOR_ASSIGNED') this.go(d, 'CONTACT_CHAIN');
      if (s.kind === 'CALL_112') {
        if (b.result === 'REACHED') {
          if (d.ev.state !== 'CONFIRMED_EMERGENCY') this.go(d, 'CONFIRMED_EMERGENCY');
          this.go(d, 'DISPATCH');
        } else d.steps.push(step('CALL_112', d.steps.length + 1));
      } else if (b.result === 'REACHED' && b.assessment === 'OK') {
        this.go(d, 'CONFIRMED_OK');
        this.skipPending(d, 'resolved');
      } else if (b.result === 'REACHED' && b.assessment === 'EMERGENCY') {
        this.go(d, 'CONFIRMED_EMERGENCY');
        this.toEmergency(d, 'emergency');
      }
      return this.changed(d);
    },
    escalate: async (id, reason) => {
      const d = this.mine(id);
      if (d.ev.state === 'OPERATOR_ASSIGNED' || d.ev.state === 'CONTACT_CHAIN') this.go(d, 'CONFIRMED_EMERGENCY');
      this.toEmergency(d, 'escalate', reason);
      return this.changed(d);
    },
    // Eğitim kişileri kurgudur: tıbbi özet yok (operatör "kayıtlı değil" görmeyi de öğrenir).
    personCard: async (id): Promise<PersonCard | null> => {
      const d = this.mine(id);
      return { ...d.person, address: null, location: d.ev.location ?? null, doorAccessNote: null, medical: null };
    },
    dispatchScript: async (id): Promise<DispatchScript> => {
      const d = this.mine(id);
      const unknown = t('O-UI-UNKNOWN');
      const loc = d.ev.location;
      const fields = {
        type: t(`O-TYPE-${d.ev.type}`),
        name: d.person.displayName,
        age: String(d.person.age),
        address: loc ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : unknown,
        conditions: unknown,
        medications: unknown,
        allergies: unknown,
        doorNote: unknown,
      };
      return { kind: 'dispatch112', code: 'O-SCRIPT-112', fields, text: t('O-SCRIPT-112', fields) };
    },
    telephonyToken: async () => ({
      provider: 'fake' as const,
      identity: this.me,
      token: 'egitim',
      ttlSec: 3600,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    telephonyConfig: async () => ({ softphone: true, inbound: false, deskLine: null, emergencyNumber: '112' }),
    // Eğitimde durum yerel (gelen arama yönlendirmesi yok).
    myStatus: async () => ({ subject: this.me, status: this.status, statusAt: null }),
    setMyStatus: async (status) => {
      this.status = status;
      return { subject: this.me, status, statusAt: new Date().toISOString() };
    },
    hold: async (callId, on) => {
      const c = this.talking(callId);
      Object.assign(c, { held: on, conference: true });
      return { ...c };
    },
    conference: async (callId) => {
      const c = this.talking(callId);
      Object.assign(c, { conference: true, parties: (c.parties ?? 0) + 1 });
      return { ...c };
    },
    hangup: async (callId) => {
      const c = this.callOf(callId).call;
      this.end(c);
      return { ...c };
    },
    // T-089 cihaz şeridi: tatbikat kişisinin sahte saati ve telefonu; komutlar hiçbir cihaza gitmez.
    coverage: async () => trainingCoverage(Date.now()),
    deviceCommand: async (_id, type, eventId) => ({ type, eventId: eventId ?? null, sent: true, outcome: 'sent' }),
    // T-092: tatbikatta değer grafiği yok (değer olayı açılmaz).
    vitals: async () => {
      throw new ApiError(404, 'Eğitim modunda değer yok');
    },
    supervisorCoverage: async () => {
      throw new ApiError(404, 'Eğitim modunda amir panosu yok');
    },
    coverageBoard: async () => {
      throw new ApiError(404, 'Eğitim modunda amir panosu yok');
    },
    // Amir panosu eğitim modunda yok (T-074).
    dashboard: async () => {
      throw new ApiError(404, 'Eğitim modunda amir panosu yok');
    },
    setOperatorStatus: async () => {
      throw new ApiError(404, 'Eğitim modunda amir panosu yok');
    },
    setOverflow: async () => {
      throw new ApiError(404, 'Eğitim modunda amir panosu yok');
    },
    unclaim: async () => {
      throw new ApiError(404, 'Eğitim modunda amir panosu yok');
    },
    // T-085 OEM: ortak gecikmesi ve kolye iş emirleri eğitim modunda yok (amir panosu yok).
    supervisorPartners: async () => [],
    workOrders: async () => [],
    completeWorkOrder: async () => {
      throw new ApiError(404, 'Eğitim modunda amir panosu yok');
    },
    // 112 süreç takibi eğitim modunda yok (gerçek 112 aranmaz).
    dispatch: async () => {
      throw new ApiError(404, 'Eğitim modunda 112 süreci yok');
    },
    updateDispatch: async () => {
      throw new ApiError(404, 'Eğitim modunda 112 süreci yok');
    },
    dispatches: async () => [],
    // Yönetim paneli eğitim modunda yok.
    adminCalls: async () => [],
    adminAnalytics: async () => {
      throw new ApiError(404, 'Eğitim modunda yönetim paneli yok');
    },
    adminHealth: async () => {
      throw new ApiError(404, 'Eğitim modunda yönetim paneli yok');
    },
    adminCoverageMetrics: async () => {
      throw new ApiError(404, 'Eğitim modunda yönetim paneli yok');
    },
    adminAudit: async () => [],
    adminEvents: async () => [],
    adminCase: async () => {
      throw new ApiError(404, 'Eğitim modunda vaka dosyası yok');
    },
    wellnessChecks: async () => [],
    alerts: async () => [],
    ackAlert: async () => {
      throw new ApiError(404, 'Eğitim modunda amir uyarısı yok');
    },
    pushConfig: async () => ({ enabled: false, publicKey: null }),
    pushSubscribe: async () => ({ enabled: false }),
    pushUnsubscribe: async () => undefined,
    recordingUrl: async () => {
      throw new ApiError(404, 'Eğitim modunda kayıt yok');
    },
    close: async (id, outcome: CloseOutcome) => {
      const d = this.mine(id);
      const emergency = outcome === 'EMERGENCY';
      if ((d.ev.state === 'CONFIRMED_EMERGENCY' || d.ev.state === 'DISPATCH') && !emergency)
        throw new ApiError(409, 'Acil teyitli olay yalnız EMERGENCY ile kapanır');
      if (d.ev.state === 'CONFIRMED_OK' && emergency) throw new ApiError(409, 'Olay iyi olarak teyit edildi');
      this.skipPending(d, 'closed');
      for (const c of d.calls) this.end(c);
      d.ev.state = 'CLOSED';
      this.emit({ type: 'remove', eventId: d.ev.id });
    },
  };

  // ---- iç ----
  private ring(d: Drill, n: number) {
    const c: CallView = {
      id: `${d.ev.id}-arama-${d.calls.length + 1}`,
      stepN: n,
      status: 'ringing',
      answered: false,
      suggestedResult: null,
      durationSec: null,
      recorded: false,
      conference: false,
      held: false,
      parties: 0,
      error: null,
      createdAt: new Date().toISOString(),
    };
    d.calls.push(c);
    setTimeout(() => {
      if (c.status === 'ringing') Object.assign(c, { status: 'in-progress', answered: true });
    }, this.ringMs);
  }
  private end(c: CallView) {
    if (!CALL_ACTIVE.includes(c.status)) return;
    const sec = Math.max(0, Math.round((Date.now() - Date.parse(c.createdAt)) / 1000));
    Object.assign(
      c,
      c.answered
        ? { status: 'completed', suggestedResult: 'REACHED', durationSec: sec, held: false }
        : { status: 'canceled', suggestedResult: null, held: false },
    );
  }
  private callOf(callId: string): { d: Drill; call: CallView } {
    for (const d of this.drills.values()) {
      const call = d.calls.find((c) => c.id === callId);
      if (call) {
        if (d.ev.operatorId !== this.me) throw new ApiError(403, 'Arama başka operatörde');
        return { d, call };
      }
    }
    throw new ApiError(404, 'Arama yok');
  }
  private talking(callId: string): CallView {
    const { call } = this.callOf(callId);
    if (call.status !== 'in-progress') throw new ApiError(409, 'Görüşme sürmüyor');
    return call;
  }
  private get(id: string): Drill {
    const d = this.drills.get(id);
    if (!d) throw new ApiError(404, 'Olay yok');
    return d;
  }
  private mine(id: string): Drill {
    const d = this.get(id);
    if (d.ev.operatorId !== this.me || !OPEN.includes(d.ev.state)) throw new ApiError(409, 'Olay sizde değil');
    return d;
  }
  private current(d: Drill, n: number): ChainStep {
    const s = d.steps.find((x) => !x.result);
    if (!s || s.n !== n) throw new ApiError(409, 'Sıra dışı adım');
    return s;
  }
  private go(d: Drill, to: EventState) {
    d.ev.transitions.push({
      from: d.ev.state,
      to,
      actorKind: 'OPERATOR',
      actorId: this.me,
      at: new Date().toISOString(),
    });
    d.ev.state = to;
  }
  private skipPending(d: Drill, reason: string, note?: string) {
    for (const s of d.steps.filter((x) => !x.result)) Object.assign(s, { result: 'SKIPPED', reason, note });
  }
  private toEmergency(d: Drill, reason: string, note?: string) {
    for (const s of d.steps.filter((x) => !x.result && x.kind !== 'CALL_112'))
      Object.assign(s, { result: 'SKIPPED', reason, note });
    if (!d.steps.some((x) => !x.result && x.kind === 'CALL_112')) d.steps.push(step('CALL_112', d.steps.length + 1));
  }
  private view(d: Drill): EventWithChain {
    const cur = d.steps.find((x) => !x.result);
    return {
      event: structuredClone(d.ev),
      chain: d.steps.length ? { procedureVersion: 0, steps: structuredClone(d.steps), current: cur?.n ?? null } : null,
      calls: structuredClone(d.calls),
    };
  }
  private changed(d: Drill): EventWithChain {
    this.emit({ type: 'upsert', item: this.item(d) });
    return this.view(d);
  }
  private item(d: Drill): QueueItem {
    return {
      eventId: d.ev.id,
      type: d.ev.type,
      priority: d.ev.priority,
      state: d.ev.state,
      createdAt: d.ev.createdAt,
      escalatedAt: d.ev.escalatedAt ?? null,
      lockedBy: d.ev.operatorId ?? null,
      lockUntil: null,
      isTest: false,
      person: d.person,
    };
  }
  private emit(m: ServerMessage) {
    this.listener?.onMessage(m);
  }
}

export function trainingBackend(): Backend {
  const sim = new TrainingSim();
  sim.start();
  return { api: sim.api, connect: (h) => sim.connect(h) };
}

/** Eğitim modu (T-089): tatbikat kişisinin cihazları — takılı saat ve telefon, tam kapsama. */
function trainingCoverage(now: number): CoverageView {
  const seen = new Date(now - 2 * 60_000).toISOString();
  const base = {
    bodyLocation: null,
    nickname: null,
    online: true,
    lastSeenAt: seen,
    charging: false,
    chargingSince: null,
    voiceOrderManual: false,
  };
  return {
    level: 'FULL',
    since: seen,
    reasons: [],
    capabilities: { sos: true, fall: true, voice: true, location: true },
    devices: [
      {
        ...base,
        id: 'training-watch',
        kind: 'WEAROS_WATCH',
        category: 'WATCH',
        tier: 'A',
        bodyLocation: 'WRIST_LEFT',
        batteryPct: 64,
        onBody: true,
        estimatedHoursLeft: 25.6,
        voiceOrder: 1,
      },
      {
        ...base,
        id: 'training-phone',
        kind: 'ANDROID_PHONE',
        category: 'PHONE',
        tier: 'A',
        batteryPct: 81,
        onBody: null,
        estimatedHoursLeft: null,
        voiceOrder: 2,
      },
    ],
  };
}
