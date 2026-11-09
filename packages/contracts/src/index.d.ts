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
  location?: {
    lat: number;
    lng: number;
    accuracyM?: number;
    source?: 'GPS' | 'NETWORK' | 'PHONE';
  } | null;
  device?: {
    batteryPct?: number;
    onWrist?: boolean;
    connectivity?: 'BLE' | 'LTE' | 'WIFI' | 'NONE';
    appVersion?: string;
  };
  payload?: Record<string, unknown>;
  /**
   * Sunucu doldurur (T-015, cihaz adaptörü); istemci gönderemez (şema additionalProperties: false).
   * Olay motoru cihaz türünü buradan okur, cihaz tablosundan değil.
   */
  source?: {
    kind: DeviceKind;
    role: DeviceRole;
  };
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
/** Kayıtlı cihaz türü (device.device.kind). Yeni tür = yeni DeviceAdapter (T-015). */
export type DeviceKind = 'WEAROS_WATCH' | 'ANDROID_PHONE' | 'IOS_PHONE' | 'SIMULATOR';
export type DeviceRole = 'WATCH' | 'PHONE';
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
export declare const TOPICS: {
  readonly signalReceived: 'signal.received';
  readonly eventCreated: 'event.created';
  readonly eventTransitioned: 'event.transitioned';
  readonly eventClosed: 'event.closed';
  readonly eventUpdated: 'event.updated';
  readonly notifyRequested: 'notify.requested';
  readonly rulesReloaded: 'rules.reloaded';
  readonly protectionChanged: 'user.protection.changed';
  readonly chainStepResult: 'chain.step.result';
  readonly devicePromptAnswered: 'device.prompt.answered';
  /** Amir uyarısı (T-021: operatör kilidi düştü). Konsol amir odasına yayınlar. */
  readonly supervisorAlert: 'supervisor.alert';
  /** T-071 (D-07): yanlış alarm kaydı (kişi, olay, neden). */
  readonly eventFalseAlarm: 'event.false_alarm';
};
/** Bildirim isteği (T-012 üretir, T-053 notify modülü tüketir). Metin değil, katalog kodu taşır. */
export interface NotifyRequest {
  code: string;
  audience: 'ELDER' | 'FAMILY';
  protectedPersonId: string;
  /** Tüketici tekrarı ayıklasın: aynı kaynak + kod bir kez gönderilir. */
  dedupeKey: string;
  eventId?: string;
  vars?: Record<string, string | number>;
}
export type StepResult = 'REACHED' | 'NO_ANSWER' | 'BUSY' | 'WRONG_NUMBER' | 'SKIPPED';
export declare const STEP_RESULTS: readonly StepResult[];
/** Ulaşılınca operatörün değerlendirmesi: OK → CONFIRMED_OK, EMERGENCY → CONFIRMED_EMERGENCY. */
export type StepAssessment = 'OK' | 'EMERGENCY';
export type StepTarget = 'WATCH' | 'ELDER_PHONE' | 'CONTACT' | 'NEIGHBOR' | 'EMERGENCY' | 'FAMILY';
export interface ChainStep {
  n: number;
  /** Kural paketindeki adım türü (CALL_WATCH, CALL_CONTACT, CALL_112 …). */
  kind: string;
  target: StepTarget;
  /** CALL_CONTACT:2 → 2. */
  contactIndex?: number;
  /** Katalog kodları (konsol metni buradan). */
  label: string;
  script?: string;
  timeoutSec: number;
  required: boolean;
  calledAt?: string;
  result?: StepResult;
  assessment?: StepAssessment;
  note?: string;
  reason?: string;
  operatorId?: string;
  completedAt?: string;
  scriptReadAt?: string;
}
export interface ChainView {
  procedureVersion: number;
  steps: ChainStep[];
  /** Sıradaki adım; hepsi bittiyse null. */
  current: number | null;
}
export interface SupervisorAlert {
  code: string;
  eventId: string;
  eventType: EventType;
  operatorId?: string;
  at: string;
}

// ---- T-071 yanlış alarm (D-07, C-12) ----
/** USER_CANCEL: kişi cihazdan iptal etti; OPERATOR: operatör FALSE_ALARM ile kapattı; FAMILY_FEEDBACK: aile "gerçek değildi". */
export type FalseAlarmCause = 'USER_CANCEL' | 'OPERATOR' | 'FAMILY_FEEDBACK';
export interface FalseAlarm {
  protectedPersonId: string;
  eventId: string;
  eventType: EventType;
  cause: FalseAlarmCause;
  at: string;
}
