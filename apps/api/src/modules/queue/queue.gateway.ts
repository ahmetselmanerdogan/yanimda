import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { type KafkaEnvelope, type SupervisorAlert, TOPICS } from '@yanimda/contracts';
import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { safeError } from '../../common/safe-error';
import { EventService } from '../event/event.service';
import { OidcVerifier, type Role, type UserPrincipal } from '../identity/oidc-verifier';
import { type SupervisorDashboard, SupervisorService } from '../metrics/supervisor.service';
import { REDIS } from '../signal/idempotency.store';

export const QUEUE_WS_PATH = '/v1/ws/queue';
const CHANNEL = 'yanimda:queue';
const AUTH_TIMEOUT_MS = 5_000;
const PING_MS = 30_000;
const SNAPSHOT_LIMIT = 200;
const ALLOWED: Role[] = ['OPERATOR', 'SUPERVISOR'];
export const QUEUE_ENV = Symbol('QUEUE_ENV');

/** Sunucu → istemci mesajları (T-022). */
export type QueueMessage =
  | { type: 'ready'; user: { sub: string; roles: Role[] } }
  | { type: 'snapshot'; items: unknown[]; total: number }
  | { type: 'upsert'; item: unknown; alarm?: string }
  | { type: 'remove'; eventId: string }
  | { type: 'alert'; alert: SupervisorAlert }
  /** T-074: yalnız amire, bağlanınca ve SUPERVISOR_PUSH_MS (5 sn) aralıkla. */
  | { type: 'dashboard'; dashboard: SupervisorDashboard }
  /**
   * İnceleme bulgusu 8: tüm personele kuyrukta bekleyen gelen SOS araması sayısı (bağlanınca ve değişince;
   * SUPERVISOR_PUSH_MS aralıkla denetlenir). Kişi adı / numara yok.
   */
  | { type: 'inbound'; queued: number; oldestQueuedSec: number | null };

/** Örnekler arası yayın: değişen olay kimliği veya amir uyarısı. */
type Fanout = { eventId: string; alarm?: string } | { alert: SupervisorAlert };

/**
 * Denetim bulgu 9: mevcut olaya gelen yeni / yükselen alarm (operatördeki olaya NEW_ALARM, kuyruktaki olayın türü
 * yükseldi veya SOS ile öncelik yükseldi) → konsol ses ve uyarı verir. Diğer güncellemeler sessiz.
 */
export function alarmOf(payload: unknown): string | undefined {
  const p = (payload ?? {}) as {
    reason?: string;
    alarm?: string;
    type?: string;
    priority?: number;
    previousPriority?: number;
  };
  if (p.reason === 'NEW_ALARM') return p.alarm;
  if (p.reason === 'UPGRADED') return p.type;
  if (typeof p.previousPriority === 'number' && typeof p.priority === 'number' && p.priority < p.previousPriority)
    return p.reason;
  return undefined;
}

interface Client {
  ws: WebSocket;
  user?: UserPrincipal;
  expiry?: NodeJS.Timeout;
  alive: boolean;
}

/**
 * T-022 canlı kuyruk: `GET /v1/ws/queue` (WebSocket). Tarayıcı WS'de başlık gönderemediği için kimlik ilk mesajla:
 * `{type:'auth', token}` (5 sn içinde; token yenilenince tekrar gönderilir, süresi dolan bağlantı 4401 ile kapanır).
 * Bağlanınca/yeniden bağlanınca tam liste (`snapshot`), sonra `upsert` / `remove` / `alert`.
 *
 * Outbox işçisi tek örnekte çalışır (kira); değişiklik Redis pub/sub ile tüm API örneklerine dağıtılır, her örnek
 * kendi istemcilerine yayınlar. Redis yoksa yalnız yerel istemcilere (tek örnek kurulumunda kayıp yok).
 */
