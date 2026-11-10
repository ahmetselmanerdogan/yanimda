-- 0022 · 112 bildirim ve intikal takibi (E-07 genişletme). Olay DISPATCH'e geçince (112 arandı) süreç açılır;
-- aşamalar operatör / amir tarafından (112'yi veya aileyi arayarak) işlenir, olay kapansa da süreç takipte kalır.
-- Aşama sırası: NOTIFIED → ACCEPTED → EN_ROUTE → ON_SCENE → TRANSPORTING → AT_HOSPITAL → COMPLETED; CANCELLED her an.
CREATE TABLE event.dispatch (
  event_id uuid PRIMARY KEY REFERENCES event.event (id) ON DELETE CASCADE,
  protected_person_id text NOT NULL,
  status text NOT NULL DEFAULT 'NOTIFIED'
    CHECK (status IN ('NOTIFIED', 'ACCEPTED', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING', 'AT_HOSPITAL', 'COMPLETED', 'CANCELLED')),
  notified_at timestamptz NOT NULL,
  notified_by text,
  -- 112'nin verdiği vaka / ihbar numarası (varsa); tahmini varış (dk); götürüldüğü hastane.
  case_ref text,
  eta_min int CHECK (eta_min IS NULL OR eta_min BETWEEN 0 AND 600),
  hospital text,
  accepted_at timestamptz,
  en_route_at timestamptz,
  on_scene_at timestamptz,
  transporting_at timestamptz,
  at_hospital_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  -- Takip zamanlayıcısının amir uyarısı sayısı ve son denetim.
  checks int NOT NULL DEFAULT 0,
  last_check_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispatch_open_idx ON event.dispatch (notified_at) WHERE status NOT IN ('COMPLETED', 'CANCELLED');

-- Zaman çizelgesi: her aşama girişi kim tarafından, hangi kaynakla (112 geri bildirimi, aile, operatör, sistem).
CREATE TABLE event.dispatch_update (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES event.dispatch (event_id) ON DELETE CASCADE,
  status text NOT NULL,
  at timestamptz NOT NULL,
  actor_kind text NOT NULL,
  actor_id text,
  source text NOT NULL CHECK (source IN ('OPERATOR', 'EMS', 'FAMILY', 'SYSTEM')),
  note text
);
CREATE INDEX dispatch_update_event_idx ON event.dispatch_update (event_id, at);
