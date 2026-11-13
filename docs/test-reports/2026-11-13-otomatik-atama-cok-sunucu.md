# Otomatik atama ve çok API sunuculu yük ölçümü (2026-11-13)

## Otomatik atama (E-02, migration 0039)

Tek ortak kuyruk her olayı her operatöre gösteriyordu; yüzlerce operatörde "kim alacak" belirsiz kalır. Amir panosundaki
**Otomatik atama** bayrağı (`PUT /v1/supervisor/auto-assign`) açıkken:

- `AssignmentService` 2 sn'de bir (`ASSIGN_EVERY_MS`) kuyruğu öncelik → kuyruk başı → yaş sırasıyla tarar. Her olay,
  uygun operatörlerin en uzun boşta kalanına teklif edilir. Uygun: rolü operatör, durumu Müsait, konsolu bağlı (son 90
  sn), elinde yürüttüğü olay (Üstlenildi / Zincir) yok, bekleyen teklifi yok, aramada değil. Teyitli veya 112'deki olayı
  izleyen operatör alabilir; hiç açık olayı olmayan önce gelir.
- Operatör `ASSIGN_ACCEPT_SEC` (20) içinde olayı kabul etmezse olay kuyruğa döner, amire `O-ASSIGN-MISSED` gider,
  operatör molaya alınır. Konsol kendi durumunu 30 sn'de bir yeniler ve molaya alındığını gösterir.
- Kabul insan eylemidir: konsol atanan olayı kendiliğinden açar, sesli uyarı verir ve geri sayımlı **Kabul et** (Enter)
  düğmesini gösterir. Kabul edilene kadar kalp atışı göndermez.
- Birden çok API sunucusu aynı anda atama yapabilir. Uygunluk, olayın transaction'ında operatör satırı kilitlendikten
  sonra ayrı bir sorguyla yeniden denetlenir.
- Amir panosu: bayrak ve son 24 saatte verilen / kabul edilen / cevapsız teklif sayıları, ortanca kabul süresi.

Testler:
- `apps/api/test/auto-assign.spec.ts` (9): bayrak, öncelik, uygunluk, operatör başına tek olay, kabul, cevapsız iade ve
  mola, el değiştirmiş olaya dokunmama, eşzamanlı iki tur, amir ucu ve pano.
- Konsol birim testleri: `offerFor`, `newOffer`.
- Playwright: amir açar, SOS konsolu açık operatöre atanır, operatör kabul eder, amir kapatır (CI'da gerçek Keycloak).

## Çok API sunuculu ölçüm

Düzenek:
- Docker'da TimescaleDB (`infra/init.sql`), tek Redis, `BENCH_APIS` kadar API süreci (aynı veritabanı, aynı zamanlayıcı
  öneki), her biri `OUTBOX_CONCURRENCY=8`, `DATABASE_POOL_MAX=20`, atama turu 1 sn.
- Sinyaller sunuculara sırayla dağıtıldı (yük dengeleyici gibi). Otomatik atama açık; 20 sanal operatör atananı üstlenip
  yanlış alarm olarak kapattı.
- Gecikmeler: sinyalin API'ye ulaşması → olay motorunda işlenmesi; olayın oluşması → operatöre teklif.
- Doğruluk: ölçüm veritabanında teklif yazılırken aynı operatörün bekleyen teklifi veya yürüttüğü olayı var mı
  (tetikleyici), aynı olay iki kez kabul edildi mi.

| Sunucu | Sinyal (SOS) | Alım /sn | İşleme /sn | Heartbeat işlenme p50 | SOS işlenme p50 / p95 | Olay → teklif p50 / p95 | İhlal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 20.000 (200) | 801 | 261 | 40,2 sn | 16,8 / 27,1 sn | 3,5 / 7,4 sn | 0 |
| 2 | 20.000 (200) | 446 | 222 | 39,2 sn | 2,4 / 23,0 sn | 0,7 / 1,6 sn | 0 |
| 2 | 10.000 (100) | 486 | 209 | 18,7 sn | 2,8 / 30,7 sn | 1,1 / 2,6 sn | 0 |
| 4 | 10.000 (500) | 247 | 120 | 34,1 sn | 10,5 / 18,6 sn | 10,3 / 21,8 sn | 0 |

İhlal: ilk iki satırda zaman aralığı çakışması sorgusuyla, son iki satırda yazım anı tetikleyicisiyle (daha kesin) ölçüldü.
Her koşuda kayıp yok (işlenen = gönderilen), HTTP hatası yok, iki kez kabul edilen olay yok. 4 sunucu / 500 SOS
koşusunda olay → teklif süresi uzun, çünkü 20 operatör 500 SOS'u sırayla alıyor (operatör kapasitesi, beklenen).

### Bulunan ve düzeltilen

- **Teklif anı turun başından yazılıyordu.** Yük altında tur saniyeler sürünce teklif anı geriye kayıyor, 20 sn'lik kabul
  süresi kısalıyordu. Ölçümde aynı operatöre üst üste teklif gibi görünüyordu (4 sunucuda 21 ve 435 çakışma). Düzeltme:
  teklif anı ve kabul son anı teklifin yazıldığı andan. Sonra 0.
- **Kilit sonrası denetim:** tek sorguda `... NOT EXISTS (...) FOR UPDATE` Postgres'te kilit beklendikten sonra alt
  sorguları eski anlık görüntüyle değerlendirir. Önce kilit, sonra ayrı denetim sorgusu yapıldı. Bu yarış iki koşuda
  gözlenmedi; Postgres davranışına göre mümkün olduğu için koruma kaldı.

### Bu makinede ölçülemeyen: yatay ölçek

Sunucu eklemek bu makinede hızlandırmadı, yavaşlattı (alım 801 → 247 /sn, işleme 261 → 120 /sn):
- Docker sanal makinesi 2 çekirdekle sınırlı ve başka projelerin veritabanları da onu paylaşıyor. Postgres koşu
  boyunca 2 çekirdekten 1–1,3'ünü kullandı.
- Mac'in 8 çekirdeğinde yük ortalaması ölçüm boyunca 8–30 arasıydı (başka oturumlar, Android derlemeleri).
- Her API süreci tek çekirdek kullanır; 4 API + Postgres + başka işler aynı çekirdekleri paylaştı.

Sonuç: sayılar kapasite iddiası değildir. Çok sunucuda **doğruluk** (kayıp yok, çift atama yok, kişi başına sıra)
gösterildi. **Ölçeklenme ve kapasite** ayrı makinelerde ölçülmeli: en az 8 çekirdekli ayrı bir Postgres ve ayrı
makinelerde API kopyaları (staging, T-083 Helm), 30 dk koşu.

### 1 milyon kişi için açık

- Yatay ölçek ve gerçek kapasite: ayrılmış ortamda ölçülmeli (yukarıda).
- Aşırı yükte (alım işlemeden 2–3 kat hızlı) SOS ortancası 2–17 sn, p95 18–37 sn. Öncelik ortancayı düşürüyor ama alarm
  yine aynı süreçlerde ve veritabanında heartbeat'lerle yarışıyor. Değerlendirilmeli: heartbeat'te kapsama değişmiyorsa
  olay motorunu hiç çalıştırmamak (erken çıkış) veya alarmlar için ayrı işçi süreci (`OUTBOX_WORKER`).
- Otomatik atamanın varsayılanı kapalı. Açmak amirin kararıdır (panodan).

Betik: oturum karalama dizinindeki `multi-api-bench.ts` (depoya alınmadı; `test/e2e/infra.ts` ile aynı yığın).
