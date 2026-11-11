# profile modülü (T-040)

Korunan kişi, aile sahipliği, adres, kapı notu, rehber, davet ve tıbbi özet.

- `profile.service.ts` — kişi CRUD, tıbbi özet (tablo `health.medical_summary`), davet, olay anı kişi kartı (`eventCard`).
- `profile.controller.ts` — `/v1/protected-persons/*` ve `ProfileGuard` (FAMILY yalnız kendi kişileri, başkası 404; ADMIN hepsi).
- `members.ts` — aile üyesi (MEMBER) daveti ve yönetimi (tablo `profile.member_invite`, 0028): OWNER kod üretir
  (72 sa, tek kullanım, yalnız sha256), `POST /v1/family/members/accept` ile katılım; son hesap sahibi çıkarılamaz.
- `contacts.ts` — zincirin arayacağı numaralar (telefoni de kullanır); numara log/audit'e yazılmaz.
- `geocoder.ts` — Google Geocoding (`GOOGLE_GEOCODING_KEY`).
- Şifreleme `src/common/field-cipher.ts` (AES-256-GCM, `FIELD_ENC_KEYS`).

Sağlık verisi yalnız olay anında, olayı yürüten operatöre çözülür (`GET /v1/events/{id}/person`, 112 şablonu); her
çözüm audit.log'a `health.medical_viewed` olarak yazılır. Aileye içerik geri okunmaz.
