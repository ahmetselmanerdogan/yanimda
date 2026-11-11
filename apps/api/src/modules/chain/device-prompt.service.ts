import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit, Optional } from '@nestjs/common';
import { type EventState, type EventType, TOPICS } from '@yanimda/contracts';
import { and, eq, sql } from 'drizzle-orm';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import { auditLog, event } from '../../db/schema';
import { DeviceService } from '../device/device.service';
import type { PromptRequest } from '../device/device.types';
import { delivered } from '../device/push.port';
import { deviceSummaries } from '../event/coverage.service';
import { loadRulePack, ruleFor, RULES, type RulesProvider, staticRules } from '../event/rules.loader';

/** Soruyu yeniden göndermeyi gerektiren olay güncellemeleri: süre kısaldı (doğrulama) veya ikinci sessiz soru. */
const REPROMPT_REASONS = new Set(['CORROBORATED', 'LEARNING_MODE_REASK']);

/**
 * T-090 (docs/07 S3.3, S3.6, S7.5, S7.6) sunucunun cihaz sorusu. Olay cihaz sorusuna (DEVICE_PROMPT) girince — kuralın
 * `devicePrompt`'u açıksa (düşme, hareketsizlik) — alarmı açan cihaz(lar)a ve yaşlının telefonuna PROMPT push'u gider
 * (DeviceService.promptUser → adaptör). Soru süresi değişince (doğrulanmış düşme 30 sn, öğrenme modunda ikinci soru)
 * yeni bitişle yeniden gönderilir. Bitiş (`until`) olay kaydındaki `device_prompt_until`'dir: istemci bunu esas alır.
 * Aynı bitiş için bir kez (audit `device.prompt_pushed`); olay akışını bekletmez (yan şerit).
 */
@Injectable()
export class DevicePromptService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('DevicePrompt');
  private readonly rules: RulesProvider;
  private readonly devices: DeviceService;
  private unsub: (() => void)[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(RULES) rules?: RulesProvider,
    @Optional() @Inject(DeviceService) devices?: DeviceService,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
    this.devices = devices ?? new DeviceService(db);
  }

  onModuleInit() {
    this.subscribe();
  }
  onModuleDestroy() {
    this.unsub.forEach((u) => u());
    this.unsub = [];
  }

  /** Testler için ayrı bus. */
  subscribe(bus: LocalBus = globalBus) {
    this.onModuleDestroy();
    const run = (id: string) => this.onEvent(id).then(() => undefined);
    this.unsub = [
      bus.subscribe<{ eventId: string; to: EventState }>(
        TOPICS.eventTransitioned,
        (e) => (e.payload.to === 'DEVICE_PROMPT' ? run(e.payload.eventId) : Promise.resolve()),
        { lane: 'side', name: 'device.prompt' },
      ),
      bus.subscribe<{ eventId: string; reason?: string }>(
        TOPICS.eventUpdated,
        (e) => (REPROMPT_REASONS.has(e.payload.reason ?? '') ? run(e.payload.eventId) : Promise.resolve()),
        { lane: 'side', name: 'device.prompt' },
      ),
    ];
  }

  /** Olay hâlâ cihaz sorusundaysa soruyu gönder. Ulaşılan cihaz sayısı (tekrar / gereksizse 0). */
  async onEvent(eventId: string, now = new Date()): Promise<number> {
    const [ev] = await this.db
      .select({
        id: event.id,
        type: event.type,
        state: event.state,
        personId: event.protectedPersonId,
        until: event.devicePromptUntil,
        sources: event.sourceDeviceIds,
      })
      .from(event)
      .where(eq(event.id, eventId));
    if (!ev || ev.state !== 'DEVICE_PROMPT' || !ev.until || ev.until.getTime() <= now.getTime()) return 0;
    const dp = ruleFor(this.rules.current(), ev.type as EventType)?.devicePrompt;
    if (!dp?.enabled || !dp.tts) return 0; // bekleme olayları (saat çıkarıldı, kapsama boşluğu) soru değildir
    const until = ev.until.toISOString();
    const [done] = await this.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, ev.id),
          eq(auditLog.action, 'device.prompt_pushed'),
          sql`${auditLog.data}->>'until' = ${until}`,
        ),
      )
      .limit(1);
    if (done) return 0;
    const summaries = await deviceSummaries(this.db, this.rules.current(), ev.personId, now);
    const phones = summaries.filter((d) => d.category === 'PHONE').map((d) => d.id);
    // Önce telefon(lar): kendi token'ı olmayan saatin sorusu zaten o telefona gider (telefon saate iletir), saate ayrıca
    // aktarılmaz.
    const targets = [...new Set([...phones, ...ev.sources])];
    const req: PromptRequest = {
      eventId: ev.id,
      kind: ev.type,
      tts: dp.tts,
      windowSec: Math.ceil((ev.until.getTime() - now.getTime()) / 1000),
      until,
      silent: dp.silent ?? false,
    };
    let sent = 0;
    let viaPhone = 0;
    const reached = new Set<string>();
    const outcomes: Record<string, number> = {};
    for (const id of targets) {
      try {
        const bridge = phones.includes(id) ? null : await this.devices.relayBridgeOf(id);
        if (bridge && reached.has(bridge)) {
          viaPhone++; // telefonun kendi kopyası saate de iletilir
          continue;
        }
        const o = await this.devices.promptUser(id, req);
        outcomes[o] = (outcomes[o] ?? 0) + 1;
        if (delivered(o)) {
          sent++;
          reached.add(id);
        }
      } catch (e) {
        this.log.warn(`Soru gönderilemedi (olay=${ev.id}): ${safeError(e)}`);
      }
    }
    await this.db.insert(auditLog).values({
      actorKind: 'SYSTEM',
      action: 'device.prompt_pushed',
      entityType: 'event',
      entityId: ev.id,
      data: { until, devices: targets.length, sent, viaPhone, outcomes },
    });
    return sent;
  }
}
