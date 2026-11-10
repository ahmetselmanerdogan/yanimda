-- 0027 · 112 takip araması (gece karar 7): operatör 112'yi tekrar arayıp durumu sorduğunu işaretler; sayılır ve denetlenir.
ALTER TABLE event.dispatch_update ADD COLUMN follow_up boolean NOT NULL DEFAULT false;
