import type {
  AdminCoverageMetrics,
  ChainView,
  CoverageView,
  EventState,
  EventType,
  LadderView,
  PartnerHealth,
  StepAssessment,
  StepResult,
  SupervisorCoverage,
  SupervisorCoverageBoard,
  WorkOrder,
} from '@yanimda/contracts';

export interface QueueItem {
  eventId: string;
  type: EventType;
  priority: number;
  state: EventState;
  createdAt: string;
  escalatedAt: string | null;
  lockedBy: string | null;
  lockUntil: string | null;
  isTest: boolean;
  person: { displayName: string; age: number | null } | null;
}

export interface Transition {
  from?: EventState;
  to: EventState;
  actorKind: string;
  actorId?: string;
  at: string;
  note?: string;
}

export interface EventRecord {
  id: string;
  protectedPersonId: string;
  type: EventType;
  priority: number;
  state: EventState;
  createdAt: string;
  escalatedAt?: string;
  operatorId?: string;
  lockUntil?: string;
  isTest: boolean;
  /** T-088/T-089 (S3.7, S7.1): birleştirilmiş konum; `at` konumun anı, `source` GPS / ağ / telefon. */
  location?: {
    lat: number;
    lng: number;
    accuracyM?: number;
    source?: 'GPS' | 'NETWORK' | 'PHONE';
    at?: string;
  } | null;
  /** Kaynak sinyal / zamanlayıcı kimlikleri (ör. `wellness:<id>` düzenli arama). */
  sourceSignalIds?: string[];
  /** T-088: olayı bildiren cihazlar ve iptal eden cihaz (cihaz şeridinde rozet). */
  sourceDeviceIds?: string[];
  cancelledByDeviceId?: string;
  transitions: Transition[];
}

/** T-040 olay anında kişi kartı: yalnız olayı yürüten operatöre; tıbbi özet burada çözülür (sunucu audit'e yazar). */
export interface PersonCard {
  displayName: string;
  age: number | null;
  address: string | null;
  location: { lat: number; lng: number } | null;
  doorAccessNote: string | null;
  /** T-089 (S7.7): aynı adreste etkin başka korunan kişi (yalnız ad ve açık olayı; sağlık verisi yok). */
  sameAddress?: { protectedPersonId: string; displayName: string; openEventId: string | null }[];
  medical: {
    conditions: string[];
    medications: string[];
    allergies: string[];
    bloodType: string | null;
    notes: string | null;
  } | null;
}

export type CallStatus =
  'queued' | 'ringing' | 'in-progress' | 'completed' | 'busy' | 'no-answer' | 'failed' | 'canceled';
/** T-050 CPaaS araması (numarasız). */
export interface CallView {
  id: string;
  stepN: number;
  status: CallStatus;
  answered: boolean;
  suggestedResult: 'REACHED' | 'NO_ANSWER' | 'BUSY' | 'WRONG_NUMBER' | null;
  durationSec: number | null;
  recorded: boolean;
  /** T-051: görüşme konferansta, aranan beklemede, konferansa eklenen yakın sayısı. */
  conference?: boolean;
  held?: boolean;
  parties?: number;
  error: string | null;
  createdAt: string;
}
/** T-051 `GET /v1/telephony/token`: yazılım telefonu (Twilio Voice) token'ı; sahte sağlayıcıda sahte. */
export interface VoiceToken {
  provider: 'twilio' | 'fake';
  identity: string;
  token: string;
  ttlSec: number;
  expiresAt: string;
}
export const CALL_ACTIVE: CallStatus[] = ['queued', 'ringing', 'in-progress'];

export interface EventWithChain {
  event: EventRecord;
  chain: ChainView | null;
  calls?: CallView[];
  /** T-087/T-088: 112 son sınırı, "2 cihaz", olası acil durum, Apple akışı. */
  ladder?: LadderView;
}

export type CloseOutcome = 'OK' | 'EMERGENCY' | 'FALSE_ALARM' | 'TEST' | 'UNREACHABLE';
export interface StepResultBody {
  result: StepResult;
  assessment?: StepAssessment;
  note?: string;
  reason?: string;
}

export interface DispatchScript {
  kind: 'dispatch112';
  code: string;
  fields: Record<string, string>;
  text: string;
}

