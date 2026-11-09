# notify modülü (T-053, D-08)

- `policy.ts` — hangi geçişte hangi aile kodu, kodun teslim biçimi (acil / bilgi / akış). Saf; tablo testi.
- `notify.service.ts` — planlama (outbox teslimi içinde, ağsız) ve arka plan dağıtımı (kira, yeniden deneme, SMS yedeği), push hedefi kaydı, teslim onayı, SMS teslim raporu.
- `fcm-client.ts` — FCM HTTP v1 (bağımlılıksız). Kişinin cihazlarına push `device/device-push.ts` üzerinden.
- `notify.controller.ts` — `/v1/me/push-target`, `/v1/notifications/{id}/ack`, `/v1/webhooks/notify/sms`.

Satırlarda metin ve telefon numarası yok; metin gönderim anında katalogdan. Log'a kod ve kimlik dışında bir şey yazılmaz.
