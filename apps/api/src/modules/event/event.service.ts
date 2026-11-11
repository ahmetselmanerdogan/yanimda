import { randomInt } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  type DeviceRole,
  type EventState,
  type EventType,
  type FalseAlarm,
  type FalseAlarmCause,
  type KafkaEnvelope,
  type NotifyRequest,
  type Signal,
  type SupervisorAlert,
  TOPICS,
} from '@yanimda/contracts';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { bus } from '../../common/bus';
import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { type TimerJob, type TimerKind, TIMERS, type Timers } from '../../common/timers/timers';
import { DB, type Db, type Tx } from '../../db/client';
import { auditLog } from '../../db/schema';
import { familyNoticeFor } from '../notify/policy';
import { type DeviceFact, isAlarmWearable } from './coverage';
import { decide, type Notice } from './decide';
import { type ActorKind, type EventRecord, EventRepository, type TransitionRecord } from './event.repository';
import { assertTransition } from './event-state-machine';
import { answerAllowed, betterLocation, corroborates, corroborationPair, type FusedLocation } from './fusion';
import { isInWindow } from './night';
import { type CoverageUpdate, type ProtectionChange, ProtectionService } from './protection.service';
import {
  fusionOf,
  loadRulePack,
  type Rule,
  ruleFor,
  type RulePack,
  RULES,
  type RulesProvider,
  staticRules,
} from './rules.loader';
import { NEVER_SCREEN, SCREENING_NOTE, type ScreeningResult, type VoiceScreener } from './voice-screening';

export type { EventRecord, QueueItem } from './event.repository';

/** Olay kaynağı: sinyal, zamanlayıcı (follow-up) veya cihaz taraması. */
interface EventSource {
  protectedPersonId: string;
  sourceId: string;
  location?: Signal['location'];
  /** CREATED geçişinin notu (ör. T-071 eşik görüşmesi). */
  note?: string;
  /** Açık olay varsa ekleme, açma (düzenli arama: süren olaya karışmasın). */
  exclusive?: boolean;
  /** T-088: sinyali gönderen cihaz ve rolü, sunucunun aldığı an (doğrulama penceresi). */
  deviceId?: string;
  deviceRole?: DeviceRole;
  at?: string;
  /** T-088 + T-086: kişinin şu an şarjdaki cihazları (kapsama olguları) — şarjdaki cihazın düşmesi doğrulamaz. */
  chargingDeviceIds?: string[];
}

/** Bir transaction içindeki olay değişiklikleri; flush ile tek seferde yazılır. */
interface Uow {
  tx: Tx;
  ev: EventRecord;
  isNew: boolean;
  dirty: boolean;
  transitions: TransitionRecord[];
  publishes: { topic: string; payload: unknown }[];
  /** Commit'ten SONRA çalışacak işler (ör. zamanlayıcı iptali). */
  after: (() => Promise<void>)[];
}

/** Bekleme olayları: cihaz sorusu yok, kişinin bir şey yapması (saati takması) beklenir; süre dolunca operatör. */
const WAITING_TYPES = new Set<EventType>(['WATCH_OFF']);
/** Cihazdan "iyiyim" ile kapanmayan olaylar (soru cihaza değil, sesli ön elemeyle kişiye sorulur). */
const NOT_DEVICE_ANSWERABLE = new Set<EventType>(['WATCH_OFF', 'COVERAGE_GAP']);
/** Gerçek alarm türleri: alarm olmayan açık olaya gelirse olayı yükseltir (attachToOpen). */
const ALARM_TYPES = new Set<EventType>(['SOS', 'FALL', 'INACTIVITY']);
/** Operatör kararını vermiş, yalnız kapatılmayı bekleyen durumlar: yeni gerçek alarm bunlara eklenmez, yeni olay açar. */
const SUPERSEDABLE = new Set<EventState>(['CONFIRMED_OK', 'CANCELLED_BY_USER']);
const WAIT_TIMERS: TimerKind[] = [
  'prompt-expire',
  'silent-ask-expire',
  'learning-ask-expire',
  'watch-off-remind',
  'watch-off-operator',
  'voice-screen-expire',
];

/** Operatörün elindeki durumlar (kilit, kapatma, zincir). */
export const OPERATOR_STATES = new Set<EventState>([
  'OPERATOR_ASSIGNED',
  'CONTACT_CHAIN',
  'CONFIRMED_OK',
  'CONFIRMED_EMERGENCY',
  'DISPATCH',
]);
export const DEFAULT_FOLLOW_UP_HOURS = 24;
/** T-063: aynı kişi için iki test arası en az. */
export const TEST_COOLDOWN_MS = 10 * 60_000;
export const MAX_FOLLOW_UP_HOURS = 168;
const CLOSE_OUTCOMES = new Set(['OK', 'EMERGENCY', 'FALSE_ALARM', 'TEST', 'UNREACHABLE']);
/** D-04 operatör kilidi süresi (varsayılan 300 sn); her operatör isteği uzatır. */
export const operatorLockMs = () => Number(process.env.OPERATOR_LOCK_SEC ?? 300) * 1000;

/** EventService.operate içinde zincir modülüne verilen işlem bağlamı (aynı transaction). */
export interface OperatorCtx {
  ev: EventRecord;
  tx: Tx;
  now: Date;
  rule: Rule | undefined;
  rulesVersion: number;
  transition(to: EventState, note?: string): void;
  publish(topic: string, payload: unknown): void;
  /** Kapat; followUpAfterHours: takip araması (EMERGENCY'de zorunlu, verilmezse kural varsayılanı). */
  finish(outcome: string, note?: string, followUpAfterHours?: number, notified112?: boolean): Promise<void>;
}