/** T-074 amir panosu (`GET /v1/supervisor/dashboard`; canlıda WS `dashboard` mesajı, 5 sn). */
export type OperatorStatus = 'AVAILABLE' | 'BREAK' | 'OFFLINE';
/** Operatörün kendi seçebildiği durumlar (konsol üst barı); OFFLINE amir işidir. */
export type SelfStatus = 'AVAILABLE' | 'BREAK';
export const SELF_STATUSES: SelfStatus[] = ['AVAILABLE', 'BREAK'];
export interface MyStatus {
  subject: string;
  status: OperatorStatus;
  statusAt: string | null;
}
/** T-052: masa sabit hattı (ulusal gösterim) ve 112; yazılım telefonu ve gelen arama açık mı. */
export interface TelephonyConfig {
  softphone: boolean;
  inbound: boolean;
  deskLine: string | null;
  emergencyNumber: string;
}
export const OPERATOR_STATUSES: OperatorStatus[] = ['AVAILABLE', 'BREAK', 'OFFLINE'];
export interface OperatorCard {
  subject: string;
  name: string | null;
  status: OperatorStatus;
  online: boolean;
  lastSeenAt: string | null;
  open: { eventId: string; type: EventType; priority: number; state: EventState; since: string }[];
  claims24h: number;
  avgClaimSec: number | null;
  closed24h: number;
}
export interface SlaBreach {
  eventId: string;
  type: EventType;
  priority: number;
  kind: 'CLAIM' | 'FIRST_CALL';
  live: boolean;
  waitedSec: number;
  at: string;
  operatorId: string | null;
}
export interface SupervisorDashboard {
  at: string;
  queue: { priority: number; waiting: number; oldestWaitSec: number | null }[];
  inProgress: number;
  activeOperators: number;
  last24h: {
    closed: number;
    byOutcome: Record<string, number>;
    falseAlarmRatio: number;
    claim: { count: number; p50Sec: number | null; p95Sec: number | null; overSlaCount: number };
  };
  falseAlarms: {
    windowDays: number;
    closedEvents: number;
    falseAlarms: number;
    ratio: number;
    byCause: Record<string, number>;
    repeatPersons: number;
  };
  queueDepth24h: { at: string; depth: number; entered: number }[];
  byType24h: Record<string, number>;
  operators: OperatorCard[];
  slaBreaches: SlaBreach[];
  sla: { claimSec: number; firstCallSec: number };
  overflow: { enabled: boolean; changedAt: string | null; changedBy: string | null };
  inbound: {
    queued: number;
    ringing: number;
    oldestQueuedSec: number | null;
    calls: {
      id: string;
      status: 'routing' | 'ringing' | 'queued';
      eventId: string | null;
      person: string | null;
      operatorId: string | null;
      waitSec: number;
    }[];
  };
}

/** 112 bildirim ve intikal takibi. */
export const DISPATCH_STAGES = [
  'NOTIFIED',
  'ACCEPTED',
  'EN_ROUTE',
  'ON_SCENE',
  'TRANSPORTING',
  'AT_HOSPITAL',
  'COMPLETED',
] as const;
export type DispatchStage = (typeof DISPATCH_STAGES)[number] | 'CANCELLED';
export type DispatchSource = 'OPERATOR' | 'EMS' | 'FAMILY' | 'SYSTEM';
export interface DispatchView {
  eventId: string;
  protectedPersonId: string;
  status: DispatchStage;
  notifiedAt: string;
  notifiedBy: string | null;
  caseRef: string | null;
  etaMin: number | null;
  hospital: string | null;
  stages: Partial<Record<DispatchStage, string>>;
  arrivalMin: number | null;
  arrivalLate: boolean;
  open: boolean;
  checks: number;
  followUps?: number;
  timeline: {
    status: DispatchStage;
    at: string;
    actorKind: string;
    actorId: string | null;
    source: DispatchSource;
    note: string | null;
  }[];
}
export interface DispatchUpdate {
  status?: DispatchStage;
  caseRef?: string | null;
  etaMin?: number | null;
  hospital?: string | null;
  note?: string;
  source?: Exclude<DispatchSource, 'SYSTEM'>;
  followUp?: boolean;
}

