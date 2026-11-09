import { ApiError, type VoiceToken } from './api';

/**
 * T-051 konsol yazılım telefonu. Model tıkla-ara köprüsü (T-050): operatör "Ara"ya basınca sunucu önce operatörün
 * ucunu (`client:<operatör>`) arar; bu cihaz gelen aramayı kendiliğinden açar, sonra sağlayıcı aranan tarafa bağlar.
 * Görüşmenin durumu (çalıyor, sürüyor, beklemede, konferans) sunucudaki arama kaydından okunur; cihaz yalnız ses
 * ucudur. Twilio Voice JS SDK tembel yüklenir (ilk kayıt anında; eğitim modunda ve sahte sağlayıcıda hiç yüklenmez).
 */
export type DeviceState =
  | 'starting'
  /** Mikrofon izni reddedildi. */
  | 'mic-denied'
  /** Mikrofon yok. */
  | 'mic-none'
  | 'ready'
  /** Sahte cihaz: eğitim modu veya sahte CPaaS (gerçek ses yok). */
  | 'fake'
  /** Yazılım telefonu kapalı: masa hattı. */
  | 'unavailable'
  | 'error';

export interface PhoneSnapshot {
  device: DeviceState;
  /** Cihazdaki ses bağlantısı (yalnız gerçek cihazda). */
  connected: boolean;
}

export interface Softphone {
  snapshot(): PhoneSnapshot;
  subscribe(fn: (s: PhoneSnapshot) => void): () => void;
  /** Cihazdaki görüşmeyi bırak (sunucu tarafı ayrıca kapatılır). */
  hangup(): void;
  destroy(): void;
}

export type MicResult = 'granted' | 'denied' | 'none';

/** Girişte mikrofon izni: izin API'si "denied" ise sormadan; değilse kısa bir getUserMedia ile (akış hemen kapanır). */
export async function checkMicrophone(
  nav: Pick<Navigator, 'mediaDevices' | 'permissions'> = navigator,
): Promise<MicResult> {
  try {
    const p = await nav.permissions?.query({ name: 'microphone' as PermissionName });
    if (p?.state === 'denied') return 'denied';
  } catch {
    // Firefox/Safari "microphone" sorgusunu desteklemeyebilir: getUserMedia'ya geç.
  }
  if (!nav.mediaDevices?.getUserMedia) return 'none';
  try {
    const stream = await nav.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    return 'granted';
  } catch (e) {
    const name = (e as { name?: string }).name;
    return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'none';
  }
}

/** SDK'nın kullandığımız yüzeyi (testte sahte sınıf verilir). */
export interface VoiceCall {
  accept(): void;
  disconnect(): void;
  on(event: 'disconnect' | 'cancel' | 'reject' | 'error', fn: () => void): unknown;
}
export interface VoiceDevice {
  register(): Promise<void>;
  updateToken(token: string): void;
  disconnectAll(): void;
  destroy(): void;
  on(event: 'registered' | 'unregistered', fn: () => void): unknown;
  on(event: 'error', fn: (e: unknown) => void): unknown;
  on(event: 'incoming', fn: (call: VoiceCall) => void): unknown;
  on(event: 'tokenWillExpire', fn: () => void): unknown;
}
export type DeviceFactory = (token: string) => VoiceDevice;

/** Tembel yükleme: SDK ayrı parçada, yalnız gerçek Twilio token'ı gelince indirilir. */
export const loadTwilioDevice = async (): Promise<DeviceFactory> => {
  const { Device } = await import('@twilio/voice-sdk');
  return (token) => new Device(token, { closeProtection: true, logLevel: 'warn' }) as unknown as VoiceDevice;
};

export interface SoftphoneDeps {
  token(): Promise<VoiceToken>;
  training?: boolean;
  mic?: () => Promise<MicResult>;
  load?: () => Promise<DeviceFactory>;
}

class Phone implements Softphone {
  private state: PhoneSnapshot = { device: 'starting', connected: false };
  private readonly subs = new Set<(s: PhoneSnapshot) => void>();
  private device?: VoiceDevice;
  private call?: VoiceCall;
  private dead = false;

  snapshot() {
    return this.state;
  }
  subscribe(fn: (s: PhoneSnapshot) => void) {
    this.subs.add(fn);
    fn(this.state);
    return () => void this.subs.delete(fn);
  }
  set(p: Partial<PhoneSnapshot>) {
    if (this.dead) return;
    this.state = { ...this.state, ...p };
    for (const f of this.subs) f(this.state);
  }
  hangup() {
    this.call?.disconnect();
  }
  destroy() {
    this.dead = true;
    this.subs.clear();
    this.device?.destroy();
  }

  async start(d: SoftphoneDeps) {
    if (d.training) return this.set({ device: 'fake' });
    let tok: VoiceToken;
    try {
      tok = await d.token();
    } catch (e) {
      return this.set({ device: e instanceof ApiError && e.status === 503 ? 'unavailable' : 'error' });
    }
    if (tok.provider === 'fake') return this.set({ device: 'fake' });
    const mic = await (d.mic ?? checkMicrophone)();
    if (mic !== 'granted') return this.set({ device: mic === 'denied' ? 'mic-denied' : 'mic-none' });
    try {
      const make = await (d.load ?? loadTwilioDevice)();
      if (this.dead) return;
      const dev = make(tok.token);
      this.device = dev;
      dev.on('registered', () => this.set({ device: 'ready' }));
      dev.on('unregistered', () => this.set({ device: 'error' }));
      dev.on('error', () => this.set({ device: 'error' }));
      dev.on('tokenWillExpire', () => {
        void d
          .token()
          .then((t) => dev.updateToken(t.token))
          .catch(() => this.set({ device: 'error' }));
      });
      // Gelen arama yalnız sunucunun bu operatöre açtığı köprü bacağıdır ("Ara"ya basınca): kendiliğinden açılır.
      dev.on('incoming', (call) => {
        this.call = call;
        const end = () => {
          if (this.call === call) this.call = undefined;
          this.set({ connected: false });
        };
        call.on('disconnect', end);
        call.on('cancel', end);
        call.on('reject', end);
        call.on('error', end);
        call.accept();
        this.set({ connected: true });
      });
      await dev.register();
    } catch {
      this.set({ device: 'error' });
    }
  }
}

/** Telefonu başlat (giriş anında). Dönen nesne hemen kullanılabilir; durum abonelikle gelir. */
export function startSoftphone(d: SoftphoneDeps): Softphone & { ready: Promise<void> } {
  const p = new Phone();
  return Object.assign(p, { ready: p.start(d) });
}
