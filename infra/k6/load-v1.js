// T-080 adım 1 · yük testi: 2.000 cihaz × 5 dk'da bir HEARTBEAT, olay dağılımı (SOS / düşme / iptal edilen düşme),
// 20 operatör (WebSocket kuyruğu açık, üstlen + kapat); varsayılan 30 dk.
// Kabul: p95 signal→screen < 5 sn (operatör ekranına WS yayını), HTTP hata 0; kayıp 0 load-cli'de veritabanından sayılır.
//
//   scripts/load-v1.sh                       (yığını açar, k6'yı koşturur, kayıp sayımı + rapor JSON'u)
//   k6 run -e API_URL=http://127.0.0.1:3000/v1 -e TOKENS_FILE=tokens.json infra/k6/load-v1.js
//
// Ortam: DURATION (30m), DEVICES (2000), HEARTBEAT_EVERY (300 sn), EVENTS_PER_MIN (6), OPERATORS (20),
//        THINK_MIN_MS / THINK_MAX_MS (operatörün üstlenip kapatma süresi; 3000 / 15000)
//
// Olay hızı: hedef "500 olay/gün" ortalama ~0,35 olay/dk'dır. Varsayılan 6 olay/dk bunun ~17 katı (yoğun saat + pay)
// ve 30 dk'da ~180 kuyruk örneği verir. Gerçek günlük dağılım için EVENTS_PER_MIN=0.35.
import { sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import ws from 'k6/ws';

const API = __ENV.API_URL || 'http://127.0.0.1:3000/v1';
const WS = `${API.replace(/^http/, 'ws')}/ws/queue`;
const DURATION = __ENV.DURATION || '30m';
const DEVICES = Number(__ENV.DEVICES || 2000);
const HEARTBEAT_EVERY = Number(__ENV.HEARTBEAT_EVERY || 300);
const EVENTS_PER_MIN = Number(__ENV.EVENTS_PER_MIN || 6);
const OPERATORS = Number(__ENV.OPERATORS || 20);
const THINK_MIN_MS = Number(__ENV.THINK_MIN_MS || 3000);
const THINK_MAX_MS = Number(__ENV.THINK_MAX_MS || 15000);
const RUN_ID = __ENV.RUN_ID || `${Date.now()}`;
// Operatör token'ları (load-cli üretir; sahte OIDC, OPERATOR rolü, OTP'li). Init bağlamında bir kez okunur.
const TOKENS = __ENV.TOKENS_FILE ? JSON.parse(open(__ENV.TOKENS_FILE)) : [];

const durationSec = (() => {
  const m = /^(\d+)([smh])$/.exec(DURATION);
  return m ? Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]] : 1800;
})();

const signalToScreen = new Trend('signal_to_screen', true);
const claimLatency = new Trend('operator_claim', true);
const accepted = new Counter('signals_accepted');
const duplicates = new Counter('signals_duplicates');
const eventsSent = new Counter('events_sent');
const eventsClosed = new Counter('events_closed');
const wsErrors = new Counter('ws_errors');
const claimOk = new Rate('claim_ok');

