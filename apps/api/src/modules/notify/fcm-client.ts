import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** T-053 FCM HTTP v1. Hizmet hesabı JWT'si (RS256) → OAuth erişim token'ı (50 dk önbellek) → messages:send. */
export const FCM = Symbol('FCM');

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** Hizmet hesabı özel anahtarı (PEM). */
  privateKey: string;
}

export interface FcmMessage {
  token: string;
  /** Uyarı bildirimi (başlıksız; gövde katalog metni). Yoksa yalnız veri mesajı. */
  body?: string;
  data: Record<string, string>;
  priority: 'normal' | 'high';
  ttlSec: number;
  collapseKey?: string;
}

export type FcmResult =
  | { status: 'ok'; id: string }
  /** Token geçersiz (uygulama silindi): hedef silinmeli. */
  | { status: 'invalid-token'; reason: string }
  /** Geçici (429, 5xx, ağ): yeniden denenebilir. */
  | { status: 'retry'; reason: string }
  | { status: 'error'; reason: string };

/** FCM_PROJECT_ID + FCM_CLIENT_EMAIL + FCM_PRIVATE_KEY (\n kaçışlı olabilir) veya FCM_CREDENTIALS_FILE (JSON). */
export function fcmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FcmConfig | null {
  if (env.FCM_CREDENTIALS_FILE) {
    const j = JSON.parse(readFileSync(env.FCM_CREDENTIALS_FILE, 'utf8')) as {
      project_id: string;
      client_email: string;
      private_key: string;
    };
    return { projectId: env.FCM_PROJECT_ID || j.project_id, clientEmail: j.client_email, privateKey: j.private_key };
  }
  const { FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY } = env;
  if (!FCM_PROJECT_ID || !FCM_CLIENT_EMAIL || !FCM_PRIVATE_KEY) return null;
  return {
    projectId: FCM_PROJECT_ID,
    clientEmail: FCM_CLIENT_EMAIL,
    privateKey: FCM_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const INVALID = new Set(['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH']);

export class FcmClient {
  private access?: { token: string; until: number };

  constructor(
    private readonly cfg: FcmConfig,
    private readonly http: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async send(m: FcmMessage): Promise<FcmResult> {
    let r: Response;
    try {
      const auth = await this.accessToken();
      r = await this.http(`https://fcm.googleapis.com/v1/projects/${this.cfg.projectId}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: this.body(m) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      return { status: 'retry', reason: (e as Error).name };
    }
    if (r.ok) return { status: 'ok', id: ((await r.json()) as { name: string }).name };
    const err = (await r.json().catch(() => ({}))) as {
      error?: { status?: string; details?: { errorCode?: string }[] };
    };
    const code = err.error?.details?.find((d) => d.errorCode)?.errorCode ?? err.error?.status ?? String(r.status);
    if (r.status === 401) this.access = undefined;
    if (r.status === 404 || INVALID.has(code)) return { status: 'invalid-token', reason: code };
    if (r.status === 429 || r.status >= 500 || r.status === 401) return { status: 'retry', reason: code };
    return { status: 'error', reason: code };
  }

  private body(m: FcmMessage) {
    return {
      token: m.token,
      data: m.data,
      ...(m.body ? { notification: { body: m.body } } : {}),
      android: {
        priority: m.priority === 'high' ? 'HIGH' : 'NORMAL',
        ttl: `${m.ttlSec}s`,
        ...(m.collapseKey ? { collapse_key: m.collapseKey } : {}),
      },
      apns: {
        headers: {
          'apns-priority': m.priority === 'high' && m.body ? '10' : '5',
          'apns-expiration': String(Math.floor(this.now() / 1000) + m.ttlSec),
          ...(m.collapseKey ? { 'apns-collapse-id': m.collapseKey } : {}),
        },
        payload: { aps: m.body ? { sound: 'default' } : { 'content-available': 1 } },
      },
    };
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.until > this.now()) return this.access.token;
    const iat = Math.floor(this.now() / 1000);
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.cfg.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(this.cfg.privateKey).toString('base64url');
    const r = await this.http(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${sig}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw Object.assign(new Error(`FCM OAuth HTTP ${r.status}`), { name: 'FcmAuthError' });
    const j = (await r.json()) as { access_token: string; expires_in: number };
    this.access = { token: j.access_token, until: this.now() + Math.min(j.expires_in, 3000) * 1000 };
    return j.access_token;
  }
}
