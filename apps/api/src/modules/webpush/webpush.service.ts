import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { type SupervisorAlert, TOPICS } from '@yanimda/contracts';
import { t } from '@yanimda/messages';
import { and, eq, sql } from 'drizzle-orm';
import webpush from 'web-push';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import { webPushSubscription } from '../../db/schema';

/**
 * Personel web push (PWA). Amir uyarıları (`supervisor.alert`: kilit düştü, 112 ekip ulaşmadı / süreç açık,
 * düzenli arama kaçırıldı) SUPERVISOR aboneliklerine gönderilir. Yük: başlık + katalog metni (olay türü),
 * etiket ve konsol yolu — kişi adı / numara yok. VAPID anahtarları yoksa kapalı (`VAPID_*`, .env.example).
 * 404/410 dönen abonelik silinir; diğer hatalarda sayaç artar (5'te silinir).
 */
export interface PushSender {
  send(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string): Promise<void>;
}
export const PUSH_SENDER = Symbol('PUSH_SENDER');

export function vapidSenderFromEnv(env: NodeJS.ProcessEnv = process.env): (PushSender & { publicKey: string }) | null {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return null;
  webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:destek@yanimda.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return {
    publicKey: VAPID_PUBLIC_KEY,
    send: async (sub, payload) => {
      await webpush.sendNotification(sub, payload, { TTL: 600, urgency: 'high' });
    },
  };
}

const URGENT = new Set(['O-DISPATCH-NO-ARRIVAL', 'O-LOCK-LOST']);
const PATH: Record<string, string> = { 'O-WELLNESS-MISSED': '/yonetim' };

@Injectable()
export class WebPushService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('WebPush');
  private unsub?: () => void;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(PUSH_SENDER) private readonly sender?: (PushSender & { publicKey?: string }) | null,
  ) {}

  get enabled() {
    return !!this.sender;
  }
  get publicKey() {
    return this.sender?.publicKey ?? null;
  }

  onModuleInit() {
    this.subscribe();
  }
  onModuleDestroy() {
    this.unsub?.();
  }

  /** Yan şerit: push gönderimi SOS'u bekletmez. Testler için ayrı bus. */
  subscribe(bus: LocalBus = globalBus) {
    this.unsub?.();
    this.unsub = bus.subscribe<SupervisorAlert>(
      TOPICS.supervisorAlert,
      (e) => this.onAlert(e.payload).then(() => undefined),
      {
        lane: 'side',
        name: 'webpush.alerts',
      },
    );
  }

  async register(subject: string, roles: string[], body: unknown) {
    const b = (body && typeof body === 'object' ? body : {}) as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    };
    if (typeof b.endpoint !== 'string' || !/^https:\/\//.test(b.endpoint) || b.endpoint.length > 1000)
      throw new BadRequestException('endpoint https olmalı');
    if (typeof b.keys?.p256dh !== 'string' || typeof b.keys?.auth !== 'string')
      throw new BadRequestException('keys gerekli');
    await this.db
      .insert(webPushSubscription)
      .values({ endpoint: b.endpoint, subject, roles, p256dh: b.keys.p256dh, auth: b.keys.auth })
      .onConflictDoUpdate({
        target: webPushSubscription.endpoint,
        set: { subject, roles, p256dh: b.keys.p256dh, auth: b.keys.auth, failures: 0 },
      });
    return { enabled: this.enabled };
  }

  async unregister(subject: string, endpoint: unknown) {
    if (typeof endpoint !== 'string') throw new BadRequestException('endpoint gerekli');
    await this.db
      .delete(webPushSubscription)
      .where(and(eq(webPushSubscription.endpoint, endpoint), eq(webPushSubscription.subject, subject)));
  }

  /** Amir uyarısı → SUPERVISOR abonelikleri. Hata fırlatmaz (yan şerit yeniden denemesin; abonelik bazlı sayaç). */
  async onAlert(a: SupervisorAlert): Promise<number> {
    if (!this.sender) return 0;
    const subs = await this.db
      .select()
      .from(webPushSubscription)
      .where(sql`'SUPERVISOR' = ANY(${webPushSubscription.roles})`);
    const payload = JSON.stringify({
      title: t('O-UI-SUP-TITLE'),
      body: t(a.code, 'tr', { type: t(`O-TYPE-${a.eventType}`) }),
      tag: `${a.code}:${a.eventId}`,
      url: PATH[a.code] ?? '/supervisor',
      urgent: URGENT.has(a.code),
    });
    let sent = 0;
    for (const s of subs) {
      try {
        await this.sender.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        await this.db
          .update(webPushSubscription)
          .set({ lastOkAt: new Date(), failures: 0 })
          .where(eq(webPushSubscription.endpoint, s.endpoint));
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410 || s.failures + 1 >= 5)
          await this.db.delete(webPushSubscription).where(eq(webPushSubscription.endpoint, s.endpoint));
        else
          await this.db
            .update(webPushSubscription)
            .set({ failures: s.failures + 1 })
            .where(eq(webPushSubscription.endpoint, s.endpoint));
        this.log.warn(`Web push gönderilemedi (${code ?? 'hata'}): ${safeError(e)}`);
      }
    }
    return sent;
  }
}
