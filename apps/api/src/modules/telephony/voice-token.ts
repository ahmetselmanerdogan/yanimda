import { createHmac } from 'node:crypto';

/**
 * T-051 konsol yazılım telefonu: Twilio Voice erişim token'ı (AccessToken + VoiceGrant), bağımlılıksız HS256 JWT.
 * Biçim Twilio'nun `twilio-fpa;v=1` şeması: iss = API anahtarı SID, sub = hesap SID, grants.identity = istemci
 * kimliği. Tarayıcıdaki Device bu token'la kaydolur; sunucu `client:<kimlik>`'i arayınca konsolda çalar.
 */
export interface VoiceConfig {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  /** Tarayıcıdan giden arama (Device.connect) için TwiML uygulaması; yoksa yalnız gelen. */
  twimlAppSid?: string;
  ttlSec: number;
}

export const VOICE_TTL_MIN = 60;
export const VOICE_TTL_MAX = 3600;

export function voiceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceConfig | null {
  const {
    TWILIO_ACCOUNT_SID: accountSid,
    TWILIO_API_KEY_SID: apiKeySid,
    TWILIO_API_KEY_SECRET: apiKeySecret,
    TWILIO_TWIML_APP_SID: twimlAppSid,
  } = env;
  if (!accountSid || !apiKeySid || !apiKeySecret) return null;
  const ttl = Number(env.TWILIO_VOICE_TOKEN_TTL_SEC || VOICE_TTL_MAX);
  return {
    accountSid,
    apiKeySid,
    apiKeySecret,
    ...(twimlAppSid ? { twimlAppSid } : {}),
    ttlSec: Math.min(VOICE_TTL_MAX, Math.max(VOICE_TTL_MIN, Number.isFinite(ttl) ? Math.round(ttl) : VOICE_TTL_MAX)),
  };
}

/** Twilio istemci kimliği yalnız harf, rakam ve alt çizgi (en çok 121): OIDC `sub` buna dönüştürülür. */
export function clientIdentity(operatorId: string): string {
  return operatorId.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 121);
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function twilioVoiceToken(cfg: VoiceConfig, identity: string, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const voice: Record<string, unknown> = { incoming: { allow: true } };
  if (cfg.twimlAppSid) voice.outgoing = { application_sid: cfg.twimlAppSid };
  const head = b64({ typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' });
  const body = b64({
    jti: `${cfg.apiKeySid}-${iat}`,
    iss: cfg.apiKeySid,
    sub: cfg.accountSid,
    iat,
    nbf: iat,
    exp: iat + cfg.ttlSec,
    grants: { identity, voice },
  });
  const sig = createHmac('sha256', cfg.apiKeySecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
