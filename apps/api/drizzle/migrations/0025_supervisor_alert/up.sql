-- 0025 · Kalıcı amir uyarıları (gece karar listesi 2). Her `supervisor.alert` (kilit, 112 ulaşmadı / açık / tekrar ara,
-- 112'siz acil kapanış, üstlenilmeyen kuyruk, kaçırılan düzenli arama) çekirdek şeritten yazılır; amir "gördüm" der
-- (kim, ne zaman; audit). Böylece gece kaçan uyarı kaybolmaz ve "takip yapıldı mı" sorusu kayıttan cevaplanır.
CREATE TABLE event.supervisor_alert (
  id uuid PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  code text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  operator_id text,
  at timestamptz NOT NULL,
  acked_at timestamptz,
  acked_by text
);
CREATE INDEX supervisor_alert_open_idx ON event.supervisor_alert (at DESC) WHERE acked_at IS NULL;
CREATE INDEX supervisor_alert_event_idx ON event.supervisor_alert (event_id);
