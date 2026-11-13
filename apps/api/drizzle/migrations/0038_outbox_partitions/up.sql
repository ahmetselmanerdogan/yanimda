-- 0038 · Outbox core şeridi bölümleri (ölçek, 2026-11-13). Sıra yalnız kişi başına gerekir (FALL'dan önce CANCEL
-- işlenmesin); genel FIFO ve tek aktif işçi büyük filonun heartbeat'lerinde SOS'u binlerce satırın arkasında
-- bekletiyordu.
--  - pkey: sıra anahtarı (kişi, yoksa zarfın konu kimliği). Aynı anahtarın satırları id sırasıyla teslim edilir.
--  - part: anahtara göre 32 bölümden biri; her bölüm kendi kirasıyla (id 100 + bölüm) ve paralel işlenir. Bölüm sayısı
--    OutboxWorker.OUTBOX_PARTITIONS ile aynı olmalıdır; değiştirmek bekleyen satırların sırasını bozar.
--  - urgent: rutin ölçüm (heartbeat, nabız, adım, konum, pil, SpO2, cilt sıcaklığı) dışındaki her satır. Bölümde acil
--    satırı olan anahtar önce işlenir (kendi önceki satırlarıyla, sırası bozulmadan); acil bölüm önce seçilir.
ALTER TABLE event.outbox ADD COLUMN pkey text NOT NULL GENERATED ALWAYS AS (
  coalesce(envelope #>> '{payload,protectedPersonId}', envelope ->> 'subjectUserId', '')
) STORED;
ALTER TABLE event.outbox ADD COLUMN part smallint NOT NULL GENERATED ALWAYS AS (
  ((((hashtext(coalesce(envelope #>> '{payload,protectedPersonId}', envelope ->> 'subjectUserId', ''))) % 32) + 32) % 32)::smallint
) STORED;
ALTER TABLE event.outbox ADD COLUMN urgent boolean NOT NULL GENERATED ALWAYS AS (
  NOT (topic = 'signal.received' AND coalesce(envelope #>> '{payload,kind}', '') IN
    ('HEARTBEAT', 'HEART_RATE', 'STEPS', 'LOCATION', 'BATTERY', 'SPO2', 'SKIN_TEMP_DEVIATION'))
) STORED;
CREATE INDEX outbox_part_pending ON event.outbox (part, id) WHERE processed_at IS NULL;
CREATE INDEX outbox_urgent_pending ON event.outbox (part, pkey) WHERE processed_at IS NULL AND urgent;

-- Kira 1 (eski tek işçi) bölümlü işçilerce kalıcı tutulan çittir: deploy sırasında eski sürüm genel FIFO'yla yeni
-- sürümle aynı anda teslim etmesin. 2 = side şeridi, 100–131 = core bölümleri.
ALTER TABLE event.outbox_lease DROP CONSTRAINT outbox_lease_id_check;
ALTER TABLE event.outbox_lease ADD CONSTRAINT outbox_lease_id_check CHECK (id IN (1, 2) OR id BETWEEN 100 AND 131);
