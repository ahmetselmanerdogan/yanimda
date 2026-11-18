Alertmanager sır dosyaları (git'e girmez, VPS'te 0600):

- `smtp_password` — SMTP parolası
- `telegram_bot_token` — Telegram bot token'ı
- `pagerduty_routing_key` — PagerDuty Events v2 routing key
- `heartbeat_url` — ölü adam anahtarı (Watchdog) ping adresi: VPS **dışındaki** bir deadman servisinin POST kabul
  eden ucu (ör. Healthchecks.io `https://hc-ping.com/<uuid>`; PagerDuty/Opsgenie heartbeat de olur). Dış serviste
  süre 5 dk, tolerans 5 dk ve bildirim kanalı (PagerDuty + Telegram) tanımlanır. Alertmanager `Watchdog` uyarısını
  dakikada bir buraya iletir; Prometheus, Alertmanager, VPS veya ağ düşerse ping kesilir ve dış servis sayfalar.
  Dosya yoksa Alertmanager açılır ama heartbeat gönderimi hata verir (log'da görünür).
