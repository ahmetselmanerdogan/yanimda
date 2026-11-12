#!/usr/bin/env node
// Sahte cihaz CLI: 03-teknik-mimari.md ortak sinyal şemasına uygun sinyal üretir ve POST /v1/signals'a gönderir.
// Kullanım: node src/index.mjs <fall|sos|heartbeat|offbody|onbody|battery|inactivity|cancel|scenario|pendant>
//   [--person id] [--device id] [--no-cancel] [--api url] [--dry] [--file scenarios/x.yaml] [--time-scale 0.1]
//   pendant (T-085 OEM sahte ortak, imzalı webhook): --event SOS|FALL|CANCEL|BATTERY|NOT_WORN|POWER|LINE|BUTTON_TEST
//   --vendor-device FP-0001 [--pct 18] [--days 3] [--off]; PARTNER_FAKE_PENDANT_WEBHOOK_SECRET gerekir.
// Teslim edilemeyen sinyal tamponda kalır ve yeniden denenir (gerçek cihaz gibi, A-09).
import { createDevice, loadScenario } from './device.mjs';
import { pendantEvent, sendPartnerEvents } from './partner.mjs';

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
  // T-085 OEM: sahte ortak merkezinden kolye / ev ünitesi olayı (cihaz önce POST /v1/vendor-links ile bağlanmalı).
  pendant: async () => {
    const type = String(opt('event', 'SOS'));
    const extra =
      type === 'BATTERY'
        ? { battery: Number(opt('pct', 18)) }
        : type === 'NOT_WORN'
          ? { days: Number(opt('days', 3)) }
          : type === 'POWER'
            ? { mains: !args.includes('--off') }
            : type === 'LINE'
              ? { lineUp: !args.includes('--off') }
              : {};
    const ev = pendantEvent(type, String(opt('vendor-device', 'FP-0001')), extra);
    if (args.includes('--dry')) return console.log(JSON.stringify({ events: [ev] }));
    const r = await sendPartnerEvents({
      api: opt('api', process.env.API_URL ?? 'http://localhost:3000/v1'),
      events: [ev],
    });
    console.log(`${type} -> ${r.status} ${JSON.stringify(r.body)}`);
  },
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
