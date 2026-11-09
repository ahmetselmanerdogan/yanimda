import { type CpaasProvider, type DialRequest, verifySignature, xml } from './cpaas';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string;
  apiBase?: string;
}

export function twilioConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TwilioConfig | null {
  const { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken, TWILIO_FROM_NUMBER: from } = env;
  return accountSid && authToken && from ? { accountSid, authToken, from } : null;
}

/**
 * Twilio REST (bağımlılıksız, fetch). Giden arama: operatör ucunu arar, TwiML ile aranan tarafa bağlanır:
 * `<Dial record="record-from-answer-dual">` + `<Number url=anons>` (aranan açınca "Bu görüşme kaydedilmektedir").
 */
export class TwilioProvider implements CpaasProvider {
  readonly name = 'twilio';
  private readonly base: string;

  constructor(
    private readonly cfg: TwilioConfig,
    private readonly http: typeof fetch = fetch,
  ) {
    this.base = `${cfg.apiBase ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${cfg.accountSid}`;
  }

  /** Testlerde TwiML'i görmek için ayrı. */
  dialTwiml(r: DialRequest): string {
    const u = r.urls;
    return (
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
      `<Dial record="record-from-answer-dual" timeout="${Math.max(5, r.timeoutSec || 25)}" callerId="${xml(this.cfg.from)}"` +
      ` action="${xml(u.dial)}" recordingStatusCallback="${xml(u.recording)}" recordingStatusCallbackEvent="completed">` +
      `<Number url="${xml(u.announce)}" statusCallback="${xml(u.status)}"` +
      ` statusCallbackEvent="initiated ringing answered completed">${xml(r.to)}</Number>` +
      '</Dial></Response>'
    );
  }

  async call(r: DialRequest) {
    const body = new URLSearchParams({
      To: r.agent,
      From: this.cfg.from,
      Twiml: this.dialTwiml(r),
      StatusCallback: r.urls.agent,
      StatusCallbackEvent: 'completed',
      Timeout: '20',
    });
    const j = (await this.req('POST', '/Calls.json', body)) as { sid: string };
    return { providerCallId: j.sid };
  }

  async hangup(sid: string) {
    await this.req('POST', `/Calls/${encodeURIComponent(sid)}.json`, new URLSearchParams({ Status: 'completed' }));
  }

  async fetchRecording(id: string): Promise<Buffer> {
    const r = await this.http(`${this.base}/Recordings/${encodeURIComponent(id)}.mp3`, { headers: this.auth() });
    if (!r.ok) throw new Error(`Twilio kayıt indirilemedi: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async deleteRecording(id: string) {
    const r = await this.http(`${this.base}/Recordings/${encodeURIComponent(id)}.json`, {
      method: 'DELETE',
      headers: this.auth(),
    });
    if (!r.ok && r.status !== 404) throw new Error(`Twilio kayıt silinemedi: HTTP ${r.status}`);
  }

  async sendSms(to: string, text: string) {
    const j = (await this.req(
      'POST',
      '/Messages.json',
      new URLSearchParams({ To: to, From: this.cfg.from, Body: text }),
    )) as {
      sid: string;
    };
    return { providerId: j.sid };
  }

  async ttsCall(to: string, text: string) {
    const twiml = `<Response><Say language="tr-TR" voice="Polly.Filiz">${xml(text)}</Say></Response>`;
    const j = (await this.req(
      'POST',
      '/Calls.json',
      new URLSearchParams({ To: to, From: this.cfg.from, Twiml: twiml }),
    )) as {
      sid: string;
    };
    return { providerCallId: j.sid };
  }

  verify(url: string, params: Record<string, string>, signature: string | undefined) {
    return verifySignature(this.cfg.authToken, url, params, signature);
  }

  private auth() {
    return { authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64')}` };
  }

  private async req(method: string, path: string, body: URLSearchParams): Promise<unknown> {
    const r = await this.http(`${this.base}${path}`, {
      method,
      headers: { ...this.auth(), 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Twilio HTTP ${r.status}`); // gövde numara içerebilir: yazılmaz
    return r.json();
  }
}
