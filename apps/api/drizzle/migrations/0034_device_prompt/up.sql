-- 0034 · T-089 (docs/07 S7.1) operatörün "Soru gönder" komutu ve cihazın cevabı.
-- Her PROMPT komutu bir satır (olay, cihaz, gönderim, pencere sonu, teslim); cihaz penceresi içinde OK / CANCEL
-- ("İyiyim") veya SOS (yardım) gönderirse cevap ve cevaplayan cihaz yazılır. Cevapsız: until geçti, answer boş.
-- Metin, numara, konum yok.
CREATE TABLE event.device_prompt (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES event.event (id) ON DELETE CASCADE,
  device_id text NOT NULL,
  operator_id text,
  sent_at timestamptz NOT NULL,
  until timestamptz NOT NULL,
  delivered boolean NOT NULL,
  answer text CHECK (answer IN ('OK', 'HELP')),
  answered_at timestamptz,
  answered_by text,
  CHECK ((answer IS NULL) = (answered_at IS NULL))
);
CREATE INDEX device_prompt_event_idx ON event.device_prompt (event_id, sent_at);