const pgCode = (e: unknown) =>
  (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;

/**
 * D-02 olay üretimi (T-012: kural paketi + karar tablosu), D-03/D-04 kuyruk, D-09 zamanlayıcılar,
 * D-10 geçiş kaydı (T-011b).
 *
 * Kalıcılık: olay event.event'te, geçişler event.transition'da. Her işlem tek transaction'da:
 * olay satırı FOR UPDATE kilitlenir → durum değişir → geçiş + audit.log + outbox (event.*) yazılır → commit.
 * Zamanlayıcılar commit'ten ÖNCE kurulur, iptaller commit'ten SONRA yapılır.
 * Periyodik tarama: süresi geçmiş cihaz sorusu/bekleme → operatör; kapsama (T-085/T-086): gece, susan cihaz, şarj
 * boşluğu ve "kapsama yok" zamanlayıcıları → KAPSAMA BOŞLUĞU (eski BATTERY_DEAD / CONNECTION_LOST taraması yerine).
 */
@Injectable()
export class EventService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('EventService');
  private readonly rules: RulesProvider;
  private readonly repo: EventRepository;
  private readonly protection: ProtectionService;
  private sweepTimer?: NodeJS.Timeout;
  private unsubscribe?: () => void;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Inject(TIMERS) private readonly timers: Timers,
    @Optional() @Inject(RULES) rules?: RulesProvider | RulePack,
  ) {
    this.rules = rules && 'current' in rules ? rules : staticRules((rules as RulePack | undefined) ?? loadRulePack());
    this.repo = new EventRepository(db);
    this.protection = new ProtectionService(db, outbox, this.rules);
  }

  private get pack(): RulePack {
    return this.rules.current();
  }

  onModuleInit() {
    this.unsubscribe = bus.subscribe<Signal>(TOPICS.signalReceived, (e) => this.onSignal(e));
    this.registerTimerHandlers();
  }

  onApplicationBootstrap() {
    const every = Number(process.env.EVENT_SWEEP_MS ?? 30_000);
    if (every > 0) {
      const tick = () =>
        Promise.all([this.recoverOverdue(), this.sweepProtection(), this.releaseExpiredLocks()])
          .catch((e) => this.log.error(`Tarama başarısız: ${safeError(e)}`))
          .finally(() => (this.sweepTimer = setTimeout(tick, every)));
      void tick();
    }
  }

  onModuleDestroy() {
    clearTimeout(this.sweepTimer);
    this.unsubscribe?.();
  }

  // ---- Okuma ----
  async get(id: string): Promise<EventRecord> {
    const ev = await this.repo.get(id);
    if (!ev) throw new NotFoundException('Olay yok');
    return ev;
  }
  queue(): Promise<EventRecord[]> {
    return this.repo.queue();
  }
  all(): Promise<EventRecord[]> {
    return this.repo.all();
  }
  queuePage(page: { limit: number; offset: number }) {
    return this.repo.queuePage(page);
  }
  queueItem(id: string) {
    return this.repo.queueItem(id);
  }

  /**
   * E-02 amir: üstlenmeyi geri al (olay kuyruğa döner, zincir kaldığı yerden sürer). Teyitli olay (CONFIRMED_*,
   * DISPATCH) kuyruğa dönemez: operatörsüz bırakılır, başka operatör üstlenince devralır.
   */
  async unclaim(id: string, supervisorId: string, reason?: string): Promise<EventRecord> {
    const ev = await this.withEvent(id, async (u) => {
      if (!OPERATOR_STATES.has(u.ev.state)) throw new ConflictException('Bu durumda geri alınamaz');
      const previous = u.ev.operatorId ?? null;
      u.ev.operatorId = undefined;
      u.ev.lockUntil = undefined;
      u.dirty = true;
      if (u.ev.state === 'OPERATOR_ASSIGNED' || u.ev.state === 'CONTACT_CHAIN')
        this.transition(u, 'OPERATOR_QUEUE', 'OPERATOR', supervisorId, reason ?? 'amir geri aldı');
      else {
        // Teyitli olay kuyruğa dönemez (durum makinesi); operatörsüz bırakılır, ilk üstlenen devralır.
        await this.repo.insertAudit(u.tx, {
          actorKind: 'OPERATOR',
          actorId: supervisorId,
          action: 'event.released',
          entityId: u.ev.id,
          data: { from: previous, state: u.ev.state },
        });
        u.publishes.push({
          topic: TOPICS.eventUpdated,
          payload: { eventId: u.ev.id, operatorId: null, previousOperatorId: previous, reason: 'RELEASED' },
        });
      }
      return u.ev;
    });
    if (!ev) throw new NotFoundException('Olay yok');
    return ev;
  }

  // ---- D-09 zamanlayıcı işleyicileri: GÜNCEL durumu kilitli okur, beklenen durumda değilse no-op ----
  private registerTimerHandlers() {
    const expire =
      (note: string) =>
      async ({ eventId }: TimerJob) => {
        const found = await this.withEvent(eventId, async (u) => {
          if (u.ev.state === 'DEVICE_PROMPT') this.escalate(u, note);
        });
        if (found === null) this.log.warn(`Zamanlayıcı: olay bulunamadı ${eventId}`);
      };
    this.timers.on('prompt-expire', expire('cevap yok'));
    this.timers.on('silent-ask-expire', (job) => this.onSilentAskExpired(job));
    this.timers.on('learning-ask-expire', this.screenOrEscalate('2. sessiz soru cevapsız'));
    this.timers.on('watch-off-operator', this.screenOrEscalate('saat takılmadı'));
    this.timers.on('voice-screen-expire', async ({ eventId }) => {
      await this.resolveScreening(eventId, { status: 'NO_ANSWER', reason: 'TIMEOUT' }, { hangup: true });
    });
    this.timers.on('watch-off-remind', async ({ eventId }) => {
      await this.withEvent(eventId, async (u) => {
        if (u.ev.state !== 'DEVICE_PROMPT') return;
        await this.notify(u.tx, u.ev.protectedPersonId, [{ code: 'P-WATCH-OFF-2H', audience: 'ELDER' }], {
          dedupeBase: `watch-off-remind:${u.ev.id}`,
          eventId: u.ev.id,
        });
      });
    });
    this.timers.on('follow-up', async ({ eventId }) => {
      const src = await this.repo.get(eventId);
      if (!src) return void this.log.warn(`Takip: kaynak olay bulunamadı ${eventId}`);
      await this.create('FOLLOW_UP', {
        protectedPersonId: src.protectedPersonId,
        sourceId: `follow-up:${eventId}`,
        location: src.location,
      });
    });
  }

  /**
   * Sessiz soru cevapsız. D-06 (T-070): kişi öğrenme modundaysa ve kural `learningMode.extraSilentAsks` veriyorsa
   * operatöre düşmeden önce bir kez daha sessizce sorulur (cihaza ELDER bildirimi, kuralın tts kodu); o da
   * cevapsızsa yükseltilir. SOS/FALL'da sessiz soru yoktur, değişmez. Yükseltmeden önce otomatik sesli ön eleme
   * (T-072, `screenOrEscalate`).
   */
  private async onSilentAskExpired({ eventId }: TimerJob) {
    const pack = this.pack;
    const found = await this.withEvent(eventId, async (u) => {
      if (u.ev.state !== 'DEVICE_PROMPT') return;
      const rule = ruleFor(pack, u.ev.type);
      const extra = rule?.learningMode?.extraSilentAsks ?? 0;
      const now = new Date();
      if (extra > 0 && rule?.devicePrompt?.silent && (await this.inLearningMode(u.tx, u.ev.protectedPersonId, now))) {
        const win = (rule.devicePrompt.windowSec ?? 60) * 1000;
        u.ev.devicePromptUntil = new Date(now.getTime() + win).toISOString();
        u.dirty = true;
        await this.repo.insertAudit(u.tx, {
          actorKind: 'SYSTEM',
          action: 'event.prompt_repeated',
          entityId: u.ev.id,
          data: { reason: 'LEARNING_MODE', ask: 2, windowSec: win / 1000 },
        });
        u.publishes.push({
          topic: TOPICS.eventUpdated,
          payload: { eventId: u.ev.id, devicePromptUntil: u.ev.devicePromptUntil, reason: 'LEARNING_MODE_REASK' },
        });
        if (rule.devicePrompt.tts)
          await this.notify(u.tx, u.ev.protectedPersonId, [{ code: rule.devicePrompt.tts, audience: 'ELDER' }], {
            dedupeBase: `learning-ask:${u.ev.id}`,
            eventId: u.ev.id,
          });
        await this.timers.schedule(u.ev.id, 'learning-ask-expire', win); // commit'ten önce (bkz. sınıf notu)
        return;
      }
      if (!(await this.startScreening(u))) this.escalate(u, 'cevap yok');
    });
    if (found === null) this.log.warn(`Zamanlayıcı: olay bulunamadı ${eventId}`);
  }

  // ---- T-072 (D-12) otomatik sesli ön eleme ----

  private screener: VoiceScreener | null = null;
  /** ScreeningModule bağlar (döngüsel bağımlılık yerine port). */
  useScreener(s: VoiceScreener) {
    this.screener = s;
  }

  /** Bekleme/soru cevapsız: ön eleme başlatılabiliyorsa başlat, yoksa yükselt. */
  private screenOrEscalate(note: string) {
    return async ({ eventId }: TimerJob) => {
      const found = await this.withEvent(eventId, async (u) => {
        if (u.ev.state === 'DEVICE_PROMPT' && !(await this.startScreening(u))) this.escalate(u, note);
      });
      if (found === null) this.log.warn(`Zamanlayıcı: olay bulunamadı ${eventId}`);
    };
  }

  /**
   * Kural `autoVoiceScreening` açıksa (asla SOS/FALL) ön eleme satırı aynı transaction'da yazılır, olay cihaz
   * sorusunda kalır ve süresi ön eleme süresine uzar (tarama güvenlik ağı), süre zamanlayıcısı commit'ten önce kurulur,
   * arama commit'ten sonra başlar. Başladıysa true.
   */
  private async startScreening(u: Uow): Promise<boolean> {
    const rule = ruleFor(this.pack, u.ev.type);
    if (!this.screener || !rule?.autoVoiceScreening?.enabled || NEVER_SCREEN.has(u.ev.type)) return false;
    const s = await this.screener.prepare(u.tx, {
      eventId: u.ev.id,
      protectedPersonId: u.ev.protectedPersonId,
      type: u.ev.type,
      rule,
    });
    if (!s) return false;
    if (!s.fresh) return true; // süren ön eleme (zamanlayıcının tekrar teslimi)
    const ms = s.timeoutSec * 1000;
    u.ev.devicePromptUntil = new Date(Date.now() + ms).toISOString();
    u.dirty = true;
    await this.repo.insertAudit(u.tx, {
      actorKind: 'SYSTEM',
      action: 'event.voice_screening_started',
      entityId: u.ev.id,
      data: { timeoutSec: s.timeoutSec },
    });
    u.publishes.push({
      topic: TOPICS.eventUpdated,
      payload: { eventId: u.ev.id, devicePromptUntil: u.ev.devicePromptUntil, reason: 'VOICE_SCREENING' },
    });
    await this.timers.schedule(u.ev.id, 'voice-screen-expire', ms); // commit'ten önce (bkz. sınıf notu)
    const screener = this.screener;
    u.after.push(() => screener.dial(u.ev.id));
    return true;
  }

  /**
   * Ön eleme sonucu (webhook, süre, arama hatası). İlk sonuç kazanır ve her durumda kaydedilir; olay hâlâ cihaz
   * sorusundaysa OK → kullanıcı adına SYSTEM kapatır (sonuç OK; yanlış alarm sayılmaz), diğerleri → kuyruk.
   * OK sonucu öğrenme modunda (ilk ay) kural oranıyla operatör örneklemine (CALLBACK P4) alınır. Uygulandıysa true.
   */
  async resolveScreening(eventId: string, r: ScreeningResult, opts: { hangup?: boolean } = {}): Promise<boolean> {
    const screener = this.screener;
    if (!screener) return false;
    const pack = this.pack;
    const applied = await this.withEvent(eventId, async (u) => {
      const live = u.ev.state === 'DEVICE_PROMPT';
      const rate = ruleFor(pack, u.ev.type)?.autoVoiceScreening?.operatorSampleRate ?? 0;
      const sampled =
        live &&
        r.status === 'OK' &&
        rate > 0 &&
        randomInt(1_000_000) < rate * 1_000_000 && // örnekleme (güvenlik değil); proje kuralı Math.random'ı yasaklar
        (await this.inLearningMode(u.tx, u.ev.protectedPersonId, new Date()));
      if (!(await screener.finish(u.tx, eventId, r, sampled))) return false;
      u.after.push(() => this.timers.cancel(eventId, 'voice-screen-expire'));
      if (opts.hangup) u.after.push(() => screener.hangup(eventId));
      if (!live) return true; // olay başka yoldan ilerledi; sonuç yalnız kayıtlı
      if (r.status === 'OK' && WAITING_TYPES.has(u.ev.type)) {
        // İnceleme bulgusu 7: "iyiyim" saatin takıldığı anlamına gelmez. Olay kapanmaz: kişiye hatırlatma gider,
        // bekleme bir kez uzar (remindAfterMin); saat takılınca (ON_BODY) kendiliğinden kapanır, yoksa ikinci ön
        // eleme yapılmaz (olay başına bir) → operatör.
        const rule = ruleFor(pack, u.ev.type);
        const ms = (rule?.remindAfterMin ?? 120) * 60_000;
        u.ev.devicePromptUntil = new Date(Date.now() + ms).toISOString();
        u.dirty = true;
        await this.repo.insertAudit(u.tx, {
          actorKind: 'SYSTEM',
          action: 'event.wait_extended',
          entityId: u.ev.id,
          data: { reason: 'VOICE_SCREENING_OK', minutes: ms / 60_000 },
        });
        u.publishes.push({
          topic: TOPICS.eventUpdated,
          payload: { eventId: u.ev.id, devicePromptUntil: u.ev.devicePromptUntil, reason: 'SCREENING_OK_WAIT' },
        });
        await this.notify(u.tx, u.ev.protectedPersonId, [{ code: 'P-WATCH-OFF-2H', audience: 'ELDER' }], {
          dedupeBase: `watch-off-screen-ok:${u.ev.id}`,
          eventId: u.ev.id,
        });
        await this.timers.schedule(u.ev.id, 'watch-off-operator', ms); // commit'ten önce (bkz. sınıf notu)
      } else if (r.status === 'OK') {
        this.transition(u, 'CANCELLED_BY_USER', 'SYSTEM', undefined, `${SCREENING_NOTE.OK} (${r.input ?? '-'})`);
        this.close(u, 'OK', 'sesli ön eleme', 'SYSTEM');
        u.after.push(() => this.cancelWaitTimers(eventId));
        if (sampled)
          u.after.push(async () => {
            await this.raiseCallback(
              u.ev.protectedPersonId,
              `voice-screen-sample:${eventId}`,
              'sesli ön eleme örneklemesi',
            );
          });
      } else this.escalate(u, SCREENING_NOTE[r.status]);
      return true;
    });
    if (applied === null) this.log.warn(`Ön eleme: olay bulunamadı ${eventId}`);
    return !!applied;
  }

  private async inLearningMode(tx: Tx, protectedPersonId: string, now: Date): Promise<boolean> {
    const until = (await this.protection.settingsOf(protectedPersonId, tx)).learningModeUntil;
    return !!until && until > now;
  }

  /**
   * T-071: kişiye "eşik görüşmesi" CALLBACK olayı (P4) açar. Aynı kaynak için bir kez; kişinin açık olayı varsa ona
   * eklenir. Yeni olay açıldıysa true.
   */
  /**
   * Sistem geri çekmesi (denetim bulgu 7a): henüz operatöre geçmemiş (CREATED / DEVICE_PROMPT / OPERATOR_QUEUE) ALARM
   * OLMAYAN olayı kapatır — ör. penceresi dolan düzenli arama geri araması kuyrukta kalıp sonraki tespitleri yutmasın.
   * Gerçek alarma yükseltilmiş veya operatördeki olaya dokunmaz (false).
   */
  async closeBySystem(id: string, outcome: string, reason: string): Promise<boolean> {
    const r = await this.withEvent(id, async (u) => {
      if (ALARM_TYPES.has(u.ev.type)) return false;
      if (u.ev.state === 'DEVICE_PROMPT') this.transition(u, 'CANCELLED_BY_USER', 'SYSTEM', undefined, reason);
      else if (u.ev.state !== 'CREATED' && u.ev.state !== 'OPERATOR_QUEUE') return false;
      this.close(u, outcome, reason, 'SYSTEM');
      u.after.push(() => this.cancelWaitTimers(u.ev.id));
      return true;
    });
    return r === true;
  }

  raiseCallback(protectedPersonId: string, sourceId: string, note: string, exclusive = false): Promise<boolean> {
    return this.create('CALLBACK', { protectedPersonId, sourceId, note, exclusive });
  }

  // ---- Taramalar ----

  /** Süresi (+ pay) geçmiş DEVICE_PROMPT olaylarını (cihaz sorusu, saat bekleme) yükseltir. */
  async recoverOverdue(graceMs = Number(process.env.EVENT_SWEEP_GRACE_MS ?? 20_000)): Promise<number> {
    let n = 0;
    for (const id of await this.repo.overduePromptIds(new Date(Date.now() - graceMs))) {
      await this.withEvent(id, async (u) => {
        if (u.ev.state !== 'DEVICE_PROMPT') return;
        this.escalate(u, 'süre doldu (tarama)');
        n++;
      });
    }
    if (n) this.log.warn(`Tarama: ${n} gecikmiş soru/bekleme yükseltildi`);
    return n;
  }

  private promptKind(rule: Rule): TimerKind {
    return rule.devicePrompt?.silent ? 'silent-ask-expire' : 'prompt-expire';
  }

  // ---- Sinyal işleme (outbox → bus) ----
  private async onSignal(e: KafkaEnvelope<Signal>) {
    const s = e.payload;
    const upd = await this.protection.applySignal(s); // D-05 / T-085: her sinyal kapsama olgularını günceller
    let night = false;
    if (s.kind === 'OFF_BODY') {
      const w = await this.protection.sleepWindowOf(s.protectedPersonId);
      night = isInWindow(new Date(s.occurredAt), w.timezone, w.start, w.end);
    }
    // T-070: kişiye özel hareketsizlik eşiği (öğrenilmiş veya aile ayarı).
    const inactivityMin =
      s.kind === 'INACTIVITY' ? (await this.protection.settingsOf(s.protectedPersonId)).inactivityMin : null;
    const fact = upd.facts.devices[s.deviceId];
    const d = decide(s, {
      pack: this.pack,
      night,
      inactivityMin,
      charging: fact?.charging ?? false,
      alarmWorn: upd.coverage.worn.length > 0,
      alarmWearable: fact ? isAlarmWearable(fact) : true,
    });
    switch (d.action) {
      case 'answer':
        await this.onUserAnswer(s, fact);
        break;
      case 'on-body':
        await this.autoCloseWatchOff(s.protectedPersonId, 'saat takıldı');
        break;
      case 'charge-start':
        await this.autoCloseWatchOff(s.protectedPersonId, 'şarja takıldı');
        break;
      case 'notify':
        await this.db.transaction((tx) =>
          this.notify(tx, s.protectedPersonId, d.notices, { dedupeBase: `signal:${s.idempotencyKey}` }),
        );
        break;
      case 'ignore':
        // S3.4: şarjındaki saatten düşme en sık yanlış düşmedir; yok sayılır ama denetime yazılır (PII yok).
        await this.db.insert(auditLog).values({
          actorKind: 'SYSTEM',
          action: 'signal.ignored',
          entityType: 'signal',
          entityId: s.idempotencyKey,
          data: { kind: s.kind, reason: d.reason },
        });
        this.log.log(`${s.kind} yok sayıldı (${d.reason})`);
        break;
      case 'create':
        await this.create(d.type, {
          protectedPersonId: s.protectedPersonId,
          sourceId: s.idempotencyKey,
          location: s.location,
          deviceId: s.deviceId,
          deviceRole: s.source?.role,
          at: s.receivedAt ?? s.occurredAt,
          chargingDeviceIds: Object.values(upd.facts.devices)
            .filter((d) => d.charging)
            .map((d) => d.id),
        });
        break;
      case 'none':
        break;
    }
    if (s.location) await this.fuseLocation(s);
    await this.onCoverageUpdate(upd);
  }

  /**
   * D-05 / T-085 kapsama taraması: gece başlangıcı/bitişi, susan cihazlar, şarj boşluğu ve "kapsama yok"
   * zamanlayıcıları. Değişen (veya iş üreten) kişi sayısını döner.
   */
  async sweepProtection(now = new Date()): Promise<number> {
    const updates = await this.protection.sweep(now);
    for (const u of updates) await this.onCoverageUpdate(u);
    return updates.length;
  }

  /** Kapsama değerlendirmesinin olay sonuçları (commit'ten sonra). */
  private async onCoverageUpdate(u: CoverageUpdate) {
    if (u.protection) await this.onProtectionChange(u.protection, u);
    for (const a of u.events) {
      if (a.kind === 'gap-event')
        // Not = neden kodu (CHARGING / WATCH_OFF / BATTERY_DEAD / CONNECTION_LOST); konsol O-UI-GAP-<neden>.
        await this.create('COVERAGE_GAP', {
          protectedPersonId: u.protectedPersonId,
          sourceId: a.sourceId,
          note: a.reason,
        });
      else await this.closeCoverageGap(u.protectedPersonId);
    }
  }

  /** Kapsama geri geldi: operatörün henüz üstlenmediği KAPSAMA BOŞLUĞU olayı sistemce kapanır. */
  private async closeCoverageGap(protectedPersonId: string) {
    const r = (await this.db.execute(sql`
      SELECT id FROM event.event
      WHERE protected_person_id = ${protectedPersonId} AND type = 'COVERAGE_GAP' AND state <> 'CLOSED'`)) as unknown as {
      rows: { id: string }[];
    };
    for (const { id } of r.rows) await this.closeBySystem(id, 'OK', 'kapsama geri geldi');
  }

  /**
   * Koruma değişikliğinin olay sonuçları:
   * - NIGHT'a geçiş: bekleyen WATCH_OFF gece operatöre düşmesin diye kapanır.
   * - NIGHT'tan çıkış ve hiçbir A sınıfı cihaz takılı değil, biri bilerek çıkarılmış (şarj dışı): sabah WATCH_OFF
   *   beklemesi açılır (gün başına bir kez).
   */
  private async onProtectionChange(c: ProtectionChange, u: CoverageUpdate) {
    if (c.to === 'NIGHT') {
      await this.withOpenEvent(c.protectedPersonId, async (w) => {
        if (w.ev.type !== 'WATCH_OFF' || w.ev.state !== 'DEVICE_PROMPT') return;
        this.transition(w, 'CANCELLED_BY_USER', 'SYSTEM', undefined, 'gece penceresi');
        this.close(w, 'SUPPRESSED', 'gece penceresi', 'SYSTEM');
        w.after.push(() => this.cancelWaitTimers(w.ev.id));
      });
    } else if (c.from === 'NIGHT' && u.coverage.offBody) {
      await this.create('WATCH_OFF', {
        protectedPersonId: c.protectedPersonId,
        sourceId: `watch-off-morning:${c.protectedPersonId}:${c.at.toISOString().slice(0, 10)}`,
      });
    }
  }

  /**
   * T-063 (C-05) test çağrısı: aile/yönetici isteğiyle TEST olayı (P4, isTest, 112'siz; operatör kurulum metniyle
   * arar). Aynı istek anahtarı aynı olayı döner. Açık olay varsa 409; 10 dk içinde ikinci test 429.
   */
  async requestTest(protectedPersonId: string, requestKey: string, now = new Date()): Promise<{ eventId: string }> {
    const sourceId = `test-sos:${requestKey}`;
    const find = async () => {
      const r = (await this.db.execute(sql`
        SELECT id FROM event.event WHERE ${sourceId} = ANY(source_signal_ids) LIMIT 1`)) as unknown as {
        rows: { id: string }[];
      };
      return r.rows[0]?.id;
    };
    const same = await find();
    if (same) return { eventId: same };
    const r = (await this.db.execute(sql`
      SELECT count(*) FILTER (WHERE state <> 'CLOSED')::int AS open,
             count(*) FILTER (WHERE type = 'TEST' AND created_at > ${new Date(now.getTime() - TEST_COOLDOWN_MS)})::int AS recent
      FROM event.event WHERE protected_person_id = ${protectedPersonId}`)) as unknown as {
      rows: { open: number; recent: number }[];
    };
    const { open, recent } = r.rows[0] ?? { open: 0, recent: 0 };
    if (open) throw new ConflictException('Açık olay var; test şimdi başlatılamaz');
    if (recent) throw new HttpException('Son 10 dakikada test yapıldı', HttpStatus.TOO_MANY_REQUESTS);
    await this.create('TEST', { protectedPersonId, sourceId });
    const id = await find();
    if (!id) throw new ConflictException('Test olayı açılamadı');
    return { eventId: id };
  }

  /** Olay açar veya kişinin açık olayına ekler. Yeni olay açıldıysa true. */
  private async create(type: EventType, s: EventSource, retry = true): Promise<boolean> {
    const rule = ruleFor(this.pack, type);
    if (!rule) {
      this.log.warn(`Kural yok: ${type}`);
      return false;
    }
    const after: Uow['after'] = [];
    let created = false;
    try {
      await this.db.transaction(async (tx) => {
        // Outbox en az bir kez teslim eder: aynı kaynak ikinci kez olay açmasın.
        if (await this.repo.hasSource(tx, s.sourceId)) return;
        const open = await this.repo.findOpenForUpdate(tx, s.protectedPersonId);
        if (open && s.exclusive) return;
        // Denetim bulgu 1: "iyi" teyit edilmiş (kapatılmayı bekleyen) olay yeni gerçek alarmı yutmaz — sistem eski olayı
        // kapatır, alarm yeni olay olarak kendi akışına girer (SOS kuyruğa P1, 112 yolu açık).
        let superseded: Uow | undefined;
        if (open && ALARM_TYPES.has(type) && SUPERSEDABLE.has(open.state)) {
          superseded = this.uow(tx, open, after);
          superseded.ev.lockUntil = undefined;
          this.close(superseded, 'OK', `yeni ${type} alarmı geldi; yeni olay açıldı`, 'SYSTEM');
          await this.flush(superseded);
          const id = superseded.ev.id;
          superseded.after.push(() => this.cancelWaitTimers(id));
        } else if (open) return this.attachToOpen(this.uow(tx, open, after), type, s.sourceId, s);

        const now = new Date();
        const u = this.uow(tx, this.newRecord(type, rule, s, now), after, true);
        u.publishes.push({ topic: TOPICS.eventCreated, payload: u.ev });
        if (superseded)
          await this.repo.insertAudit(tx, {
            actorKind: 'SYSTEM',
            action: 'event.superseded',
            entityId: superseded.ev.id,
            data: { by: u.ev.id, alarm: type, sourceId: s.sourceId },
          });
        this.transition(u, 'CREATED', 'SYSTEM', undefined, s.note);
        if (rule.devicePrompt?.enabled) {
          // T-061 (C-09): düşme sorusunun süresi aile ayarıyla (30–90 sn) değişebilir.
          const personal =
            type === 'FALL' ? (await this.protection.settingsOf(s.protectedPersonId, tx)).fallPromptSec : null;
          const win = (personal ?? rule.devicePrompt.windowSec ?? 60) * 1000;
          u.ev.devicePromptUntil = new Date(now.getTime() + win).toISOString();
          this.transition(
            u,
            'DEVICE_PROMPT',
            'SYSTEM',
            undefined,
            `prompt ${rule.devicePrompt.tts ?? ''} ${win / 1000}s`,
          );
          await this.flush(u);
          await this.timers.schedule(u.ev.id, this.promptKind(rule), win); // commit'ten önce (bkz. sınıf notu)
        } else if (WAITING_TYPES.has(type) && rule.operatorAfterMin) {
          const wait = rule.operatorAfterMin * 60_000;
          u.ev.devicePromptUntil = new Date(now.getTime() + wait).toISOString();
          this.transition(u, 'DEVICE_PROMPT', 'SYSTEM', undefined, `bekleniyor ${rule.operatorAfterMin} dk`);
          await this.flush(u);
          await this.timers.schedule(u.ev.id, 'watch-off-operator', wait);
          if (rule.remindAfterMin)
            await this.timers.schedule(u.ev.id, 'watch-off-remind', rule.remindAfterMin * 60_000);
        } else if (type === 'COVERAGE_GAP' && rule.autoVoiceScreening?.enabled && this.screener) {
          // T-086 (S5.4): kapsama boşluğunda önce sesli ön eleme (kişiye), sonuç yoksa / olumsuzsa operatör.
          u.ev.devicePromptUntil = now.toISOString();
          this.transition(u, 'DEVICE_PROMPT', 'SYSTEM', undefined, 'sesli ön eleme');
          await this.flush(u);
          if (!(await this.startScreening(u))) this.escalate(u, 'ön eleme yapılamadı');
          await this.flush(u);
        } else {
          this.escalate(u, 'cihaz sorusu yok');
          await this.flush(u);
        }
        created = true;
      });
    } catch (e) {
      // Eş zamanlı ikinci açık olay tekil indekse takıldı → bir kez daha dene (bu kez açık olaya eklenir).
      if (retry && pgCode(e) === '23505') return this.create(type, s, false);
      throw e;
    }
    await this.runAfter(after);
    return created;
  }

  /**
   * D-02 adım 3: açık olay varken yeni kaynak eklenir; SOS ise öncelik 1'e çekilir ve bekleme varsa hemen yükseltilir.
   * Gerçek alarm (SOS/FALL/INACTIVITY) alarm olmayan bir olaya (TEST, CALLBACK, FOLLOW_UP, WATCH_OFF, pil, bağlantı)
   * gelirse olay o alarma YÜKSELTİLİR: tür, öncelik ve test bayrağı değişir (112 adımı zincire girer), bekleme varsa
   * hemen operatöre gider, kuyruğa daha önce girmişse aileye alarm bildirimi ayrıca planlanır.
   */
  private async attachToOpen(u: Uow, type: EventType, sourceId: string, src?: EventSource) {
    u.ev.sourceSignalIds.push(sourceId);
    u.dirty = true;
    // T-088 (S3.3): ikinci sinyal olaya kaynak olarak eklenir; farklı cihazdan pencere içinde düşme → doğrulanmış.
    if (src?.deviceId && !u.ev.sourceDeviceIds.includes(src.deviceId)) {
      u.ev.sourceDeviceIds.push(src.deviceId);
      const charging = new Set(src.chargingDeviceIds ?? []);
      if (
        type === 'FALL' &&
        u.ev.type === 'FALL' &&
        !u.ev.corroboratedAt &&
        corroborationPair(u.ev.sourceDeviceIds, src.deviceId, charging)
      )
        await this.corroborate(u, src);
    }
    // Alarm olmayan olay her gerçek alarma; hareketsizlik (en hafif alarm) düşme / SOS'a yükseltilir (denetim bulgu 2:
    // düşme hareketsizlik sorusunda P2 kalıp ses ön elemesine gitmesin).
    const upgrade =
      ALARM_TYPES.has(type) && (!ALARM_TYPES.has(u.ev.type) || (u.ev.type === 'INACTIVITY' && type !== 'INACTIVITY'));
    const rule = ruleFor(this.pack, type);
    // Eklenen tespitin kendi önceliği daha acilse olay ona çekilir (bulgu 7b: P4 geri aramaya pil bitti → P3).
    const to = upgrade
      ? Math.min(u.ev.priority, rule?.priority ?? 1)
      : type === 'SOS'
        ? 1
        : Math.min(u.ev.priority, rule?.priority ?? u.ev.priority);
    if (to < u.ev.priority) {
      await this.repo.insertAudit(u.tx, {
        actorKind: 'SYSTEM',
        action: 'event.priority_raised',
        entityId: u.ev.id,
        data: { from: u.ev.priority, to, reason: type, sourceId },
      });
      u.publishes.push({
        topic: TOPICS.eventUpdated,
        payload: { eventId: u.ev.id, priority: to, previousPriority: u.ev.priority, reason: type },
      });
      u.ev.priority = to;
    }
    if (upgrade) await this.upgradeType(u, type, sourceId);
    if ((type === 'SOS' || upgrade) && u.ev.state === 'DEVICE_PROMPT') {
      this.escalate(u, `${type} geldi`);
      u.after.push(() => this.cancelWaitTimers(u.ev.id));
    } else if (upgrade && u.ev.state === 'CREATED') this.escalate(u, `${type} geldi`);
    else if (type === 'COVERAGE_GAP' && WAITING_TYPES.has(u.ev.type) && u.ev.state === 'DEVICE_PROMPT') {
      // T-086: bekleyen "saat çıkarıldı" sürerken kapsama boşluğu süresi doldu → beklemeden operatöre.
      this.escalate(u, 'kapsama boşluğu');
      u.after.push(() => this.cancelWaitTimers(u.ev.id));
    } else if (ALARM_TYPES.has(type) && !upgrade && OPERATOR_STATES.has(u.ev.state))
      // Denetim bulgu 9: operatördeki olaya yeni alarm — olay aynı, konsol uyarır (ses + vurgu).
      u.publishes.push({
        topic: TOPICS.eventUpdated,
        payload: { eventId: u.ev.id, priority: u.ev.priority, reason: 'NEW_ALARM', alarm: type, sourceId },
      });
    this.log.log(`Açık olaya ${type} kaynağı eklendi (olay=${u.ev.id}${upgrade ? ', yükseltildi' : ''})`);
    await this.flush(u);
  }

  /**
   * T-088 (S3.3): iki farklı cihaz `fusion.corroborateSec` içinde düşme bildirdi → olay doğrulanmış. Cihaz sorusu
   * sürüyorsa süresi soru açılışından `corroboratedPromptSec`'e iner (daha kısa değil; aile ayarı zaten kısaysa
   * değişmez); süre geçtiyse hemen kuyruğa. Konsol "2 cihaz" görür; zincir doğrulayan cihazı önce arar (T-087).
   */
  private async corroborate(u: Uow, src: EventSource) {
    const f = fusionOf(this.pack);
    const now = new Date();
    if (!corroborates(u.ev.createdAt, src.at ?? now.toISOString(), f.corroborateSec)) return;
    u.ev.corroboratedAt = now.toISOString();
    await this.repo.insertAudit(u.tx, {
      actorKind: 'SYSTEM',
      action: 'event.corroborated',
      entityId: u.ev.id,
      data: { devices: u.ev.sourceDeviceIds.length, by: src.deviceId, role: src.deviceRole ?? null },
    });
    u.publishes.push({
      topic: TOPICS.eventUpdated,
      payload: {
        eventId: u.ev.id,
        corroborated: true,
        sourceDeviceCount: u.ev.sourceDeviceIds.length,
        reason: 'CORROBORATED',
      },
    });
    if (u.ev.state !== 'DEVICE_PROMPT' || !u.ev.devicePromptUntil) return;
    const askedAt = [...u.ev.transitions].reverse().find((t) => t.to === 'DEVICE_PROMPT')?.at ?? u.ev.createdAt;
    const until = Date.parse(askedAt) + f.corroboratedPromptSec * 1000;
    if (until >= Date.parse(u.ev.devicePromptUntil)) return;
    const id = u.ev.id;
    if (until <= now.getTime()) {
      this.escalate(u, 'doğrulanmış düşme');
      u.after.push(() => this.cancelWaitTimers(id));
      return;
    }
    u.ev.devicePromptUntil = new Date(until).toISOString();
    const rule = ruleFor(this.pack, u.ev.type);
    const kind = rule ? this.promptKind(rule) : 'prompt-expire';
    // Kısa süre: eski iş iptal, yenisi kurulur (commit sonrası; arada çökme olursa tarama devicePromptUntil'i görür).
    u.after.push(async () => {
      await this.timers.cancel(id, kind);
      await this.timers.schedule(id, kind, Math.max(0, until - Date.now()));
    });
  }

  /**
   * T-088 (S3.7): açık P1/P2 olayda konum en taze ve en doğru kaynaktan yeniden birleştirilir (yeni GPS > cihaz >
   * telefon ağı). Konsola yalnız kaynak ve an gider (koordinat olay kaydında; log'a yazılmaz).
   */
  private async fuseLocation(s: Signal) {
    const f = fusionOf(this.pack);
    await this.withOpenEvent(s.protectedPersonId, async (u) => {
      if (u.ev.priority > 2 || !s.location) return;
      const incoming: FusedLocation = { ...s.location, at: s.occurredAt };
      if (!betterLocation(u.ev.location as FusedLocation | undefined, incoming, new Date(), f.gpsFreshSec)) return;
      u.ev.location = incoming;
      u.dirty = true;
      u.publishes.push({
        topic: TOPICS.eventUpdated,
        payload: {
          eventId: u.ev.id,
          reason: 'LOCATION_FUSED',
          locationSource: incoming.source ?? null,
          at: incoming.at,
        },
      });
    });
  }

  private async upgradeType(u: Uow, type: EventType, sourceId: string) {
    const from = { type: u.ev.type, isTest: u.ev.isTest };
    await this.repo.insertAudit(u.tx, {
      actorKind: 'SYSTEM',
      action: 'event.type_upgraded',
      entityId: u.ev.id,
      data: { from: from.type, to: type, wasTest: from.isTest, sourceId },
    });
    u.ev.type = type;
    u.ev.isTest = false;
    u.publishes.push({
      topic: TOPICS.eventUpdated,
      payload: { eventId: u.ev.id, type, previousType: from.type, priority: u.ev.priority, reason: 'UPGRADED' },
    });
    // Kuyruğa girişte aile bildirimi (ESCALATED → OPERATOR_QUEUE) eski türle gitti/gitmedi; alarm bildirimi şimdi.
    if (u.ev.state !== 'CREATED' && u.ev.state !== 'DEVICE_PROMPT') {
      const code = familyNoticeFor(
        { id: u.ev.id, type, isTest: false, confirmedOutcome: null },
        { to: 'OPERATOR_QUEUE' },
      );
      if (code)
        await this.notify(u.tx, u.ev.protectedPersonId, [{ code, audience: 'FAMILY' }], {
          dedupeBase: `event:${u.ev.id}`,
          eventId: u.ev.id,
        });
    }
  }

  private escalate(u: Uow, note: string) {
    if (u.ev.state !== 'CREATED' && u.ev.state !== 'DEVICE_PROMPT') return;
    u.ev.escalatedAt = new Date().toISOString();
    this.transition(u, 'ESCALATED', 'SYSTEM', undefined, note);
    this.transition(u, 'OPERATOR_QUEUE', 'SYSTEM');
    this.log.warn(`KUYRUK: ${u.ev.type} P${u.ev.priority} olay=${u.ev.id}`);
  }

  /**
   * Cihaz sorusuna cevap (CANCEL / OK). İnceleme bulgusu 9: cevap soruya bağlanır —
   *  - sunucuya soru açıldıktan SONRA ulaşmış olmalı (receivedAt ≥ DEVICE_PROMPT geçişi; sunucu saati). Geciken veya
   *    outbox'tan yeniden teslim edilen eski bir cevap sonradan açılan yeni olayı iptal etmez;
   *  - cihaz `payload.eventId` gönderiyorsa açık olayla aynı olmalı.
   * Uymayan cevap yok sayılır (audit `event.answer_ignored`).
   */
  private async onUserAnswer(s: Signal, fact?: DeviceFact) {
    await this.withOpenEvent(s.protectedPersonId, async (u) => {
      // Yalnız cihaz sorusu cevaplanır; WATCH_OFF beklemesi saat takılınca (ON_BODY), KAPSAMA BOŞLUĞU kapsama
      // geri gelince kapanır.
      if (u.ev.state !== 'DEVICE_PROMPT' || NOT_DEVICE_ANSWERABLE.has(u.ev.type)) return;
      const askedAt = [...u.ev.transitions].reverse().find((t) => t.to === 'DEVICE_PROMPT')?.at;
      const answeredAt = s.receivedAt ?? s.occurredAt;
      const forEvent = typeof s.payload?.eventId === 'string' ? s.payload.eventId : undefined;
      // T-088 (S3.6): soru penceresi içinde ve yalnız izinli cihazdan (alarmı açan, takılı A sınıfı, telefon "İyiyim").
      // Takılı / şarj / sınıf T-085 kapsama olgusundan (sinyal uygulandıktan sonra: sinyaldeki bilgi, yoksa son bilinen).
      const allowed = answerAllowed(u.ev.sourceDeviceIds, {
        deviceId: s.deviceId,
        device: fact,
        role: s.source?.role,
        screen: s.payload?.screen,
      });
      const reason =
        forEvent !== undefined && forEvent !== u.ev.id
          ? 'OTHER_EVENT'
          : askedAt && Date.parse(answeredAt) < Date.parse(askedAt)
            ? 'BEFORE_PROMPT'
            : u.ev.devicePromptUntil && Date.parse(answeredAt) > Date.parse(u.ev.devicePromptUntil)
              ? 'AFTER_PROMPT'
              : !allowed
                ? 'DEVICE_NOT_ALLOWED'
                : null;
      if (reason) {
        await this.repo.insertAudit(u.tx, {
          actorKind: 'SYSTEM',
          action: 'event.answer_ignored',
          entityId: u.ev.id,
          data: { reason, kind: s.kind, idempotencyKey: s.idempotencyKey },
        });
        this.log.warn(`Cevap yok sayıldı (${reason}) olay=${u.ev.id}`);
        return;
      }
      u.ev.cancelledByDeviceId = s.deviceId;
      this.transition(u, 'CANCELLED_BY_USER', 'USER', s.deviceId, 'kullanıcı iyiyim dedi');
      this.close(u, 'FALSE_ALARM', 'kullanıcı iptali', 'SYSTEM', undefined, 'USER_CANCEL');
      u.after.push(() => this.cancelWaitTimers(u.ev.id));
      // T-088 (S3.6): doğrulanmış düşme başka bir cihazdan iptal edildi (bir cihazın alarmını öteki kapattı) → olay
      // kapanır ama aynı gün P4 takip araması planlanır (ucuz sigorta; kural paketi bayrağı).
      const f = fusionOf(this.pack);
      if (
        f.crossCancelFollowUp &&
        u.ev.corroboratedAt &&
        u.ev.type === 'FALL' &&
        u.ev.sourceDeviceIds.some((d) => d !== s.deviceId)
      ) {
        await this.repo.insertAudit(u.tx, {
          actorKind: 'SYSTEM',
          action: 'event.follow_up_planned',
          entityId: u.ev.id,
          data: { minutes: f.crossCancelFollowUpMin, reason: 'CROSS_DEVICE_CANCEL', by: s.deviceId },
        });
        await this.timers.schedule(u.ev.id, 'follow-up', f.crossCancelFollowUpMin * 60_000); // commit'ten önce
      }
    });
  }

  /** Saat takıldı (ON_BODY) veya şarja takıldı (CHARGE_START, T-086): bekleyen / kuyruktaki WATCH_OFF kapanır. */
  private async autoCloseWatchOff(subject: string, note: string) {
    await this.withOpenEvent(subject, async (u) => {
      if (u.ev.type !== 'WATCH_OFF') return;
      if (u.ev.state !== 'DEVICE_PROMPT' && u.ev.state !== 'OPERATOR_QUEUE') return;
      if (u.ev.state === 'DEVICE_PROMPT') this.transition(u, 'CANCELLED_BY_USER', 'USER', undefined, note);
      else {
        this.transition(u, 'OPERATOR_ASSIGNED', 'SYSTEM');
        this.transition(u, 'CONFIRMED_OK', 'SYSTEM', undefined, note);
      }
      this.close(u, 'OK', note, 'SYSTEM');
      u.after.push(() => this.cancelWaitTimers(u.ev.id));
    });
  }

  private async cancelWaitTimers(eventId: string) {
    for (const k of WAIT_TIMERS) await this.timers.cancel(eventId, k);
    await this.screener?.abort(eventId); // T-072: bekleyen ön eleme iptal, süren arama kapanır
  }

  // ---- Konsol tarafı (E-02, E-07; T-021 zincir bunun üstünde) ----

  /**
   * Operatör işlemi: olay kilitlenir, sahiplik denetlenir, operatör kilidi (lock_until) uzatılır, fn aynı
   * transaction'da çalışır (zincir adımları + olay geçişleri + outbox birlikte yazılır). claim: kuyruktaki olayı
   * üstlenir (aynı operatöre tekrar → aynı sonuç; başkasında → 409).
   */
  async operate<T>(
    id: string,
    operatorId: string,
    fn: (c: OperatorCtx) => Promise<T>,
    opts: { claim?: boolean; now?: Date } = {},
  ): Promise<T> {
    const now = opts.now ?? new Date();
    const found = await this.withEvent(id, async (u) => {
      if (opts.claim) {
        if (u.ev.state === 'OPERATOR_QUEUE') {
          u.ev.operatorId = operatorId;
          this.transition(u, 'OPERATOR_ASSIGNED', 'OPERATOR', operatorId);
        } else if (
          OPERATOR_STATES.has(u.ev.state) &&
          u.ev.operatorId !== operatorId &&
          (!u.ev.lockUntil || new Date(u.ev.lockUntil) <= now)
        ) {
          // Kilidi dolmuş (veya amirce bırakılmış) olay devralınır; teyitli olay (CONFIRMED_*, DISPATCH) dahil —
          // durum değişmez, zincir yeni operatörle sürer.
          const previous = u.ev.operatorId ?? null;
          await this.repo.insertAudit(u.tx, {
            actorKind: 'OPERATOR',
            actorId: operatorId,
            action: 'event.taken_over',
            entityId: u.ev.id,
            data: { from: previous, state: u.ev.state },
          });
          u.ev.operatorId = operatorId;
          u.publishes.push({
            topic: TOPICS.eventUpdated,
            payload: { eventId: u.ev.id, operatorId, previousOperatorId: previous, reason: 'TAKEN_OVER' },
          });
        } else if (u.ev.operatorId !== operatorId || !OPERATOR_STATES.has(u.ev.state)) {
          throw new ConflictException(u.ev.operatorId ? 'Başka operatör üstlendi' : 'Olay kuyrukta değil');
        }
      } else if (u.ev.operatorId !== operatorId || !OPERATOR_STATES.has(u.ev.state)) {
        throw new ConflictException('Olay sizde değil');
      }
      u.ev.lockUntil = new Date(now.getTime() + operatorLockMs()).toISOString();
      u.dirty = true;
      const ctx: OperatorCtx = {
        ev: u.ev,
        tx: u.tx,
        now,
        rule: ruleFor(this.pack, u.ev.type),
        rulesVersion: this.pack.version,
        transition: (to, note) => this.transition(u, to, 'OPERATOR', operatorId, note),
        publish: (topic, payload) => u.publishes.push({ topic, payload }),
        finish: (outcome, note, hours, notified112) => this.finish(u, operatorId, outcome, note, hours, notified112),
      };
      return { value: await fn(ctx) };
    });
    if (!found) throw new NotFoundException('Olay yok');
    return found.value;
  }

  async claim(id: string, operatorId: string): Promise<EventRecord> {
    return this.operate(id, operatorId, async (c) => c.ev, { claim: true });
  }

  async closeByOperator(id: string, operatorId: string, outcome: string, note?: string): Promise<EventRecord> {
    return this.operate(id, operatorId, async (c) => {
      await c.finish(outcome, note);
      return c.ev;
    });
  }

  /**
   * E-07 kapatma: bulunulan duruma göre CONFIRMED_* / DISPATCH üzerinden CLOSED. Takip araması (T-024): EMERGENCY'de
   * zorunlu (verilmezse kuralın followUpAfterHours'u, o da yoksa 24 saat); diğer sonuçlarda istenirse.
   */
  /**
   * Kapanış. Acil teyitli olay yalnız 112 gerçekten arandıysa DISPATCH üzerinden kapanır (zincirde 112 adımı ulaşıldı
   * → zaten DISPATCH; zincir dışında arandıysa `notified112`). 112 aranmadan acil kapanış (aile kendi götürdü vb.)
   * DISPATCH'siz: sahte 112 süreci ve aileye "ambulans yolda" gitmez; audit `event.closed_without_112` + amir uyarısı.
   */
  private async finish(
    u: Uow,
    operatorId: string,
    outcome: string,
    note?: string,
    followUpAfterHours?: number,
    notified112 = false,
  ) {
    if (!CLOSE_OUTCOMES.has(outcome)) throw new BadRequestException('Geçersiz sonuç');
    if (
      followUpAfterHours !== undefined &&
      (!Number.isInteger(followUpAfterHours) || followUpAfterHours < 1 || followUpAfterHours > MAX_FOLLOW_UP_HOURS)
    )
      throw new BadRequestException(`Takip 1–${MAX_FOLLOW_UP_HOURS} saat arası olmalı`);
    const op = (to: EventState, n?: string) => this.transition(u, to, 'OPERATOR', operatorId, n);
    const emergency = outcome === 'EMERGENCY';
    // Denetim bulgu 4: ulaşılamayan gerçek SOS / düşme. 112 arandıysa acil yolu (DISPATCH, ambulans takibi); aranmadıysa
    // kapanır ama audit + amir uyarısı (sessiz kapanış olmasın).
    const unreachableAlarm = outcome === 'UNREACHABLE' && !u.ev.isTest && (u.ev.type === 'SOS' || u.ev.type === 'FALL');
    switch (u.ev.state) {
      case 'OPERATOR_ASSIGNED':
      case 'CONTACT_CHAIN':
        if (emergency) op('CONFIRMED_EMERGENCY', note);
        else if (unreachableAlarm && notified112) op('CONFIRMED_EMERGENCY', 'ulaşılamadı; 112 arandı');
        else if (outcome === 'UNREACHABLE') {
          if (u.ev.state === 'OPERATOR_ASSIGNED') op('CONTACT_CHAIN');
        } else op('CONFIRMED_OK', note);
        break;
      case 'CONFIRMED_OK':
        if (emergency) throw new ConflictException('Olay iyi olarak teyit edildi; acil kapatılamaz');
        break;
      case 'CONFIRMED_EMERGENCY':
      case 'DISPATCH':
        if (!emergency) throw new ConflictException('Acil teyitli olay yalnız EMERGENCY ile kapanır');
        break;
      default:
        throw new ConflictException('Olay kapatılamaz');
    }
    if (u.ev.state === 'CONFIRMED_EMERGENCY') {
      if (notified112) op('DISPATCH', '112 arandı (zincir dışında)');
      else {
        await this.repo.insertAudit(u.tx, {
          actorKind: 'OPERATOR',
          actorId: operatorId,
          action: 'event.closed_without_112',
          entityId: u.ev.id,
          data: { type: u.ev.type },
        });
        if (!u.ev.isTest) {
          const alert: SupervisorAlert = {
            code: 'O-CLOSE-NO-112',
            eventId: u.ev.id,
            eventType: u.ev.type,
            operatorId,
            at: new Date().toISOString(),
          };
          u.publishes.push({ topic: TOPICS.supervisorAlert, payload: alert });
        }
      }
    }
    if (unreachableAlarm && !notified112) {
      await this.repo.insertAudit(u.tx, {
        actorKind: 'OPERATOR',
        actorId: operatorId,
        action: 'event.closed_without_112',
        entityId: u.ev.id,
        data: { type: u.ev.type, outcome },
      });
      const alert: SupervisorAlert = {
        code: 'O-CLOSE-UNREACHABLE-NO-112',
        eventId: u.ev.id,
        eventType: u.ev.type,
        operatorId,
        at: new Date().toISOString(),
      };
      u.publishes.push({ topic: TOPICS.supervisorAlert, payload: alert });
    }
    u.ev.lockUntil = undefined;
    this.close(u, outcome, note ?? '', 'OPERATOR', operatorId);
    const hours = emergency
      ? (followUpAfterHours ?? ruleFor(this.pack, u.ev.type)?.followUpAfterHours ?? DEFAULT_FOLLOW_UP_HOURS)
      : followUpAfterHours;
    if (hours) {
      await this.repo.insertAudit(u.tx, {
        actorKind: 'OPERATOR',
        actorId: operatorId,
        action: 'event.follow_up_planned',
        entityId: u.ev.id,
        data: { hours },
      });
      await this.timers.schedule(u.ev.id, 'follow-up', hours * 3600 * 1000); // commit'ten önce
    }
  }

  /**
   * D-04 operatör kilidi: süresi dolan olay kuyruğa döner (OPERATOR_ASSIGNED / CONTACT_CHAIN), teyit edilmiş olay
   * operatörde kalır; her iki durumda amir uyarısı outbox'a yazılır (olay başına kilit süresi başına bir kez).
   */
  async releaseExpiredLocks(now = new Date()): Promise<number> {
    let n = 0;
    for (const id of await this.repo.expiredLockIds(now)) {
      await this.withEvent(id, async (u) => {
        if (!u.ev.lockUntil || new Date(u.ev.lockUntil) > now || !OPERATOR_STATES.has(u.ev.state)) return;
        const operatorId = u.ev.operatorId;
        u.ev.lockUntil = undefined;
        u.dirty = true;
        if (u.ev.state === 'OPERATOR_ASSIGNED' || u.ev.state === 'CONTACT_CHAIN') {
          u.ev.operatorId = undefined;
          this.transition(u, 'OPERATOR_QUEUE', 'SYSTEM', undefined, 'operatör kilidi doldu');
        }
        const alert: SupervisorAlert = {
          code: 'O-LOCK-LOST',
          eventId: u.ev.id,
          eventType: u.ev.type,
          ...(operatorId ? { operatorId } : {}),
          at: now.toISOString(),
        };
        u.publishes.push({ topic: TOPICS.supervisorAlert, payload: alert });
        n++;
      });
    }
    if (n) this.log.warn(`Kilit: ${n} olayın operatör kilidi doldu`);
    return n;
  }

  // ---- Bildirim isteği (T-053 tüketir) ----
  private async notify(
    tx: Tx,
    protectedPersonId: string,
    notices: Notice[],
    opts: { dedupeBase: string; eventId?: string },
  ) {
    for (const n of notices) {
      const payload: NotifyRequest = {
        code: n.code,
        audience: n.audience,
        protectedPersonId,
        dedupeKey: `${opts.dedupeBase}:${n.code}`,
        ...(opts.eventId ? { eventId: opts.eventId } : {}),
      };
      await this.outbox.publish(
        TOPICS.notifyRequested,
        this.envelope(TOPICS.notifyRequested, protectedPersonId, payload),
        tx,
      );
    }
  }

  // ---- Birim iş (unit of work) ----

  private uow(tx: Tx, ev: EventRecord, after: Uow['after'], isNew = false): Uow {
    return { tx, ev, isNew, dirty: false, transitions: [], publishes: [], after };
  }

  private newRecord(type: EventType, rule: Rule, s: EventSource, now: Date): EventRecord {
    return {
      id: uuidv7(),
      protectedPersonId: s.protectedPersonId,
      type,
      priority: rule.priority,
      state: 'CREATED',
      createdAt: now.toISOString(),
      location: s.location ?? undefined,
      sourceSignalIds: [s.sourceId],
      sourceDeviceIds: s.deviceId ? [s.deviceId] : [],
      isTest: type === 'TEST',
      transitions: [],
    };
  }

  /** Olayı kilitleyip fn'i çalıştırır, değişiklikleri tek transaction'da yazar. Olay yoksa null. */
  private async withEvent<T>(id: string, fn: (u: Uow) => Promise<T>): Promise<T | null | undefined> {
    return this.unitOfWork((tx) => this.repo.findForUpdate(tx, id), fn);
  }

  private async withOpenEvent<T>(protectedPersonId: string, fn: (u: Uow) => Promise<T>) {
    return this.unitOfWork((tx) => this.repo.findOpenForUpdate(tx, protectedPersonId), fn);
  }

  private async unitOfWork<T>(
    load: (tx: Tx) => Promise<EventRecord | null>,
    fn: (u: Uow) => Promise<T>,
  ): Promise<T | null | undefined> {
    const after: Uow['after'] = [];
    const result = await this.db.transaction(async (tx) => {
      const ev = await load(tx);
      if (!ev) return null;
      const u = this.uow(tx, ev, after);
      const r = await fn(u);
      await this.flush(u);
      return r;
    });
    await this.runAfter(after);
    return result;
  }

  private async runAfter(after: Uow['after']) {
    for (const a of after) await a().catch((e) => this.log.warn(`Commit sonrası iş başarısız: ${safeError(e)}`));
  }

  /**
   * Olayı kapatır. FALSE_ALARM (test olayı hariç) aynı transaction'da `event.false_alarm` yayınlar (T-071, D-07):
   * neden verilmezse operatör kapatması OPERATOR sayılır.
   */
  private close(
    u: Uow,
    outcome: string,
    reason: string,
    actorKind: 'SYSTEM' | 'OPERATOR',
    actorId?: string,
    cause?: FalseAlarmCause,
  ) {
    u.ev.confirmedOutcome = outcome;
    u.ev.closedAt = new Date().toISOString();
    u.ev.closeReason = reason;
    this.transition(u, 'CLOSED', actorKind, actorId, reason);
    u.publishes.push({ topic: TOPICS.eventClosed, payload: u.ev });
    const why = cause ?? (actorKind === 'OPERATOR' ? 'OPERATOR' : undefined);
    if (outcome === 'FALSE_ALARM' && why && !u.ev.isTest) {
      const fa: FalseAlarm = {
        protectedPersonId: u.ev.protectedPersonId,
        eventId: u.ev.id,
        eventType: u.ev.type,
        cause: why,
        at: u.ev.closedAt,
      };
      u.publishes.push({ topic: TOPICS.eventFalseAlarm, payload: fa });
    }
  }

  private transition(u: Uow, to: EventState, actorKind: ActorKind, actorId?: string, note?: string) {
    const from = u.transitions.length || !u.isNew || u.ev.transitions.length ? u.ev.state : undefined;
    if (from) assertTransition(from, to);
    u.ev.state = to;
    const t: TransitionRecord = { id: uuidv7(), from, to, actorKind, actorId, at: new Date().toISOString(), note };
    u.ev.transitions.push(t);
    u.transitions.push(t);
    u.publishes.push({
      topic: TOPICS.eventTransitioned,
      payload: { eventId: u.ev.id, from, to, note, actorKind, actorId, at: t.at },
    });
  }

  private envelope<T>(topic: string, subject: string, payload: T): KafkaEnvelope<T> {
    return {
      eventId: uuidv7(),
      type: topic,
      version: 1,
      occurredAt: new Date().toISOString(),
      countryCode: this.pack.country,
      subjectUserId: subject,
      payload,
    };
  }

  /** Olay satırı + geçişler + audit + outbox — çağıranın transaction'ında. */
  private async flush(u: Uow) {
    if (u.isNew) {
      await this.repo.insert(u.tx, u.ev);
      u.isNew = false;
    } else if (u.dirty || u.transitions.length || u.publishes.length) await this.repo.update(u.tx, u.ev);
    await this.repo.insertTransitions(u.tx, u.ev.id, u.transitions);
    for (const p of u.publishes) {
      const payload = p.payload === u.ev ? { ...u.ev, transitions: undefined } : p.payload;
      await this.outbox.publish(p.topic, this.envelope(p.topic, u.ev.protectedPersonId, payload), u.tx);
    }
    u.dirty = false;
    u.transitions = [];
    u.publishes = [];
  }
}
