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

export interface EventWithChain {
  event: EventRecord;
  chain: ChainView | null;
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
    close: (id: string, outcome: CloseOutcome, note?: string, followUpAfterHours?: number) =>
      req<void>('POST', `${ev(id)}/close`, {
        outcome,
        ...(note ? { note } : {}),
        ...(followUpAfterHours ? { followUpAfterHours } : {}),
      }),
  };
}
export type Api = ReturnType<typeof createApi>;

/** WebSocket adresi (aynı köken veya VITE_API_BASE). */
export function queueSocketUrl(base: string = import.meta.env.VITE_API_BASE || '/v1'): string {
  const u = new URL(`${base}/ws/queue`, window.location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}
