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
import { type KafkaEnvelope, TOPICS } from '@yanimda/contracts';
import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { safeError } from '../../common/safe-error';
import { OidcVerifier, type UserPrincipal } from '../identity/oidc-verifier';
import { REDIS } from '../signal/idempotency.store';
import { type FamilyEventView, FamilyService } from './family.service';

export const FAMILY_WS_PATH = '/v1/ws/family';
const CHANNEL = 'yanimda:family';
const AUTH_TIMEOUT_MS = 5_000;
const PING_MS = 30_000;

/** Sunucu → aile uygulaması. */
export type FamilyMessage = { type: 'ready'; persons: string[] } | { type: 'event'; event: FamilyEventView };

interface Client {
  ws: WebSocket;
  user?: UserPrincipal;
  persons: Set<string>;
  expiry?: NodeJS.Timeout;
  alive: boolean;
}

/**
 * T-061 (C-06) aile canlı olay akışı: `GET /v1/ws/family` (WebSocket). İlk mesaj `{type:'auth', token}` (consumers
 * realm, FAMILY; 5 sn). Sunucu `ready {persons}` ve ardından yalnız bu ailenin kişilerindeki olay değişikliklerini
 * `event {event}` olarak gönderir (aile görünümü: numara/ad/operatör yok). Kişi listesi bağlanınca ve token
 * yenilenince okunur. Örnekler arası dağıtım Redis pub/sub (QueueGateway ile aynı düzen).
 */
@Injectable()
export class FamilyGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('FamilyWs');
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private readonly clients = new Set<Client>();
  private readonly unsub: (() => void)[] = [];
  private sub?: Redis;
  private ping?: NodeJS.Timeout;
  private server?: Server;
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head);

  constructor(
    @Inject(FamilyService) private readonly family: FamilyService,
    @Inject(OidcVerifier) private readonly verifier: OidcVerifier,
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
    @Optional() @Inject(HttpAdapterHost) private readonly host?: HttpAdapterHost,
  ) {}

  onApplicationBootstrap() {
    const server = this.host?.httpAdapter?.getHttpServer() as Server | undefined;
    if (server) this.attach(server);
  }

  async onApplicationShutdown() {
    await this.close();
  }

  attach(server: Server, bus: LocalBus = globalBus) {
    this.server = server;
    server.on('upgrade', this.onUpgrade);
    for (const topic of [
      TOPICS.eventCreated,
      TOPICS.eventTransitioned,
      TOPICS.eventClosed,
      TOPICS.eventUpdated,
      TOPICS.chainStepResult,
    ])
      this.unsub.push(bus.subscribe<{ eventId?: string; id?: string }>(topic, (e) => this.fanout(eventIdOf(e))));
    this.subscribeRedis();
    this.ping = setInterval(() => this.heartbeat(), PING_MS);
    this.ping.unref();
  }

  async close() {
    this.server?.off('upgrade', this.onUpgrade);
    for (const u of this.unsub.splice(0)) u();
    clearInterval(this.ping);
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.sub?.disconnect();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if ((req.url ?? '').split('?')[0] !== FAMILY_WS_PATH) return;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws));
  }

  private connect(ws: WebSocket) {
    const c: Client = { ws, alive: true, persons: new Set() };
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
    try {
      user = await this.verifier.verify(msg.token);
    } catch {
      return c.ws.close(4401, 'auth');
    }
    if (user.realm !== 'consumers' || !user.roles.includes('FAMILY')) return c.ws.close(4403, 'role');
    const first = !c.user;
    c.user = user;
    c.persons = new Set(await this.family.personsOf(user.sub));
    clearTimeout(c.expiry);
    c.expiry = setTimeout(() => c.ws.close(4401, 'expired'), Math.max(0, expOf(msg.token) * 1000 - Date.now()));
    if (first) this.send(c, { type: 'ready', persons: [...c.persons] });
  }

  /** Bus aboneliği: hata fırlatmaz (outbox teslimini tekrarlatmamak için). */
  private async fanout(eventId: string) {
    if (!eventId) return;
    if (this.redis && this.redis.status === 'ready') {
      try {
        await this.redis.publish(CHANNEL, eventId);
        return;
      } catch (e) {
        this.log.warn(`Redis yayını başarısız, yalnız yerel: ${safeError(e)}`);
      }
    }
    await this.deliver(eventId);
  }

  private subscribeRedis() {
    if (!this.redis || typeof this.redis.duplicate !== 'function') return;
    const sub = this.redis.duplicate();
    this.sub = sub;
    sub.on('error', () => undefined);
    sub.on('message', (_ch: string, id: string) => void this.deliver(id));
    const subscribe = () => void sub.subscribe(CHANNEL).catch(() => undefined);
    sub.on('ready', subscribe);
    if (sub.status === 'ready') subscribe();
  }

  private async deliver(eventId: string) {
    const targets = [...this.clients].filter((c) => c.user && c.ws.readyState === WebSocket.OPEN);
    if (!targets.length) return;
    try {
      const base = await this.family.view(eventId);
      if (!base) return;
      for (const c of targets) {
        if (!c.persons.has(base.protectedPersonId)) continue;
        // Üyelik bağlantı açıkken kalkmış olabilir (T-040: sahip çıkardı / ayrıldı): teslimden önce yeniden doğrula.
        c.persons = new Set(await this.family.personsOf(c.user!.sub));
        if (!c.persons.has(base.protectedPersonId)) continue;
        // Geri bildirim alanları kişiye özel: kapanmış olayda yeniden hesapla.
        const view = base.state === 'CLOSED' ? ((await this.family.view(eventId, c.user!.sub)) ?? base) : base;
        this.send(c, { type: 'event', event: view });
      }
    } catch (e) {
      this.log.warn(`Aile yayını başarısız: ${safeError(e)}`);
    }
  }

  private send(c: Client, m: FamilyMessage) {
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
    }
  }
}

function eventIdOf(e: KafkaEnvelope<{ eventId?: string; id?: string }>): string {
  return e.payload?.eventId ?? e.payload?.id ?? '';
}

function expOf(token: string): number {
  const p = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
  return p.exp ?? 0;
}
