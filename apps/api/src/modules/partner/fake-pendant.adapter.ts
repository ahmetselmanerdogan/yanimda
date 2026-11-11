import { BasePartnerAdapter } from './base-partner.adapter';
import {
  type ParsedPartnerEvent,
  type PartnerGateway,
  type PartnerModelProfile,
  RecordingPartnerGateway,
  type SignalDraft,
  wornOf,
} from './partner.types';

/**
 * Sahte OEM ortağı (FAKE_PENDANT; yalnız test, geliştirme ve simülatör — gerçek üretici entegrasyonu değil). Üç model:
 *  - FAKE_PENDANT_CELL: hücresel kolye (A): SOS, düşme, iki yönlü ses, GPS, pil (2–4 gün), takılı kanıtı, hat durumu.
 *  - FAKE_PENDANT_RADIO: EN 50134-2 radyo kolye (A, ev ünitesi üzerinden): SOS, düşme, 12 ay pil, "N gündür takılmadı";
 *    ses ev ünitesinden.
 *  - FAKE_HOME_UNIT: ev ünitesi (A): SOS düğmesi, hoparlör, elektrik kesintisi, hat kaybı, düğme testi.
 *
 * Webhook gövdesi: `{ "events": [ { id, type, device, at, battery?, confidence?, days?, mains?, lineUp?, lat?, lng?,
 * accuracyM? } ] }`. type: SOS | FALL | CANCEL | BATTERY | HEARTBEAT | WORN | NOT_WORN | POWER | LINE | BUTTON_TEST |
 * LOCATION. Her olay ayrı doğrulanır; okunamayan olay yalnız kendisi EVENT_INVALID olur.
 */
export const FAKE_PENDANT_PROFILES: readonly PartnerModelProfile[] = [
  {
    modelId: 'FAKE_PENDANT_CELL',
    category: 'PENDANT',
    tier: 'A',
    connectionPath: 'PARTNER_CENTER',
    signals: ['SOS', 'FALL', 'CANCEL', 'BATTERY', 'HEARTBEAT', 'ON_BODY', 'OFF_BODY', 'LOCATION', 'TEST'],
    voice: true,
    location: true,
    fallDetection: true,
    wornEvidence: true,
    latencyTargetP95Sec: 15,
    latencyClass: 'INSTANT',
    quality: null,
    commands: ['RING', 'CALL', 'LOCATE', 'TEST'],
  },
  {
    modelId: 'FAKE_PENDANT_RADIO',
    category: 'PENDANT',
    tier: 'A',
    connectionPath: 'HOME_UNIT',
    signals: ['SOS', 'FALL', 'CANCEL', 'BATTERY', 'HEARTBEAT', 'ON_BODY', 'OFF_BODY', 'TEST'],
    voice: false,
    location: false,
    fallDetection: true,
    wornEvidence: true,
    latencyTargetP95Sec: 15,
    latencyClass: 'INSTANT',
    quality: null,
    commands: ['TEST'],
  },
  {
    modelId: 'FAKE_HOME_UNIT',
    category: 'HOME_UNIT',
    tier: 'A',
    connectionPath: 'PARTNER_CENTER',
    signals: ['SOS', 'CANCEL', 'BATTERY', 'HEARTBEAT', 'TEST'],
    voice: true,
    location: false,
    fallDetection: false,
    wornEvidence: false,
    latencyTargetP95Sec: 15,
    latencyClass: 'INSTANT',
    quality: null,
    commands: ['CALL', 'TEST'],
  },
];

type Obj = Record<string, unknown>;
const ID = /^[\x21-\x7e]{1,200}$/;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;

export class FakePendantAdapter extends BasePartnerAdapter {
  readonly kind = 'FAKE_PENDANT' as const;
  readonly partner = 'FAKE_PENDANT';
  readonly dataRegion = 'TR';

  constructor(gateway: PartnerGateway = new RecordingPartnerGateway()) {
    super(gateway, FAKE_PENDANT_PROFILES);
  }

