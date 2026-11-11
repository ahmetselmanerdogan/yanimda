import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { type EventState, type KafkaEnvelope, type NotifyRequest, TOPICS } from '@yanimda/contracts';
import { catalogs, t } from '@yanimda/messages';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import {
  contact,
  device,
  deviceModel,
  event,
  familyMember,
  notification,
  protectedPerson,
  pushTarget,
} from '../../db/schema';
import { DevicePush } from '../device/device-push';
import { PUSH, type PushPort } from '../device/push.port';
import type { CpaasProvider } from '../telephony/cpaas';
import { CPAAS } from '../telephony/telephony.service';
import { FCM, type FcmClient } from './fcm-client';
import { deliveryFor, familyNoticeFor } from './policy';

export const NOTIFY_ENV = Symbol('NOTIFY_ENV');

type Row = typeof notification.$inferSelect;
type Channel = 'PUSH' | 'SMS' | 'VOICE' | 'DEVICE';
type Outcome =
  | { kind: 'sent'; providerId?: string }
  | { kind: 'retry'; error: string }
  | { kind: 'failed'; error: string; invalidTarget?: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 30_000;
const BATCH = 20;
const PUSH_TTL_SEC = 3600;

/**
 * T-053 (D-08) bildirim modülü. İki aşama:
 *  1. Planlama (outbox teslimi içinde, hızlı): `notify.requested` ve `event.transitioned` → alıcı × kanal başına
 *     `notify.notification` satırı (tekrar teslimde aynı satır: dedupe). Ağ çağrısı yok; olay akışı beklemez.
 *  2. Dağıtım (arka plan): kira ile satır alınır, kanaldan gönderilir; geçici hata üstel geri çekilmeyle 5 deneme.
 *     INFO push teslim edilmezse (uygulama onayı yok / push başarısız / hedef yok) ilk yakına SMS (yedek).
 * Metin gönderim anında katalogdan (`t()`); satırda metin ve numara yok. Log'da kişi adı, numara, token yok.
 */
@Injectable()
export class NotifyService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Notify');
  private unsub: (() => void)[] = [];
  private timer?: NodeJS.Timeout;
  private draining?: Promise<void>;
  private again = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PUSH) private readonly devicePush: PushPort,
    @Optional() @Inject(FCM) private readonly fcm: Pick<FcmClient, 'send'> | null = null,
    @Optional()
    @Inject(CPAAS)
    private readonly cpaas: Pick<CpaasProvider, 'sendSms' | 'ttsCall' | 'verify'> | null = null,
    @Optional() @Inject(NOTIFY_ENV) private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  onModuleInit() {
    this.subscribe();
    const every = Number(this.env.NOTIFY_SWEEP_MS ?? 2000);
    if (every > 0) {
      this.timer = setInterval(() => this.kick(), every);
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    this.unsub.forEach((u) => u());
    if (this.timer) clearInterval(this.timer);
  }

  /** Testler için ayrı bus. */
  subscribe(bus: LocalBus = globalBus) {
    this.unsub.forEach((u) => u());
    this.unsub = [
      bus.subscribe<NotifyRequest>(TOPICS.notifyRequested, (e) => this.onRequest(e)),
      bus.subscribe<{ eventId: string; from?: EventState; to: EventState }>(TOPICS.eventTransitioned, (e) =>
        this.onTransition(e),
      ),
    ];
  }

  // ---- 1. planlama ----

  async onRequest(e: KafkaEnvelope<NotifyRequest>) {
    await this.plan(e.payload);
  }

  async onTransition(e: KafkaEnvelope<{ eventId: string; from?: EventState; to: EventState }>) {
    const { eventId, from, to } = e.payload;
    if (!['OPERATOR_QUEUE', 'DISPATCH', 'CLOSED'].includes(to)) return;
    const [ev] = await this.db
      .select({
        id: event.id,
        type: event.type,
        isTest: event.isTest,
        confirmedOutcome: event.confirmedOutcome,
        protectedPersonId: event.protectedPersonId,
      })
      .from(event)
      .where(eq(event.id, eventId));
    if (!ev) return;
    const code = familyNoticeFor(ev as Parameters<typeof familyNoticeFor>[0], { from, to });
    if (!code) return;
    await this.plan({
      code,
      audience: 'FAMILY',
      protectedPersonId: ev.protectedPersonId,
      eventId: ev.id,
      dedupeKey: `event:${ev.id}:${code}`,
    });
  }

  /** Alıcıları çözüp satırları yazar (idempotent). Kaç satır yazıldığını döner. */
  async plan(req: NotifyRequest, now = new Date()): Promise<number> {
    const d = deliveryFor(req.code);
    const base = {
      dedupeKey: req.dedupeKey,
      code: req.code,
      audience: req.audience,
      urgency: d.urgency,
      protectedPersonId: req.protectedPersonId,
      eventId: req.eventId && UUID.test(req.eventId) ? req.eventId : null,
      vars: req.vars ?? null,
      createdAt: now,
      nextAttemptAt: now,
    };
    const rows: (typeof notification.$inferInsert)[] = [];
    const add = (channel: Channel, recipientKind: Row['recipientKind'], recipientId: string, extra = {}) =>
      rows.push({ ...base, id: uuidv7(), channel, recipientKind, recipientId, ...extra });

    if (d.elderVoice) {
      // T-087 (S4.7): yaşlının kendi numarasına sesli arama (CPaaS ttsCall); numara gönderimde okunur, satırda yok.
      const elder = await this.elderNumber(req.protectedPersonId);
      if (elder) add('VOICE', 'CONTACT', elder);
    } else if (req.audience === 'ELDER') {
      for (const r of await this.elderRecipients(req.protectedPersonId, req.code)) add('DEVICE', r.kind, r.id);
    } else if (d.voiceOnly) {
      const [first] = await this.familyContacts(req.protectedPersonId);
      if (first) add('VOICE', 'CONTACT', first); // T-087: yalnız 1. yakına sesli mesaj
    } else {
      const targets = await this.familyTargets(req.protectedPersonId);
      const contacts = await this.familyContacts(req.protectedPersonId);
      const fallbackAt = d.smsFallbackSec != null ? new Date(now.getTime() + d.smsFallbackSec * 1000) : null;
      for (const id of targets) add('PUSH', 'PUSH_TARGET', id, fallbackAt ? { fallbackAt } : {});
      if (d.parallelSmsVoice) {
        for (const c of contacts) add('SMS', 'CONTACT', c);
        if (contacts[0]) add('VOICE', 'CONTACT', contacts[0]);
      } else if (!targets.length && d.smsFallbackSec != null && contacts[0]) {
        add('SMS', 'CONTACT', contacts[0]); // push hedefi yok: yedek hemen
      }
    }
    if (!rows.length) return 0;
    const inserted = await this.db
      .insert(notification)
      .values(rows)
      .onConflictDoNothing({ target: [notification.dedupeKey, notification.channel, notification.recipientId] })
      .returning({ id: notification.id });
    if (inserted.length) this.kick();
    return inserted.length;
  }

  // ---- 2. dağıtım ----

  /** Arka planda boşalt (tek uçuş; çalışırken gelen istek bir tur daha ister). */
  kick() {
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = (async () => {
      do {
        this.again = false;
        await this.drain().catch((e) => this.log.warn(`Dağıtım: ${safeError(e)}`));
      } while (this.again);
    })().finally(() => (this.draining = undefined));
  }

  /** Testler: arka plan turunun bitmesini bekle. */
  async settled() {
    while (this.draining) await this.draining;
  }

  /** Vadesi gelenleri gönder, süresi dolan push'lar için SMS yedeğini planla. Gönderilen satır sayısı. */
  async drain(now = new Date()): Promise<number> {
    let n = 0;
    for (;;) {
      const batch = await this.claim(now);
      if (!batch.length) break;
      for (const row of batch) await this.finish(row, await this.send(row), now);
      n += batch.length;
    }
    if (await this.fallbacks(now)) n += await this.drain(now);
    return n;
  }

  private async claim(now: Date): Promise<Row[]> {
    const r = (await this.db.execute(sql`
      UPDATE notify.notification SET status = 'sending', attempts = attempts + 1,
        lease_until = ${new Date(now.getTime() + LEASE_MS)}
      WHERE id IN (
        SELECT id FROM notify.notification
        WHERE (status = 'queued' AND next_attempt_at <= ${now}) OR (status = 'sending' AND lease_until < ${now})
        ORDER BY urgency DESC, created_at
        LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
      RETURNING id`)) as unknown as { rows: { id: string }[] };
    if (!r.rows.length) return [];
    return this.db
      .select()
      .from(notification)
      .where(
        inArray(
          notification.id,
          r.rows.map((x) => x.id),
        ),
      )
      .orderBy(asc(notification.createdAt));
  }

  private async finish(row: Row, o: Outcome, now: Date) {
    if (o.kind === 'sent') {
      await this.db
        .update(notification)
        .set({ status: 'sent', sentAt: now, providerId: o.providerId ?? null, leaseUntil: null, error: null })
        .where(eq(notification.id, row.id));
      return;
    }
    const giveUp = o.kind === 'failed' || row.attempts >= MAX_ATTEMPTS;
    await this.db
      .update(notification)
      .set(
        giveUp
          ? // Push başarısızsa yedeği bekletme: hemen.
            { status: 'failed', error: o.error, leaseUntil: null, ...(row.fallbackAt ? { fallbackAt: now } : {}) }
          : {
              status: 'queued',
              error: o.error,
              leaseUntil: null,
              nextAttemptAt: new Date(now.getTime() + 1000 * 2 ** row.attempts),
            },
      )
      .where(eq(notification.id, row.id));
    if (o.kind === 'failed' && o.invalidTarget && row.recipientKind === 'PUSH_TARGET')
      await this.db.delete(pushTarget).where(eq(pushTarget.id, row.recipientId));
    if (giveUp) this.log.warn(`Bildirim gönderilemedi: ${row.code} ${row.channel} (${o.error})`);
  }

  /** INFO push yedeği: aynı bildirimin hiçbir push'u teslim edilmediyse ilk yakına SMS. Planlanan sayı. */
  private async fallbacks(now: Date): Promise<number> {
    const due = await this.db
      .select()
      .from(notification)
      .where(
        and(
          eq(notification.fallbackDone, false),
          isNotNull(notification.fallbackAt),
          sql`${notification.fallbackAt} <= ${now}`,
        ),
      );
    let planned = 0;
    for (const key of new Set(due.map((r) => r.dedupeKey))) {
      const all = due.filter((r) => r.dedupeKey === key);
      const siblings = await this.db
        .select({ status: notification.status, fallbackAt: notification.fallbackAt })
        .from(notification)
        .where(and(eq(notification.dedupeKey, key), eq(notification.channel, 'PUSH')));
      const delivered = siblings.some((s) => s.status === 'delivered');
      // Henüz gönderilmeye çalışılan (vadesi gelmemiş) kardeş varsa bekle.
      const pending = siblings.some((s) => s.fallbackAt && s.fallbackAt > now && s.status !== 'failed');
      if (pending && !delivered) continue;
      const first = all[0]!;
      const [c] = delivered ? [] : await this.familyContacts(first.protectedPersonId);
      await this.db.transaction(async (tx) => {
        await tx
          .update(notification)
          .set({ fallbackDone: true })
          .where(and(eq(notification.dedupeKey, key), eq(notification.channel, 'PUSH')));
        if (!c) return;
        const ins = await tx
          .insert(notification)
          .values({
            ...pick(first),
            id: uuidv7(),
            channel: 'SMS',
            recipientKind: 'CONTACT',
            recipientId: c,
            fallbackOf: first.id,
            createdAt: now,
            nextAttemptAt: now,
          })
          .onConflictDoNothing({ target: [notification.dedupeKey, notification.channel, notification.recipientId] })
          .returning({ id: notification.id });
        planned += ins.length;
      });
    }
    return planned;
  }

  private async send(row: Row): Promise<Outcome> {
    try {
      const text = await this.render(row);
      switch (row.channel as Channel) {
        case 'PUSH':
          return await this.sendPush(row, text);
        case 'DEVICE':
          return await this.sendDevice(row);
        case 'SMS':
        case 'VOICE':
          return await this.sendPhone(row, text);
      }
    } catch (e) {
      return { kind: 'retry', error: safeError(e) };
    }
    return { kind: 'failed', error: 'channel' };
  }

  private async sendPush(row: Row, text: string): Promise<Outcome> {
    if (!this.fcm) return { kind: 'failed', error: 'unconfigured' };
    const [target] = await this.db.select().from(pushTarget).where(eq(pushTarget.id, row.recipientId));
    if (!target) return { kind: 'failed', error: 'no-target' };
    const r = await this.fcm.send({
      token: target.token,
      body: text,
      data: {
        type: 'NOTICE',
        code: row.code,
        notificationId: row.id,
        ...(row.eventId ? { eventId: row.eventId } : {}),
        // T-061: aile uygulaması bildirime dokununca olay ekranını açar (kişi + olay).
        ...(row.protectedPersonId ? { protectedPersonId: row.protectedPersonId } : {}),
      },
      priority: row.urgency === 'URGENT' ? 'high' : 'normal',
      ttlSec: PUSH_TTL_SEC,
      collapseKey: row.dedupeKey.slice(0, 64),
    });
    if (r.status === 'ok') return { kind: 'sent', providerId: r.id };
    if (r.status === 'retry') return { kind: 'retry', error: r.reason };
    return { kind: 'failed', error: r.reason, invalidTarget: r.status === 'invalid-token' };
  }

  /**
   * Cihaz bildirimi: `{type: NOTICE, code, notificationId}`. DEVICE_RELAY (token'sız saat): köprü telefona
   * `forDeviceId` = saat ile gider; telefon bunu göstermez, Data Layer'dan saate `/yanimda/prompt` NOTICE iletir.
   */
  private async sendDevice(row: Row): Promise<Outcome> {
    const relay = row.recipientKind === 'DEVICE_RELAY';
    const target = relay ? await this.bridgeOf(row.protectedPersonId) : row.recipientId;
    if (!target) return { kind: 'failed', error: 'no-bridge' };
    const msg = {
      deviceId: target,
      priority: 'high' as const,
      ttlSec: PUSH_TTL_SEC,
      data: {
        type: 'NOTICE',
        code: row.code,
        notificationId: row.id,
        ...(relay ? { forDeviceId: row.recipientId } : {}),
      },
    };
    if (!(this.devicePush instanceof DevicePush)) {
      await this.devicePush.send(msg);
      return { kind: 'sent' };
    }
    const r = await this.devicePush.deliver(msg);
    if (r === 'sent' || r === 'relayed') return { kind: 'sent' };
    if (r === 'retry') return { kind: 'retry', error: r };
    return { kind: 'failed', error: r };
  }

  private async sendPhone(row: Row, text: string): Promise<Outcome> {
    if (!this.cpaas) return { kind: 'failed', error: 'unconfigured' };
    const [c] = await this.db.select({ phone: contact.phoneE164 }).from(contact).where(eq(contact.id, row.recipientId));
    if (!c) return { kind: 'failed', error: 'no-contact' };
    if (row.channel === 'VOICE')
      return { kind: 'sent', providerId: (await this.cpaas.ttsCall(c.phone, text)).providerCallId };
    return { kind: 'sent', providerId: (await this.cpaas.sendSms(c.phone, text, this.smsCallback(row.id))).providerId };
  }

  /** Katalog metni; {name}, {address} gönderim anında profilden (satırda saklanmaz). */
  private async render(row: Row): Promise<string> {
    const vars: Record<string, string | number> = { ...((row.vars as Record<string, string | number>) ?? {}) };
    const text = t(row.code);
    if (text.includes('{name}') || text.includes('{address}')) {
      const p = UUID.test(row.protectedPersonId)
        ? (
            await this.db
              .select({
                name: protectedPerson.displayName,
                line: protectedPerson.addressLine,
                district: protectedPerson.district,
                city: protectedPerson.city,
              })
              .from(protectedPerson)
              .where(eq(protectedPerson.id, row.protectedPersonId))
          )[0]
        : undefined;
      vars.name ??= p?.name ?? t('F-NAME-UNKNOWN');
      if (text.includes('{address}'))
        vars.address ??= p?.line ? [p.line, p.district, p.city].filter(Boolean).join(', ') : await this.eventPlace(row);
    }
    return t(row.code, 'tr', vars);
  }

  private async eventPlace(row: Row): Promise<string> {
    if (!row.eventId) return t('F-ADDRESS-UNKNOWN');
    const [e] = await this.db.select({ location: event.location }).from(event).where(eq(event.id, row.eventId));
    const loc = e?.location as { lat: number; lng: number } | null | undefined;
    return loc ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : t('F-ADDRESS-UNKNOWN');
  }

  private smsCallback(id: string) {
    const base = this.env.CPAAS_WEBHOOK_BASE?.replace(/\/+$/, '');
    return base ? `${base}/v1/webhooks/notify/sms?n=${id}` : undefined;
  }

  // ---- alıcılar ----

  private async familyTargets(personId: string): Promise<string[]> {
    if (!UUID.test(personId)) return [];
    const rows = await this.db
      .selectDistinct({ id: pushTarget.id })
      .from(pushTarget)
      .innerJoin(familyMember, eq(familyMember.subject, pushTarget.subject))
      .where(eq(familyMember.protectedPersonId, personId));
    return rows.map((r) => r.id);
  }

  /** Yakınlar (rehber CONTACT, öncelik sırasıyla). */
  /** Yaşlının aranacak numarası: rehberde ELDER (telefon), yoksa WATCH (LTE saat); öncelik sırasıyla ilki. */
  private async elderNumber(personId: string): Promise<string | null> {
    for (const role of ['ELDER', 'WATCH']) {
      const [c] = await this.db
        .select({ id: contact.id })
        .from(contact)
        .where(and(eq(contact.protectedPersonId, personId), eq(contact.role, role)))
        .orderBy(asc(contact.priority))
        .limit(1);
      if (c) return c.id;
    }
    return null;
  }

  private async familyContacts(personId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: contact.id })
      .from(contact)
      .where(and(eq(contact.protectedPersonId, personId), eq(contact.role, 'CONTACT')))
      .orderBy(asc(contact.priority));
    return rows.map((r) => r.id);
  }

  /** Kişinin etkin cihazları: kategori (kayıt, katalog, yoksa türden), push token'ı var mı; en son görülen önce. */
  private async elderDevices(personId: string) {
    if (!UUID.test(personId)) return [];
    const rows = await this.db
      .select({
        id: device.id,
        kind: device.kind,
        category: sql<string | null>`coalesce(${device.category}, ${deviceModel.category})`,
        hasToken: sql<boolean>`${device.pushToken} IS NOT NULL`,
      })
      .from(device)
      .leftJoin(deviceModel, sql`${deviceModel.id} = coalesce(${device.modelId}, ${device.kind})`)
      .where(and(eq(device.protectedPersonId, personId), isNull(device.revokedAt), isNull(device.retiredAt)))
      .orderBy(sql`${device.lastSeenAt} DESC NULLS LAST`, asc(device.id));
    return rows.map((r) => ({
      id: r.id,
      hasToken: r.hasToken,
      category: r.category ?? (r.kind.endsWith('PHONE') ? 'PHONE' : 'WATCH'),
    }));
  }

  /**
   * Yaşlıya giden bildirimin alıcıları, kodun katalog kanalına göre: saat metni (W-*, `watch`) yalnız saat
   * kategorisindeki cihazlara, telefon metni (P-*, `phone`) yalnız telefona; diğerleri push token'ı olan her cihaza.
   * Kendi push token'ı olmayan saat (Wear OS: FCM yok, telefona bağlı) bildirimi telefon üzerinden alır
   * (DEVICE_RELAY: alıcı saat, gönderimde köprü telefon çözülür).
   */
  private async elderRecipients(personId: string, code: string): Promise<{ kind: Row['recipientKind']; id: string }[]> {
    const devices = await this.elderDevices(personId);
    const channel = catalogs.tr[code]?.channel;
    if (channel === 'watch')
      return devices
        .filter((d) => d.category === 'WATCH')
        .map((d) => ({ kind: d.hasToken ? 'DEVICE' : 'DEVICE_RELAY', id: d.id }));
    const own = devices.filter((d) => d.hasToken && (channel !== 'phone' || d.category === 'PHONE'));
    return own.map((d) => ({ kind: 'DEVICE', id: d.id }));
  }

  /** Saatin köprüsü: kişinin push token'ı olan, en son görülen telefonu. */
  private async bridgeOf(personId: string): Promise<string | undefined> {
    return (await this.elderDevices(personId)).find((d) => d.category === 'PHONE' && d.hasToken)?.id;
  }

  // ---- uygulama uçları ----

  /** Aile/kişi uygulaması push token'ı (aynı token başka hesaba geçmişse taşınır). */
  async setPushTarget(subject: string, body: unknown, now = new Date()) {
    const b = (body ?? {}) as { platform?: unknown; token?: unknown };
    if (b.platform !== 'FCM') throw new BadRequestException('platform: FCM');
    if (typeof b.token !== 'string' || b.token.length < 20 || b.token.length > 4096)
      throw new BadRequestException('token geçersiz');
    await this.db
      .insert(pushTarget)
      .values({ id: uuidv7(), subject, platform: 'FCM', token: b.token, updatedAt: now })
      .onConflictDoUpdate({ target: pushTarget.token, set: { subject, updatedAt: now } });
  }

  async deletePushTarget(subject: string, token: string) {
    await this.db.delete(pushTarget).where(and(eq(pushTarget.subject, subject), eq(pushTarget.token, token)));
  }

  /** Uygulama bildirimi gösterdi: teslim edildi (INFO yedeği iptal). Başkasının bildirimi 404. */
  async ack(subject: string, id: string, now = new Date()) {
    if (!UUID.test(id)) throw new NotFoundException();
    const r = (await this.db.execute(sql`
      UPDATE notify.notification n SET status = 'delivered', delivered_at = ${now}
      FROM notify.push_target p
      WHERE n.id = ${id} AND n.recipient_kind = 'PUSH_TARGET' AND p.id::text = n.recipient_id AND p.subject = ${subject}
      RETURNING n.id`)) as unknown as { rows: unknown[] };
    if (!r.rows.length) throw new NotFoundException();
  }

  /** CPaaS SMS teslim raporu (imza denetleyicide doğrulanır). Durum geri gitmez. */
  async smsStatus(id: string, params: Record<string, string>, now = new Date()) {
    if (!UUID.test(id)) return;
    const s = params.MessageStatus ?? params.SmsStatus;
    const status = s === 'delivered' ? 'delivered' : s === 'failed' || s === 'undelivered' ? 'failed' : null;
    if (!status) return;
    await this.db
      .update(notification)
      .set(
        status === 'delivered'
          ? { status, deliveredAt: now }
          : { status, error: (params.ErrorCode ?? 'undelivered').slice(0, 40) },
      )
      .where(
        and(
          eq(notification.id, id),
          eq(notification.channel, 'SMS'),
          inArray(notification.status, ['sent', 'sending']),
        ),
      );
  }

  verifyWebhook(url: string, params: Record<string, string>, signature: string | undefined) {
    return !!this.cpaas?.verify(url, params, signature);
  }
}

function pick(r: Row) {
  return {
    dedupeKey: r.dedupeKey,
    code: r.code,
    audience: r.audience,
    urgency: r.urgency,
    protectedPersonId: r.protectedPersonId,
    eventId: r.eventId,
    vars: r.vars,
  };
}
