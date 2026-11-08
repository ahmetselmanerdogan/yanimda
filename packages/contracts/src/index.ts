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
  /**
   * Sunucu doldurur (T-015, cihaz adaptörü); istemci gönderemez (şema additionalProperties: false).
   * Olay motoru cihaz türünü buradan okur, cihaz tablosundan değil.
   */
  source?: { kind: DeviceKind; role: DeviceRole };
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

export const TOPICS = {
  signalReceived: 'signal.received',
  eventCreated: 'event.created',
  eventTransitioned: 'event.transitioned',
  eventClosed: 'event.closed',
  eventUpdated: 'event.updated',
  notifyRequested: 'notify.requested',
  rulesReloaded: 'rules.reloaded',
  protectionChanged: 'user.protection.changed',
  chainStepResult: 'chain.step.result',
  devicePromptAnswered: 'device.prompt.answered',
} as const;

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
