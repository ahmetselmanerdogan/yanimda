DROP TABLE IF EXISTS event.assignment;
DELETE FROM event.supervisor_flag WHERE key = 'auto_assign';
