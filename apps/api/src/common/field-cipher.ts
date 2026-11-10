import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';

/**
 * T-040 alan şifreleme (AES-256-GCM). Biçim: `v1:<kid>:<base64(iv12 | tag16 | şifreli)>`.
 * AAD = bağlam (ör. `medical:<kişi>`): şifreli değer başka kişinin/alanın satırına taşınırsa çözülmez.
 * Anahtarlar `FIELD_ENC_KEYS="kid1:<base64 32 bayt>,kid0:<…>"`; ilki yeni yazımlarda, hepsi okumada (döndürme).
 * Üretimde KMS'ten gelen anahtar ortam değişkenine konur; anahtar yoksa üretim açılmaz.
 */
export class FieldCipher {
  private readonly keys = new Map<string, Buffer>();
  private readonly active: string;

  constructor(spec: string) {
    for (const part of spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const i = part.indexOf(':');
      const kid = part.slice(0, i);
      const key = Buffer.from(part.slice(i + 1), 'base64');
      if (i < 1 || !/^[A-Za-z0-9_-]+$/.test(kid) || key.length !== 32)
        throw new Error('FIELD_ENC_KEYS biçimi: kid:<base64 32 bayt>[,…]');
      this.keys.set(kid, key);
    }
    if (!this.keys.size) throw new Error('FIELD_ENC_KEYS boş');
    this.active = this.keys.keys().next().value!;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): FieldCipher {
    if (env.FIELD_ENC_KEYS) return new FieldCipher(env.FIELD_ENC_KEYS);
    if (env.NODE_ENV === 'production') throw new Error('FIELD_ENC_KEYS üretimde zorunlu');
    // Geliştirme: süreç ömrünce geçici anahtar (yeniden başlatınca eski şifreli alanlar okunamaz).
    new Logger('FieldCipher').warn('FIELD_ENC_KEYS yok: geçici anahtar (yalnız geliştirme)');
    return new FieldCipher(`dev:${randomBytes(32).toString('base64')}`);
  }

  encrypt(plain: string, context: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keys.get(this.active)!, iv);
    c.setAAD(Buffer.from(context));
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1:${this.active}:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
  }

  decrypt(value: string, context: string): string {
    const [v, kid, data] = value.split(':');
    const key = kid ? this.keys.get(kid) : undefined;
    if (v !== 'v1' || !key || !data) throw new Error('Şifreli alan çözülemedi');
    const raw = Buffer.from(data, 'base64');
    // Semgrep gcm-no-tag-length (T-081): kısa etiketle sahte şifreli metin kabul edilmesin
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), { authTagLength: 16 });
    d.setAAD(Buffer.from(context));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }

  /** Eski anahtarla yazılmış mı (yeniden şifreleme işi için). */
  isStale(value: string) {
    return value.split(':')[1] !== this.active;
  }
}
