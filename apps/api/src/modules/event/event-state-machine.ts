import type { EventState } from '@yanimda/contracts';

/** 02-prd.md Modül D "Durum makinesi" ve 03-teknik-mimari.md "Kritik akışlar". Saf fonksiyon; test edilir. */
export const TRANSITIONS: Record<EventState, EventState[]> = {
  CREATED: ['DEVICE_PROMPT', 'ESCALATED'],
  DEVICE_PROMPT: ['CANCELLED_BY_USER', 'ESCALATED'],
  CANCELLED_BY_USER: ['CLOSED'],
  ESCALATED: ['OPERATOR_QUEUE'],
  OPERATOR_QUEUE: ['OPERATOR_ASSIGNED'],
  OPERATOR_ASSIGNED: ['CONTACT_CHAIN', 'CONFIRMED_OK', 'CONFIRMED_EMERGENCY', 'OPERATOR_QUEUE'],
  CONTACT_CHAIN: ['CONFIRMED_OK', 'CONFIRMED_EMERGENCY', 'CLOSED', 'OPERATOR_QUEUE'], // kuyruk: kilit düştü (D-04)
  CONFIRMED_OK: ['CLOSED'],
  CONFIRMED_EMERGENCY: ['DISPATCH'],
  DISPATCH: ['FOLLOW_UP', 'CLOSED'],
  FOLLOW_UP: ['CLOSED'],
  CLOSED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: EventState,
    public readonly to: EventState,
  ) {
    super(`Geçersiz geçiş: ${from} -> ${to}`);
  }
}

export function canTransition(from: EventState, to: EventState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: EventState, to: EventState): EventState {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

export const isTerminal = (s: EventState) => s === 'CLOSED';
