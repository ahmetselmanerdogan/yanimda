-- 0038 · Outbox core şeridi bölümleri (ölçek, 2026-11-13). Sıra yalnız kişi başına gerekir (FALL'dan önce CANCEL
-- işlenmesin); genel FIFO ve tek aktif işçi 1 milyon cihazın heartbeat'inde SOS'u binlerce satırın arkasında
-- bekletiyordu. Satır kişiye (yoksa zarfın konu kimliğine) göre 32 bölümden birine düşer; her bölüm kendi kirasıyla
-- (id 100 + bölüm) ve paralel işlenir. Bölüm sayısı OutboxWorker.OUTBOX_PARTITIONS ile aynı olmalıdır; değiştirmek
-- bekleyen satırların sırasını bozar (yeni migration + kuyruk boşken).
ALTER TABLE event.outbox ADD COLUMN part smallint NOT NULL GENERATED ALWAYS AS (
  ((((hashtext(coalesce(envelope #>> '{payload,protectedPersonId}', envelope ->> 'subjectUserId', ''))) % 32) + 32) % 32)::smallint
) STORED;
CREATE INDEX outbox_part_pending ON event.outbox (part, id) WHERE processed_at IS NULL;

-- Kira 1 (eski tek işçi) bölümlü işçilerce sonsuza dek tutulan çittir: deploy sırasında eski sürüm genel FIFO'yla
-- yeni sürümle aynı anda teslim etmesin. 2 = side şeridi, 100–131 = core bölümleri.
ALTER TABLE event.outbox_lease DROP CONSTRAINT outbox_lease_id_check;
ALTER TABLE event.outbox_lease ADD CONSTRAINT outbox_lease_id_check CHECK (id IN (1, 2) OR id BETWEEN 100 AND 131);
