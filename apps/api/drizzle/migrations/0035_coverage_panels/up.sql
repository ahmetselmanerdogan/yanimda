-- 0035 · docs/07 S4.3 öğrenilmiş şarj penceresi (T-086), S4.10 kronik boşluk planı, S7.1–S7.3 paneller (T-085, T-089).

-- S4.3: şarj penceresi 14 günlük CHARGE_START / CHARGE_END geçmişinden öğrenilir (kaynak LEARNED; aile FAMILY
-- yazdıysa ona dokunulmaz). Kaç geçerli günden öğrenildiği ve ne zaman.
ALTER TABLE event.charging_plan
  ADD COLUMN learned_days integer CHECK (learned_days BETWEEN 1 AND 60),
  ADD COLUMN learned_at timestamptz;

-- Günlük öğrenme kontrolü (kişinin yerel günü) ve S4.10 kronik boşluk işareti: 7 günde 5 boşluktan sonra her boşlukta
-- KAPSAMA BOŞLUĞU (P3) açılmaz; aileye bir kez plan bildirimi, operasyona bir takip. chronic_cleared_at: plan yapıldı
-- (tolerans değişti) veya boşluklar eşiğin altına indi; sayım bu andan sonraki boşluklarla yeniden başlar.
ALTER TABLE event.coverage_state
  ADD COLUMN plan_learned_on text,
  ADD COLUMN chronic_gap_since timestamptz,
  ADD COLUMN chronic_cleared_at timestamptz;

-- Olay eşiğine ulaşan her kapsama boşluğu (şarj boşluğu 120 dk, kapsama YOK 60 dk; + kişiye özel tolerans) bir kez.
-- chronic: boşluk kronik dönemde geldi, P3 açılmadı. Kişisel veri yok (kaynak kimliği kişi kimliği + başlangıç).
CREATE TABLE event.coverage_gap (
  source_id text PRIMARY KEY,
  protected_person_id text NOT NULL,
  reason text NOT NULL,
  at timestamptz NOT NULL,
  chronic boolean NOT NULL DEFAULT false
);
CREATE INDEX coverage_gap_person_at_idx ON event.coverage_gap (protected_person_id, at);

-- S4.10 kişiye özel tolerans (dk): kapsama boşluğu olay eşiğine eklenir (aile planı veya operasyon; 0–240).
ALTER TABLE profile.protected_person
  ADD COLUMN coverage_tolerance_min integer NOT NULL DEFAULT 0 CHECK (coverage_tolerance_min BETWEEN 0 AND 240);
