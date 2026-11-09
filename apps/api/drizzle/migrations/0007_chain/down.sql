DROP TABLE chain.chain_step;
DROP TABLE chain.chain_run;
DROP INDEX event.event_lock_until_idx;
ALTER TABLE event.event DROP COLUMN lock_until;