@Injectable()
export class QueueGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('QueueWs');
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private readonly clients = new Set<Client>();
  private readonly unsub: (() => void)[] = [];
  private sub?: Redis;
  private ping?: NodeJS.Timeout;
  private push?: NodeJS.Timeout;
  private pushing = false;
  private server?: Server;
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head);

  constructor(
    @Inject(EventService) private readonly events: EventService,
    @Inject(OidcVerifier) private readonly verifier: OidcVerifier,
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
    @Optional() @Inject(HttpAdapterHost) private readonly host?: HttpAdapterHost,
    @Optional() @Inject(SupervisorService) private readonly supervisor?: SupervisorService,
    @Optional() @Inject(QUEUE_ENV) private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  onApplicationBootstrap() {
    const server = this.host?.httpAdapter?.getHttpServer() as Server | undefined;
    if (server) this.attach(server);
  }

  async onApplicationShutdown() {
    await this.close();
  }

  /** HTTP sunucusuna bağlan (Nest dışında testlerde de kullanılır). */
  attach(server: Server, bus: LocalBus = globalBus) {
    this.server = server;
    server.on('upgrade', this.onUpgrade);
    for (const topic of [TOPICS.eventCreated, TOPICS.eventTransitioned, TOPICS.eventClosed, TOPICS.eventUpdated])
      this.unsub.push(
        bus.subscribe<{ eventId?: string; id?: string }>(topic, (e) => {
          const alarm = topic === TOPICS.eventUpdated ? alarmOf(e.payload) : undefined;
          return this.fanout({ eventId: eventIdOf(e), ...(alarm ? { alarm } : {}) });
        }),
      );
    this.unsub.push(bus.subscribe<SupervisorAlert>(TOPICS.supervisorAlert, (e) => this.fanout({ alert: e.payload })));
    this.subscribeRedis();
    this.ping = setInterval(() => this.heartbeat(), PING_MS);
    this.ping.unref();
    const every = Number(this.env.SUPERVISOR_PUSH_MS ?? 5_000);
    if (this.supervisor && every > 0) {
      this.push = setInterval(() => {
        void this.pushDashboard();
        void this.pushInbound();
      }, every);
      this.push.unref();
    }
  }

  async close() {
    this.server?.off('upgrade', this.onUpgrade);
    for (const u of this.unsub.splice(0)) u();
    clearInterval(this.ping);
    clearInterval(this.push);
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.sub?.disconnect();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  get size() {
    return this.clients.size;
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const path = (req.url ?? '').split('?')[0];
    if (path !== QUEUE_WS_PATH) return; // başka WS yolu yok; Nest/ws dışındaki dinleyicilere bırak
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws));
  }

  private connect(ws: WebSocket) {
    const c: Client = { ws, alive: true };
    this.clients.add(c);
    const authTimer = setTimeout(() => !c.user && ws.close(4401, 'auth'), AUTH_TIMEOUT_MS);
    ws.on('pong', () => (c.alive = true));
    ws.on('close', () => {
      clearTimeout(authTimer);
      clearTimeout(c.expiry);
      this.clients.delete(c);
    });
    ws.on('error', () => ws.terminate());
    ws.on('message', (raw) => void this.onMessage(c, raw.toString()).catch(() => ws.close(1011, 'error')));
  }

  private async onMessage(c: Client, raw: string) {
    let msg: { type?: unknown; token?: unknown };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return c.ws.close(4400, 'json');
    }
    if (msg.type !== 'auth' || typeof msg.token !== 'string') return c.ws.close(4400, 'type');
    let user: UserPrincipal;
    let exp: number;
    try {
      user = await this.verifier.verify(msg.token);
      exp = expOf(msg.token);
    } catch {
      return c.ws.close(4401, 'auth');
    }
    if (!user.roles.some((r) => ALLOWED.includes(r))) return c.ws.close(4403, 'role');
    const first = !c.user;
    c.user = user;
    clearTimeout(c.expiry);
    c.expiry = setTimeout(() => c.ws.close(4401, 'expired'), Math.max(0, exp * 1000 - Date.now()));
    if (!first) return; // token yenileme
    this.send(c, { type: 'ready', user: { sub: user.sub, roles: user.roles } });
    const { items, total } = await this.events.queuePage({ limit: SNAPSHOT_LIMIT, offset: 0 });
    this.send(c, { type: 'snapshot', items, total });
    await this.markSeen(c);
    if (isSupervisor(c)) await this.pushDashboard(c);
    await this.pushInbound(c);
  }

  private lastInbound = '';

  /** Gelen arama kuyruğu özeti: bağlanana hemen, diğerlerine yalnız değişince. Hata fırlatmaz. */
  private async pushInbound(only?: Client) {
    if (!this.supervisor || (!only && !this.clients.size)) return;
    try {
      const s = await this.supervisor.inbound();
      const m: QueueMessage = { type: 'inbound', queued: s.queued, oldestQueuedSec: s.oldestQueuedSec };
      const key = `${s.queued}`;
      if (only) return this.send(only, m);
      // Sayı değişince yayınla; kuyruk doluyken bekleme süresi de güncel kalsın (her turda).
      if (key === this.lastInbound && s.queued === 0) return;
      this.lastInbound = key;
      this.broadcast(m);
    } catch (e) {
      this.log.warn(`Gelen arama özeti yayını başarısız: ${safeError(e)}`);
    }
  }

  /** T-074: amir istemcilerine pano (tek hesap, hepsine aynı). Hata fırlatmaz. */
  private async pushDashboard(only?: Client) {
    if (!this.supervisor) return;
    const targets = only ? [only] : [...this.clients].filter(isSupervisor);
    if (!targets.length || (!only && this.pushing)) return;
    if (!only) this.pushing = true;
    try {
      const data = JSON.stringify({ type: 'dashboard', dashboard: await this.supervisor.dashboard() });
      for (const c of targets) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    } catch (e) {
      this.log.warn(`Amir panosu yayını başarısız: ${safeError(e)}`);
    } finally {
      if (!only) this.pushing = false;
    }
  }

  /** T-074: bağlı personel "görüldü" (amir kartı: bağlı mı, ad). Ad log'a yazılmaz. */
  private async markSeen(c: Client) {
    if (!this.supervisor || !c.user) return;
    try {
      const kind = c.user.roles.includes('OPERATOR') ? 'OPERATOR' : 'SUPERVISOR';
      await this.supervisor.seen(c.user.sub, c.user.name ?? null, kind);
    } catch (e) {
      this.log.warn(`Operatör görüldü yazılamadı: ${safeError(e)}`);
    }
  }

  /** Bus aboneliği: hata fırlatmaz (outbox teslimini tekrarlatmamak için). */
  private async fanout(f: Fanout) {
    if ('eventId' in f && !f.eventId) return;
    if (this.redis && this.redis.status === 'ready') {
      try {
        await this.redis.publish(CHANNEL, JSON.stringify(f));
        return;
      } catch (e) {
        this.log.warn(`Redis yayını başarısız, yalnız yerel: ${safeError(e)}`);
      }
    }
    await this.deliver(f);
  }

  private subscribeRedis() {
    if (!this.redis || typeof this.redis.duplicate !== 'function') return;
    const sub = this.redis.duplicate();
    this.sub = sub;
    sub.on('error', () => undefined); // ana bağlantı zaten raporluyor
    sub.on('message', (_ch: string, m: string) => {
      try {
        void this.deliver(JSON.parse(m) as Fanout);
      } catch {
        /* bozuk mesaj */
      }
    });
    const subscribe = () => void sub.subscribe(CHANNEL).catch(() => undefined);
    sub.on('ready', subscribe);
    if (sub.status === 'ready') subscribe();
  }

  private async deliver(f: Fanout) {
    if (!this.clients.size) return;
    try {
      // Amir uyarıları yalnız SUPERVISOR/ADMIN'e; üstlenilmeyen kuyruk uyarısı herkese (operatör üstlenebilir).
      if ('alert' in f)
        return this.broadcast(
          { type: 'alert', alert: f.alert },
          f.alert.code === 'O-QUEUE-UNCLAIMED'
            ? undefined
            : (c) => !!c.user?.roles.some((r) => r === 'SUPERVISOR' || r === 'ADMIN'),
        );
      const item = await this.events.queueItem(f.eventId);
      this.broadcast(
        item
          ? { type: 'upsert', item, ...(f.alarm ? { alarm: f.alarm } : {}) }
          : { type: 'remove', eventId: f.eventId },
      );
    } catch (e) {
      this.log.warn(`Kuyruk yayını başarısız: ${safeError(e)}`);
    }
  }

  private broadcast(m: QueueMessage, only?: (c: Client) => boolean) {
    const data = JSON.stringify(m);
    for (const c of this.clients)
      if (c.user && c.ws.readyState === WebSocket.OPEN && (!only || only(c))) c.ws.send(data);
  }

  private send(c: Client, m: QueueMessage) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(m));
  }

  private heartbeat() {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
      void this.markSeen(c);
    }
  }
}

const isSupervisor = (c: Client) => !!c.user?.roles.includes('SUPERVISOR');

function eventIdOf(e: KafkaEnvelope<{ eventId?: string; id?: string }>): string {
  return e.payload?.eventId ?? e.payload?.id ?? '';
}

function expOf(token: string): number {
  const p = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
  return p.exp ?? 0;
}
