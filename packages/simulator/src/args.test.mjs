import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseArgs } from './args.mjs';

const cli = new URL('./index.mjs', import.meta.url).pathname;
const run = (...a) =>
  JSON.parse(
    execFileSync(process.execPath, [cli, ...a], { encoding: 'utf8' })
      .trim()
      .split('\n')[0],
  );
const kinds = JSON.parse(readFileSync(new URL('../../contracts/schemas/signal.schema.json', import.meta.url), 'utf8'))
  .properties.kind.enum;

test('pnpm\'in ilettiği çıplak "--" komutu kaydırmaz', () => {
  const p = parseArgs(['--', 'fall', '--person', 'pp_demo', '--no-cancel', '--dry']);
  assert.equal(p.cmd, 'fall');
  assert.equal(p.opt('person'), 'pp_demo');
  assert.equal(p.has('--no-cancel'), true);
  assert.equal(parseArgs(['--dry', 'sos']).cmd, 'sos');
  assert.equal(parseArgs(['--person', 'x']).cmd, 'heartbeat');
  assert.equal(parseArgs(['pendant', '--event', 'POWER', '--off']).cmd, 'pendant');
});

test('CLI: "-- fall … --dry" FALL sinyali üretir; cihaz bloğunda charging var', () => {
  const [s] = run('--', 'fall', '--person', 'pp_demo', '--no-cancel', '--dry');
  assert.equal(s.kind, 'FALL');
  assert.equal(s.protectedPersonId, 'pp_demo');
  assert.equal(s.device.charging, false);
});

test('şarj ve değer komutları signal.schema.json türleriyle', () => {
  const cases = [
    ['charge-start', 'CHARGE_START'],
    ['charge-end', 'CHARGE_END'],
    ['spo2', 'SPO2'],
    ['skintemp', 'SKIN_TEMP_DEVIATION'],
  ];
  for (const [cmd, kind] of cases) {
    const [s] = run(cmd, '--dry');
    assert.equal(s.kind, kind);
    assert.ok(kinds.includes(s.kind));
  }
  assert.equal(run('charge-start', '--dry')[0].device.charging, true);
  assert.equal(run('charge-end', '--dry')[0].device.charging, false);
  assert.equal(run('spo2', '--value', '87', '--dry')[0].value, 87);
  assert.equal(run('skintemp', '--dry')[0].vital.context, 'SLEEP');
});
