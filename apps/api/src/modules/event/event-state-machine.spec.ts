import { describe, expect, it } from 'vitest';

import { assertTransition, canTransition, InvalidTransitionError, TRANSITIONS } from './event-state-machine';

describe('EventStateMachine (D-10, 03 Kritik akışlar)', () => {
  it('düşme teyitsiz: CREATED → DEVICE_PROMPT → ESCALATED → OPERATOR_QUEUE → OPERATOR_ASSIGNED → CONTACT_CHAIN → CONFIRMED_EMERGENCY → DISPATCH → FOLLOW_UP → CLOSED', () => {
    const path = [
      'CREATED',
      'DEVICE_PROMPT',
      'ESCALATED',
      'OPERATOR_QUEUE',
      'OPERATOR_ASSIGNED',
      'CONTACT_CHAIN',
      'CONFIRMED_EMERGENCY',
      'DISPATCH',
      'FOLLOW_UP',
      'CLOSED',
    ] as const;
    for (let i = 1; i < path.length; i++) expect(assertTransition(path[i - 1], path[i])).toBe(path[i]);
  });
  it('yanlış alarm: DEVICE_PROMPT → CANCELLED_BY_USER → CLOSED', () => {
    expect(canTransition('DEVICE_PROMPT', 'CANCELLED_BY_USER')).toBe(true);
    expect(canTransition('CANCELLED_BY_USER', 'CLOSED')).toBe(true);
  });
  it('SOS cihaz sorusunu atlar: CREATED → ESCALATED', () => {
    expect(canTransition('CREATED', 'ESCALATED')).toBe(true);
  });
  it('geçersiz geçişler hata fırlatır', () => {
    expect(() => assertTransition('CLOSED', 'CREATED')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('CREATED', 'DISPATCH')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('CANCELLED_BY_USER', 'OPERATOR_QUEUE')).toThrow(InvalidTransitionError);
  });
  it('operatör kilidi düşünce olay kuyruğa döner: OPERATOR_ASSIGNED → OPERATOR_QUEUE', () => {
    expect(canTransition('OPERATOR_ASSIGNED', 'OPERATOR_QUEUE')).toBe(true);
  });
  it('her durumun en az bir çıkışı var (CLOSED hariç)', () => {
    for (const [s, outs] of Object.entries(TRANSITIONS)) if (s !== 'CLOSED') expect(outs.length).toBeGreaterThan(0);
  });
});
