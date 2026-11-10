-- 0017 · T-072 (D-12) otomatik sesli ön eleme: olay başına en çok bir arama ve sonucu.
-- Numara tutulmaz (contact_id); konuşma dökümü tutulmaz, yalnız eşleşen katalog terimi (ör. "evet") ve güven.
CREATE TABLE event.voice_screening (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES event.event (id),
  protected_person_id text NOT NULL,
  event_type text NOT NULL,
  contact_id uuid,
  provider text NOT NULL,
  provider_call_id text,
  -- Kural paketinden o anki eşleştirme ayarları (sıcak yüklemede arama ortasında değişmesin).
  config jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'OK', 'HELP', 'UNCLEAR', 'NO_ANSWER', 'FAILED', 'CANCELLED')),
  reason text,
  input text CHECK (input IN ('DTMF', 'SPEECH')),
  matched text,
  confidence real,
  call_status text,
  -- Öğrenme modunda (ilk ay) OK sonucu operatör örneklemine alındı mı (CALLBACK kaynağı voice-screen-sample:<id>).
  sampled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX voice_screening_event_uq ON event.voice_screening (event_id);
CREATE INDEX voice_screening_created_idx ON event.voice_screening (created_at);
