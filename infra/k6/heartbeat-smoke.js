// T-016 adım 2 · k6 duman testi: 200 cihaz × 5 dk'da bir HEARTBEAT, 10 dk; aynı anda SOS → kuyruk gecikmesi.
// Kabul: p95 signal→queue < 5 sn, HTTP hata 0.
//   k6 run -e API_URL=http://127.0.0.1:3000/v1 infra/k6/heartbeat-smoke.js
// Süreleri kısaltmak için: -e DURATION=2m -e HEARTBEAT_EVERY=60
import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const API = __ENV.API_URL || 'http://127.0.0.1:3000/v1';
const DURATION = __ENV.DURATION || '10m';
const DEVICES = Number(__ENV.DEVICES || 200);
const HEARTBEAT_EVERY = Number(__ENV.HEARTBEAT_EVERY || 300); // sn
const SOS_EVERY = Number(__ENV.SOS_EVERY || 30); // sn

const signalToQueue = new Trend('signal_to_queue', true);
const heartbeats = new Counter('heartbeats_sent');

export const options = {
  scenarios: {
    heartbeat: { executor: 'constant-vus', vus: DEVICES, duration: DURATION, exec: 'heartbeat' },
    sos_latency: { executor: 'constant-vus', vus: 1, duration: DURATION, exec: 'sosLatency' },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    signal_to_queue: ['p(95)<5000'],
    checks: ['rate==1'],
    'http_req_duration{name:signals}': ['p(95)<300'],
  },
};

const post = (signal) =>
  http.post(`${API}/signals`, JSON.stringify([signal]), {
    headers: { 'content-type': 'application/json' },
    tags: { name: 'signals' },
  });

const signal = (kind, device, person) => ({
  schemaVersion: 1,
  idempotencyKey: `${device}:${Date.now()}:${kind}:${Math.random().toString(36).slice(2, 10)}`,
  deviceId: device,
  protectedPersonId: person,
  kind,
  occurredAt: new Date().toISOString(),
  device: { batteryPct: 70, onWrist: true, connectivity: 'BLE', appVersion: 'k6' },
});

export function heartbeat() {
  const device = `k6-dev-${__VU}`;
  if (__ITER === 0) sleep(Math.random() * HEARTBEAT_EVERY); // cihazları zamana yay
  const r = post(signal('HEARTBEAT', device, `k6-pp-${__VU}`));
  check(r, { 'heartbeat 202': (x) => x.status === 202 });
  heartbeats.add(1);
  sleep(HEARTBEAT_EVERY);
}

export function sosLatency() {
  const person = `k6-sos-${__ITER}-${Date.now()}`;
  const t0 = Date.now();
  const r = post(signal('SOS', `k6-sos-dev-${__ITER}`, person));
  check(r, { 'sos 202': (x) => x.status === 202 });
  let queued = false;
  while (!queued && Date.now() - t0 < 15000) {
    const s = http.get(`${API}/protected-persons/${person}/status`, {
      tags: { name: 'status' },
      responseCallback: http.expectedStatuses(200, 404), // sinyal işlenene kadar 404 beklenir
    });
    queued = s.status === 200 && s.json('openEvent.state') === 'OPERATOR_QUEUE';
    if (!queued) sleep(0.1);
  }
  check(queued, { 'sos kuyrukta (15 sn içinde)': (q) => q === true });
  if (queued) signalToQueue.add(Date.now() - t0);
  sleep(SOS_EVERY);
}
