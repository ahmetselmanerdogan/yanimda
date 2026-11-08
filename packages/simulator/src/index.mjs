#!/usr/bin/env node
// Sahte cihaz: 03-teknik-mimari.md ortak sinyal şemasına uygun sinyal üretir ve POST /v1/signals'a gönderir.
// Kullanım: node src/index.mjs <fall|sos|heartbeat|offbody|onbody|battery|inactivity|cancel|scenario> [--person id] [--device id] [--no-cancel] [--api url] [--dry] [--file scenarios/x.yaml]
import { readFileSync } from 'node:fs';

import YAML from 'yaml';

const args = process.argv.slice(2);
const cmd =
  args.find(
    (a, i) =>
      !a.startsWith('--') &&
      !(i > 0 && args[i - 1].startsWith('--') && !['--dry', '--no-cancel'].includes(args[i - 1])),
  ) ?? 'heartbeat';
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] ?? true) : d;
};
const api = opt('api', process.env.API_URL ?? 'http://localhost:3000/v1');
const person = opt('person', '00000000-0000-0000-0000-000000000001');
const device = opt('device', '00000000-0000-0000-0000-00000000d001');
const dry = args.includes('--dry');
const token = process.env.DEVICE_TOKEN ?? 'dev-token';

const base = (kind, extra = {}) => ({
  schemaVersion: 1,
  idempotencyKey: `${device}:${Date.now()}:${kind}:${Math.random().toString(36).slice(2, 8)}`,
  deviceId: device,
  protectedPersonId: person,
  kind,
  occurredAt: new Date().toISOString(),
  location: { lat: 40.9873, lng: 29.0291, accuracyM: 12, source: 'GPS' },
  device: { batteryPct: 63, onWrist: true, connectivity: 'BLE', appVersion: 'sim-0.1' },
  ...extra,
});

async function send(signals) {
  const body = JSON.stringify(signals);
  if (dry) {
    console.log(body);
    return;
  }
  const res = await fetch(`${api}/signals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body,
  });
  console.log(`${signals.map((s) => s.kind).join(',')} -> ${res.status}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const commands = {
  heartbeat: () => send([base('HEARTBEAT', { payload: { steps: 3200, hrAvg: 74 } })]),
  fall: async () => {
    await send([base('FALL', { payload: { confidence: 0.91, impactG: 3.4, postImpactMotionSec: 0 } })]);
    if (!args.includes('--no-cancel')) {
      await sleep(Number(opt('cancel-after', 5)) * 1000);
      await send([base('CANCEL')]);
    }
  },
  sos: () => send([base('SOS')]),
  cancel: () => send([base('CANCEL')]),
  inactivity: () => send([base('INACTIVITY', { value: Number(opt('minutes', 35)) })]),
  offbody: () => send([base('OFF_BODY', { device: { batteryPct: 63, onWrist: false, connectivity: 'BLE' } })]),
  onbody: () => send([base('ON_BODY')]),
  battery: () => send([base('BATTERY', { value: Number(opt('pct', 18)) })]),
  scenario: async () => {
    const doc = YAML.parse(readFileSync(opt('file', 'scenarios/s3-dusme-teyitsiz.yaml'), 'utf8'));
    console.log(`Senaryo: ${doc.name}`);
    for (const step of doc.steps) {
      if (step.wait) {
        console.log(`  bekle ${step.wait}s`);
        await sleep(step.wait * 1000);
        continue;
      }
      await send([base(step.kind, step.extra ?? {})]);
    }
  },
};
if (!commands[cmd]) {
  console.error(`Bilinmeyen komut: ${cmd}. Seçenekler: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
await commands[cmd]();
