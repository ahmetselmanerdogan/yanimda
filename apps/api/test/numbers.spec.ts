import { describe, expect, it } from 'vitest';

import { loadProcedures } from '../src/modules/chain/procedures';
import { loadRulePack, numbersOf } from '../src/modules/event/rules.loader';
import { formatTrNational, normalizePhone, telephonyEnvProblems, trNumberKind } from '../src/modules/telephony/numbers';
import { providerFromEnv } from '../src/modules/telephony/telephony.module';
import { TwilioProvider } from '../src/modules/telephony/twilio';

/**
 * T-052 Türkiye numarası ve 112 prosedürü (E-05). Gerçek hesap olmadan yapılabilenler:
 *  - TR numara biçimi: ulusal / uluslararası / SIP URI → E.164; tür (cep, coğrafi, 850, 800)
 *  - telefoni ortam değişkenleri başlangıçta denetlenir (bozuk numara açılmaz; TR'de TR dışı numara uyarı)
 *  - SIP trunk (Netgsm/Verimor → Twilio BYOC): giden aramalar `byoc` ile trunk'tan çıkar
 *  - 112 / 183 / 182 kural paketinde; 112 adımı aranmaz (masa sabit hattından, manuel)
 */
describe('TR numara biçimi', () => {
  it('ulusal, uluslararası ve SIP URI biçimleri E.164 olur', () => {
    expect(normalizePhone('0532 123 45 67')).toBe('+905321234567');
    expect(normalizePhone('+90 (212) 555 00 00')).toBe('+902125550000');
    expect(normalizePhone('905321234567')).toBe('+905321234567');
    expect(normalizePhone('00905321234567')).toBe('+905321234567');
    expect(normalizePhone('5321234567')).toBe('+905321234567');
    expect(normalizePhone('sip:05321234567@yanimda.sip.twilio.com')).toBe('+905321234567');
    expect(normalizePhone('sip:+905321234567@trunk.example;transport=tls')).toBe('+905321234567');
    expect(normalizePhone('+14155550100')).toBe('+14155550100'); // yurt dışı yakın
  });

  it('geçersizler null: kısa, uzun, harf, TR biçimine uymayan +90', () => {
    for (const bad of ['', '123', '+90532123456', '+9053212345678', 'abc', '0 1 2', '+900000000000', 'client:op_1'])
      expect(normalizePhone(bad), bad).toBeNull();
  });

  it('tür: cep, coğrafi, 850, 800; ulusal gösterim', () => {
    expect(trNumberKind('+905321234567')).toBe('MOBILE');
    expect(trNumberKind('+902125550000')).toBe('GEOGRAPHIC');
    expect(trNumberKind('+903125550000')).toBe('GEOGRAPHIC');
    expect(trNumberKind('+908501234567')).toBe('NON_GEOGRAPHIC');
    expect(trNumberKind('+908001234567')).toBe('TOLL_FREE');
    expect(trNumberKind('+14155550100')).toBeNull();
    expect(formatTrNational('+905321234567')).toBe('0532 123 45 67');
    expect(formatTrNational('+902125550000')).toBe('0212 555 00 00');
    expect(formatTrNational('+14155550100')).toBe('+14155550100');
  });
});

describe('telefoni ortam değişkenleri', () => {
  const base = {
    CPAAS_PROVIDER: 'twilio',
    COUNTRY_CODE: 'TR',
    TWILIO_ACCOUNT_SID: 'AC1',
    TWILIO_AUTH_TOKEN: 'x',
    TWILIO_FROM_NUMBER: '+908501234567',
  };

  it('geçerli TR yapılandırması sorunsuz', () => {
    expect(
      telephonyEnvProblems({
        ...base,
        CPAAS_AGENT_NUMBER: '+902120000000',
        CPAAS_INBOUND_NUMBER: '+908501234567',
        CPAAS_BACKUP_NUMBER: '+902161234567',
        TWILIO_BYOC_TRUNK_SID: `BY${'a'.repeat(32)}`,
      }),
    ).toEqual({ errors: [], warnings: [] });
  });

  it('E.164 olmayan numara, bozuk BYOC kimliği ve aralık dışı süreler hata; TR dışı arayan numara uyarı', () => {
    const p = telephonyEnvProblems({
      ...base,
      TWILIO_FROM_NUMBER: '+14155550100',
      CPAAS_AGENT_NUMBER: '0212 000 00 00',
      CPAAS_INBOUND_NUMBER: 'abc',
      TWILIO_BYOC_TRUNK_SID: 'BYxyz',
      INBOUND_RING_SEC: '2',
    });
    expect(p.errors.map((e) => e.split(':')[0])).toEqual([
      'CPAAS_AGENT_NUMBER',
      'CPAAS_INBOUND_NUMBER',
      'TWILIO_BYOC_TRUNK_SID',
      'INBOUND_RING_SEC',
    ]);
    expect(p.errors[0]).toContain('+902120000000'); // düzeltme önerisi
    expect(p.warnings.map((w) => w.split(':')[0])).toEqual(['TWILIO_FROM_NUMBER']);
    // Hata mesajında sır yok.
    expect(JSON.stringify(p)).not.toContain('AC1');
  });

  it('providerFromEnv hatalı yapılandırmada açılmaz', () => {
    expect(() => providerFromEnv({ ...base, CPAAS_AGENT_NUMBER: '02120000000' } as NodeJS.ProcessEnv)).toThrow(
      /CPAAS_AGENT_NUMBER/,
    );
    expect(providerFromEnv(base as NodeJS.ProcessEnv)?.name).toBe('twilio');
  });
});

describe('SIP trunk (Twilio BYOC)', () => {
  const BYOC = `BY${'b'.repeat(32)}`;
  const urls = {
    status: 's',
    dial: 'd',
    agent: 'a',
    recording: 'r',
    announce: 'n',
    party: 'p',
  };

  it('giden köprü ve konferansa ekleme trunk üzerinden; BYOC yoksa değişmez', async () => {
    const sent: URLSearchParams[] = [];
    const http = (async (_u: string, init?: RequestInit) => {
      if (init?.body) sent.push(init.body as URLSearchParams);
      return new Response(JSON.stringify({ sid: 'CA1' }), { status: 201 });
    }) as typeof fetch;
    const tw = new TwilioProvider(
      { accountSid: 'AC1', authToken: 'x', from: '+908501234567', byocTrunkSid: BYOC },
      http,
    );
    const twiml = tw.dialTwiml({ callId: 'c', to: '+905321234567', agent: 'client:op', timeoutSec: 20, urls });
    expect(twiml).toContain(`<Number byoc="${BYOC}"`);
    await tw.conference({ kind: 'add', room: 'r', to: '+905321234567', announce: 'a', urls });
    await tw.ttsCall('+905321234567', 'metin');
    expect(sent.map((b) => b.get('Byoc'))).toEqual([BYOC, BYOC]);

    const plain = new TwilioProvider({ accountSid: 'AC1', authToken: 'x', from: '+908501234567' }, http);
    expect(plain.dialTwiml({ callId: 'c', to: '+905321234567', agent: 'x', timeoutSec: 20, urls })).not.toContain(
      'byoc',
    );
  });
});

describe('112 ve resmi hatlar kural paketinde', () => {
  it('112, 183, 182; 112 adımı EMERGENCY hedefli (CPaaS aramaz, masa sabit hattı)', () => {
    expect(numbersOf(loadRulePack())).toEqual({ emergency: '112', social: '183', health: '182' });
    expect(loadProcedures().steps.CALL_112).toMatchObject({ target: 'EMERGENCY' });
  });
});
