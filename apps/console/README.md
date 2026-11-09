# Operatör konsolu (React + Vite)

T-023. Düzen: üst bar, kuyruk (240 px), olay kartı, kişi paneli (260 px), telefon barı. Metinler
`packages/messages` kataloğundan (O-*), renkler `packages/ui-tokens/tokens.json`'dan. Giriş Keycloak
`operations` realm'i (PKCE, OTP zorunlu); API ve canlı kuyruk (`/v1/ws/queue`) operatör token'ıyla.

```bash
cp apps/console/.env.example apps/console/.env.local   # gerekirse adresleri düzenleyin
pnpm --filter @yanimda/console dev                      # http://localhost:5173
```

Klavye: ↑ ↓ seç · Enter üstlen · A ara · 1 ulaşıldı (sonra 1 iyi / 2 acil / 3 devam) · 2 cevap yok · 3 meşgul ·
4 yanlış numara · 5 atla (gerekçe) · N not · C kapat · Ctrl+1 doğrudan 112 · Esc vazgeç.
