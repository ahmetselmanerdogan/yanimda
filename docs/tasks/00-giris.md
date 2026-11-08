# 07 · Görev Kitabı — adım adım uygulama (v1.0)

Her görev tek başına yapılabilir, test edilebilir ve geri alınabilir bir PR'dır. Biçim: **Amaç · Adımlar · Dosyalar · Kabul/Test · Bağımlılık**. Kimlikler PRD'ye (02), teknik kararlar 03'e, ekranlar 04'e, prosedürler 05'e bağlıdır.

## Basit ama sağlam: v1.0 teknoloji sadeleştirmesi
03 numaralı dokümandaki mimari korunur, ancak v1.0'da işletme yükünü düşürmek için şu sadeleştirmeler geçerlidir (03'ü bu kadarıyla günceller):

| Konu | 03'teki seçim | v1.0 kararı | Neden sağlam kalır |
| --- | --- | --- | --- |
| Olay akışı | Kafka/Redpanda | **Postgres outbox tablosu + BullMQ (Redis) işçileri** | Sinyal önce aynı transaction'da `signal.signal` + `outbox` tablosuna yazılır; işçi outbox'ı okuyup işler; kayıp sıfır, tek veritabanı yedeği yeter. Kafka v2.0'da (çok ülke, yüksek hacim) eklenir; `Bus` arayüzü aynı kalır |
| Kimlik | Keycloak | **Keycloak (dev'de docker, prod'da yönetilen)**; alternatif Auth0 | Değişmedi; ama v1.0'da yalnız 2 realm: `consumers`, `operations` |
| Aile uygulaması | Flutter veya RN | **Flutter** (tek karar) | Tek kod tabanı, arka plan kritik değil |
| Konsol | React + Vite | Değişmedi | |
| Telefoni | Twilio + TR SIP trunk | Değişmedi; **sahte CPaaS** geliştirmede zorunlu | |
| Konum/harita | Google Maps | Değişmedi | |
| Bulut | K8s + Terraform | **v1.0 beta: tek VM/VPS + docker compose (prod profili) + yönetilen Postgres**; K8s Faz 3 | 200–2.000 abone için yeterli; Terraform yalnız VM, DNS, DB için |

Sağlamlık kuralları her görevde geçerlidir: olay kaybı sıfır (outbox), idempotency, her geçiş kayıtlı, her görevde test, PII loglanmaz, mesajlar katalogdan, hata biçimi RFC 7807, sağlık verisi şifreli.

## Çalışma ritmi
1. Görevi `FIRST-CLAUDE-CODE-PROMPT.md` şablonuyla ver; bu kitaptaki adımları istemin "Yapılacak" bölümüne kopyala.
2. Claude Code önce test yazar, sonra kod; `pnpm test` ve `pnpm typecheck` yeşil olmadan PR açılmaz.
3. PR açıklamasında: görev kimliği, kabul kriterleri ve karşılayan testlerin adı.
4. Görev bitince TASKS.md'de kutuyu işaretle, CHANGELOG'a satır ekle.
