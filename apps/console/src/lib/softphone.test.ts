import { describe, expect, it, vi } from 'vitest';

import { ApiError, type VoiceToken } from './api';
import { checkMicrophone, type PhoneSnapshot, startSoftphone, type VoiceCall, type VoiceDevice } from './softphone';

const tok = (provider: 'twilio' | 'fake', token = 'jwt-1'): VoiceToken => ({
  provider,
  identity: 'op_1',
  token,
  ttlSec: 3600,
  expiresAt: '2026-11-09T11:00:00Z',
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...a: any[]) => void;
class FakeDevice implements VoiceDevice {
  readonly handlers = new Map<string, Handler>();
  readonly tokens: string[] = [];
  registered = false;
  destroyed = false;
  constructor(token: string) {
    this.tokens.push(token);
  }
  on(event: string, fn: Handler) {
    this.handlers.set(event, fn);
    return this;
  }
  async register() {
    this.registered = true;
    this.handlers.get('registered')?.();
  }
  updateToken(t: string) {
    this.tokens.push(t);
  }
  disconnectAll() {}
  destroy() {
    this.destroyed = true;
  }
}

const last = (p: { subscribe(fn: (s: PhoneSnapshot) => void): () => void }) => {
  let s: PhoneSnapshot | undefined;
  p.subscribe((x) => (s = x));
  return () => s!;
};

describe('mikrofon izni (girişte)', () => {
  const nav = (o: { perm?: PermissionState; gum?: () => Promise<MediaStream> }) =>
    ({
      permissions: { query: async () => ({ state: o.perm ?? 'prompt' }) },
      mediaDevices: o.gum ? { getUserMedia: o.gum } : undefined,
    }) as unknown as Navigator;

  it('izin API\'si "denied" → sormadan reddedildi', async () => {
    const gum = vi.fn();
    expect(await checkMicrophone(nav({ perm: 'denied', gum }))).toBe('denied');
    expect(gum).not.toHaveBeenCalled();
  });

  it('getUserMedia: izin → akış hemen kapanır; NotAllowedError → denied; NotFoundError → none', async () => {
    const stop = vi.fn();
    const ok = async () => ({ getTracks: () => [{ stop }] }) as unknown as MediaStream;
    expect(await checkMicrophone(nav({ gum: ok }))).toBe('granted');
    expect(stop).toHaveBeenCalled();
    const fail = (name: string) => async () => Promise.reject(Object.assign(new Error(name), { name }));
    expect(await checkMicrophone(nav({ gum: fail('NotAllowedError') }))).toBe('denied');
    expect(await checkMicrophone(nav({ gum: fail('NotFoundError') }))).toBe('none');
    expect(await checkMicrophone(nav({}))).toBe('none');
  });
});

describe('yazılım telefonu', () => {
  it('eğitim modunda sahte cihaz: token istenmez, SDK yüklenmez', async () => {
    const token = vi.fn();
    const load = vi.fn();
    const p = startSoftphone({ token, training: true, load });
    await p.ready;
    expect(p.snapshot().device).toBe('fake');
    expect(token).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('sahte sağlayıcı → sahte cihaz; 503 → masa hattı; diğer hata → error', async () => {
    const load = vi.fn();
    const a = startSoftphone({ token: async () => tok('fake'), load });
    await a.ready;
    expect(a.snapshot().device).toBe('fake');
    expect(load).not.toHaveBeenCalled();
    const b = startSoftphone({ token: async () => Promise.reject(new ApiError(503, 'kapalı')) });
    await b.ready;
    expect(b.snapshot().device).toBe('unavailable');
    const c = startSoftphone({ token: async () => Promise.reject(new Error('ağ')) });
    await c.ready;
    expect(c.snapshot().device).toBe('error');
  });

  it('mikrofon izni yoksa cihaz kaydedilmez', async () => {
    const load = vi.fn();
    const p = startSoftphone({ token: async () => tok('twilio'), mic: async () => 'denied', load });
    await p.ready;
    expect(p.snapshot().device).toBe('mic-denied');
    expect(load).not.toHaveBeenCalled();
  });

  it('Twilio: SDK tembel yüklenir, kayıt → hazır; gelen köprü bacağı kendiliğinden açılır; süre dolmadan token yenilenir', async () => {
    let dev: FakeDevice | undefined;
    const load = vi.fn(async () => (t: string) => (dev = new FakeDevice(t)));
    let n = 0;
    const p = startSoftphone({ token: async () => tok('twilio', `jwt-${++n}`), mic: async () => 'granted', load });
    const state = last(p);
    await p.ready;
    expect(load).toHaveBeenCalledOnce();
    expect(dev!.registered).toBe(true);
    expect(state().device).toBe('ready');

    const call = { accept: vi.fn(), disconnect: vi.fn(), reject: vi.fn(), handlers: new Map<string, () => void>() };
    const c: VoiceCall = { ...call, on: (e, fn) => call.handlers.set(e, fn) };
    dev!.handlers.get('incoming')!(c);
    expect(call.accept).toHaveBeenCalled();
    expect(state().incoming).toBeNull();
    expect(state().connected).toBe(true);
    p.hangup();
    expect(call.disconnect).toHaveBeenCalled();
    call.handlers.get('disconnect')!();
    expect(state().connected).toBe(false);

    dev!.handlers.get('tokenWillExpire')!();
    await vi.waitFor(() => expect(dev!.tokens).toEqual(['jwt-1', 'jwt-2']));

    dev!.handlers.get('error')!(new Error('x'));
    expect(state().device).toBe('error');
    p.destroy();
    expect(dev!.destroyed).toBe(true);
  });

  it('gelen SOS araması (inboundId parametreli) kendiliğinden açılmaz: çalar, Cevapla / Reddet; arayan vazgeçerse susar', async () => {
    let dev: FakeDevice | undefined;
    const p = startSoftphone({
      token: async () => tok('twilio'),
      mic: async () => 'granted',
      load: async () => (t: string) => (dev = new FakeDevice(t)),
    });
    const state = last(p);
    await p.ready;
    const ring = (params: Record<string, string>) => {
      const call = { accept: vi.fn(), disconnect: vi.fn(), reject: vi.fn(), handlers: new Map<string, () => void>() };
      const c: VoiceCall = {
        ...call,
        customParameters: new Map(Object.entries(params)),
        on: (e, fn) => call.handlers.set(e, fn),
      };
      dev!.handlers.get('incoming')!(c);
      return call;
    };

    const a = ring({ inboundId: 'in-1', eventId: 'ev-1' });
    expect(a.accept).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ connected: false, incoming: { inboundId: 'in-1', eventId: 'ev-1' } });
    p.accept();
    expect(a.accept).toHaveBeenCalled();
    expect(state()).toMatchObject({ connected: true, inbound: true, incoming: null });
    a.handlers.get('disconnect')!();
    expect(state()).toMatchObject({ connected: false, inbound: false });

    const b = ring({ inboundId: 'in-2' });
    expect(state().incoming).toEqual({ inboundId: 'in-2', eventId: null });
    p.reject();
    expect(b.reject).toHaveBeenCalled();
    expect(state().incoming).toBeNull();

    // Arayan kapattı ya da süre doldu (sıradaki operatöre geçti): çalma susar.
    const c = ring({ inboundId: 'in-3' });
    expect(state().incoming?.inboundId).toBe('in-3');
    c.handlers.get('cancel')!();
    expect(state().incoming).toBeNull();
  });
});
