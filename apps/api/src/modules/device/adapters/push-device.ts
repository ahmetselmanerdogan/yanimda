import type { DeviceCommand, PromptRequest, RingRequest } from '../device.types';
import type { PushOutcome, PushPort } from '../push.port';

/** Saatin soru kodu → telefonun soru metni (P-*); bilinmeyen kod olay türünden, o da yoksa operatör sorusu. */
const PHONE_PROMPT_BY_TTS: Record<string, string> = {
  'W-FALL-1': 'P-FALL-PROMPT',
  'W-INACT-1': 'P-INACT-1',
  'W-OP-PROMPT': 'P-OP-PROMPT',
};
const PHONE_PROMPT_BY_KIND: Record<string, string> = { FALL: 'P-FALL-PROMPT', INACTIVITY: 'P-INACT-1' };
export const phonePromptCode = (d: { tts?: string; kind?: string }) =>
  (d.tts && PHONE_PROMPT_BY_TTS[d.tts]) || (d.kind && PHONE_PROMPT_BY_KIND[d.kind]) || 'P-OP-PROMPT';

/**
 * FCM kullanan cihazların ortak komutları (data mesajı, görünür bildirim yok; FCM yalnız string taşır):
 *  - PROMPT (yüksek öncelik): `{type, eventId, kind, tts, phoneTts, windowSec, until, silent}`. `until` sorunun mutlak
 *    bitişi (ISO, sunucu saati) — doğrulanmış düşmenin 30 sn'si dahil istemci bunu esas alır; `windowSec` gönderim
 *    anında kalan süre (yalnız `windowSec` okuyan eski istemciler için). `kind` olay türü, `tts` saatin W-* kodu,
 *    `phoneTts` telefonun P-* metni. TTL kalan süre: pencere geçtiyse soru anlamsız.
 *  - RING (yüksek) `{type, eventId}`; LOCATE (yüksek) `{type, eventId}`; TEST (normal) `{type}`.
 * Kendi token'ı olmayan saate giden mesaj DevicePush'ta köprü telefona `forDeviceId` ile aktarılır.
 */
export function pushPrompt(push: PushPort, deviceId: string, req: PromptRequest): Promise<PushOutcome | void> {
  return push.send({
    deviceId,
    priority: 'high',
    data: {
      type: 'PROMPT',
      eventId: req.eventId,
      kind: req.kind,
      tts: req.tts,
      phoneTts: phonePromptCode(req),
      windowSec: String(req.windowSec),
      until: req.until,
      silent: String(req.silent),
    },
    ttlSec: Math.max(1, req.windowSec),
  });
}

export function pushRing(push: PushPort, deviceId: string, req: RingRequest): Promise<PushOutcome | void> {
  return push.send({ deviceId, priority: 'high', data: { type: 'RING', eventId: req.eventId }, ttlSec: 30 });
}

export function pushCommand(push: PushPort, deviceId: string, cmd: DeviceCommand): Promise<PushOutcome | void> {
  if (cmd.type === 'LOCATE')
    return push.send({ deviceId, priority: 'high', data: { type: 'LOCATE', eventId: cmd.eventId }, ttlSec: 60 });
  return push.send({ deviceId, priority: 'normal', data: { type: 'TEST' }, ttlSec: 3600 });
}