/** Yönetim paneli. */
export interface AdminCall {
  id: string;
  direction: 'OUT' | 'IN';
  at: string;
  eventId: string | null;
  eventType: string | null;
  person: string | null;
  operatorId: string | null;
  operatorName: string | null;
  isTest: boolean;
  party: string;
  stepN: number | null;
  status: string;
  answered: boolean;
  durationSec: number | null;
  result: string | null;
  recording: boolean;
}
export interface AdminAnalytics {
  days: number;
  events: { total: number; real: number; byType: Record<string, number>; byOutcome: Record<string, number> };
  sla: {
    claimP50Sec: number | null;
    claimP95Sec: number | null;
    firstCallP50Sec: number | null;
    firstCallP95Sec: number | null;
  };
  calls: {
    total: number;
    answered: number;
    answerRate: number;
    avgTalkSec: number | null;
    byParty: Record<string, { total: number; answered: number }>;
  };
  inbound: { total: number; answered: number; abandoned: number; avgWaitSec: number | null };
  dispatch: {
    total: number;
    arrived: number;
    arrivalP50Min: number | null;
    arrivalP90Min: number | null;
    late: number;
    cancelled: number;
  };
  wellness: { planned: number; done: number; help: number; notified: number; missed: number };
  falseAlarmRatio: number;
  operators: {
    operatorId: string;
    claims: number;
    closed: number;
    calls: number;
    answered: number;
    avgClaimSec: number | null;
    avgHandleMin: number | null;
  }[];
  daily: { day: string; events: number; emergencies: number; calls: number }[];
}
export interface AdminHealth {
  at: string;
  outbox: {
    core: number;
    coreOldestSec: number | null;
    side: number;
    sideOldestSec: number | null;
    dlq: number;
    sideDead: number;
  };
  queue: { waiting: number; oldestSec: number | null };
  dispatch: { open: number; late: number };
  wellness: { missed24h: number };
  staffOnline: number;
}
export interface AuditRow {
  id: string;
  at: string;
  actorKind: string;
  actorId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  data: unknown;
}
export interface WellnessCheck {
  id: string;
  protectedPersonId: string;
  person: string | null;
  dueAt: string;
  windowUntil: string;
  channel: 'CALL' | 'NOTIFY' | 'BOTH';
  status: 'SCHEDULED' | 'IN_PROGRESS' | 'DONE_OK' | 'DONE_HELP' | 'NOTIFIED' | 'MISSED' | 'SKIPPED';
  eventId: string | null;
  operatorId: string | null;
  completedAt: string | null;
  outcome: string | null;
}

export interface SupervisorAlertView {
  id: string;
  code: string;
  eventId: string;
  eventType: string;
  operatorId: string | null;
  at: string;
  ackedAt: string | null;
  ackedBy: string | null;
}

export interface AdminCase {
  event: {
    id: string;
    type: string;
    priority: number;
    state: EventState;
    outcome: string | null;
    isTest: boolean;
    person: string | null;
    operatorId: string | null;
    createdAt: string | null;
    escalatedAt: string | null;
    closedAt: string | null;
    closeReason: string | null;
    signals: number;
  };
  transitions: {
    from: string | null;
    to: EventState;
    actorKind: string;
    actorId: string | null;
    at: string | null;
    note: string | null;
  }[];
  steps: {
    n: number;
    kind: string;
    contactIndex: number | null;
    result: string | null;
    assessment: string | null;
    reason: string | null;
    note: string | null;
    operatorId: string | null;
    calledAt: string | null;
    completedAt: string | null;
  }[];
  calls: AdminCall[];
  dispatch: {
    status: DispatchStage;
    caseRef: string | null;
    hospital: string | null;
    notifiedAt: string | null;
    onSceneAt: string | null;
    timeline: {
      status: DispatchStage;
      at: string | null;
      actorKind: string;
      actorId: string | null;
      source: DispatchSource;
      note: string | null;
    }[];
  } | null;
  notifications: {
    total: number;
    delivered: number;
    failed: number;
    items: {
      code: string;
      audience: string;
      recipientKind: string;
      channel: string;
      status: string;
      attempts: number;
      fallback: boolean;
      createdAt: string | null;
      sentAt: string | null;
      deliveredAt: string | null;
    }[];
  };
  wellness: { checkId: string; status: string; dueAt: string | null } | null;
  alerts: { code: string; at: string | null; ackedAt: string | null; ackedBy: string | null }[];
  audit: AuditRow[];
}

