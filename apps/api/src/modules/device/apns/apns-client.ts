import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';

/**
 * T-053 (cihaz tarafı) APNs: token tabanlı kimlik (ES256 .p8 anahtarı), HTTP/2. Bağımlılık yok (node:http2, node:crypto).
 * https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
 */
export const APNS_PRODUCTION = 'https://api.push.apple.com';
export const APNS_SANDBOX = 'https://api.sandbox.push.apple.com';
/** Apple: sağlayıcı token'ı 20 dk'dan sık yenilenmez, 60 dk geçerlidir. */
const PROVIDER_TOKEN_TTL_MS = 50 * 60_000;

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** .p8 içeriği (PEM). */
  privateKey: string;
  /** Uygulama paket kimliği (apns-topic). */
  topic: string;
}

/** APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY (PEM; \n kaçışlı olabilir) veya APNS_PRIVATE_KEY_FILE, APNS_TOPIC. Eksikse null. */
export function apnsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const key = env.APNS_PRIVATE_KEY
    ? env.APNS_PRIVATE_KEY.replace(/\\n/g, '\n')
    : env.APNS_PRIVATE_KEY_FILE
      ? readFileSync(env.APNS_PRIVATE_KEY_FILE, 'utf8')
      : '';
  if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !key) return null;
  return {
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    privateKey: key,
    topic: env.APNS_TOPIC || 'app.yanimda.companion',
  };
}

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** ES256 sağlayıcı JWT'si: başlık {alg, kid}, gövde {iss: takım, iat}. */
export function providerToken(cfg: Pick<ApnsConfig, 'keyId' | 'teamId' | 'privateKey'>, now = new Date()): string {
  const body = `${b64({ alg: 'ES256', kid: cfg.keyId })}.${b64({ iss: cfg.teamId, iat: Math.floor(now.getTime() / 1000) })}`;
  const sig = sign('sha256', Buffer.from(body), { key: cfg.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${body}.${sig.toString('base64url')}`;
}

export interface ApnsResponse {
  status: number;
  body: string;
}

export interface ApnsTransport {
  post(origin: string, path: string, headers: Record<string, string>, body: string): Promise<ApnsResponse>;
  close(): void;
}

/** Kaynak başına tek HTTP/2 oturumu (Apple bağlantıyı açık tutmayı ister); kopunca yeniden kurulur. */
export class Http2Transport implements ApnsTransport {
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();

  constructor(private readonly timeoutMs = 10_000) {}

  private session(origin: string): http2.ClientHttp2Session {
    const s = this.sessions.get(origin);
    if (s && !s.closed && !s.destroyed) return s;
    const fresh = http2.connect(origin);
    const drop = () => {
      if (this.sessions.get(origin) === fresh) this.sessions.delete(origin);
    };
    fresh.on('error', drop);
    fresh.on('close', drop);
    fresh.on('goaway', drop);
    this.sessions.set(origin, fresh);
    return fresh;
  }

  post(origin: string, path: string, headers: Record<string, string>, body: string): Promise<ApnsResponse> {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (!done) {
          done = true;
          fn();
        }
      };
      let req: http2.ClientHttp2Stream;
      try {
        req = this.session(origin).request({
          ':method': 'POST',
          ':path': path,
          'content-type': 'application/json',
          ...headers,
        });
      } catch (e) {
        return reject(e);
      }
      let status = 0;
      const chunks: Buffer[] = [];
      req.setTimeout(this.timeoutMs, () => req.close(http2.constants.NGHTTP2_CANCEL));
      req.on('response', (h) => (status = Number(h[':status'])));
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => finish(() => resolve({ status, body: Buffer.concat(chunks).toString('utf8') })));
      req.on('error', (e) => finish(() => reject(e)));
      req.on('close', () => finish(() => reject(new Error('APNs isteği kapandı (zaman aşımı veya bağlantı)'))));
      req.end(body);
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}

export interface ApnsRequest {
  /** Cihazın APNs token'ı (hex). */
  token: string;
  /** Geliştirme ortamı (Debug derlemeleri). */
  sandbox: boolean;
  pushType: 'background' | 'alert';
  /** background: 5 (Apple zorunlu), alert: 10 */
  priority: 5 | 10;
  /** Bu andan sonra teslim edilmez (sn, epoch). */
  expiration: number;
  collapseId?: string;
  payload: Record<string, unknown>;
}

export type ApnsResult =
  | { status: 'ok' }
  /** Token artık geçersiz (uygulama silindi / yanlış konu): cihaz kaydından silinmeli. */
  | { status: 'invalid-token'; reason: string }
  /** Geçici: yeniden denenebilir (429, 5xx, ağ). */
  | { status: 'retry'; reason: string }
  | { status: 'error'; reason: string };

const INVALID_TOKEN = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered', 'ExpiredToken']);

export class ApnsClient {
  private jwt?: { token: string; at: number };

  constructor(
    private readonly cfg: ApnsConfig,
    private readonly transport: ApnsTransport = new Http2Transport(),
    private readonly origins = { production: APNS_PRODUCTION, sandbox: APNS_SANDBOX },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private bearer(): string {
    const now = this.clock();
    if (!this.jwt || now.getTime() - this.jwt.at >= PROVIDER_TOKEN_TTL_MS)
      this.jwt = { token: providerToken(this.cfg, now), at: now.getTime() };
    return this.jwt.token;
  }

  async send(r: ApnsRequest): Promise<ApnsResult> {
    const headers: Record<string, string> = {
      authorization: `bearer ${this.bearer()}`,
      'apns-topic': this.cfg.topic,
      'apns-push-type': r.pushType,
      'apns-priority': String(r.priority),
      'apns-expiration': String(r.expiration),
    };
    if (r.collapseId) headers['apns-collapse-id'] = r.collapseId;
    let res: ApnsResponse;
    try {
      res = await this.transport.post(
        r.sandbox ? this.origins.sandbox : this.origins.production,
        `/3/device/${encodeURIComponent(r.token)}`,
        headers,
        JSON.stringify(r.payload),
      );
    } catch (e) {
      return { status: 'retry', reason: (e as Error).message };
    }
    if (res.status === 200) return { status: 'ok' };
    let reason = `HTTP ${res.status}`;
    try {
      reason = (JSON.parse(res.body) as { reason?: string }).reason ?? reason;
    } catch {
      /* gövdesiz yanıt */
    }
    if (res.status === 410 || INVALID_TOKEN.has(reason)) return { status: 'invalid-token', reason };
    if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') {
      this.jwt = undefined; // bir sonraki istek yeni sağlayıcı token'ıyla
      return { status: 'retry', reason };
    }
    if (res.status === 429 || res.status >= 500) return { status: 'retry', reason };
    return { status: 'error', reason };
  }

  close(): void {
    this.transport.close();
  }
}
