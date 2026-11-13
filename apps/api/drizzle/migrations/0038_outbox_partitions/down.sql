DELETE FROM event.outbox_lease WHERE id >= 100;
-- Çiti kaldır: eski tek işçi kira 1'i yeniden alabilsin.
UPDATE event.outbox_lease SET owner = 'released', until = '-infinity' WHERE id = 1 AND owner = 'partitioned';
ALTER TABLE event.outbox_lease DROP CONSTRAINT outbox_lease_id_check;
ALTER TABLE event.outbox_lease ADD CONSTRAINT outbox_lease_id_check CHECK (id IN (1, 2));
DROP INDEX IF EXISTS event.outbox_part_pending;
ALTER TABLE event.outbox DROP COLUMN part;
