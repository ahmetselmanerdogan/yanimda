// 03-teknik-mimari.md "Sinyal ve olay şemaları" ile birebir; şema dosyaları schemas/ altındadır.
export type SignalKind =
  | 'SOS'
  | 'FALL'
  | 'CANCEL'
  | 'OK'
  | 'HEART_RATE'
  | 'STEPS'
  | 'INACTIVITY'
  | 'OFF_BODY'
  | 'ON_BODY'
  | 'BATTERY'
  | 'LOCATION'
  | 'HEARTBEAT'
  | 'CALLBACK_REQUEST'
  | 'TEST';

export interface Signal {
  schemaVersion: 1;
  idempotencyKey: string;
  deviceId: string;
  protectedPersonId: string;
  kind: SignalKind;
  occurredAt: string;
  receivedAt?: string | null;
  value?: number | null;
  location?: { lat: number; lng: number; accuracyM?: number; source?: 'GPS' | 'NETWORK' | 'PHONE' } | null;
  device?: {
    batteryPct?: number;
    onWrist?: boolean;
    connectivity?: 'BLE' | 'LTE' | 'WIFI' | 'NONE';
    appVersion?: string;
  };
  payload?: Record<string, unknown>;
}

export type EventType =
  | 'SOS'
  | 'FALL'
  | 'INACTIVITY'
  | 'CALLBACK'
  | 'WATCH_OFF'
  | 'BATTERY_LOW'
  | 'BATTERY_DEAD'
  | 'CONNECTION_LOST'
  | 'ROUTINE_DEVIATION'
  | 'HEART_ANOMALY'
  | 'TEST'
  | 'FOLLOW_UP';

export type EventState =
  | 'CREATED'
  | 'DEVICE_PROMPT'
  | 'CANCELLED_BY_USER'
  | 'ESCALATED'
  | 'OPERATOR_QUEUE'
  | 'OPERATOR_ASSIGNED'
  | 'CONTACT_CHAIN'
  | 'CONFIRMED_OK'
  | 'CONFIRMED_EMERGENCY'
  | 'DISPATCH'
  | 'FOLLOW_UP'
  | 'CLOSED';

export type ProtectionState = 'PROTECTED_WATCH' | 'PROTECTED_PHONE' | 'NIGHT' | 'UNPROTECTED';

export interface KafkaEnvelope<T> {
  eventId: string;
  type: string;
  version: number;
  occurredAt: string;
  countryCode: string;
  subjectUserId: string;
  payload: T;
}

export const TOPICS = {
  signalReceived: 'signal.received',
  eventCreated: 'event.created',
  eventTransitioned: 'event.transitioned',
  eventClosed: 'event.closed',
  protectionChanged: 'user.protection.changed',
  chainStepResult: 'chain.step.result',
  devicePromptAnswered: 'device.prompt.answered',
} as const;