  parse(body: unknown): ParsedPartnerEvent[] {
    const events = isObj(body) && Array.isArray(body.events) ? body.events : null;
    if (!events) return [];
    return events.map((e) => this.one(e));
  }

  private one(e: unknown): ParsedPartnerEvent {
    if (!isObj(e)) return { ok: false, vendorEventId: null, reason: 'EVENT_INVALID' };
    const vendorEventId = typeof e.id === 'string' && ID.test(e.id) ? e.id : null;
    const invalid = { ok: false as const, vendorEventId, reason: 'EVENT_INVALID' as const };
    const vendorDeviceId = typeof e.device === 'string' && ID.test(e.device) ? e.device : null;
    const at = typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : null;
    if (!vendorEventId || !vendorDeviceId || !at) return invalid;
    const draft = this.draft(e);
    if (!draft) return invalid;
    return { ok: true, vendorEventId, vendorDeviceId, occurredAt: at, draft };
  }

  /** Üretici olayı → kanonik sinyal (cihaz/kişi/anahtar webhook servisinde eklenir). */
  private draft(e: Obj): SignalDraft | null {
    const battery = num(e.battery, 0, 100);
    const confidence = num(e.confidence, 0, 1);
    const device: NonNullable<SignalDraft['device']> = {};
    const payload: Obj = {};
    if (battery !== undefined) device.batteryPct = Math.round(battery);
    if (confidence !== undefined) {
      payload.wornConfidence = confidence;
      const worn = wornOf(confidence);
      if (worn !== undefined) device.onWrist = worn;
    }
    if (typeof e.mains === 'boolean') device.mainsPower = e.mains;
    if (typeof e.lineUp === 'boolean') device.lineOk = e.lineUp;
    const out = (d: SignalDraft): SignalDraft => ({
      ...d,
      ...(Object.keys(device).length ? { device: { ...device, ...d.device } } : {}),
      payload: { ...payload, ...d.payload },
    });
    switch (e.type) {
      case 'SOS':
      case 'FALL':
      case 'CANCEL':
      case 'HEARTBEAT':
        return out({ kind: e.type, ...this.location(e) });
      case 'BATTERY':
        return battery === undefined ? null : out({ kind: 'BATTERY', value: battery });
      case 'WORN': {
        // Takılı kanıtı: kesin değilse yalnız canlılık (durum değişmez).
        if (confidence === undefined) return null;
        const worn = wornOf(confidence);
        return out({ kind: worn === true ? 'ON_BODY' : worn === false ? 'OFF_BODY' : 'HEARTBEAT' });
      }
      case 'NOT_WORN': {
        // "N gündür takılmadı" (radyo kolye): OFF_BODY, value = gün (kural paketi pendant.notWornMinDays).
        const days = num(e.days, 1, 365);
        if (days === undefined) return null;
        return out({ kind: 'OFF_BODY', value: Math.floor(days), device: { onWrist: false } });
      }
      case 'POWER':
        return typeof e.mains === 'boolean' ? out({ kind: 'HEARTBEAT' }) : null;
      case 'LINE':
        return typeof e.lineUp === 'boolean' ? out({ kind: 'HEARTBEAT' }) : null;
      case 'BUTTON_TEST':
        return out({ kind: 'TEST', payload: { trigger: 'BUTTON' } });
      case 'LOCATION': {
        const loc = this.location(e);
        return loc.location ? out({ kind: 'LOCATION', ...loc }) : null;
      }
      default:
        return null;
    }
  }

  private location(e: Obj): Pick<SignalDraft, 'location'> {
    const lat = num(e.lat, -90, 90);
    const lng = num(e.lng, -180, 180);
    if (lat === undefined || lng === undefined) return {};
    const accuracyM = num(e.accuracyM, 0, 100_000);
    return { location: { lat, lng, source: 'GPS', ...(accuracyM !== undefined ? { accuracyM } : {}) } };
  }
}
