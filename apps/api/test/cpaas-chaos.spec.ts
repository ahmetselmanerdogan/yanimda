import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import { MemoryRecordingStore } from '../src/modules/telephony/recording-store';
import { TelephonyService } from '../src/modules/telephony/telephony.service';
import { TwilioProvider } from '../src/modules/telephony/twilio';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-080 adım 2 kaos: CPaaS (Twilio REST) 500 dönüyor. Kabul:
 *  - "Ara" hata fırlatmaz; arama `failed` + hata kodu, olay operatörde kalır (CONTACT_CHAIN), kayıp yok
 *  - kesinti sırasında gelen yeni SOS kuyruğa düşer (sinyal → olay yolu CPaaS'tan bağımsız)
 *  - CPaaS dönünce aynı adım yeniden aranabilir (yeni arama satırı, sağlayıcı kimliği yazılır)
 *  - numara / Twilio cevabı log'a ve arama satırının hata alanına yazılmaz
 */
const ENV = {
  CPAAS_WEBHOOK_BASE: 'https://api.test',
  CPAAS_AGENT_NUMBER: '+902120000000',
  CPAAS_SOFTPHONE: 'off',
  COUNTRY_CODE: 'TR',
};
const ELDER = '+905550000011'; // saat ve yaşlı aynı hat (adım 1 saat)

let h: Harness;
let tel: TelephonyService;
let chain: ChainService;
let down = false;
const requests: { status: number }[] = [];

// Twilio'nun 500'ü gövdesinde istek ayrıntısı (numara) döndürebilir: sızmadığını da denetle.
const http = (async () => {
  const status = down ? 500 : 201;
  requests.push({ status });
  return down
    ? new Response(JSON.stringify({ code: 20500, message: `Internal error for To=${ELDER}` }), { status })
    : new Response(JSON.stringify({ sid: `CA${requests.length}` }), { status });
}) as unknown as typeof fetch;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  down = false;
  requests.length = 0;
  const tw = new TwilioProvider({ accountSid: 'AC1', authToken: 'tok', from: '+908500000000' }, http);
  tel = new TelephonyService(h.db, h.outbox, tw, new MemoryRecordingStore(), ENV);
  chain = new ChainService(h.db, h.events(new InMemoryTimers()), loadProcedures(), tel);
});
afterAll(async () => {
  await h.close();
});

async function sos(person: string) {
  await bus.deliver<Signal>('signal.received', {
    payload: sig('SOS', { protectedPersonId: person }),
  } as unknown as KafkaEnvelope<Signal>);
  const [row] = await h.rows<{ id: string; state: string }>(
    'SELECT id, state FROM event.event WHERE protected_person_id = $1',
    [person],
  );
  return row!;
}

describe('Kaos: CPaaS 500', () => {
  it('arama başarısız işaretlenir, olay kaybolmaz; CPaaS dönünce aynı adım yeniden aranır', async () => {
    await tel.setContacts('pp-cpaas', [
      { role: 'WATCH', phone: ELDER },
      { role: 'ELDER', phone: ELDER },
    ]);
    const { id } = await sos('pp-cpaas');
    await chain.claim(id, 'op-1');

    down = true;
    const t0 = Date.now();
    const failed = await chain.call(id, 1, 'op-1'); // hata fırlatmaz
    expect(failed.event.state).toBe('CONTACT_CHAIN');
    expect(failed.calls).toHaveLength(1);
    expect(failed.calls[0]).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(failed.calls)).not.toContain(ELDER);
    expect(JSON.stringify(failed.calls)).toContain('Twilio HTTP 500');

    // kesinti sırasında gelen yeni SOS: kuyrukta (telefoni sinyal yolunda değil)
    const other = await sos('pp-cpaas-2');
    expect(other.state).toBe('OPERATOR_QUEUE');

    down = false;
    const retried = await chain.call(id, 1, 'op-1');
    const recoveryMs = Date.now() - t0;
    expect(retried.calls).toHaveLength(2);
    expect(retried.calls[1]!.status).not.toBe('failed');
    const [row] = await h.rows<{ provider_call_id: string | null }>(
      'SELECT provider_call_id FROM telephony.call WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1',
      [id],
    );
    expect(row!.provider_call_id).toMatch(/^CA/);
    expect(requests.map((r) => r.status)).toEqual([500, 201]);

    // olay hâlâ aynı operatörde, açık; kayıp yok
    const [ev] = await h.rows<{ state: string; operator_id: string }>(
      'SELECT state, operator_id FROM event.event WHERE id = $1',
      [id],
    );
    expect(ev).toEqual({ state: 'CONTACT_CHAIN', operator_id: 'op-1' });
    expect(recoveryMs).toBeLessThan(120_000);

    // numara audit / arama satırına yazılmadı
    const leaked = await h.rows<{ n: number }>(
      `SELECT (SELECT count(*) FROM audit.log WHERE data::text LIKE $1)::int
            + (SELECT count(*) FROM telephony.call WHERE coalesce(error, '') LIKE $1)::int AS n`,
      [`%${ELDER}%`],
    );
    expect(leaked[0]!.n).toBe(0);
  });
});