export const options = {
  discardResponseBodies: false,
  // Her yineleme ayrı bir cihazdır; gerçek saat 5 dk'da bir yeni bağlantı açar. Yinelemeler arası bağlantı paylaşımı
  // hem gerçekçi değil hem de Node'un 5 sn keepAliveTimeout'uyla yarışıp EOF üretir (üretimde Caddy keepalive 4s).
  noVUConnectionReuse: true,
  scenarios: {
    // 2.000 cihaz × 5 dk: sabit varış hızı (cihaz başına bir VU yerine; bellek dostu), cihaz kimliği yinelemeden
    heartbeat: {
      executor: 'constant-arrival-rate',
      exec: 'heartbeat',
      rate: DEVICES,
      timeUnit: `${HEARTBEAT_EVERY}s`,
      duration: DURATION,
      preAllocatedVUs: 40,
      maxVUs: 200,
    },
    events: {
      executor: 'constant-arrival-rate',
      exec: 'incident',
      rate: Math.max(1, Math.round(EVENTS_PER_MIN * 100)),
      timeUnit: '100m',
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
    operators: {
      executor: 'per-vu-iterations',
      exec: 'operator',
      vus: OPERATORS,
      iterations: 1,
      maxDuration: `${durationSec + 180}s`,
    },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    signal_to_screen: ['p(95)<5000'],
    'http_req_duration{name:signals}': ['p(95)<300'],
    ws_errors: ['count==0'],
    claim_ok: ['rate==1'],
  },
};

const post = (signals) =>
  http.post(`${API}/signals`, JSON.stringify(signals), {
    headers: { 'content-type': 'application/json' },
    tags: { name: 'signals' },
  });

const signal = (kind, device, person, extra = {}) => ({
  schemaVersion: 1,
  idempotencyKey: `${device}:${Date.now()}:${kind}:${Math.random().toString(36).slice(2, 10)}`,
  deviceId: device,
  protectedPersonId: person,
  kind,
  occurredAt: new Date().toISOString(),
  device: { batteryPct: 70, onWrist: true, connectivity: 'BLE', appVersion: 'k6' },
  ...extra,
});

function send(signals) {
  const r = post(signals);
  if (r.status === 202) {
    accepted.add(r.json('accepted') || 0);
    duplicates.add(r.json('duplicates') || 0);
  }
  return r;
}

export function heartbeat() {
  const n = exec.scenario.iterationInTest % DEVICES;
  send([signal('HEARTBEAT', `k6-dev-${n}`, `k6-pp-${n}`, { payload: { steps: 1200, hrAvg: 72 } })]);
}

/** Olay dağılımı: %40 SOS, %30 düşme (cevap yok → yükselir), %30 düşme + 5 sn sonra iptal (kuyruğa düşmez). */
export function incident() {
  const i = exec.scenario.iterationInTest;
  const person = `k6-ev-${RUN_ID}-${i}`;
  const device = `k6-evdev-${RUN_ID}-${i}`;
  const roll = Math.random();
  eventsSent.add(1, { kind: roll < 0.4 ? 'SOS' : roll < 0.7 ? 'FALL' : 'FALL_CANCELLED' });
  if (roll < 0.4) {
    send([signal('SOS', device, person)]);
    return;
  }
  send([signal('FALL', device, person, { payload: { confidence: 0.91, impactG: 3.4, postImpactMotionSec: 0 } })]);
  if (roll >= 0.7) {
    sleep(5); // VU'yu bekletir; arrival-rate maxVUs bunu karşılar
    send([signal('CANCEL', device, person)]);
  }
}

const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

/**
 * Operatör: kuyruk WebSocket'i açık; her yeni OPERATOR_QUEUE öğesi geldiğinde signal→screen ölçülür (tüm
 * operatör ekranlarında). Olay kimliğinin özeti operatör sırasını seçer (yarış yok): o operatör düşünür, üstlenir,
 * "OK" ile kapatır. Başlangıç: cihaz sorusu olmayan olayda createdAt, sorulu olayda escalatedAt (API metriğiyle aynı).
 */
export function operator() {
  const me = exec.vu.idInTest - 1;
  const token = TOKENS[me % Math.max(1, TOKENS.length)];
  if (!token) throw new Error('TOKENS_FILE yok veya boş');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const seen = {};
  const res = ws.connect(WS, {}, (socket) => {
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token })));
    socket.on('error', () => wsErrors.add(1));
    socket.on('close', () => undefined);
    socket.on('message', (raw) => {
      const m = JSON.parse(raw);
      const items = m.type === 'snapshot' ? m.items : m.type === 'upsert' ? [m.item] : [];
      for (const it of items) {
        if (it.state !== 'OPERATOR_QUEUE' || it.lockedBy || seen[it.eventId]) continue;
        seen[it.eventId] = true;
        if (m.type === 'snapshot') continue; // bağlanmadan önce kuyruğa düşmüş: ölçülmez
        const start = Date.parse(it.escalatedAt || it.createdAt);
        signalToScreen.add(Date.now() - start, { type: it.type });
        if (hash(it.eventId) % OPERATORS !== me) continue;
        const think = THINK_MIN_MS + Math.random() * (THINK_MAX_MS - THINK_MIN_MS);
        socket.setTimeout(() => work(it.eventId, headers), think);
      }
    });
    socket.setTimeout(() => socket.close(), (durationSec + 60) * 1000);
  });
  if (!res || res.status !== 101) wsErrors.add(1);
}

function work(eventId, headers) {
  const t0 = Date.now();
  const c = http.post(`${API}/events/${eventId}/claim`, null, { headers, tags: { name: 'claim' } });
  claimOk.add(c.status === 200);
  if (c.status !== 200) return;
  claimLatency.add(Date.now() - t0);
  const r = http.post(`${API}/events/${eventId}/close`, JSON.stringify({ outcome: 'OK', note: 'k6 yük testi' }), {
    headers,
    tags: { name: 'close' },
  });
  if (r.status === 204) eventsClosed.add(1);
}
