-- 0023 · Düzenli "yanınızdayız" aramaları ve bildirimleri. Kişi başına plan (sıklık, gün, yerel saat, kanal);
-- her dönem için bir arama satırı: kişiye bildirim + operatör kuyruğunda P4 geri arama (CALLBACK); olay kapanınca
-- sonuç işlenir, pencere dolarsa KAÇIRILDI + amir uyarısı. Uyum oranı kişi ve merkez bazında raporlanır.
CREATE TABLE profile.check_plan (
  protected_person_id uuid PRIMARY KEY REFERENCES profile.protected_person (id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  frequency text NOT NULL DEFAULT 'WEEKLY' CHECK (frequency IN ('DAILY', 'WEEKLY', 'BIWEEKLY')),
  -- ISO hafta günü (1 = Pazartesi … 7); DAILY'de yok sayılır.
  weekday int NOT NULL DEFAULT 3 CHECK (weekday BETWEEN 1 AND 7),
  local_time text NOT NULL DEFAULT '11:00' CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  channel text NOT NULL DEFAULT 'BOTH' CHECK (channel IN ('CALL', 'NOTIFY', 'BOTH')),
  -- Aramanın tamamlanması için süre (dk); dolunca KAÇIRILDI.
  window_min int NOT NULL DEFAULT 120 CHECK (window_min BETWEEN 15 AND 1440),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE TABLE event.check_call (
  id uuid PRIMARY KEY,
  protected_person_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  window_until timestamptz NOT NULL,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED'
    CHECK (status IN ('SCHEDULED', 'IN_PROGRESS', 'DONE_OK', 'DONE_HELP', 'NOTIFIED', 'MISSED', 'SKIPPED')),
  event_id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  operator_id text,
  outcome text,
  UNIQUE (protected_person_id, due_at)
);
CREATE INDEX check_call_due_idx ON event.check_call (due_at) WHERE status IN ('SCHEDULED', 'IN_PROGRESS');
CREATE INDEX check_call_event_idx ON event.check_call (event_id);
