import type { ChainView, EventState, EventType, StepAssessment, StepResult } from '@yanimda/contracts';

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
  location?: { lat: number; lng: number } | null;
  transitions: Transition[];
}

/** T-040 olay anında kişi kartı: yalnız olayı yürüten operatöre; tıbbi özet burada çözülür (sunucu audit'e yazar). */
export interface PersonCard {
  displayName: string;
  age: number | null;
  address: string | null;
  location: { lat: number; lng: number } | null;
  doorAccessNote: string | null;
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
    close: (id: string, outcome: CloseOutcome, note?: string, followUpAfterHours?: number) =>
      req<void>('POST', `${ev(id)}/close`, {
        outcome,
        ...(note ? { note } : {}),
        ...(followUpAfterHours ? { followUpAfterHours } : {}),
      }),
    telephonyToken: () => req<VoiceToken>('GET', '/telephony/token'),
    hold: (callId: string, on: boolean) => req<CallView>('POST', `${tc(callId)}/hold`, { on }),
    conference: (callId: string, contactIndex = 1) =>
      req<CallView>('POST', `${tc(callId)}/conference`, { contactIndex }),
    hangup: (callId: string) => req<CallView>('POST', `${tc(callId)}/hangup`),
    dashboard: () => req<SupervisorDashboard>('GET', '/supervisor/dashboard'),
    setOperatorStatus: (sub: string, status: OperatorStatus) =>
      req<{ subject: string; status: OperatorStatus }>(
        'PUT',
        `/supervisor/operators/${encodeURIComponent(sub)}/status`,
        { status },
      ),
    setOverflow: (enabled: boolean) => req<SupervisorDashboard['overflow']>('PUT', '/supervisor/overflow', { enabled }),
    unclaim: (id: string) => req<{ eventId: string; state: EventState }>('POST', `${ev(id)}/unclaim`, {}),
  };
}
export type Api = ReturnType<typeof createApi>;

/** WebSocket adresi (aynı köken veya VITE_API_BASE). */
export function queueSocketUrl(base: string = import.meta.env.VITE_API_BASE || '/v1'): string {
  const u = new URL(`${base}/ws/queue`, window.location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}
