-- 0014 · T-074 (E-11) amir panosu: operatör durumu ve "görüldü", amir bayrakları (yedek merkeze taşma, v2.0'da gerçek).
-- Operatör adı personel adıdır (korunan kişi verisi değil); log'a yazılmaz.
CREATE TABLE identity.operator (
  subject text PRIMARY KEY,
  display_name text,
  -- Amir de görülür (adı, olay üstlenirse kartta görünsün); kartlar yalnız OPERATOR veya olay yürütenler.
  kind text NOT NULL DEFAULT 'OPERATOR' CHECK (kind IN ('OPERATOR', 'SUPERVISOR')),
  status text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'BREAK', 'OFFLINE')),
  status_at timestamptz NOT NULL DEFAULT now(),
  status_by text,
  last_seen_at timestamptz
);

CREATE TABLE event.supervisor_flag (
  key text PRIMARY KEY,
  enabled boolean NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text
);
