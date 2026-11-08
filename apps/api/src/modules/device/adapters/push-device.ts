import type { PromptRequest, RingRequest } from '../device.types';
import type { PushPort } from '../push.port';

/** FCM kullanan cihazların ortak komutları: soru = data mesajı (normal), çaldırma = yüksek öncelik. */
export async function pushPrompt(push: PushPort, deviceId: string, req: PromptRequest) {
  await push.send({
    deviceId,
    priority: 'normal',
    data: {
      type: 'PROMPT',
      eventId: req.eventId,
      tts: req.tts,
      windowSec: String(req.windowSec),
      silent: String(req.silent),
    },
    ttlSec: req.windowSec, // pencere geçtiyse soru anlamsız
  });
}

export async function pushRing(push: PushPort, deviceId: string, req: RingRequest) {
  await push.send({ deviceId, priority: 'high', data: { type: 'RING', eventId: req.eventId }, ttlSec: 30 });
}
