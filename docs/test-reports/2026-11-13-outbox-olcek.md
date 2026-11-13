# Outbox ölçek: kişi başına bölümlü, paralel ve öncelikli teslim (2026-11-13)

Bağlam: 1 milyon kişi değerlendirmesinde en büyük teknik engel olarak çıktı. Core şeridi tek aktif işçiyle ve genel
FIFO ile işleniyordu. Her HEARTBEAT de bu kuyruktan geçtiği için büyük filoda SOS binlerce heartbeat'in, bir kişinin
takılan satırı herkesin arkasında bekliyordu.

## Değişiklik (migration 0038, `apps/api/src/common/outbox.worker.ts`)

| | Önce | Sonra |
| --- | --- | --- |
| Sıra | Genel FIFO (bütün satırlar) | Kişi başına (`event.outbox.pkey`: kişi, yoksa zarfın konu kimliği) |
| İşçi | Tek aktif işçi (kira 1), satır satır | 32 bölüm (`part`), bölüm başına kira (100 + bölüm); süreçte `OUTBOX_CONCURRENCY` (4) bölüm paralel, API kopyaları arasında dağılır |
| Takılan satır | Bütün kuyruğu bekletir | Yalnız kendi kişisini bekletir (aynı bölümde bile) |
| Öncelik | Yok | Rutin ölçüm (heartbeat, nabız, adım, konum, pil, SpO2, cilt sıcaklığı) dışındaki her satır acil (`urgent`). Acil satırı olan bölüm her toplu turdan önce öne alınır; bölümde o kişinin satırları (öncekiler dahil, sırasıyla) önce teslim edilir |
| Kira yenileme | Her satırda | Süresinin üçte biri geçince |
| Side şeridi | Her heartbeat için `pendant.maintenance` satırı | Abone süzgeci (`accepts`): yalnız BATTERY |

Kişi başına sıra korunduğu için FALL'dan önce CANCEL veya şarja girmeden önce düşme işlenmez. Kural: CLAUDE.md "her
sinyal aynı transaction'da signal.signal + outbox" değişmedi.

**Deploy:** kira 1, bölümlü işçilerce kalıcı tutulan çittir. Eski sürüm canlıyken yeni işçi teslim etmez; eski sürüm
bıraktığında çit kapanır ve eski sürüm bir daha teslim edemez. Eski sürüme geri dönmek için önce `0038` down migration'ı
çalıştırılmalıdır (çiti kaldırır). Bölüm sayısı (32) değiştirilecekse kuyruk boşken ve yeni migration ile.

## Ölçüm

Ortam: geliştirici Mac (8 çekirdek), Docker'da `timescale/timescaledb:2.17.2-pg16` + `infra/init.sql`, tek API kopyası
(`tsx`, gerçek olay motoru ve kurallar), `DATABASE_POOL_MAX=20`, `OUTBOX_CONCURRENCY=8`, hız sınırı kapalı. Yük: 4.000
kişiye 20.000 sinyal, olabildiğince hızlı (25'lik partiler, 16 paralel istek); %25, %50 ve %75'te birer SOS. Teslim
hızı = teslim edilen satır / (son teslim − ilk yazım). SOS gecikmesi = olayın oluşması − sinyalin alınması.

| Kod | Yük ortalaması | Alım (sinyal/sn) | Teslim (satır/sn) | Tümü teslim | SOS sinyal→olay (sn) |
| --- | --- | --- | --- | --- | --- |
| `main` (tek işçi, FIFO) | ~14 | 1.010 | **112** | 194 sn | **55,8 · 88,9 · 124,3** |
| Bölümlü, öncelik yok (ara adım) | ~15 | 680 | 297 | 68 sn | 45,7 · 21,2 · 40,3 |
| Bölümlü + öncelik (bu PR) | **~106** | 800 | **328** | 61 sn | **5,9 · 4,9 · 4,5** |

Makine aynı anda başka işlerle yüklüydü (son koşuda yük ortalaması 106); sayılar kapasite iddiası değildir, aynı
düzenekte karşılaştırmadır. SOS'un kalan ~5 sn'si, binlerce satırlık birikim varken süren toplu turların ve olay
motorunun süresidir (aşırı yüklü makinede).

Betik: oturum karalama dizinindeki `outbox-bench.ts` (depoya alınmadı; `test/e2e/infra.ts` `startStack` ile aynı yığın).

## 1 milyon kişi için ne değişti, ne kalıyor

- **Çözüldü:** teslim artık yatayda ölçeklenebilir (32 bölüm, API kopyaları arasında dağılır); alarm rutin ölçümlerin
  arkasında beklemiyor; bir kişinin hatası başkasını bekletmiyor.
- **Kalıyor:** tek kopyada ~300 satır/sn. 1 milyon cihaz, 5 dakikada bir heartbeat ≈ 3.300 satır/sn ister:
  - Yaklaşık 10+ API kopyası (veya ayrı işçi süreçleri, `OUTBOX_WORKER`) ve buna göre boyutlanmış Postgres. Çok kopyalı
    ölçüm yapılmadı.
  - Heartbeat başına olay motoru işi (`protection.applySignal`, kapsama güncellemesi) asıl maliyet; heartbeat'te kapsama
    değişmiyorsa erken çıkış veya toplu işleme ayrıca ölçülmeli.
  - 32 bölüm üst sınırı: 32'den çok paralel işçi kullanılamaz. Daha büyük ölçekte Kafka (v2.0 planı).
- **Ölçülmedi:** temiz donanımda uzun koşu, çok API kopyası, gerçek yönetilen Postgres.
