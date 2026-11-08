# Değişiklik günlüğü

## Yayınlanmamış

- T-007 CI tamamlama: `apps/api/Dockerfile` (çok aşamalı node:20-alpine, `pnpm deploy --prod`, root olmayan kullanıcı), `.dockerignore`; CI'da kural paketi doğrulaması, lint, typecheck, test, build, imaj boyutu < 250 MB kontrolü, duman testi ve Trivy (HIGH/CRITICAL'da fail).
- Düzeltme: `@yanimda/contracts` artık `dist/`'e derleniyor (`main: dist/index.js`, tipler `src/`'den). Önceden derlenmiş API (`node dist/main.js`) `.ts` dosyası yüklemeye çalışıp açılmıyordu.

- T-001b Kod kalitesi araçları: kökte `eslint.config.js` (flat, typescript-eslint, simple-import-sort, prettier uyumu), `.prettierrc` (singleQuote, 120 kolon); tüm paketlerde `lint` ve `typecheck`; Husky pre-commit (lint-staged: prettier + eslint --fix) ve commit-msg (commitlint: `<alan>(<PRD-id|T-id|X-id>): <özet>`). CI'a `pnpm lint` eklendi.
