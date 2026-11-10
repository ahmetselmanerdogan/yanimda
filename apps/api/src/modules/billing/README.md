# billing modülü (T-060, C-01)

Web abonelik: kayıt, ödeme sağlayıcısı, webhook, deneme / ödeme bekleme / askı, tek tık iptal.

- `lifecycle.ts` — saf durum kuralları (tablo testli). TRIAL (ilk gerçek olay veya 30 gün) → ödeme yoksa PAST_DUE
  (7 gün koruma, F-SUB-PAY) → askıda (türetilmiş; koruma kapalı, F-SUB-SUSPENDED). Ödeme → ACTIVE. CANCELED son durum.
- `billing.service.ts` — kayıt (Keycloak hesabı + `ProfileService.create` + TRIAL), telefon OTP (Redis, sha256),
  checkout, webhook uygulama (tek transaction: `profile.payment_webhook` tekrar ayıklama + durum + outbox bildirim +
  audit), iptal, tarama (`BILLING_SWEEP_MS`), `event.created` ile denemenin bitmesi.
- `providers/` — `PaymentProvider` soyutlaması: `iyzico.ts` (Abonelik Checkout Form, IYZWSv2, X-IYZ-SIGNATURE-V3),
  `stripe.ts` (Checkout Session, Stripe-Signature), `fake.ts` (geliştirme/test; `/odeme/sahte`), `registry.ts`
  (TR → iyzico, US → Stripe; `PAYMENT_PROVIDER=fake`).
- `consumer-accounts.ts` — Keycloak Admin REST (hizmet hesabı `yanimda-signup`) ve bellek içi sahte.
- `subscription-protection.ts` — cihaz config'in (`EnrollmentService.config`) okuduğu koruma etkisi.

Kart verisi hiç gelmez (sağlayıcının sayfası). Log'da yalnız kimlikler ve sağlayıcı olay türü; e-posta, telefon,
ad, fatura adresi, token yazılmaz. Gerçek iyzico/Stripe sandbox'ına karşı denenmedi — bkz. CHANGELOG.
