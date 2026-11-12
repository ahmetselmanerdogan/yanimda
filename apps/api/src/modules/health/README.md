# health şeması

`health.medical_summary` (T-040): kişi başına tek şifreli tıbbi özet. Kod `modules/profile/profile.service.ts`'te
(`setMedical`, `deleteMedical`, `eventCard`). Kural: yalnız olay anında çözülür, log'a yazılmaz.

T-092 değer kuralları (docs/07 S6, migration 0037) — **bayrakla kapalı** (`vitals.enabled`, `VITALS_ENABLED`):
`health.vital_sample` (geçerli ham örnek, 30 gün), `health.vital_daily` (günlük dilim özeti, 13 ay),
`health.vital_baseline` (kişisel taban), `health.vital_profile` (öğrenme başlangıcı, kişiye özel eşik — aile onayı +
doktor notu işareti, belge içeriği yok), `health.vital_alert` / `vital_silence` / `vital_review` (kural sonuçları,
yorgunluk, amirin eşik incelemesi). Kod `modules/vitals/`. Kapalıyken bu tablolara yazılmaz; operatör yalnız açık
olayda 5 dk ortancaları görür (erişim denetimde), aile haftalık eğilimi; ham dakika verisi kimseye gitmez.
