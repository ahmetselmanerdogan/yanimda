#!/usr/bin/env node
// Sahte cihaz CLI: 03-teknik-mimari.md ortak sinyal şemasına uygun sinyal üretir ve POST /v1/signals'a gönderir.
// Kullanım: node src/index.mjs <fall|sos|heartbeat|offbody|onbody|battery|inactivity|cancel|scenario>
//   [--person id] [--device id] [--no-cancel] [--api url] [--dry] [--file scenarios/x.yaml] [--time-scale 0.1]
// Teslim edilemeyen sinyal tamponda kalır ve yeniden denenir (gerçek cihaz gibi, A-09).
import { createDevice, loadScenario } from './device.mjs';

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
const dev = createDevice({
  api: opt('api', process.env.API_URL ?? 'http://localhost:3000/v1'),
  person: opt('person', '00000000-0000-0000-0000-000000000001'),
  device: opt('device', '00000000-0000-0000-0000-00000000d001'),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const one = (kind, extra) =>
  args.includes('--dry') ? console.log(JSON.stringify([dev.base(kind, extra)])) : dev.send(kind, extra);

const commands = {
  heartbeat: () => one('HEARTBEAT', { payload: { steps: 3200, hrAvg: 74 } }),
  fall: async () => {
    await one('FALL', { payload: { confidence: 0.91, impactG: 3.4, postImpactMotionSec: 0 } });
    if (!args.includes('--no-cancel')) {
      await sleep(Number(opt('cancel-after', 5)) * 1000);
      await one('CANCEL');
    }
  },
  sos: () => one('SOS'),
  cancel: () => one('CANCEL'),
  inactivity: () => one('INACTIVITY', { value: Number(opt('minutes', 35)) }),
  offbody: () => one('OFF_BODY', { device: { batteryPct: 63, onWrist: false, connectivity: 'BLE' } }),
  onbody: () => one('ON_BODY'),
  battery: () => one('BATTERY', { value: Number(opt('pct', 18)) }),
  scenario: () =>
    dev.scenario(loadScenario(opt('file', 'scenarios/s3-dusme-teyitsiz.yaml')), {
      timeScale: Number(opt('time-scale', 1)),
    }),
};
if (!commands[cmd]) {
  console.error(`Bilinmeyen komut: ${cmd}. Seçenekler: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
await commands[cmd]();
