# Aşırı yükte SOS gecikmesi: kök neden ve düzeltme (2026-11-14)

Önceki ölçümler (`2026-11-13-otomatik-atama-cok-sunucu.md`): alım işlemeden 2–3 kat hızlıyken SOS işlenme p95 12–37
sn. Bu, alarmın heartbeat'lerle aynı süreçte yarışmasının doğal sonucu sanılıyordu. Değildi: outbox işçisinin bölüm
seçiminde iki gecikme kaynağı vardı.

## Kök nedenler

1. **Turda "bitti" sayılan bölümün SOS'u turun sonunu bekliyordu.** Core işçisi bölümleri turlar halinde işler; bölüm
   turda bir kez boşalınca (veya kirası başka işçide olduğu için hiçbir şey teslim edemeyince) `done` kümesine girer ve
   acil bölüm seçimi (`urgentParts().find(free)`) onu dışlıyordu. Aşırı yükte diğer bölümler hep dolu olduğundan tur
   bitmez: o kişinin SOS'u onlarca saniye, bir koşuda 104 sn bekledi. Testte: SOS gelişinden sonra 291 satır daha.
2. **SOS, şeridin elindeki toplu turu (100 satır) bekliyordu.** Aşırı yükte bir satır onlarca ms sürer; tur saniyeler
   sürer. Testte: 95 satır.

Çok sunuculu ilk düzeltme denemesinde üçüncü bir durum çıktı: kirası o an öbür sunucuda olduğu için alınamayan bölüm
tur boyunca "takıldı" sayılırsa iki sunucu da onu bırakıp SOS'u turlarının sonuna bırakabiliyordu (2 sunucuda p95 22
sn).

## Düzeltme (`apps/api/src/common/outbox.worker.ts`)

- Acil satırı olan bölüm, turda boşalmış olsa da yeniden seçilir.
- Acil diye alınıp hiçbir şey teslim edemeyen bölüm (kira başka işçide, anahtar geri çekilmede) 1 sn boyunca yeniden
  acil seçilmez (şerit aynı bölümü boşuna döndürmez), sonra yeniden denenir.
- Rutin toplu tur sırasında `OUTBOX_YIELD_CHECK_MS` (500) aralıkla bekleyen acil iş yoklanır (kısmi indeks
  `outbox_urgent_pending`); bu bölümde yeni gelmiş veya boştaki başka bölümde acil iş varsa şerit turu bırakır, bölüm
  sıranın sonuna döner (iş kaybolmaz). Bölümün kendi acil anahtarı takılıysa (geri çekilmede) kendi acil satırı turu
  bıraktırmaz. Yoklama veritabanı üzerinden olduğu için çok sunucuda da çalışır.
- Kişi başına sıra ve en az bir kez teslim değişmedi.

Testler (`apps/api/test/outbox-partitions.spec.ts`, 5 yeni; ilk üçü düzeltmesiz kırmızı):
- bölümü turda boşalmışken gelen SOS en geç süren toplu turun ardından;
- toplu tur ortasında gelen SOS ≤ 2 satır içinde, bırakılan tur kaybolmaz;
- kirası başka işçide olduğu için alınamayan acil bölüm, kira bırakılınca aynı turda alınır;
- işlenen bölümün içinde başka kişinin SOS'u da beklemez; takılı acil anahtar turu döndürmez;
- kirası başka işçideki acil bölüm turu sonsuz döndürmez.

## Ölçüm

`multi-api-bench.ts` (karalama dizini; `test/e2e/infra.ts` yığını), TimescaleDB konteyneri, 10.000 sinyal (100 SOS,
her SOS ayrı kişi), 4.000 kişi, 20 sanal operatör, her API `OUTBOX_CONCURRENCY=8`, otomatik atama açık. Her satırda
düzeltmesiz (`main`) ve düzeltmeli işçi aynı yükle arka arkaya koşuldu. SOS işlenme: API'ye ulaşma → olay motorunda
işlenme. Mac'te aynı anda emülatörler ve derlemeler vardı (yük ortalaması 8–59): koşular arası iş hacmi farkları
gürültüdür; düzeltmesiz/düzeltmeli karşılaştırması aynı satırdadır.

Son sürüm (iki düzeltme + 1 sn'lik "takıldı"):

| Sunucu | Sürüm | İşleme /sn | SOS p50 / p95 / en kötü | Heartbeat p50 / p95 |
| --- | --- | --- | --- | --- |
| 2 | düzeltmesiz | 317 | 2,1 / 18,3 / 20,3 sn | 11,2 / 21,0 sn |
| 2 | düzeltmeli | 311 | **0,3 / 0,9 / 1,3 sn** | 14,2 / 23,6 sn |
| 4 | düzeltmesiz | 295 | 3,9 / 14,6 / 19,5 sn | 10,2 / 18,1 sn |
| 4 | düzeltmeli | 254 | **0,3 / 0,7 / 1,3 sn** | 16,2 / 28,2 sn |
| 2 | düzeltmesiz | 313 | 3,1 / 15,7 / 18,9 sn | 10,6 / 22,0 sn |
| 2 | düzeltmeli | 310 | **0,3 / 0,7 / 1,3 sn** | 11,5 / 24,5 sn |

Tek sunucu (iki düzeltme, "takıldı" henüz tur boyu; tek sunucuda kira çekişmesi olmadığından son sürümle aynı yol):

| Sunucu | Sürüm | İşleme /sn | SOS p50 / p95 / en kötü | Heartbeat p50 / p95 |
| --- | --- | --- | --- | --- |
| 1 | düzeltmesiz | 88 | 3,1 / 7,5 / 103,9 sn | 64,3 / 103,3 sn |
| 1 | düzeltmeli | 191 | **0,5 / 1,0 / 1,3 sn** | 24,7 / 43,2 sn |
| 1 | düzeltmesiz | 96 | 2,2 / 4,6 / 93,9 sn | 56,6 / 96,7 sn |
| 1 | düzeltmeli | 209 | **0,4 / 0,9 / 1,1 sn** | 22,2 / 37,0 sn |

Yalnız 1. düzeltmeyle (ara sürüm, 1 sunucu) SOS p95 27,4 → 4,9 sn ve 15,2 → 7,9 sn idi; kalan gecikme toplu turu
beklemekti (2. düzeltme).

Okuma:
- Aşırı yükte SOS artık heartbeat birikiminden bağımsız: p95 < 1 sn, en kötü 1,3 sn (1, 2, 4 sunucu).
- Çok sunucuda iş hacmi değişmedi (gürültü içinde). Tek sunucuda düzeltmesiz sürüm turu kapanmayan bölümler yüzünden
  yarı hızda çalışıyordu; düzeltmeyle iki katı.
- Bedel: çok sunucuda heartbeat gecikmesi biraz arttı (p50 +1–6 sn): acil iş her geldiğinde rutin tur bırakılıyor.
  Heartbeat'in hedefi dakika düzeyinde (kapsama), SOS'unki saniye.
- Bu sayılar kapasite iddiası değildir (aynı makinede A/B); kapasite staging'de ölçülmeli.

## Açık

- Heartbeat'te kapsama değişmiyorsa olay motorunu atlamak (erken çıkış) iş hacmini artırır; SOS gecikmesi için artık
  gerekli değil. Ayrı alarm işçisi (`OUTBOX_WORKER`) de gerekmedi.
- Alım (HTTP) tarafı ölçülmedi: SOS, API'ye ulaştığı andan sayıldı. Aşırı yükte HTTP kuyruğu ve bağlantı havuzu
  bekleyişi ayrıca ölçülmeli (staging).