/** T-089 operatörün cihaz komutu (`POST /v1/devices/{id}/commands`). */
export type DeviceCommandType = 'RING' | 'PROMPT' | 'LOCATE' | 'TEST';
export interface DeviceCommandResult {
  type: DeviceCommandType;
  eventId: string | null;
  /** Cihaza ulaştı (doğrudan veya köprü telefon üzerinden). */
  sent: boolean;
  /** Teslim sonucu: sent, relayed, unsupported, no-token, unconfigured, retry … */
  outcome: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export type TokenSource = () => Promise<string | null>;

/** API istemcisi: her istekte güncel operatör token'ı; hata RFC 7807 → ApiError. */
export function createApi(token: TokenSource, base: string = import.meta.env.VITE_API_BASE || '/v1') {
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const t = await token();
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(t ? { authorization: `Bearer ${t}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const p = (await r.json().catch(() => ({}))) as { detail?: string; title?: string };
      throw new ApiError(r.status, p.detail ?? p.title ?? String(r.status));
    }
    return (r.status === 204 ? undefined : await r.json()) as T;
  }
  const ev = (id: string) => `/events/${encodeURIComponent(id)}`;
  const tc = (callId: string) => `/telephony/calls/${encodeURIComponent(callId)}`;
  return {
    queue: () => req<{ items: QueueItem[]; total: number }>('GET', '/queue?limit=200'),
    event: (id: string) => req<EventWithChain>('GET', ev(id)),
    claim: (id: string) => req<EventWithChain>('POST', `${ev(id)}/claim`),
    heartbeat: (id: string) => req<{ lockUntil?: string }>('POST', `${ev(id)}/heartbeat`),
    call: (id: string, n: number) => req<EventWithChain>('POST', `${ev(id)}/chain/steps/${n}/call`),
    scriptRead: (id: string, n: number) => req<EventWithChain>('POST', `${ev(id)}/chain/steps/${n}/script-read`),
    result: (id: string, n: number, b: StepResultBody) =>
      req<EventWithChain>('POST', `${ev(id)}/chain/steps/${n}/result`, b),
    escalate: (id: string, reason: string) => req<EventWithChain>('POST', `${ev(id)}/escalate-112`, { reason }),
    dispatchScript: (id: string) => req<DispatchScript>('GET', `${ev(id)}/script?kind=dispatch112`),
    personCard: (id: string) => req<PersonCard | null>('GET', `${ev(id)}/person`),
    close: (id: string, outcome: CloseOutcome, note?: string, followUpAfterHours?: number, notified112?: boolean) =>
      req<void>('POST', `${ev(id)}/close`, {
        outcome,
        ...(note ? { note } : {}),
        ...(followUpAfterHours ? { followUpAfterHours } : {}),
        ...(notified112 !== undefined ? { notified112 } : {}),
      }),
    telephonyToken: () => req<VoiceToken>('GET', '/telephony/token'),
    telephonyConfig: () => req<TelephonyConfig>('GET', '/telephony/config'),
    myStatus: () => req<MyStatus>('GET', '/operators/me'),
    setMyStatus: (status: SelfStatus) => req<MyStatus>('PUT', '/operators/me/status', { status }),
    hold: (callId: string, on: boolean) => req<CallView>('POST', `${tc(callId)}/hold`, { on }),
    conference: (callId: string, contactIndex = 1) =>
      req<CallView>('POST', `${tc(callId)}/conference`, { contactIndex }),
    hangup: (callId: string) => req<CallView>('POST', `${tc(callId)}/hangup`),
    /** T-085/T-089: kişinin kapsaması ve cihaz kartları (olay ekranı cihaz şeridi). */
    coverage: (personId: string) =>
      req<CoverageView>('GET', `/protected-persons/${encodeURIComponent(personId)}/coverage`),
    deviceCommand: (deviceId: string, type: DeviceCommandType, eventId?: string) =>
      req<DeviceCommandResult>('POST', `/devices/${encodeURIComponent(deviceId)}/commands`, {
        type,
        ...(eventId ? { eventId } : {}),
      }),
    supervisorCoverage: () => req<SupervisorCoverage>('GET', '/supervisor/coverage'),
    /** T-089 (S7.2) amir kapsama panosu listeleri. */
    coverageBoard: () => req<SupervisorCoverageBoard>('GET', '/supervisor/coverage/board'),
    dashboard: () => req<SupervisorDashboard>('GET', '/supervisor/dashboard'),
    setOperatorStatus: (sub: string, status: OperatorStatus) =>
      req<{ subject: string; status: OperatorStatus }>(
        'PUT',
        `/supervisor/operators/${encodeURIComponent(sub)}/status`,
        { status },
      ),
    setOverflow: (enabled: boolean) => req<SupervisorDashboard['overflow']>('PUT', '/supervisor/overflow', { enabled }),
    unclaim: (id: string) => req<{ eventId: string; state: EventState }>('POST', `${ev(id)}/unclaim`, {}),
    dispatch: (id: string) => req<DispatchView>('GET', `${ev(id)}/dispatch`),
    updateDispatch: (id: string, b: DispatchUpdate) => req<DispatchView>('POST', `${ev(id)}/dispatch`, b),
    dispatches: (open = true) => req<DispatchView[]>('GET', `/events/dispatches${open ? '?open=1' : ''}`),
    adminCalls: (days: number, answered?: boolean) =>
      req<AdminCall[]>('GET', `/admin/calls?days=${days}${answered === undefined ? '' : `&answered=${answered}`}`),
    adminAnalytics: (days: number) => req<AdminAnalytics>('GET', `/admin/analytics?days=${days}`),
    /** T-085 (S7.3) kapsama ve cihaz ölçüleri (yalnız toplamlar). */
    adminCoverageMetrics: (days: number) =>
      req<AdminCoverageMetrics>('GET', `/admin/coverage-metrics?days=${Math.min(days, 90)}`),
    adminHealth: () => req<AdminHealth>('GET', '/admin/health'),
    adminEvents: (days: number, q?: string) =>
      req<
        {
          id: string;
          type: string;
          priority: number;
          state: EventState;
          outcome: string | null;
          isTest: boolean;
          createdAt: string;
          closedAt: string | null;
          operatorId: string | null;
          person: string | null;
          dispatch: DispatchStage | null;
        }[]
      >('GET', `/admin/events?days=${days}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    adminCase: (id: string) => req<AdminCase>('GET', `/admin/events/${encodeURIComponent(id)}/case`),
    alerts: (open = true) => req<SupervisorAlertView[]>('GET', `/supervisor/alerts${open ? '?open=1' : ''}`),
    ackAlert: (id: string) => req<SupervisorAlertView>('POST', `/supervisor/alerts/${encodeURIComponent(id)}/ack`, {}),
    // T-085 OEM (S2.7, S4.9): ortak gecikmesi ve kolye pili iş emirleri (amir).
    supervisorPartners: () => req<PartnerHealth[]>('GET', '/supervisor/partners'),
    workOrders: (status: 'OPEN' | 'DONE' = 'OPEN') =>
      req<WorkOrder[]>('GET', `/supervisor/work-orders?status=${status}`),
    completeWorkOrder: (id: string) =>
      req<WorkOrder>('POST', `/supervisor/work-orders/${encodeURIComponent(id)}/done`, {}),
    pushConfig: () => req<{ enabled: boolean; publicKey: string | null }>('GET', '/push/web/config'),
    pushSubscribe: (sub: PushSubscriptionJSON) => req<{ enabled: boolean }>('POST', '/push/web/subscriptions', sub),
    pushUnsubscribe: (endpoint: string) => req<void>('DELETE', '/push/web/subscriptions', { endpoint }),
    adminAudit: (days: number, action?: string) =>
      req<AuditRow[]>('GET', `/admin/audit?days=${days}${action ? `&action=${encodeURIComponent(action)}` : ''}`),
    wellnessChecks: (days: number) => req<WellnessCheck[]>('GET', `/wellness/checks?days=${days}`),
    /** Ses kaydı (denetimli): Blob URL; çağıran URL.revokeObjectURL ile bırakır. */
    recordingUrl: async (callId: string, reason: string) => {
      const t = await token();
      const r = await fetch(
        `${base}/admin/calls/${encodeURIComponent(callId)}/recording?reason=${encodeURIComponent(reason)}`,
        {
          headers: t ? { authorization: `Bearer ${t}` } : {},
        },
      );
      if (!r.ok) throw new ApiError(r.status, String(r.status));
      return URL.createObjectURL(await r.blob());
    },
  };
}
export type Api = ReturnType<typeof createApi>;

/** WebSocket adresi (aynı köken veya VITE_API_BASE). */
export function queueSocketUrl(base: string = import.meta.env.VITE_API_BASE || '/v1'): string {
  const u = new URL(`${base}/ws/queue`, window.location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}
