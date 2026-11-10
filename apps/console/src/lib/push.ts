import type { Api } from './api';

/** VAPID açık anahtarı (base64url) → Uint8Array (PushManager.subscribe). */
export function urlBase64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushState = 'unsupported' | 'disabled' | 'denied' | 'on' | 'off';

/** Tarayıcı ve sunucu web push'u destekliyor mu, bu cihaz abone mi. */
export async function pushState(api: Api): Promise<PushState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return 'unsupported';
  const cfg = await api.pushConfig().catch(() => ({ enabled: false, publicKey: null }));
  if (!cfg.enabled || !cfg.publicKey) return 'disabled';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ? 'on' : 'off';
}

/** Amir uyarıları için bu cihazı abone eder (izin ister). */
export async function enablePush(api: Api): Promise<PushState> {
  const cfg = await api.pushConfig();
  if (!cfg.enabled || !cfg.publicKey) return 'disabled';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(cfg.publicKey) }));
  await api.pushSubscribe(sub.toJSON());
  return 'on';
}

export async function disablePush(api: Api): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe();
  }
  return 'off';
}
