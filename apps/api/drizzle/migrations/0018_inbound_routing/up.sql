-- 0018 · T-051 kalan (E-05) gelen SOS aramaları: CPaaS numarasına gelen arama → olayı yürüten operatör, yoksa bağlı ve
-- müsait operatörler (en uzun boşta kalan önce) sırayla, kimse yoksa kuyruk + bekleme anonsu.
-- Arayan numara yazılmaz: yalnız eşleşen korunan kişi (rehberdeki WATCH/ELDER numarası) ve açık olayı tutulur.
CREATE TABLE telephony.inbound_call (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_call_id text NOT NULL,
  protected_person_id text,
  event_id uuid REFERENCES event.event (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'routing'
    CHECK (status IN ('routing', 'ringing', 'queued', 'connected', 'completed', 'abandoned')),
  -- Çalan / bağlanan operatör (masa hattı modunda 'desk').
  operator_id text,
  -- Denenen operatörler: [{ op, at, result }] (result: ringing | answered | no-answer | busy | failed | canceled).
  attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
  queued_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_sec int,
  recording_ref text,
  recording_provider_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_call_id)
);
CREATE INDEX inbound_call_operator_idx ON telephony.inbound_call (operator_id, status);
CREATE INDEX inbound_call_event_idx ON telephony.inbound_call (event_id);
