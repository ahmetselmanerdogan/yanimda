import { Logger } from '@nestjs/common';
import { t } from '@yanimda/messages';
import { eq } from 'drizzle-orm';

import { safeError } from '../../common/safe-error';
import type { Db } from '../../db/client';
import { device } from '../../db/schema';
import type { ApnsClient, ApnsRequest } from './apns/apns-client';
import { type PushMessage, type PushPort, RecordingPush } from './push.port';

export type PushOutcome = 'sent' | 'no-token' | 'unconfigured' | 'unsupported' | 'invalid-token' | 'retry' | 'error';

/** iOS uygulamasının "İyiyim" eylemli bildirim kategorisi (yanimda-ios ProtectionMonitor). */
export const IOS_PROMPT_CATEGORY = 'yanimda.inactivity';

/**
 * PushPort'un gerçek uygulaması: cihazın push sağlayıcısını ve token'ını (T-041 `PUT /devices/{id}/push-token`)
 * okur, APNs'e yönlendirir. FCM T-053'ün kalan kısmında; o zamana kadar FCM cihazlarına giden mesajlar kaydedilir.
 * Geçersiz token (uygulama silindi) cihaz kaydından temizlenir. Log'da token ve kişi bilgisi yok.
 */
export class DevicePush implements PushPort {
  private readonly log = new Logger('DevicePush');
  /** Yapılandırılmamış kanallar için (geliştirme): gönderilenler bellekte. */
  readonly recorded = new RecordingPush();

  constructor(
    private readonly db: Db,
    private readonly apns: Pick<ApnsClient, 'send'> | null,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async send(msg: PushMessage): Promise<void> {
    await this.deliver(msg);
  }

  async deliver(msg: PushMessage): Promise<PushOutcome> {
    const [row] = await this.db
      .select({ provider: device.pushProvider, token: device.pushToken, sandbox: device.pushSandbox })
      .from(device)
      .where(eq(device.id, msg.deviceId));
    if (!row?.token || !row.provider) return 'no-token';
    if (row.provider !== 'APNS' || !this.apns) {
      await this.recorded.send(msg);
      return 'unconfigured';
    }
    const req = this.toApns(msg, row.token, row.sandbox === true);
    if (!req) return 'unsupported';
    let res;
    try {
      res = await this.apns.send(req);
    } catch (e) {
      this.log.warn(`APNs gönderilemedi: ${safeError(e)}`);
      return 'retry';
    }
    switch (res.status) {
      case 'ok':
        return 'sent';
      case 'invalid-token':
        // Uygulama silinmiş veya token başka uygulamanın: bir daha gönderme. Uygulama açılınca yenisini kaydeder.
        await this.db
          .update(device)
          .set({ pushToken: null, pushUpdatedAt: this.clock() })
          .where(eq(device.id, msg.deviceId));
        this.log.log(`APNs token geçersiz (${res.reason}); cihaz kaydından silindi`);
        return 'invalid-token';
      default:
        this.log.warn(`APNs ${res.status}: ${res.reason}`);
        return res.status;
    }
  }

  /** PushMessage → APNs isteği. WAKE: sessiz (content-available); PROMPT: "İyiyim" eylemli uyarı. RING: telefonda arama ile. */
  private toApns(msg: PushMessage, token: string, sandbox: boolean): ApnsRequest | null {
    const expiration = Math.floor(this.clock().getTime() / 1000) + msg.ttlSec;
    const type = msg.data.type;
    if (type === 'WAKE')
      return {
        token,
        sandbox,
        pushType: 'background',
        priority: 5, // Apple: arka plan push'u 10 olamaz
        expiration,
        collapseId: 'wake', // birikenlerden yalnız sonuncusu teslim edilir
        payload: { aps: { 'content-available': 1 }, type: 'WAKE' },
      };
    if (type === 'PROMPT' && msg.data.tts)
      return {
        token,
        sandbox,
        pushType: 'alert',
        priority: 10,
        expiration,
        collapseId: msg.data.eventId,
        payload: {
          aps: { alert: { body: t(msg.data.tts) }, sound: 'default', category: IOS_PROMPT_CATEGORY },
          type: 'PROMPT',
          eventId: msg.data.eventId,
        },
      };
    return null;
  }
}
