#!/usr/bin/env node
// Sahte cihaz CLI: 03-teknik-mimari.md ortak sinyal şemasına uygun sinyal üretir ve POST /v1/signals'a gönderir.
// Kullanım: node src/index.mjs <fall|sos|heartbeat|offbody|onbody|battery|inactivity|cancel|charge-start|charge-end|
//   spo2|skintemp|scenario|pendant>
//   [--person id] [--device id] [--no-cancel] [--api url] [--dry] [--file scenarios/x.yaml] [--time-scale 0.1]
//   battery --pct 18 · inactivity --minutes 35 · spo2 --value 96 (%) · skintemp --value 0.3 (°C, gece tabanından)
//   pendant (T-085 OEM sahte ortak, imzalı webhook): --event SOS|FALL|CANCEL|BATTERY|NOT_WORN|POWER|LINE|BUTTON_TEST
//   --vendor-device FP-0001 [--pct 18] [--days 3] [--off]; PARTNER_FAKE_PENDANT_WEBHOOK_SECRET gerekir.
// Teslim edilemeyen sinyal tamponda kalır ve yeniden denenir (gerçek cihaz gibi, A-09).
import { parseArgs } from './args.mjs';
import { createDevice, loadScenario } from './device.mjs';
import { pendantEvent, sendPartnerEvents } from './partner.mjs';

const { args, cmd, opt } = parseArgs(process.argv.slice(2));
const dev = createDevice({
  api: opt('api', process.env.API_URL ?? 'http://localhost:3000/v1'),
  person: opt('person', '00000000-0000-0000-0000-000000000001'),
  device: opt('device', '00000000-0000-0000-0000-00000000d001'),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const one = (kind, extra) =>
  args.includes('--dry') ? console.log(JSON.stringify([dev.base(kind, extra)])) : dev.send(kind, extra);
// Sinyalin `device` bloğu bütün yazılır: varsayılanın (device.mjs) üzerine değişiklik.
const devState = (o) => ({ ...dev.base('HEARTBEAT').device, ...o });

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
  offbody: () => one('OFF_BODY', { device: devState({ onWrist: false }) }),
  onbody: () => one('ON_BODY'),
  battery: () => one('BATTERY', { value: Number(opt('pct', 18)) }),
  // T-086 şarj oturumu (S3.4, S4.3): şarja takılan saat çıkarma olayı açmaz; CHARGE_START/END şarj penceresini öğretir.
  'charge-start': () => one('CHARGE_START', { device: devState({ charging: true, onWrist: false }) }),
  'charge-end': () => one('CHARGE_END', { device: devState({ charging: false, onWrist: false }) }),
  // T-092 değerler (S6): SPO2 %, SKIN_TEMP_DEVIATION °C (cihazın gece tabanına göre); kalite Q2 bilek optik.
  spo2: () => one('SPO2', { value: Number(opt('value', 96)), vital: { quality: 'Q2', context: 'RESTING' } }),
  skintemp: () =>
    one('SKIN_TEMP_DEVIATION', { value: Number(opt('value', 0.3)), vital: { quality: 'Q2', context: 'SLEEP' } }),
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
