-- 0039 · Otomatik atama (1 milyon kişi değerlendirmesi, 2026-11-13). Amir bayrağı event.supervisor_flag
-- 'auto_assign' açıkken kuyruktaki olay uygun operatöre atanır. Her atama bir tekliftir: operatör olayı süre içinde
-- açarsa (üstlen / kalp atışı) ACCEPTED, açmazsa MISSED (olay kuyruğa döner, operatör molaya), olay bu arada başka
-- yoldan el değiştirdiyse SUPERSEDED. Kabul süresi ve oranı amir panosu için buradan okunur. PII yok.
CREATE TABLE event.assignment (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL,
  operator_id text NOT NULL,
  offered_at timestamptz NOT NULL,
  -- Kabul son anı: konsol geri sayımı ve iade (offered_at + ASSIGN_ACCEPT_SEC).
  expires_at timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('ACCEPTED', 'MISSED', 'SUPERSEDED')),
  decided_at timestamptz
);
CREATE INDEX assignment_open_idx ON event.assignment (expires_at) WHERE outcome IS NULL;
CREATE INDEX assignment_event_idx ON event.assignment (event_id);
CREATE INDEX assignment_operator_open_idx ON event.assignment (operator_id) WHERE outcome IS NULL;
