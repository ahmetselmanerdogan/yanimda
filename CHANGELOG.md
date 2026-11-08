# Değişiklik günlüğü

## Yayınlanmamış

- T-001b Kod kalitesi araçları: kökte `eslint.config.js` (flat, typescript-eslint, simple-import-sort, prettier uyumu), `.prettierrc` (singleQuote, 120 kolon); tüm paketlerde `lint` ve `typecheck`; Husky pre-commit (lint-staged: prettier + eslint --fix) ve commit-msg (commitlint: `<alan>(<PRD-id|T-id|X-id>): <özet>`). CI'a `pnpm lint` eklendi.
