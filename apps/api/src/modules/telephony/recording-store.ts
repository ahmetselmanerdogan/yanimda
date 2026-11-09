import { createHash, createHmac } from 'node:crypto';

/** Görüşme kayıtlarının kalıcı deposu (T-050). Üretimde S3 uyumlu (MinIO / AWS) ve nesne kilitli. */
export interface RecordingStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class MemoryRecordingStore implements RecordingStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
}

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  /** Nesne kilidi (COMPLIANCE) süresi, gün. 0 = kilit yok (yalnız geliştirme). */
  retentionDays: number;
}

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) return null;
  return {
    endpoint: S3_ENDPOINT.replace(/\/+$/, ''),
    bucket: S3_BUCKET,
    region: env.S3_REGION || 'us-east-1',
    accessKey: S3_ACCESS_KEY,
    secretKey: S3_SECRET_KEY,
    retentionDays: Number(env.RECORDING_RETENTION_DAYS ?? 365),
  };
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * S3 uyumlu depo, yol tarzı adres ve AWS SigV4 (bağımlılıksız). PUT'ta nesne kilidi: COMPLIANCE + saklama süresi
 * (kova nesne kilidiyle açılmış olmalı: `ensureBucket`). Kayıt silinemez/değiştirilemez; süre dolunca yaşam döngüsü.
 */
export class S3RecordingStore implements RecordingStore {
  constructor(
    private readonly cfg: S3Config,
    private readonly http: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async put(key: string, body: Buffer, contentType: string) {
    const headers: Record<string, string> = {
      'content-type': contentType,
      'content-md5': createHash('md5').update(body).digest('base64'),
    };
    if (this.cfg.retentionDays > 0) {
      const until = new Date(this.now().getTime() + this.cfg.retentionDays * 86_400_000);
      headers['x-amz-object-lock-mode'] = 'COMPLIANCE';
      headers['x-amz-object-lock-retain-until-date'] = until.toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    const r = await this.send('PUT', `/${this.cfg.bucket}/${key}`, headers, body);
    if (!r.ok) throw new Error(`S3 PUT başarısız: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }

  async exists(key: string) {
    const r = await this.send('HEAD', `/${this.cfg.bucket}/${key}`, {}, Buffer.alloc(0));
    return r.ok;
  }

  /** Geliştirme: kovayı nesne kilidiyle oluştur (varsa dokunma). */
  async ensureBucket() {
    const head = await this.send('HEAD', `/${this.cfg.bucket}`, {}, Buffer.alloc(0));
    if (head.ok) return;
    const r = await this.send(
      'PUT',
      `/${this.cfg.bucket}`,
      { 'x-amz-bucket-object-lock-enabled': 'true' },
      Buffer.alloc(0),
    );
    if (!r.ok && r.status !== 409) throw new Error(`S3 kova oluşturulamadı: HTTP ${r.status}`);
  }

  /** Test: imzalı istek başlıkları. */
  sign(method: string, path: string, headers: Record<string, string>, body: Buffer) {
    const url = new URL(this.cfg.endpoint);
    const t = this.now();
    const amzDate = t
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const all: Record<string, string> = {
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()])),
      host: url.host,
      'x-amz-content-sha256': sha256(body),
      'x-amz-date': amzDate,
    };
    const names = Object.keys(all).sort();
    const canonicalPath = path
      .split('/')
      .map((seg) => enc(decodeURIComponent(seg)))
      .join('/');
    const canonical = [
      method,
      canonicalPath,
      '',
      ...names.map((n) => `${n}:${all[n]}`),
      '',
      names.join(';'),
      all['x-amz-content-sha256'],
    ].join('\n');
    const scope = `${day}/${this.cfg.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const kDate = hmac(`AWS4${this.cfg.secretKey}`, day);
    const kSigning = hmac(hmac(hmac(kDate, this.cfg.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
    const { host: _host, ...rest } = all;
    return {
      url: `${url.origin}${canonicalPath}`,
      headers: {
        ...rest,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
      },
    };
  }

  private send(method: string, path: string, headers: Record<string, string>, body: Buffer) {
    const s = this.sign(method, path, headers, body);
    return this.http(s.url, {
      method,
      headers: s.headers,
      body: method === 'PUT' ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  }
}
