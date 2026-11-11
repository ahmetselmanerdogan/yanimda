import { Logger } from '@nestjs/common';
import { t } from '@yanimda/messages';
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';

import { safeError } from '../../common/safe-error';
import type { Db } from '../../db/client';
import { device, deviceModel } from '../../db/schema';
import type { FcmClient, FcmMessage } from '../notify/fcm-client';
import { phonePromptCode } from './adapters/push-device';
import type { ApnsClient, ApnsRequest } from './apns/apns-client';
import { type PushMessage, type PushOutcome, type PushPort, RecordingPush } from './push.port';

export { phonePromptCode } from './adapters/push-device';
export type { PushOutcome } from './push.port';

/** iOS uygulamasının "İyiyim" eylemli bildirim kategorisi (yanimda-ios ProtectionMonitor). */
export const IOS_PROMPT_CATEGORY = 'yanimda.inactivity';

/** Kendi token'ı olmayan saate köprü telefon üzerinden aktarılan komutlar (NOTICE aktarımı notify modülünde). */
const RELAYED = new Set(['PROMPT', 'RING', 'LOCATE', 'TEST']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Route {
  id: string;
  personId: string;
  phone: boolean;
  provider: string | null;
  token: string | null;
  sandbox: boolean | null;
}

const routeCols = {
  id: sql<string>`${device.id}::text`,
  personId: device.protectedPersonId,
  phone: sql<boolean>`coalesce(${device.category}, ${deviceModel.category}, CASE WHEN ${device.kind} LIKE '%PHONE' THEN 'PHONE' END) = 'PHONE'`,
  provider: device.pushProvider,
  token: device.pushToken,
  sandbox: device.pushSandbox,
};

/** Cihazın push yolu (token, sağlayıcı, telefon mu). Kayıtlı değilse (simülatör kimliği) undefined. */
export async function pushRoute(db: Db, deviceId: string): Promise<Route | undefined> {
  if (!UUID.test(deviceId)) return undefined;
  const [r] = await db
    .select(routeCols)
    .from(device)
    .leftJoin(deviceModel, sql`${deviceModel.id} = coalesce(${device.modelId}, ${device.kind})`)
    .where(eq(device.id, deviceId));
  return r;
}

/** Saatin köprüsü: kişinin push token'ı olan, etkin, en son görülen telefonu. */
export async function bridgeOf(db: Db, personId: string, exceptId: string): Promise<Route | undefined> {
  const rows = await db
    .select(routeCols)
    .from(device)
    .leftJoin(deviceModel, sql`${deviceModel.id} = coalesce(${device.modelId}, ${device.kind})`)
    .where(
      and(
        eq(device.protectedPersonId, personId),
        ne(device.id, exceptId),
        isNull(device.revokedAt),
        isNull(device.retiredAt),
        isNotNull(device.pushToken),
        isNotNull(device.pushProvider),
      ),
    )
    .orderBy(sql`${device.lastSeenAt} DESC NULLS LAST`, device.id);
  return rows.find((r) => r.phone);
}

/**
 * Bu cihaza giden komut hangi telefon üzerinden aktarılır: cihazın kendi token'ı yoksa (ve telefon değilse) köprü
 * telefonun kimliği; kendi token'ı varsa, kayıtsızsa veya köprü yoksa null.
 */
export async function relayBridgeOf(db: Db, deviceId: string): Promise<string | null> {
  const r = await pushRoute(db, deviceId);
  if (!r || r.phone || (r.token && r.provider)) return null;
  return (await bridgeOf(db, r.personId, r.id))?.id ?? null;
}

/**
 * PushPort'un gerçek uygulaması: cihazın push sağlayıcısını ve token'ını (T-041 `PUT /devices/{id}/push-token`)
 * okur, APNs'e veya FCM'e (T-053) yönlendirir; sağlayıcısı yapılandırılmamış mesajlar kaydedilir ('unconfigured',
 * cihaza ulaşmadı). Kendi token'ı olmayan saate (Wear OS: FCM yok) PROMPT / RING / LOCATE / TEST köprü telefona
 * `forDeviceId` = saat ile, görünür bildirim olmadan gider ('relayed'); telefon Data Layer'dan saate iletir.
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
    private readonly fcm: Pick<FcmClient, 'send'> | null = null,
  ) {}

  send(msg: PushMessage): Promise<PushOutcome> {
    return this.deliver(msg);
  }

  async deliver(msg: PushMessage): Promise<PushOutcome> {
    const r = await pushRoute(this.db, msg.deviceId);
    if (!r) return 'no-token';
    if (r.token && r.provider) return this.direct(msg, r);
    if (r.phone || !RELAYED.has(msg.data.type ?? '') || msg.data.forDeviceId) return 'no-token';
    const bridge = await bridgeOf(this.db, r.personId, r.id);
    if (!bridge) return 'no-token';
    const out = await this.direct(
      { ...msg, deviceId: bridge.id, data: { ...msg.data, forDeviceId: msg.deviceId } },
      bridge,
    );
    return out === 'sent' ? 'relayed' : out;
  }

  private async direct(msg: PushMessage, r: Route): Promise<PushOutcome> {
    if (r.provider === 'FCM' && this.fcm) return this.viaFcm(msg, r.token!);
    if (r.provider !== 'APNS' || !this.apns) {
      await this.recorded.send(msg);
      return 'unconfigured';
    }
    const req = this.toApns(msg, r.token!, r.sandbox === true);
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
        return this.dropToken(msg.deviceId, `APNs ${res.reason}`);
      default:
        this.log.warn(`APNs ${res.status}: ${res.reason}`);
        return res.status;
    }
  }

  /**
   * FCM (Android saat/telefon): yalnız veri mesajı (öncelik mesajın kendisinden: PROMPT ve RING yüksek). Görünür
   * bildirim (FCM `notification`) yalnız telefonun kendi NOTICE'unda; saate aktarılan (forDeviceId) hiçbir mesaj
   * telefonda gösterilmez, soruyu ve çaldırmayı uygulama kendisi gösterir.
   */
  private async viaFcm(msg: PushMessage, token: string): Promise<PushOutcome> {
    const m: FcmMessage = { token, data: msg.data, priority: msg.priority, ttlSec: msg.ttlSec };
    if (msg.data.type === 'NOTICE' && msg.data.code && !msg.data.forDeviceId) m.body = t(msg.data.code);
    if (msg.data.type === 'WAKE') m.collapseKey = 'wake';
    const res = await this.fcm!.send(m);
    if (res.status === 'ok') return 'sent';
    if (res.status === 'invalid-token') return this.dropToken(msg.deviceId, `FCM ${res.reason}`);
    this.log.warn(`FCM ${res.status}: ${res.reason}`);
    return res.status;
  }

  private async dropToken(deviceId: string, why: string): Promise<PushOutcome> {
    // Uygulama silinmiş veya token başka uygulamanın: bir daha gönderme. Uygulama açılınca yenisini kaydeder.
    await this.db.update(device).set({ pushToken: null, pushUpdatedAt: this.clock() }).where(eq(device.id, deviceId));
    this.log.log(`Push token geçersiz (${why}); cihaz kaydından silindi`);
    return 'invalid-token';
  }

  /**
   * PushMessage → APNs isteği. Başka cihaza aktarılan (forDeviceId), WAKE, LOCATE, TEST: sessiz arka plan (öncelik 5,
   * Apple kuralı). PROMPT: "İyiyim" eylemli uyarı, telefon metni (phoneTts), öncelik 10; özel alanlar FCM PROMPT'la
   * aynı (kind, tts, phoneTts, windowSec, until, silent). RING: P-RING uyarısı, öncelik
   * 10. NOTICE: katalog metni.
   */
  private toApns(msg: PushMessage, token: string, sandbox: boolean): ApnsRequest | null {
    const expiration = Math.floor(this.clock().getTime() / 1000) + msg.ttlSec;
    const d = msg.data;
    const background = (payload: Record<string, unknown>, collapseId?: string): ApnsRequest => ({
      token,
      sandbox,
      pushType: 'background',
      priority: 5, // Apple: arka plan push'u 10 olamaz
      expiration,
      ...(collapseId ? { collapseId } : {}),
      payload: { aps: { 'content-available': 1 }, ...payload },
    });
    const alert = (body: string, payload: Record<string, unknown>, collapseId?: string, category?: string) => ({
      token,
      sandbox,
      pushType: 'alert' as const,
      priority: 10 as const,
      expiration,
      ...(collapseId ? { collapseId } : {}),
      payload: { aps: { alert: { body }, sound: 'default', ...(category ? { category } : {}) }, ...payload },
    });
    if (d.forDeviceId) return background({ ...d });
    switch (d.type) {
      case 'WAKE':
        return background({ type: 'WAKE' }, 'wake'); // birikenlerden yalnız sonuncusu teslim edilir
      case 'LOCATE':
      case 'TEST':
        return background({ ...d });
      case 'NOTICE':
        return d.code ? alert(t(d.code), { type: 'NOTICE', code: d.code }, d.code) : null;
      case 'RING':
        return alert(t('P-RING'), { type: 'RING', eventId: d.eventId }, d.eventId);
      case 'PROMPT': {
        if (!d.tts) return null;
        // FCM PROMPT'la aynı alanlar (yalnız katalog kodları ve süreler; PII yok): uygulama metni ve süreyi buradan alır.
        const phoneTts = d.phoneTts ?? phonePromptCode(d);
        return alert(
          t(phoneTts),
          {
            type: 'PROMPT',
            eventId: d.eventId,
            ...(d.kind ? { kind: d.kind } : {}),
            tts: d.tts,
            phoneTts,
            ...(d.windowSec ? { windowSec: d.windowSec } : {}),
            ...(d.until ? { until: d.until } : {}),
            silent: d.silent ?? 'false',
          },
          d.eventId,
          IOS_PROMPT_CATEGORY,
        );
      }
      default:
        return null;
    }
  }
}
