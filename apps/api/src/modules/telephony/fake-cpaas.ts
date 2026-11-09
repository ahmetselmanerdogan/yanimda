import { randomUUID } from 'node:crypto';

import { type CpaasProvider, cpaasSignature, type DialRequest, verifySignature } from './cpaas';

export const FAKE_CPAAS_TOKEN = 'fake-cpaas-token';

/** Sahte CPaaS'ın webhook'u nasıl ilettiği: varsayılan imzalı HTTP POST; testler doğrudan servise bağlar. */
export type FakeTransport = (url: string, params: Record<string, string>, signature: string) => Promise<void>;

const httpTransport: FakeTransport = async (url, params, signature) => {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    body: new URLSearchParams(params),
  }).catch(() => undefined);
};

/**
 * Geliştirme ve test CPaaS'ı (T-050). Gerçek arama yapmaz; Twilio'nun göndereceği webhook'ları imzalayıp sırasıyla
 * gönderir. Aranan numaranın son hanesi sonucu belirler: 0 cevap yok, 1 meşgul, 9 hatalı numara, diğerleri açar
 * (görüşme `talkMs`, ardından kayıt hazır). Operatör ucu her zaman açar.
 */
export class FakeProvider implements CpaasProvider {
  readonly name = 'fake';
  readonly recordings = new Map<string, Buffer>();
  readonly deleted: string[] = [];
  readonly sms: { to: string; body: string }[] = [];
  readonly hungUp: string[] = [];

  constructor(private readonly opts: { stepMs?: number; talkMs?: number; transport?: FakeTransport } = {}) {}

  private get step() {
    return this.opts.stepMs ?? Number(process.env.FAKE_CPAAS_STEP_MS ?? 700);
  }

  async call(r: DialRequest) {
    const sid = `CAfake${randomUUID().replace(/-/g, '')}`;
    void this.play(r, sid);
    return { providerCallId: sid };
  }

  /** Senaryo: zamanlamalar setTimeout ile; testler `settled` ile bekler. */
  settled: Promise<void> = Promise.resolve();

  private play(r: DialRequest, sid: string) {
    const leg = `${sid}L`;
    const last = r.to.at(-1);
    const outcome = last === '0' ? 'no-answer' : last === '1' ? 'busy' : last === '9' ? 'failed' : 'answered';
    const talk = this.opts.talkMs ?? this.step * 3;
    const steps: [number, string, Record<string, string>][] = [
      [this.step, r.urls.status, { CallSid: leg, CallStatus: 'initiated' }],
      [this.step, r.urls.status, { CallSid: leg, CallStatus: 'ringing' }],
    ];
    if (outcome === 'answered') {
      steps.push(
        [this.step, r.urls.status, { CallSid: leg, CallStatus: 'in-progress' }],
        [talk, r.urls.status, { CallSid: leg, CallStatus: 'completed', CallDuration: String(Math.round(talk / 1000)) }],
        [0, r.urls.dial, { CallSid: sid, DialCallSid: leg, DialCallStatus: 'completed' }],
      );
      const rec = `REfake${randomUUID().replace(/-/g, '')}`;
      this.recordings.set(rec, Buffer.from(`FAKE-MP3:${r.callId}`));
      steps.push([
        this.step,
        r.urls.recording,
        { CallSid: sid, RecordingSid: rec, RecordingStatus: 'completed', RecordingUrl: `https://fake.invalid/${rec}` },
      ]);
    } else {
      steps.push(
        [this.step * 2, r.urls.status, { CallSid: leg, CallStatus: outcome }],
        [0, r.urls.dial, { CallSid: sid, DialCallSid: leg, DialCallStatus: outcome }],
      );
    }
    const transport = this.opts.transport ?? httpTransport;
    this.settled = (async () => {
      for (const [wait, url, params] of steps) {
        await new Promise((res) => setTimeout(res, wait));
        await transport(url, params, cpaasSignature(FAKE_CPAAS_TOKEN, url, params));
      }
    })();
    return this.settled;
  }

  async hangup(sid: string) {
    this.hungUp.push(sid);
  }

  async fetchRecording(id: string) {
    const b = this.recordings.get(id);
    if (!b) throw new Error('Kayıt yok');
    return b;
  }

  async deleteRecording(id: string) {
    this.recordings.delete(id);
    this.deleted.push(id);
  }

  async sendSms(to: string, body: string) {
    this.sms.push({ to, body });
    return { providerId: `SMfake${randomUUID()}` };
  }

  readonly tts: { to: string; text: string }[] = [];
  async ttsCall(to: string, text: string) {
    this.tts.push({ to, text });
    return { providerCallId: `CAfake${randomUUID()}` };
  }

  verify(url: string, params: Record<string, string>, signature: string | undefined) {
    return verifySignature(FAKE_CPAAS_TOKEN, url, params, signature);
  }
}
