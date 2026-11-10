import type { QueueItem, SupervisorDashboard } from './api';

export type ServerMessage =
  | { type: 'ready'; user: { sub: string; roles: string[] } }
  | { type: 'snapshot'; items: QueueItem[]; total: number }
  | { type: 'upsert'; item: QueueItem }
  | { type: 'remove'; eventId: string }
  | { type: 'alert'; alert: { code: string; eventId: string; eventType: string; operatorId?: string; at: string } }
  | { type: 'dashboard'; dashboard: SupervisorDashboard }
  | { type: 'inbound'; queued: number; oldestQueuedSec: number | null };

export interface LiveHandlers {
  onMessage(m: ServerMessage): void;
  onStatus(online: boolean): void;
}

/**
 * T-022 canlı kuyruk istemcisi: bağlanınca token'ı ilk mesajla gönderir, token yenilenince tekrar gönderir,
 * koparsa 1→10 sn artan aralıkla yeniden bağlanır (sunucu yeniden bağlanınca tam liste gönderir).
 */
export class QueueSocket {
  private ws?: WebSocket;
  private retry = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly token: () => Promise<string | null>,
    private readonly h: LiveHandlers,
  ) {}

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close(1000);
  }

  /** Token yenilendi: açık bağlantıda yeniden kimlik. */
  async reauth() {
    const t = await this.token();
    if (t && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'auth', token: t }));
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = async () => {
      const t = await this.token();
      if (!t) return ws.close(4401);
      ws.send(JSON.stringify({ type: 'auth', token: t }));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      if (m.type === 'ready') {
        this.retry = 0;
        this.h.onStatus(true);
      }
      this.h.onMessage(m);
    };
    ws.onclose = () => {
      this.h.onStatus(false);
      if (this.closed) return;
      const wait = Math.min(1000 * 2 ** this.retry++, 10_000);
      this.timer = setTimeout(() => this.connect(), wait);
    };
  }
}
