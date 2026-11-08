-- Geliştirme demo verisi (infra/init.sql'den taşındı). T-008 scripts/seed.ts bunu genişletir.
INSERT INTO profile.protected_person (id, display_name, birth_year)
VALUES ('00000000-0000-0000-0000-000000000001', 'Ayşe K. (demo)', 1952)
ON CONFLICT DO NOTHING;
INSERT INTO device.device (id, protected_person_id, kind, model)
VALUES ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-000000000001', 'WEAROS_WATCH', 'Galaxy Watch 6')
ON CONFLICT DO NOTHING;
