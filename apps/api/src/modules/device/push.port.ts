/**
 * Cihaza push (FCM data mesajı). T-015: arayüz + kayıt eden sahte uygulama.
 * T-053: FCM HTTP v1 / APNs gerçek uygulaması (cihaz push token'ı T-041 kaydıyla gelir).
 */
export interface PushMessage {
  deviceId: string;
  priority: 'normal' | 'high';
  /** FCM data alanları yalnız string taşır. */
  data: Record<string, string>;
  ttlSec: number;
}

export interface PushPort {
  send(msg: PushMessage): Promise<void>;
}

export const PUSH = Symbol('PUSH');

/** Geliştirme/test: gönderilenleri bellekte tutar, ağa çıkmaz. */
export class RecordingPush implements PushPort {
  readonly sent: PushMessage[] = [];
  async send(msg: PushMessage): Promise<void> {
    this.sent.push(msg);
    if (this.sent.length > 1000) this.sent.shift();
  }
}
