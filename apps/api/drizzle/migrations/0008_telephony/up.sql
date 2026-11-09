-- 0008 · T-050 (E-05) giden arama ve kayıt.
-- profile.contact: zincir adımlarının arayacağı numaralar (asgari; aile ekranları ve tam profil T-040). Numara
-- yalnız arama anında okunur; log'a ve telephony.call'a yazılmaz (call yalnız contact_id tutar).
CREATE TABLE profile.contact (
  id uuid PRIMARY KEY,
  protected_person_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('ELDER', 'WATCH', 'CONTACT', 'NEIGHBOR')),
  priority int NOT NULL DEFAULT 1 CHECK (priority >= 1),
  display_name text,
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (protected_person_id, role, priority)
);

-- telephony.call: CPaaS ile yapılan her arama (bir zincir adımında birden çok olabilir).
CREATE TABLE telephony.call (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES event.event (id) ON DELETE CASCADE,
  step_n int NOT NULL,
  operator_id text NOT NULL,
  contact_id uuid REFERENCES profile.contact (id) ON DELETE SET NULL,
  provider text NOT NULL,
  provider_call_id text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'failed', 'canceled')),
  answered boolean NOT NULL DEFAULT false,
  suggested_result text CHECK (suggested_result IN ('REACHED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER')),
  duration_sec int,
  recording_ref text,
  recording_provider_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_event_idx ON telephony.call (event_id, step_n);
CREATE UNIQUE INDEX call_provider_idx ON telephony.call (provider, provider_call_id) WHERE provider_call_id IS NOT NULL;
