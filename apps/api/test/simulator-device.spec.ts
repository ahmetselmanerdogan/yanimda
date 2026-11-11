import { createDevice } from '@yanimda/simulator';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * D-01 referans cihaz (packages/simulator/src/device.mjs): sunucunun açıkça reddetmediği alarm sinyali 4xx'te
 * atılmaz; yalnız `rejected` listesinde adı geçen sinyal kalıcı hatadır.
 */
type Reply = { status: number; body?: unknown };

function fakeFetch(replies: Reply[]) {
  const calls: unknown[][] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    const r = replies.shift() ?? { status: 202, body: { accepted: 1, duplicates: 0, rejected: [] } };
    return {
      status: r.status,
      headers: { get: () => null },
      json: async () => r.body ?? null,
    };
  });
  return calls;
}

const device = () => createDevice({ api: 'http://test/v1', log: () => undefined, minBackoffMs: 1, maxBackoffMs: 2 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('simülatör cihazı 4xx davranışı', () => {
  it('açıkça reddedilmeyen 4xx (ör. 401/403) alarm sinyalini atmaz; düzelince teslim eder', async () => {
    const calls = fakeFetch([{ status: 401 }, { status: 403, body: { status: 403, detail: 'x' } }]);
    const d = device();
    await d.send('SOS');
    expect(calls).toHaveLength(3);
    expect(d.stats).toMatchObject({ delivered: 1, failed: 0, retries: 2 });
    expect(d.pending()).toBe(0);
  });

  it('rejected listesinde adı geçen sinyal (400) kalıcı hatadır, atılır — alarm olsa da', async () => {
    const calls = fakeFetch([
      { status: 400, body: { status: 400, rejected: [{ index: 0, reason: 'UNSUPPORTED_SIGNAL' }] } },
    ]);
    const d = device();
    await d.send('SOS');
    expect(calls).toHaveLength(1);
    expect(d.stats).toMatchObject({ delivered: 0, failed: 1 });
  });

  it('alarm olmayan sinyal açıklamasız 4xx’te eskisi gibi atılır', async () => {
    const calls = fakeFetch([{ status: 400 }]);
    const d = device();
    await d.send('HEARTBEAT');
    expect(calls).toHaveLength(1);
    expect(d.stats).toMatchObject({ delivered: 0, failed: 1 });
  });

  it('202 yanıtında reddedilen sinyal teslim sayılmaz', async () => {
    fakeFetch([
      { status: 202, body: { accepted: 0, duplicates: 0, rejected: [{ index: 0, reason: 'SCHEMA_INVALID' }] } },
    ]);
    const d = device();
    await d.send('FALL');
    expect(d.stats).toMatchObject({ delivered: 0, failed: 1 });
  });
});
