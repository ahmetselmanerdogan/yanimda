DELETE FROM event.outbox_lease WHERE id = 2;
ALTER TABLE event.outbox_lease DROP CONSTRAINT outbox_lease_id_check;
ALTER TABLE event.outbox_lease ADD CONSTRAINT outbox_lease_id_check CHECK (id = 1);
DROP TABLE IF EXISTS event.outbox_side;
