# health şeması

`health.medical_summary` (T-040): kişi başına tek şifreli tıbbi özet. Kod `modules/profile/profile.service.ts`'te
(`setMedical`, `deleteMedical`, `eventCard`). Kural: yalnız olay anında çözülür, log'a yazılmaz.
