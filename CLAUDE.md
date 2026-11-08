# Yanımda — Claude Code çalışma kuralları

## Proje

Akıllı saat tabanlı acil müdahale servisi: Wear OS saat + Android/iOS eşlikçi + aile uygulaması + NestJS olay motoru + React operatör konsolu.
Tek doğruluk kaynağı: docs/ altındaki 00–06 numaralı dokümanlar. PRD kimlikleri (A-01, D-03 …) görevlerin referansıdır.
Görev listesi: docs/TASKS.md (T-001 … T-084). Sıra sprint planına göredir.

## Önce oku

- docs/README.md (doküman seti ve indirme bağlantıları)
- docs/02-prd.md (gereksinim ve kabul kriterleri, mesaj kataloğu)
- docs/03-teknik-mimari.md (modüller, veri modeli, şemalar, API)
- docs/04-ux-ui.md (ekranlar, tokens)
- docs/05-prosedur.md (konsol adım listeleri ve script'ler)
- docs/TASKS.md (özet liste) ve docs/TASKS-DETAY.md (her görevin adımları, dosyaları, kabul kriterleri — görev istemine buradan kopyala)

## Kurallar

- Olay kaybı sıfır: her sinyal aynı transaction'da signal.signal + outbox tablosuna yazılır; BullMQ işçisi outbox'ı işler (v1.0; Kafka v2.0). idempotencyKey zorunlu.
- Olay motoru cihaz ve ülke bilmez; cihaz adaptörü ve kural paketi (packages/rules/*.yaml) üzerinden çalışır.
- Kullanıcıya gösterilen her metin packages/messages kataloğundan gelir; yeni metin uydurma, kataloğa ekle.
- Sağlık verisi (health şeması) yalnızca olay anında çözülür; log'lara PII yazılmaz.
- Her görevde: önce test (birim + gerekirse entegrasyon), sonra kod; OpenAPI şeması (packages/contracts/openapi.yaml) güncellenir.
- Commit mesajı: `<alan>(<PRD-id>): <özet>` örn. `backend(D-03): teyit zinciri yürütücüsü`.
- Kod stili: TypeScript strict, ESLint + Prettier; Kotlin ktlint; Swift SwiftLint.
- Sırları koda yazma; .env.example güncelle.

## Komutlar

- `pnpm install` · `docker compose -f infra/docker-compose.yml up -d` · `pnpm dev` · `pnpm test` · `pnpm lint`
- Simülatör: `pnpm --filter @yanimda/simulator start -- fall --person pp_demo --no-cancel`

## Bitmeden kontrol et

docs/06-gelistirme-plani.md "Tanımı tamamlandı" listesi; her PRD kabul kriteri için test; log'da PII yok; mesaj kataloğu dışına metin eklenmedi.
