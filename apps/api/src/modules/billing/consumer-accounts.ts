import { ConflictException } from '@nestjs/common';

/**
 * T-060 (4) Keycloak `consumers` hesabı. Parola bizim API'mizden geçmez: hesap gerekli eylemlerle
 * (VERIFY_EMAIL + UPDATE_PASSWORD) açılır, Keycloak e-postadaki bağlantıyla e-posta doğrulatıp parola belirletir.
 * Telefon Keycloak'ta SMS doğrulamasız olduğundan bizim OTP'mizle doğrulanır ve `phone_number_verified` yazılır.
 */
export interface NewConsumer {
  email: string;
  phone: string;
  firstName: string;
  lastName: string;
}

export interface ConsumerAccounts {
  /** Yeni hesap; e-posta zaten kayıtlıysa ConflictException. Dönen `subject` = token `sub`. */
  create(u: NewConsumer): Promise<{ subject: string }>;
  /** E-posta doğrulama + parola belirleme e-postası. */
  sendSetupEmail(subject: string, redirectUri?: string): Promise<void>;
  markPhoneVerified(subject: string): Promise<void>;
  /** Ödeme sağlayıcısına iletilecek iletişim bilgisi (DB'de tutulmaz; kaynak Keycloak). */
  contactOf(subject: string): Promise<(NewConsumer & { phoneVerified: boolean }) | null>;
  /** Telafi (kayıt yarıda kaldı). */
  remove(subject: string): Promise<void>;
}

export interface KeycloakAdminConfig {
  url: string;
  realm: string;
  clientId: string;
  clientSecret: string;
  /** execute-actions-email bağlantısının döneceği istemci. */
  appClientId: string;
}

export function keycloakAdminConfigFromEnv(env: NodeJS.ProcessEnv = process.env): KeycloakAdminConfig | null {
  const url = env.KEYCLOAK_URL;
  const clientSecret = env.KEYCLOAK_SIGNUP_CLIENT_SECRET;
  if (!url || !clientSecret) return null;
  return {
    url: url.replace(/\/+$/, ''),
    realm: env.KEYCLOAK_CONSUMERS_REALM || 'consumers',
    clientId: env.KEYCLOAK_SIGNUP_CLIENT_ID || 'yanimda-signup',
    clientSecret,
    appClientId: env.KEYCLOAK_FAMILY_CLIENT_ID || 'family-web',
  };
}

type Fetch = typeof fetch;

/** Keycloak Admin REST, hizmet hesabı (client credentials; consumers realm'inde manage-users). */
export class KeycloakConsumerAccounts implements ConsumerAccounts {
  private token?: { value: string; until: number };

  constructor(
    private readonly cfg: KeycloakAdminConfig,
    private readonly http: Fetch = fetch,
  ) {}

  private async bearer(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const r = await this.http(`${this.cfg.url}/realms/${this.cfg.realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      }),
    });
    if (!r.ok) throw new Error(`keycloak token HTTP ${r.status}`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, until: Date.now() + Math.max(10, j.expires_in - 30) * 1000 };
    return j.access_token;
  }

  private async req(method: string, path: string, body?: unknown): Promise<Response> {
    return this.http(`${this.cfg.url}/admin/realms/${this.cfg.realm}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.bearer()}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async create(u: NewConsumer): Promise<{ subject: string }> {
    const r = await this.req('POST', '/users', {
      username: u.email,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      enabled: true,
      emailVerified: false,
      attributes: { phone_number: [u.phone], phone_number_verified: ['false'] },
      requiredActions: ['VERIFY_EMAIL', 'UPDATE_PASSWORD'],
    });
    if (r.status === 409) throw new ConflictException('Bu e-posta ile hesap var');
    if (r.status !== 201) throw new Error(`keycloak kullanıcı HTTP ${r.status}`);
    const id = r.headers.get('location')?.split('/').pop();
    if (!id) throw new Error('keycloak kullanıcı kimliği yok');
    return { subject: id };
  }

  async sendSetupEmail(subject: string, redirectUri?: string): Promise<void> {
    const q = new URLSearchParams({ client_id: this.cfg.appClientId, lifespan: String(24 * 3600) });
    if (redirectUri) q.set('redirect_uri', redirectUri);
    const r = await this.req('PUT', `/users/${encodeURIComponent(subject)}/execute-actions-email?${q}`, [
      'VERIFY_EMAIL',
      'UPDATE_PASSWORD',
    ]);
    if (!r.ok) throw new Error(`keycloak e-posta HTTP ${r.status}`);
  }

  private async user(subject: string): Promise<Record<string, unknown> & { attributes?: Record<string, string[]> }> {
    const r = await this.req('GET', `/users/${encodeURIComponent(subject)}`);
    if (!r.ok) throw new Error(`keycloak kullanıcı oku HTTP ${r.status}`);
    return (await r.json()) as never;
  }

  async markPhoneVerified(subject: string): Promise<void> {
    const u = await this.user(subject);
    const attributes = { ...(u.attributes ?? {}), phone_number_verified: ['true'] };
    const r = await this.req('PUT', `/users/${encodeURIComponent(subject)}`, { ...u, attributes });
    if (!r.ok) throw new Error(`keycloak telefon HTTP ${r.status}`);
  }

  async contactOf(subject: string) {
    const u = (await this.user(subject)) as Record<string, unknown> & { attributes?: Record<string, string[]> };
    const phone = u.attributes?.phone_number?.[0];
    if (typeof u.email !== 'string' || !phone) return null;
    return {
      email: u.email,
      phone,
      firstName: typeof u.firstName === 'string' ? u.firstName : '',
      lastName: typeof u.lastName === 'string' ? u.lastName : '',
      phoneVerified: u.attributes?.phone_number_verified?.[0] === 'true',
    };
  }

  async remove(subject: string): Promise<void> {
    const r = await this.req('DELETE', `/users/${encodeURIComponent(subject)}`);
    if (!r.ok && r.status !== 404) throw new Error(`keycloak sil HTTP ${r.status}`);
  }
}

/** Keycloak yokken (geliştirme, testler): bellekte hesap. Üretimde kullanılamaz. */
export class FakeConsumerAccounts implements ConsumerAccounts {
  readonly users = new Map<string, NewConsumer & { phoneVerified: boolean; setupEmails: number }>();
  private n = 0;

  async create(u: NewConsumer) {
    if ([...this.users.values()].some((x) => x.email.toLowerCase() === u.email.toLowerCase()))
      throw new ConflictException('Bu e-posta ile hesap var');
    const subject = `fake-consumer-${++this.n}`;
    this.users.set(subject, { ...u, phoneVerified: false, setupEmails: 0 });
    return { subject };
  }
  async sendSetupEmail(subject: string) {
    const u = this.users.get(subject);
    if (u) u.setupEmails++;
  }
  async markPhoneVerified(subject: string) {
    const u = this.users.get(subject);
    if (u) u.phoneVerified = true;
  }
  async contactOf(subject: string) {
    const u = this.users.get(subject);
    return u
      ? { email: u.email, phone: u.phone, firstName: u.firstName, lastName: u.lastName, phoneVerified: u.phoneVerified }
      : null;
  }
  async remove(subject: string) {
    this.users.delete(subject);
  }
}
