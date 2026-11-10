-- 0020 · İnceleme bulgusu 3: kritik olmayan aboneler (SLA metrikleri, faturalama, yanlış alarm kaydı) SOS'u bekletmesin.
-- Core işçi satırı core abonelere teslim edince, side aboneler için buraya birer satır yazar (aynı transaction'da
-- processed_at ile). Side işçi (ayrı kira, id = 2) abone başına sırayla, geri çekilmeyle teslim eder; maxAttempts
-- sonra dead_at dolar (abone başına DLQ) ve o abonenin kuyruğu ilerler. Core DLQ event.outbox_dlq'da kalır.
CREATE TABLE event.outbox_side (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outbox_id bigint NOT NULL,
  topic text NOT NULL,
  handler text NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  dead_at timestamptz,
  UNIQUE (outbox_id, handler)
);
CREATE INDEX outbox_side_pending_idx ON event.outbox_side (id) WHERE processed_at IS NULL AND dead_at IS NULL;
CREATE INDEX outbox_side_dead_idx ON event.outbox_side (dead_at) WHERE dead_at IS NOT NULL;
-- İkinci kira satırı (side işçi).
ALTER TABLE event.outbox_lease DROP CONSTRAINT outbox_lease_id_check;
ALTER TABLE event.outbox_lease ADD CONSTRAINT outbox_lease_id_check CHECK (id IN (1, 2));
