import type { DeviceCommand, PromptRequest, RingRequest } from '../device.types';
import type { PushPort } from '../push.port';

/**
 * FCM kullanan cihazların ortak komutları (data mesajı; FCM yalnız string taşır):
 *  - PROMPT (normal öncelik): `{type, eventId, kind, tts, windowSec, until, silent}`. `until` sorunun mutlak bitişi
 *    (ISO, sunucu saati) — doğrulanmış düşmenin 30 sn'si dahil istemci bunu esas alır; `windowSec` gönderim anında
 *    kalan süre (yalnız `windowSec` okuyan eski istemciler için). `kind` olay türü (FALL / INACTIVITY …), `tts` cihazın
 *    W-* katalog kodu (telefon kendi P-* metnini `kind`'den seçer). TTL kalan süre: pencere geçtiyse soru anlamsız.
 *  - RING (yüksek öncelik) `{type, eventId}`; LOCATE (yüksek) `{type, eventId}`; TEST (normal) `{type}`.
 */
export async function pushPrompt(push: PushPort, deviceId: string, req: PromptRequest) {
  await push.send({
    deviceId,
    priority: 'normal',
    data: {
      type: 'PROMPT',
      eventId: req.eventId,
      kind: req.kind,
      tts: req.tts,
      windowSec: String(req.windowSec),
      until: req.until,
      silent: String(req.silent),
    },
    ttlSec: Math.max(1, req.windowSec),
  });
}

export async function pushRing(push: PushPort, deviceId: string, req: RingRequest) {
  await push.send({ deviceId, priority: 'high', data: { type: 'RING', eventId: req.eventId }, ttlSec: 30 });
}

export async function pushCommand(push: PushPort, deviceId: string, cmd: DeviceCommand) {
  if (cmd.type === 'LOCATE')
    await push.send({ deviceId, priority: 'high', data: { type: 'LOCATE', eventId: cmd.eventId }, ttlSec: 60 });
  else await push.send({ deviceId, priority: 'normal', data: { type: 'TEST' }, ttlSec: 3600 });
}
