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
- `apps/api/test/auto-assign.spec.ts` (11): bayrak, öncelik, uygunluk, operatör başına tek olay, kabul, okumanın kabul
  sayılmaması, "Kabul et" ile zincirin kurulması, cevapsız iade ve mola, el değiştirmiş olaya dokunmama, eşzamanlı iki
  tur, amir ucu ve pano.
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
- **Okuma kabul sayılıyordu (CI'da Playwright buldu).** Konsol atanan olayı açınca kişi kartını okuyor; okuma da
  `EventService.operate` üzerinden geçtiği için teklif 0 sn'de kabul edilmiş sayılıyor, "Kabul et" düğmesi kayboluyordu.
  Masada olmayan operatör de olayı kabul etmiş görünürdü. Düzeltme: okumalar ve sistem işlemleri (kişi kartı, 112
  metni, kalp atışı, zincirin yeniden planlanması) `operate(..., { accept: false })` ile geçer. Kabul yalnız operatörün
  kendi eylemleriyle olur (Kabul et / üstlen, arama, adım sonucu, kapatma). Önce kırmızı, sonra yeşil test eklendi.
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

### 6 çekirdekle tekrar (2026-11-14)

Konteyner sanal makinesi (Colima) 2 → 6 çekirdek, 4 → 8 GB yapıldı ve ölçüm aynı yükle yeniden koşuldu: 10.000 sinyal
(100 SOS), 4.000 kişi, 20 sanal operatör, `BENCH_APIS` = 1, 2, 4. Her satır tek koşudur. Yük ortalaması ve Postgres
işlemcisi koşu boyunca 4 sn'de bir örneklendi (Postgres %100 = bir çekirdek).

| Sunucu | Alım /sn | İşleme /sn | Hepsi bitti | Heartbeat işlenme p50 / p95 | SOS işlenme p50 / p95 | Olay → teklif p50 / p95 | Postgres işlemci ortanca / tepe | Mac yük ortalaması (ortanca) | İhlal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 498 | 179 | 57 sn | 29,2 / 46,2 sn | 20,4 / 33,6 sn | 0,9 / 1,6 sn | %136 / %226 | 16 | 0 |
| 2 | 437 | 193 | 52 sn | 20,6 / 32,6 sn | 5,7 / 12,1 sn | 1,0 / 1,6 sn | %243 / %312 | 26 | 0 |
| 4 | 392 | 202 | 50 sn | 12,5 / 26,6 sn | 4,0 / 12,2 sn | 0,9 / 1,8 sn | %270 / %343 | 25 | 0 |

Her koşuda kayıp yok (10.000 / 10.000 işlendi), HTTP hatası yok. 100 olayın hepsi teklif edildi ve kabul edildi.
Yazım anı tetikleyicisi ihlal bulmadı, iki kez kabul edilen olay yok.

Okuma:
- **İşleme hızı neredeyse sabit:** 1 → 4 sunucuda 179 → 202 /sn (+%13). Alım düştü (498 → 392 /sn). Sunucu eklemek
  bu makinede hâlâ ölçeklenme getirmiyor.
- **Darboğaz veritabanı değil, Mac:** Postgres 6 çekirdeğin en çok 2,7'sini (tepe 3,4) kullandı. API süreçleri Mac'te
  koşuyor ve 8 çekirdekli Mac'in yük ortalaması 16–27 idi. Aynı anda başka bir oturum Android emülatörü ve derlemeler
  çalıştırıyordu. Sunucu eklemek boş çekirdek getirmediği için iş hacmi artmadı.
- **Sunucu eklemek gecikmeyi düşürdü:** SOS işlenme ortancası 20,4 → 4,0 sn, heartbeat 29,2 → 12,5 sn. Toplam işçi
  şeridi (sunucu × `OUTBOX_CONCURRENCY`) arttıkça acil bölüm daha erken alınıyor. Yine de aşırı yükte SOS p95 12 sn.
- **Otomatik atama yükten bağımsız:** olay → teklif ortancası her koşuda ~1 sn (tur aralığı 1 sn).
- 1 sunucu satırı 2 çekirdekli koşudan (261 /sn) yavaş: Mac'in yükü koşudan koşuya değişiyor. Satırlar arası küçük
  farklar gürültü içinde.

Sonuç: Bu da kapasite iddiası değildir. Veritabanında boş yer olduğu görüldü (6 çekirdeğin yarısı kullanılmadı);
yatay ölçek ancak API'ler ayrı makinelerde koşunca ölçülebilir (staging, T-083 Helm, 30 dk koşu).

### 1 milyon kişi için açık

- Yatay ölçek ve gerçek kapasite: ayrılmış ortamda ölçülmeli (yukarıda).
- ~~Aşırı yükte SOS p95 18–37 sn~~ → düzeltildi (2026-11-14): kök neden outbox işçisinin bölüm seçimiydi; SOS p95
  < 1 sn (1, 2, 4 sunucu). Bkz. `2026-11-14-sos-asiri-yuk.md`. Eski not: Aşırı yükte (alım işlemeden 2–3 kat hızlı) SOS ortancası 2–17 sn, p95 18–37 sn. Öncelik ortancayı düşürüyor ama alarm
  yine aynı süreçlerde ve veritabanında heartbeat'lerle yarışıyor. Değerlendirilmeli: heartbeat'te kapsama değişmiyorsa
  olay motorunu hiç çalıştırmamak (erken çıkış) veya alarmlar için ayrı işçi süreci (`OUTBOX_WORKER`).
- Otomatik atamanın varsayılanı kapalı. Açmak amirin kararıdır (panodan).

Betik: oturum karalama dizinindeki `multi-api-bench.ts` (depoya alınmadı; `test/e2e/infra.ts` ile aynı yığın).
