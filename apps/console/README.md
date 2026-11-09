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

## Eğitim modu (T-026)

`http://localhost:5173/?training=1`: giriş yok, ağ isteği yok, yerel sahte olaylarla tatbikat. Üretim derlemesinde yoktur.

## Uçtan uca testler

Gerçek Keycloak (realm'ler `infra/keycloak`, kullanıcılar `infra/keycloak/dev-users.mjs`) ve API yığını gerekir:

```bash
KEYCLOAK_URL=http://localhost:8080 STACK_API_PORT=3000 STACK_TIME_SCALE=0.1 pnpm --filter @yanimda/api stack:local
KEYCLOAK_DEV_PASSWORD=... KEYCLOAK_DEV_OTP_SECRET=... VITE_OIDC_AUTHORITY=http://localhost:8080/realms/operations \
  CONSOLE_API_PROXY=http://127.0.0.1:3000 PW_CHANNEL=chrome pnpm --filter @yanimda/console test:e2e
```
