import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type EventType, TOPICS } from '@yanimda/contracts';
import { eq } from 'drizzle-orm';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { DB, type Db } from '../../db/client';
import { auditLog, event } from '../../db/schema';

/**
 * Tarama kaynak önekleri → kendi olay türü. T-086: kapsama zamanlayıcıları (şarj boşluğu, kapsama yok) KAPSAMA
 * BOŞLUĞU açar; eski cihaz taraması önekleri (battery-dead, connection-lost) sürüm geçişinde açık kalmış olaylar için.
 */
const SWEEP_SOURCES: [prefix: string, type: EventType][] = [
  ['coverage-gap:', 'COVERAGE_GAP'],
  ['coverage-none:', 'COVERAGE_GAP'],
  // T-087 YERİNDE KONTROL: kapsama zamanlayıcısı (welfare:) ve kaçırılan yanınızdayız araması (welfare-wellness:).
  ['welfare:', 'WELFARE_CHECK'],
  ['welfare-wellness:', 'WELFARE_CHECK'],
  ['battery-dead:', 'BATTERY_DEAD'],
  ['connection-lost:', 'CONNECTION_LOST'],
];
/** Serbest bırakılan kaynağın yeni adı: tekrar ayıklaması (`hasSource`, birebir eşleşme) artık onu bulmaz. */
export const RELEASED_SUFFIX = '#released';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Denetim bulgusu (yutulan tespit): taramanın KAPSAMA BOŞLUĞU (eskiden BATTERY_DEAD / CONNECTION_LOST) tespiti kişinin açık olayına
 * eklenir (attachToOpen). O olay başka türdense (ör. 20:00 WATCH_OFF beklemesi, düzenli arama CALLBACK'i) ve
 * tespitle ilgilenilmeden kapanırsa (23:00 gece penceresi → SUPPRESSED) tespit kaybolur: tarama aynı
 * `<cihaz>:<son görülme>` anahtarını tekrar üretir ama kaynak kimliği kapanmış olayda durduğu için yeni olay açılmaz.
 *
 * Çözüm (olay motoruna dokunmadan): olay kapanınca (`event.closed`, yan şerit) içine başka türden eklenmiş tarama
 * kaynakları `#released` ekiyle yeniden adlandırılır (audit `event.source_released`). Cihaz hâlâ sessizse sonraki
 * taramada (EVENT_SWEEP_MS) kendi olayı açılır — ya da yine açık bir olaya eklenir ve o kapanınca tekrar serbest
 * kalır. Cihaz geri geldiyse son görülme değiştiği için tarama hiçbir şey üretmez. Kendi türündeki olayın kaynağı
 * (BATTERY_DEAD olayının battery-dead kaynağı) serbest bırakılmaz: o tespit operatörce ele alındı.
 * Log'a kişi/cihaz kimliği yazılmaz.
 */
@Injectable()
export class AbsorbedSourceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AbsorbedSource');
  private unsub?: () => void;

  constructor(@Inject(DB) private readonly db: Db) {}

  onModuleInit() {
    this.subscribe();
  }
  onModuleDestroy() {
    this.unsub?.();
  }

  /** Yan şerit: bozulursa SOS teslimini bekletmez; kendi kuyruğunda yeniden denenir (işlem idempotent). */
  subscribe(bus: LocalBus = globalBus) {
    this.unsub?.();
    this.unsub = bus.subscribe<{ id: string }>(
      TOPICS.eventClosed,
      (e) => this.onClosed(e.payload.id).then(() => undefined),
      { lane: 'side', name: 'event.absorbed-release' },
    );
  }

  /** Kapanmış olaydaki başka türden tarama kaynaklarını serbest bırakır. Serbest bırakılan sayısı. */
  async onClosed(eventId: string): Promise<number> {
    if (!UUID.test(eventId)) return 0;
    return this.db.transaction(async (tx) => {
      const [ev] = await tx
        .select({ type: event.type, state: event.state, sources: event.sourceSignalIds })
        .from(event)
        .where(eq(event.id, eventId))
        .for('update');
      if (!ev || ev.state !== 'CLOSED') return 0;
      const released: string[] = [];
      const sources = ev.sources.map((sid) => {
        const own = SWEEP_SOURCES.find(([prefix]) => sid.startsWith(prefix));
        if (!own || own[1] === ev.type || sid.endsWith(RELEASED_SUFFIX)) return sid;
        released.push(own[1]);
        return `${sid}${RELEASED_SUFFIX}`;
      });
      if (!released.length) return 0;
      await tx.update(event).set({ sourceSignalIds: sources }).where(eq(event.id, eventId));
      await tx.insert(auditLog).values({
        actorKind: 'SYSTEM',
        action: 'event.source_released',
        entityType: 'event',
        entityId: eventId,
        data: { eventType: ev.type, released },
      });
      this.log.log(`Kapanan ${ev.type} olayına eklenmiş ${released.join(', ')} tespiti yeniden değerlendirilecek`);
      return released.length;
    });
  }
}
