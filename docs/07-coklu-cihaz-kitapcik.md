# Yanımda — Çoklu Cihaz, Şarj ve Acil Durum Kitapçığı

11 Kasım 2026

## Giriş

Bu kitapçık, Yanımda'nın tek saatten kişi başına 3–4 cihaza (saat, telefon, yüzük, kulaklık, küpe, kolye) geçişini soru-cevap olarak planlar. Ana karar: hiçbir cihaz tek başına "koruma" sayılmaz; kişinin korunup korunmadığını cihazların toplamından hesaplanan tek bir **kapsama durumu** söyler.

Kapsam:

- Kişi başına çoklu cihaz modeli ve harici OEM cihazların devreye alınması
- Birden çok cihazdan gelen sinyallerin birleştirilmesi
- Şarj sırasında oluşan koruma boşluğu
- Kişiye ulaşılamadığında izlenecek yol
- Nabız, oksijen, sıcaklık ve hareketsizlikte anormallik
- Operatör, amir, yönetim panelleri; aile, telefon ve saat uygulamaları
- Veri modeli, API, kural paketi, güvenlik ve mevzuat

Nasıl hazırlandı: bir ajan mevcut kodu (cihaz, koruma, pil, zincir, paneller) inceledi; bir ajan OEM cihaz ekosistemini ve mevzuatı kaynaklarıyla araştırdı; iki tasarım ajanı (Fable 5.1 ve Opus 5.5) birbirinin önerisini eleştirdi. Kararlar, tartışmanın uzlaştığı yerdir; uzlaşılmayan noktalar son bölümde sizin kararınıza bırakıldı.

Okuma önerisi: hızlı bakış için her bölümün ilk cümlesi o bölümün kararıdır. Ayrıntı, altındaki sorulardadır.

## 1. Kişi başına çoklu cihaz

Karar: "birincil cihaz" yoktur. Her cihaz bir kategori, bir sınıf (A/B/C), bir vücut konumu ve bir yetenek profiliyle kaydedilir. Kimin neyi algılayacağını yetenekler belirler; yalnız sesli arama sırası vardır.

**S1.1 — Bugün sistem kaç cihazı tanıyor?** Kayıt sınırı yok ama koruma durumu kişi başına tek saat ve tek telefon alanı tutuyor. İki giyilebilir cihaz birbirinin bilgisini ezer; yüzük takılıyken saat çıkarılırsa yine "saat çıkarıldı" olayı açılır. Çoklu cihazın ilk işi bu tek-saat varsayımını kaldırmaktır.

**S1.2 — Neden birincil cihaz yok?** Saat, kolye ve yüzükü olan bir kişide gündüz ses için saat, gece düşme için kolye önemlidir. Tek "birincil" bayrağı günün yarısında yanlış olur ve şarjdaki birincil cihaz korumayı bir anda düşürür. Algılama "herhangi biri" mantığıyla çalışır: giyili ve çevrimiçi her alarm sınıfı cihaz düşme veya SOS yakalayabilir.

**S1.3 — Hangi cihaz kategorileri olacak?** Saat, telefon, kolye (hücresel veya ev ünitesine bağlı radyo), yüzük, kulaklık, küpe, ev ünitesi ve bulut kaynağı (Oura, Garmin, Google Health gibi üretici bulutları). Vücut konumu: bilek (sol/sağ), boyun, göğüs, parmak, kulak, cep, ev (sabit).

**S1.4 — Bir cihazın neler yapabildiğini nereden bileceğiz?** İki katmandan: üretici modeli kataloğu ve cihazın anlık durumu. Katalog her model ve yazılım sürümü için yetenekleri tutar: SOS düğmesi, otomatik düşme algılama, iki yönlü ses, otomatik cevap, konum, takılı algılama, şarj bildirimi, nabız, oksijen, cilt sıcaklığı, adım. Her yeteneğin gecikme sınıfı (anlık ≤30 sn, yakın ≤5 dk, toplu ≤1 sa, günlük) ve kalite sınıfı (Q1 doğrulanmış, Q2 bilek optik, Q3 yüzük/kulak/küpe sağlık-amaçlı) vardır.

Bir yetenek ancak şu an geçerliyse sayılır: modelde var, izin verilmiş, cihaz takılı (vücut yetenekleri için), bağlı, şarjda değil ve pil %5'in üzerinde.

**S1.5 — Aynı saat neden iki farklı sınıfta olabilir?** Galaxy Watch bizim uygulamamızla çalışırken alarm sınıfıdır (A); yalnız Samsung Health üzerinden okunursa sadece eğilim verisidir (C). Yetenek cihaz türüne değil, model × entegrasyon yoluna aittir. Galaxy Watch'ta sert düşme algılama varsayılan kapalıdır; aile açtığını onaylayana kadar düşme yeteneği sayılmaz.

**S1.6 — Cihazlar sunucuya nasıl ulaşır?**

| Yol | Hangi cihaz | Not |
| --- | --- | --- |
| Doğrudan hücresel | LTE saat, hücresel kolye | Telefona bağımlı değil |
| Telefon üzerinden (BLE) | Yüzük, kulaklık, küpe, BLE kolye, LTE'siz saat | Telefon kapanırsa hepsi aynı anda düşer |
| Ev ünitesi üzerinden | 869 MHz radyo kolye | Ses ev ünitesinden yapılır |
| Üretici bulutu | Oura, Garmin, Google Health | Dakikalar-saatler gecikmeli; yalnız eğilim |
| Ortak alarm merkezi | Kolye üreticisinin kendi merkezi | Ticari ortaklık gerekir |

Köprü ilişkisi (örneğin yüzük → telefon) artık kayıtlı tutulur. Köprülü bir cihaz, köprüsü çevrimiçiyse çevrimiçi sayılır. Bu yüzden telefonun pili ve şarjı artık tüm BLE cihazların korumasını belirler ve kendi uyarıları vardır.

**S1.7 — Kişi başına üst sınır nedir?** En çok 6 etkin cihaz: en çok 3 alarm sınıfı giyilebilir, tam 1 yaşlı telefonu (sesli arama yolu tek ve net kalsın; ev sabit hattı yakın numarası olarak girilir), en çok 2 bulut kaynağı. Üç alarm cihazı gerçek bir senaryodur: gündüz saati, hücresel kolye, gece radyo kolye. Sınır aşılırsa aileye F-DEVICE-LIMIT gösterilir.

**S1.8 — Sesli arama sırası nasıl belirlenir?** Varsayılan sıra hesaplanır: şu an takılı olan, en son görülen, iki yönlü ses > ev ünitesi hoparlörü > telefon. Aile veya operatör bu sırayı elle değiştirebilir. İşitme veya konuşma güçlüğü olan kişide otomatik cevap "ulaşılamadı" sayılır ve yakınlara daha erken geçilir.

**S1.9 — Cihaz değiştirince ne olur?** Eski cihaz "emekli" olarak işaretlenir, geçmişi silinmez; yeni cihaz aynı kategoride devralır. Bir ev ünitesine iki yaşlı bağlıysa her sinyal hangi kolyeden geldiğini taşımalıdır.

## 2. Harici OEM cihazların devreye alınması

Karar: üç sınıf vardır ve bir cihazın ne yapabileceğini sınıfı kesin olarak belirler. Yalnız A sınıfı acil olay (SOS, düşme) açabilir; yüzük, küpe ve üretici bulutları hiçbir zaman acil olay açmaz.

**S2.1 — Sınıflar neler?**

| Sınıf | Ne yapabilir | Örnekler | Gecikme hedefi (p95) |
| --- | --- | --- | --- |
| A — Alarm | SOS ve düşme (P1) açar, korumaya sayılır | Bizim Wear OS uygulamamız, bizim watchOS uygulamamız (Apple izniyle), hücresel kolye, EN 50134-2 radyo kolye (ortaklıkla) | Doğrudan ≤5 sn, telefon üzerinden ≤10 sn, ortak merkez ≤15 sn |
| B — Canlı izlem | Nabız/oksijen okur, "takılı ve hareketli" kanıtı verir; P2/P3 yalnız kurallarla (Bölüm 6) | Standart BLE nabız (0x180D), nabız oksimetre (0x1822) cihazları telefonumuza bağlıyken; HealthKit anında nabız olayları | ≤5 dk |
| C — Eğilim | Taban çizgisi, günlük özet, aileye haftalık eğilim; olay açmaz, korumaya sayılmaz | Oura, Galaxy Ring (Samsung Health), Garmin, Google Health API, Lumia küpe | ≤24 sa |

Kulaklıklar yalnız B sınıfıdır (bağlıyken nabız) ve pil ömrü \~6 saat olduğu için korumaya sayılmaz.

**S2.2 — Yüzük neden acil olay açamaz?** Yüzüklerde SOS düğmesi, ses ve gerçek zamanlı düşme algılama yoktur. Oura verisi yüzük → telefon → bulut yolundan gelir; webhook yalnız "yeni kayıt var" der ve veri çoğunlukla günlük özettir. [Oura senkron](https://support.ouraring.com/hc/en-us/articles/360025586673), [Oura webhook](https://hookdeck.com/webhooks/platforms/guide-to-oura-webhooks-features-and-best-practices.md)

**S2.3 — Apple Watch nasıl giriyor?** Kendi watchOS uygulamamızla. SOS düğmemiz A sınıfıdır. Düşme olayı Apple'ın izniyle (`CMFallDetectionManager`) gelir ama Apple'ın kendi akışı bittikten sonra; bu akış 112'yi zaten aramış olabilir ve 3–5 dk gecikme görülmüştür. Olay yine P1 açılır, operatör "Apple 112'yi aramış olabilir; önce kişiyle veya yakınla doğrula, 112'yi yeniden arama" metniyle başlar. [Apple geliştirici](https://developer.apple.com/tutorials/data/documentation/coremotion/cmfalldetectionmanager.md), [forum](https://developer.apple.com/forums/thread/751373)

**S2.4 — Kolye için hangi yol?** Kolye düşme algılamasında en iyi konumdur: gövdeye takılan cihazlarda medyan duyarlılık %97,5, bilek/kulak/el cihazlarında %81,5. [PMC8591794](https://pmc.ncbi.nlm.nih.gov/articles/PMC8591794/) Ama kolyeler olaylarını kendi merkezlerine gönderir, açık API vermez. İki yol var:

1. Hücresel kolye (Bay Alarm / Lifeline sınıfı) ile ortaklık veya beyaz etiket: SOS, düşme, iki yönlü ses, GPS; pil 2–4 gün, her akşam şarj.
2. EN 50134-2 radyo kolye + ev ünitesi (Tunstall iVi sınıfı): 12 ay pil, "takılmadı" uyarısı, ses ev ünitesinden; evden çıkınca kapsama yok.

Önerimiz önce hücresel kolyedir; evde kalan, şarj edemeyen kişiler için radyo kolye ikinci adımdır.

**S2.5 — Bir OEM entegrasyonu hangi sözleşmeye uyar?** Adaptör şunları sağlar: model profili (yetenekler, gecikme, kalite), sinyal dönüştürme (üretici olay kimliğinden türetilen idempotencyKey ile), cihaz komutları (soru göster, çaldır, ara, konum, test), canlılık (son görülme, gecikme p95) ve takılı kanıtı (doğruluk 0–1). Profil dışı sinyal yalnız o sinyal olarak reddedilir ve denetime yazılır; C sınıfı bir adaptör düşme gönderirse reddedilir.

**S2.6 — Bir cihaz A sınıfı olmak için hangi testi geçmeli?**

- [ ] İmzalı webhook, tekrar koruması, idempotency
- [ ] SOS uçtan uca ≤15 sn (p95); 20 SOS + 10 iptal testinde %95 zamanında
- [ ] 20 senaryolu düşme (5'i yavaş/oturur): duyarlılık gövde ≥%85, bilek ≥%75
- [ ] 7 günlük giyme testinde en çok 1 yanlış alarm
- [ ] Gerçek pil ömrü vaadin ≥%80'i; şarj ve takılı durumu bildiriliyor (takılı algılama doğruluğu ≥%95)
- [ ] İki yönlü ses veya ev ünitesi sesi; düğme testi
- [ ] Yurt dışı bulutta KVKK aktarım dayanağı (açık rıza + standart sözleşme bildirimi)
- [ ] %99,9 erişilebilirlik, 1 saat içinde olay bildirimi, 7/24 irtibat
- [ ] Yazılım güncellemesi 14 gün önceden; her büyük sürümde yeniden sertifika

**Ortak devreye alma notu (T-085).** Listenin otomatikleşebilen kısmı sahte ortağa (FAKE_PENDANT) karşı API test paketidir (`apps/api/test/oem-partner.spec.ts`); gerçek ortak aynı paketi kendi test ortamında geçmelidir:

- İmzalı webhook `POST /v1/webhooks/partners/{ortak}`: `X-Partner-Timestamp` (±5 dk), `X-Partner-Nonce` (teslim başına tek), `X-Partner-Signature: v1=<HMAC-SHA256(sır, "ts.nonce.gövde")>`. Sır ortamdan (`PARTNER_<KOD>_WEBHOOK_SECRET`), kodda yok.
- Tekrar koruması: aynı nonce 409. Idempotency: aynı üretici olay kimliği yeni teslimle gelirse tekrar sayılır, olay ikinci kez açılmaz.
- Sinyal başına ret ve denetim: bilinmeyen cihaz, okunamayan olay, model profili dışındaki sinyal (ör. radyo kolyeden konum, C sınıfından düşme).
- SOS uçtan uca ≤15 sn: 20 SOS (ortak gecikmesi 1–10 sn) %95 zamanında kuyrukta; 10 düşme kolyeden iptalle kapanıyor.
- Sınıf kapısı: C sınıfı hiçbir olay açmıyor, kapsamayı değiştirmiyor; B sınıfı SOS / düşme açmıyor (`oem-class.spec.ts`).
- Canlılık: ortak, A sınıfı cihaz için en geç 15 dk'da bir canlılık (HEARTBEAT veya takılı kanıtı) göndermeli; yoksa cihaz kapsamada çevrimdışı sayılır.

Gerçek donanım ister ve elle yapılır: 20 senaryolu düşme duyarlılığı, 7 günlük giyme testi, pil ömrü ve takılı algılama doğruluğu, ses / ev ünitesi sesi, %99,9 erişilebilirlik ve 7/24 irtibat, KVKK aktarım dayanağı (bağlantı kaydında `consent` olarak tutulur), güncelleme bildirimi. Bağlantı amir / yönetici tarafından `POST /v1/vendor-links` ile kurulur, `DELETE /v1/devices/{id}` ile kaldırılır.

**S2.7 — Ortak gecikmesi bozulursa?** Bir ortağın gecikmesi 1 saat boyunca p99 60 sn'yi aşarsa amire O-OEM-LATENCY uyarısı gider; o ortaktan gelen cihazların kapsaması "zayıf" sayılır.

**S2.8 — Google, Huawei, Garmin bulutları?** Fitbit Web API 2 Kasım 2026'da kapandı; yerine Google Health API güvenlik incelemesi isteyen kısıtlı izinlerle gelir. [Google Health](https://developers.google.com/health/about) Huawei Wear Engine sensör verisi vermiyor. [Huawei](https://developer.huawei.com/consumer/en/doc/connectivity-Guides/dev-process-0000001051058039) Garmin ve Google yalnız C sınıfı (eğilim) olarak, son aşamada girer.

## 3. Birden çok cihazdan gelen sinyaller ve kapsama durumu

Karar: "saat koruması / telefon koruması" yerine kişi başına bir **kapsama durumu** hesaplanır: hangi yetenekler (SOS, düşme, ses, konum, hareket, değerler) şu an hangi cihazlarla karşılanıyor. Aynı olay için iki cihazın sinyali tek olayda birleşir; bir cihazın alarmını başka bir cihaz iptal edemez, tek istisna şarjından düşen saattir.

**S3.1 — Kapsama seviyeleri neler?**

| Seviye | Koşul | Bugünkü karşılığı |
| --- | --- | --- |
| TAM | SOS ve düşme karşılanıyor, ses en az zayıf | Saat koruması |
| TEMEL | Takılı SOS düğmesi ve ses var, düşme yok | (yeni) |
| YALNIZ TELEFON | Yalnız telefondan SOS (zayıf: telefon yakında mı bilinmez) | Telefon koruması |
| GECE | Uyku penceresi ve seviye TAM'ın altında | Gece |
| YOK | Hiçbir SOS yolu yok | Korumasız |

Gece takılı bir kolye veya saat seviyeyi TAM tutar; bugünkü kod bunu ifade edemiyor. TEMEL ile YALNIZ TELEFON ayrı tutulur: takılı bir SOS düğmesi çekmecedeki telefondan çok daha iyidir ve bekleme süreleri farklıdır. Aile uygulaması için eski durum alanı bir sürüm boyunca türetilerek verilir.

**S3.2 — Kapsama ne zaman yeniden hesaplanır?** Her cihaz durumu değişikliğinde ve dakikada bir taramada. A sınıfı cihaz son 15 dk içinde görülmediyse çevrimdışı, B sınıfı 30 dk. Konum 30 dk'dan eskiyse zayıf. Kapsama geçmişi tutulur; "uyanık zamanın yüzde kaçı korundu" buradan çıkar.

**S3.3 — Aynı düşmeyi kolye ve saat birlikte bildirirse?** Kişi başına tek açık olay kuralı zaten tekilleştirir; ikinci sinyal olaya kaynak olarak eklenir. Farklı vücut konumundaki iki cihaz 90 sn içinde düşme bildirirse olay **doğrulanmış** sayılır: kişiye soru süresi 60 sn yerine 30 sn olur (daha kısa değil), operatör "2 cihaz" ibaresini görür ve ilk sesli arama doğrulayan cihaza yapılır. Pencere geniş tutuldu çünkü kolye ve saat algoritmaları aynı düşmeyi farklı anlarda bildirir; geniş pencere yalnız yardımı hızlandırır.

**S3.4 — Çelişen sinyallerde ne olur?**

- Bir alarmı başka bir cihaz veto edemez.
- İstisna: düşme sinyali kendi içinde "şarjda" bilgisini taşıyorsa yok sayılır ve denetime yazılır (şarjından düşen saat en sık yanlış düşmedir). Eski bir şarj bilgisi asla veto etmez.
- Takılı olmayan bir cihazdan gelen düşme yine P1 açılır, "cihaz takılı değildi" notuyla (takılı algılama da yanılabilir).
- Yüzük takılı ve hareketli, saat çıkarılmış: çelişki yok. Hareket yüzükten, düşme kapsaması saatten gelir; seviye düşer ama "saat çıkarıldı" olayı yalnız hiçbir A sınıfı cihaz takılı değilken açılır.
- Gecikmeli sinyal: 10 dk geç gelen düşme yine P1 açılır, "gecikmeli" notuyla; arkasından takılı/hareket kanıtı geldiyse operatör bunu görür.

**S3.5 — Hangi cihaz hangi olayı açabilir?**

| Olay | Kim açabilir |
| --- | --- |
| SOS | SOS düğmeli A sınıfı cihaz, telefon uygulaması (basılı tut), ev ünitesi |
| Düşme | Yalnız otomatik düşme algılamalı A sınıfı cihaz |
| Hareketsizlik | Sunucu hesaplar: hiçbir takılı cihazda eşik süresince hareket yok (cihazın kendi hareketsizlik sinyali yalnız ipucu) |
| Anormal değer | A/B sınıfı, Bölüm 6 kurallarıyla |
| Rutin sapması | B veya C sınıfı, yalnız aileye |
| Kapsama boşluğu | Sunucu (saat çıkarıldı, pil bitti, bağlantı yok bunun nedenleri olur) |

**S3.6 — "İyiyim" (iptal) hangi cihazdan kabul edilir?** Alarmı açan cihazdan, takılı herhangi bir A sınıfı cihazdan veya telefonda özel "İyiyim" ekranına dokunulunca; soru penceresi içinde ve soru açıldıktan sonra gelmek şartıyla. Aile uygulamasından ve B/C sınıfından asla. Doğrulanmış bir düşme başka bir cihazdan iptal edildiyse olay kapanır ama aynı gün P4 takip araması planlanır (ucuz sigorta).

**S3.7 — Konum hangi cihazdan alınır?** En taze ve en doğru olan: 2 dk'dan yeni GPS önce, telefonun ağ konumu en son. Açık P1/P2 olay süresince konum 60 sn'de bir yeniden birleştirilir.

## 4. Şarj ve pil

Karar: şarj cihazın değil kişinin kapsamasının meselesidir. Başka bir takılı alarm cihazı koruyorsa şarja giren cihaz için kimseye hiçbir şey gönderilmez; koruma düştüyse boşluk saati işler ve en çok 120 dakika uyanık süre sonra operatöre olay açılır.

**S4.1 — Bugün şarj nasıl görülüyor?** Hiç görülmüyor. Sinyal şemasında şarj alanı yok; pil eşikleri (%20, %10, %5) kodda sabit. Şarjdaki saat, telefon çevrimiçi olsa bile 2 saat sonra "pil bitti", 6 saat sonra "bağlantı yok" olayı açar.

**S4.2 — Ne değişiyor?** Şarj başladı / bitti iki yeni sinyal olur, cihaz durumuna "şarjda" eklenir. Şarjdayken pil uyarıları susar. Cihazın tahmini kalan saati (pil yüzdesi × katalogdaki pil ömrü) hesaplanır. Tüm pil eşikleri kural paketine taşınır.

**S4.3 — Şarj ne zaman yapılmalı?** Varsayılan pencere 19:00–21:00: oturarak TV izlenen, düşme riskinin en düşük olduğu saat; saat gece tuvalet düşmeleri için takılı kalır. 14 gün sonra gerçek şarj saatinden öğrenilir; aile değiştirebilir. Tek alarm cihazını gece şarj etmek yalnız aile açıkça seçerse ve "gece düşme koruması yok" uyarısını görerek onaylarsa izinlidir.

**S4.4 — Şarj sırasında kim, ne zaman uyarılır?** Saat şarja girdiği anda kapsama TAM'ın altına düştüyse başlar; gece penceresinde durur, uyanış+30 dk'da devam eder.

| Ne zaman | Ne olur | Kime |
| --- | --- | --- |
| Şarj başı, seviye YOK | "Saat şarjda, telefonu yanınızda tutun" | Yaşlının telefonu |
| Pil ≥%80 ve ≥20 dk şarjda (veya %100) | "Şarj tamam, takabilirsiniz" (titreşim + sesli) | Şarjdaki cihaz + telefon |
| Şarjdan çıktı, 15 dk takılmadı | "Saatinizi takmayı unutmayın" | Cihaz + telefon |
| 30 dk takılmadı | İkinci hatırlatma | Cihaz + telefon |
| Boşluk 90 dk (plan dışı saatte 60 dk) | F-CHARGE-GAP, günde en çok 1 | Aile |
| Boşluk 120 dk | KAPSAMA BOŞLUĞU olayı P3: sesli ön eleme, sonra telefon ve 1. yakın | Operatör |

Aileye 60 dk yerine 90 dk'da gidilmesinin nedeni: normal 60–90 dk'lık şarjda her akşam bildirim gitseydi aile bildirimleri görmezden gelmeyi öğrenirdi.

**S4.5 — "Şarj ediyorum" düğmesi ne işe yarar?** Yaşlının telefonunda ve aile uygulamasında tek dokunuşla "saati şarj ediyorum, 90 dk" bildirilir. Bu hatırlatmaları susturur ama 120 dk'lık operatör olayını susturmaz.

**S4.6 — Pil yetmeyecekse önceden uyarılır mı?** Evet. Her gün 18:00'de: bir A sınıfı cihaz %30'un altındaysa veya tahmini kalan süre bir sonraki şarj penceresine yetmiyorsa yaşlıya "şimdi şarj edin"; %15'in altındaysa aileye de.

**S4.7 — Hiçbir SOS yolu kalmazsa (seviye YOK, uyanık)?** Bu şarjdan daha ağırdır ve ayrı izlenir; bugünkü 6 saatlik "bağlantı yok" beklemesinin yerini alır.

| Süre | Ne olur |
| --- | --- |
| 20 dk | Ulaşılabilen her cihaza hatırlatma; yaşlının numarasına otomatik sesli arama |
| 45 dk | Aileye F-COVERAGE-NONE |
| 60 dk | KAPSAMA BOŞLUĞU P3, operatör |
| 2 sa | Takılı bir cihaz pili %20'nin üzerindeyken birden sustuysa: YERİNDE KONTROL olayı (P2) |
| 6 sa | Telefon dahil tüm cihazlar sessiz ve kimse cevap vermiyorsa: YERİNDE KONTROL olayı (P2) |
| Geri dönüş | Aileye F-COVERAGE-BACK |

**S4.8 — Telefon şarjda veya bitmişse?** Telefon BLE cihazların (yüzük, kulaklık, BLE kolye, LTE'siz saat) köprüsüdür; telefon kapanınca hepsi aynı anda düşer. Bu yüzden telefonun pili de aynı tabloyla izlenir ve telefona bağlı cihazların kapsaması telefonla birlikte düşer.

**S4.9 — 12 ay pilli kolyede ne yapılır?** Yaşlı hiç rahatsız edilmez. Pil haftalık bildirilir; %20'nin altında veya tahmini bitimden 30 gün önce operasyon iş emri açılır (14 gün içinde yerinde değişim), aile bilgilendirilir. 30 gündür düğme testi yapılmadıysa aylık test hatırlatması. Üreticinin "3/5/7 gündür takılmadı" uyarısı KAPSAMA BOŞLUĞU P3 olur. Ev ünitesinin elektriği kesilirse veya hücresel kolyenin hattı düşerse bu da kapsama nedenidir.

**S4.10 — Saati sürekli çıkaran kişi (örneğin demans)?** 7 günde 5 boşluktan sonra her seferinde P3 açmak yerine aileyle bir plan yapılır (kişiye özel tolerans, kolyeye geçiş, bakıcı hatırlatması). Aile "hastanede / seyahatte" modunu bitiş tarihiyle açabilir; bu sürede kapsama uyarıları durur, SOS ve düşme her zaman çalışır.

**S4.11 — Akşam herkes aynı anda şarj ederse?** 19:00–21:00'de filonun büyük bölümü YALNIZ TELEFON seviyesine iner. Bu beklenen bir durumdur: amir panosu bunu "planlı şarj" olarak ayırır, operatör kapasitesi bu saatlere göre planlanır. P3 zamanlayıcıları canlıya almadan önce gerçek veriyle olay hacmi modellenir.

## 5. Kişiye ulaşılamadığında

Karar: SOS'ta kuyruğa düşüşten 180 sn, düşmede 300 sn içinde kişiye ulaşılamadıysa operatör 112'yi aramak zorundadır. Sistem cihazları çaldırır, aileye haber verir ve çevrimdışı adımları atlar; 112'yi kendisi aramaz ve bir P1 olayı kendisi kapatmaz.

**S5.1 — "Ulaşılamadı" tam olarak ne demek?** Her arama denemesi şu sonuçlardan biriyle biter: ulaşıldı, cevap yok (süre doldu), meşgul, ağ hatası veya **çevrimdışı — atlandı**. Bir cihazı aramadan önce son 15 dk içinde görülüp görülmediğine bakılır; ölü cihazı aramak her adımda 15–30 sn kaybettirir. Otomatik cevapla bağlanıp 20 sn sessiz kalan arama "cevap yok" değil, olası acil durum sayılır. Yüzük ve kulaklık aranmaz; yalnız titreşimle soru gösterilebilir.

**S5.2 — SOS ve düşmede (P1) merdiven nasıl?** Süreler olayın kuyruğa düştüğü andan.

&#91;embedded content: P1 merdiveni · 5 kişi denemesi, yakınlar, 112 son sınırı\]

Kişiye yönelik denemeler en fazla \~75 sn sürer; ardından yakınlar ve anahtar sahibi, son sınırda 112 gelir. Tablo her adımın ayrıntısını verir.

| Adım | Süre | Ne olur |
| --- | --- | --- |
| T+0 | anında | Tüm takılı A sınıfı cihazlar çaldırılır, telefona kritik bildirim, konum anı alınır, aileye F-EVT bildirimi + SMS |
| Üstlenme | ≤60 sn (hedef %97,5) | 90 sn üstlenilmezse amir çağrılır |
| 1. sesli cihaz | 20 sn (otomatik cevap 10 sn'de) | Doğrulanmış düşmede doğrulayan cihaz önce |
| 2. sesli cihaz | 20 sn | Varsa |
| Yaşlının telefonu | 20 sn |  |
| En iyi cihaza yeniden | 15 sn | Kişiye denemeler toplam ≤75 sn |
| Yakınlar | her biri 25 sn | Paralel aile bildirimi sürer |
| Anahtar sahibi | 25 sn | Varma süresi en kısa olan önce |
| **112 son sınırı** | SOS 180 sn, düşme 300 sn | Ekranda geri sayım; kişiye ulaşılmadıysa operatör 112'yi arar |
| 112 sonrası | — | Ekip yoldayıken yakınlara bir tur daha |

"Aile yolda" demek 112'yi durdurmaz; aile kişiye bizzat ulaştıysa durur. 112'ye anahtar sahibinin varma süresi ve kapı notu okunur; kapıyı kırma kararı 112'nindir. Mevcut kural sürer: 112 aranmadan "ulaşılamadı" kapanış amire uyarı üretir.

**S5.3 — Operatör olayı hiç üstlenmezse?** 90 sn'de amir çağrılır. 180 sn'de hâlâ üstlenilmemişse (öneri, kararı sizde) sistem 1. yakını sesli mesajla arar: "Acil durum; lütfen 112'yi arayın." Üstlenilmemiş bir P1 hizmet hatasıdır ve sessizlik bu mesajdan kötüdür.

**S5.4 — Olay türüne göre merdiven nasıl değişir?**

| Olay | Merdiven | 112 |
| --- | --- | --- |
| Hareketsizlik (P2) | Sessiz soru 120 sn → sesli ön eleme 120 sn → cihaz/telefon → yakınlar → anahtar sahibine "gidip bakar mısınız" | Kuyruğa düşüşten 20 dk sonra kimseye ulaşılamadıysa ve 30 dk içinde kimse yanına varamayacaksa operatör 112'yi arar. Konum fark etmez; evde değilse GPS konumu verilir. Amir bilgilendirilir, onay beklenmez |
| Kapsama boşluğu (P3) | Sesli ön eleme → telefon → 1. yakın | Hayır; S4.7'deki koşullarda YERİNDE KONTROL (P2) olur |
| Yerinde kontrol (P2) | Telefon → yakınlar → anahtar sahibi ziyareti | Ziyaret 30 dk içinde mümkün değilse operatör kararıyla |
| Anormal değer (P2/P3) | Cihaz → telefon → 1. yakın | Kişiye ulaşılıp belirti anlatırsa. Ulaşılamaz ve 10 dk hareket yoksa P2 hareketsizlik merdivenine geçer |
| Yanınızdayız araması (P4) | 30 dk ve 2 sa sonra yeniden → aileye F-WELLNESS-MISSED | Hayır; 24 sa hiçbir cihaz hareketi de yoksa YERİNDE KONTROL (P2) |

**S5.5 — Kişi evden uzaktaysa?** Evden 200 m'den uzaktaysa komşu ve anahtar sahibi adımları atlanır; 112'ye canlı GPS konumu ve son konum komutunun sonucu okunur.

**S5.6 — Anahtar sahibi nasıl tanımlanır?** Ayrı bir rol değil, yakın kaydına eklenen özelliktir: anahtarı var mı, eve varma süresi (dk), ulaşılabilir saatleri. Çünkü kızı genellikle hem 1. yakın hem anahtar sahibidir. Anahtar sahiplerinin KVKK rızasını kimin alacağı sizin kararınızdır.

**S5.7 — Apple 112'yi zaten aradıysa?** Operatör 112'yi yeniden aramaz; "Apple 112'yi aradı mı?" sorusuyla başlayıp kişiyi veya yakını doğrular, gerekirse 112'yle teyit eder.

**S5.8 — Sistem kendi başına neyi yapar, neyi asla yapmaz?** Yapar: cihazı çaldırmak, soru göstermek, sesli ön eleme, otomatik cevap (yalnız P1; yanınızdayız aramasında gizlilik nedeniyle asla), aile bildirimi, konum, çevrimdışı adımı atlamak, yeni kanıtla olayı yükseltmek. Yapmaz: 112'yi aramak, komşuyu veya anahtar sahibini aramak, P1 olayı kapatmak.

**S5.9 — İşitme veya konuşma güçlüğü olan kişi?** Profilde işaretlenir. Otomatik cevapla bağlanılsa bile "ulaşılamadı" sayılır ve yakınlara daha erken geçilir; mümkünse cihaza yazılı "İyi misiniz? Evet / Yardım" sorusu gönderilir.

## 6. Değerlerde anormallik

Karar: anormal değer bir teşhis değil, "cihaz alışılmadık bir okuma gösterdi, kişiyi arayalım" tetikleyicisidir. Tek başına bir okuma kimseye gitmez; kural ancak takılı, hareketsiz, şarjda olmayan bir cihazda en az 10 dk süren tutarlı okumayla çalışır. Özellik, yazılı bir mevzuat görüşü alınana kadar bayrakla kapalı tutulur.

**S6.1 — Bugün anormal bir nabız ne yapıyor?** Hiçbir şey. Nabız ve adım yalnız kaydediliyor; "kalp anomalisi" türü tanımlı ama üreten kural yok.

**S6.2 — Hangi değerlere bakılacak?** Nabız (dinlenme ve anlık), oksijen (sağlık-amaçlı doğrulukta), cilt sıcaklığı sapması, hareket/adım, uyku süresi. Tansiyon, şeker ve EKG ilk sürümde yok. Apple'ın düzensiz ritim bildirimi yalnız kanıt olarak kaydedilir.

**S6.3 — Kişisel taban çizgisi nasıl çıkar?** 14 gün öğrenme, en az 7 geçerli gün (mevcut öğrenme moduyla aynı). Uyku, uyanık-dinlenme ve uyanık-hareketli dilimleri için ayrı ortanca değer; yalnız takılı, hareketsiz ve en az Q2 kalitedeki örneklerle. 28 günlük kayan pencereyle yenilenir. Taban çizgisi oluşana kadar yalnız genel eşikler kullanılır.

**S6.4 — Kurallar neler?** Tüm kuralların ortak şartı: cihaz takılı, şarjda değil, 5 dk'dan uzun süredir takılı, pil ≥%10, son 5 dk'da 20 adımdan az, en az 3 tutarlı örnek, 25–250 aralığı dışındaki nabız atılır.

| Kural | Koşul | Sonuç |
| --- | --- | --- |
| Düşük nabız + hareketsiz | Nabız <40, hiçbir cihazda hareket yok, ≥5 dk, takılı (her saatte, gece dahil) | P2, kuyruğun başına, ön eleme atlanır |
| Düşük nabız | <40 ve uyku tabanının 10 altında, ≥10 dk | P3, 15 dk içinde üstlenme hedefi |
| Yüksek nabız | Dinlenirken ≥130, ≥10 dk | P3, 15 dk içinde üstlenme |
| Taban çizgisinden sapma | Dinlenme nabzı tabanın %30 üstü/altı, ≥30 dk | Aileye P4 eğilim, operatör yok |
| Oksijen | ≤%88 (KOAH'ta ≤%85), uyanık ve hareketsiz, 10 dk arayla 2 okuma, Q2 cihaz veya iki cihaz uyumlu | P3; aynı anda nabız ≥120 ise P2 |
| Cilt sıcaklığı | 2 gece üst üste +1,0 °C sapma | Yalnız aileye haftalık bilgi |
| Düşme + anormal nabız | Düşme olayı sırasında | P1 kalır, operatöre vurgu |

Eşiklerin dayanağı: bradikardi <50 [ACC/AHA](https://www.acc.org/About-ACC/Press-Releases/2018/11/06/13/31/Societies-Publish-New-Guidance-for-the-Treatment-of-Slow-Irregular-Heartbeats); nabız ≤40 veya ≥131 ve oksijen ≤%91 klinik erken uyarı ölçeğinde en ağır puan [NEWS2](https://rightdecisions.scot.nhs.uk/media/vhcccgq2/news2-guideline-no-fp.pdf); oksijen hedefi %94–98, KOAH'ta %88–92 [BTS](https://www.brit-thoracic.org.uk/quality-improvement/guidelines/emergency-oxygen). NEWS2'yi hesaplamıyor ve adını kullanmıyoruz: solunum sayısı, tansiyon, ateş ve bilinç düzeyi gerekir ve adı klinik bir iddiadır.

**S6.5 — Neden 5 dk değil 10 dk?** Bilekteki optik sensör dinlenirken atım kaçırır ve birkaç dakika 38 gösterebilir. 5 dk yalnız hareketsizlikle birleştiğinde yeterli kanıttır.

**S6.6 — Yüzüğün oksijen ölçümüne güvenilir mi?** Hayır, tek başına değil. Ten rengi, düşük kan dolaşımı, sıcaklık, oje hata kaynağıdır [FDA](https://www.fda.gov/medical-devices/products-and-medical-procedures/pulse-oximeters). Yüzük/kulak oksijeni (Q3) yalnız eğilime gider; tek bir cihaz en fazla Q2 sayılır, iki cihaz 5 dk içinde uyuşursa kanıt bir basamak güçlenir.

**S6.7 — Alarm yorgunluğu nasıl önlenir?**

- Operatör "iyi" kaydettikten sonra aynı kişi ve kural için 24 sa sessizlik; okuma %20 kötüleşirse sessizlik delinir.
- Kişi başına haftada en çok 2 değer kaynaklı kontrol araması; fazlası eşik incelemesine gider.
- P2 kombinasyonları (hareketsizlik + düşük nabız) hiçbir sınıra takılmaz.
- 30 günde 3 yanlış alarmda mevcut yanlış alarm incelemesi değerlere de uygulanır.
- Kişiye özel eşik, aile onayı ve yüklenen doktor notuyla ayarlanabilir.

**S6.8 — Kim neyi görür?** Operatör değerleri yalnız açık bir olay sırasında görür: son 2 saatin grafiği, taban çizgisi ve kalite rozeti; dışa aktarım yok. Aile "iyi" olmayan sonuçları ve haftalık eğilimleri görür (sağlık-amaçlı uyarı notuyla). Dakika düzeyinde ham veriyi kimse görmez; ham örnekler 30 gün, özetler 13 ay saklanır; log'a kişisel veri yazılmaz.

**S6.9 — Neyi asla söylemeyiz?** "Kalp krizini / ritim bozukluğunu / oksijen düşüklüğünü tespit eder", "tıbbi izlem", "7/24 hayati bulgu takibi", "doktora haber verilir" ve herhangi bir klinik skor. Apple bile saatinin kalp krizi tespit edemediğini yazıyor [Apple](https://support.apple.com/en-AU/120276).

## 7. Paneller ve uygulamalar

Karar: bugün operatör, amir ve yönetim panellerinde hiç cihaz bilgisi yok; her panel kişinin kapsama durumunu ve cihazlarını kendi işine göre gösterecek. Tüm metinler mesaj kataloğundan gelir; tüm ekranlar telefon ve masaüstünde çalışır.

**S7.1 — Operatör olay ekranında ne değişiyor?**

- Cihaz şeridi: her cihaz için simge, vücut konumu, takılı mı, pil, şarjda mı, son görülme, "telefon üzerinden", sesli arama/otomatik cevap rozeti; olayı hangi cihazın açtığı ve hangisinin iptal ettiği.
- Kapsama rozeti (TAM / TEMEL / YALNIZ TELEFON / GECE / YOK + neden) ve "2 cihaz doğruladı" bandı.
- Konum ve yaşı (örn. "4 dk önce, GPS").
- Düğmeler: "Tümünü çaldır", "Soru göster", "Konum iste", "Bu cihazı ara".
- 112 geri sayımı (SOS 180 sn, düşme 300 sn).
- Değer olayında son 2 saatin grafiği, taban çizgisi ve kalite rozeti; yalnız olay açıkken.
- Apple düşmesinde "Apple 112'yi aramış olabilir" metni.

**S7.2 — Amir panosuna ne ekleniyor?**

- Filo kapsama tablosu: her seviyede kaç kişi; uyanıkken 20 dk'dan uzun süredir YOK seviyesindekiler, süreye göre sıralı.
- Akşam şarjını "planlı şarj" olarak ayıran görünüm (S4.11).
- Kronik boşluk: son 7 günde uyanık zamanın %80'inden azı korunanlar.
- Çevrimdışı telefon köprüleri, ortak gecikmesi (O-OEM-LATENCY), biten kolye pilleri kuyruğu.
- Ulaşılamama oranı: merdivenin hangi adımında takılınıyor.
- 90 sn üstlenilmeyen P1 çağrısı ve hareketsizlik/yerinde kontrol 112 bildirimleri.

**S7.3 — Yönetim panelinde hangi ölçüler olacak?** Kişi-gün başına kapsama yüzdesi; cihaz modeli ve yazılım sürümü başına yanlış alarm oranı; sınıf ve adaptör başına gecikme p95; şarj uyumu (hatırlatmadan sonra takılma süresi); değer uyarılarının isabet oranı (operatörün "iyi" dediği oran); 100 kişi-gün başına olay türü; ortak SLA'ları; model başına pil sağlığı.

**S7.4 — Aile uygulamasında ne değişiyor?**

- Cihazlar sayfası: kartlar (durum, pil, "şarjda 40 dk", "düşme/SOS/ses koruyor"), cihaz ekleme (bizim cihazlar QR, bulut kaynakları OAuth), sesli arama sırası, vücut konumu.
- Kapsama çipi ve son 7 günün kapsama zaman çizelgesi.
- Şarj planı düzenleyici ve gece şarjı uyarısı.
- "Şarj ediyorum" düğmesi; hatırlatmaları kimin alacağı.
- "Hastanede / seyahatte" modu (bitiş tarihli).
- Haftalık eğilimler (sağlık-amaçlı notuyla); P4 eğilimleri susturma (P3 susturulamaz).
- Bugünkü "bir saat + bir telefon" durum ekranının yerini alır.

**S7.5 — Yaşlının telefon uygulaması?** Büyük kapsama satırı ("Kolye koruyor"), büyük "İyiyim" ve SOS düğmeleri, "Saati şarj ediyorum" düğmesi, takma/şarj hatırlatmaları. Arka planda B sınıfı BLE cihazları (nabız, oksimetre, BLE kolye) için köprü servisi; telefonun kendi pili de izlenir.

**S7.6 — Saat ve kolye uygulaması?** Şarjdayken "Şarj tamam, beni takın" ekranı; sunucudan gelen çaldırma ve soru komutları; "Telefon yanınızda olsun" kutucuğu; aylık test modu; şarj ve takılı durumunun her sinyalde gönderilmesi.

**S7.7 — Aynı evde iki korunan kişi (çift) varsa?** Ortak ev ünitesi veya telefon kullanılabilir. Her sinyal hangi kişinin cihazından geldiğini taşımak zorundadır; bir kişinin düşmesi asla ötekinin olayına eklenmez. Operatör ekranı "aynı adreste ikinci kişi" bilgisini gösterir: eş ilk ulaşılacak kişi olabilir.

## 8. Veri modeli, API, kural paketi ve mesaj kataloğu

Karar: olay motoru yine cihaz ve ülke bilmez. Yenilikler cihaz kataloğu, adaptörler ve kural paketiyle gelir; kodda sabit pil eşiği kalmaz. Eski koruma durumu bir sürüm boyunca yeni kapsama modelinden türetilir.

**S8.1 — Hangi tablolar ekleniyor veya değişiyor?**

| Tablo | Değişiklik |
| --- | --- |
| `device.device_model` (yeni) | Üretici, model, kategori, sınıf, yetenekler (gecikme + kalite), pil ömrü, şarj süresi, sertifikalı yazılım aralığı |
| `device.device` | + model, kategori, sınıf, vücut konumu, bağlantı yolu, köprü cihazı, sesli arama sırası, takılı / şarjda (+ başlangıç zamanı), takma ad, üretici kimliği, emeklilik |
| `device.vendor_link` (yeni) | Üretici bulutu bağlantısı: şifreli belirteçler, izinler, rıza kaydı, veri bölgesi |
| `event.coverage_state` (yeni) | Kişi başına kapsama seviyesi, yetenek vektörü, nedenler; `protection_state`'in yerini alır (uyum için görünüm kalır) |
| `event.coverage_history` (yeni) | Seviye geçişleri; uyanık zaman kapsama yüzdesi |
| `event.charging_plan` (yeni) | Tercih edilen şarj penceresi, kaynak (varsayılan / öğrenilmiş / aile), gece şarjı onayı |
| `health.vital_sample` (yeni) | Aylık bölümlenmiş örnekler, 30 gün |
| `health.vital_baseline` (yeni) | Dilim başına taban çizgisi |
| `profile.contact` | + anahtarı var, varma süresi, ulaşılabilir saatler |
| `profile.protected_person` | + işitme/konuşma güçlüğü, "hastanede/seyahatte" modu ve bitişi |

**S8.2 — Hangi türler (enum) değişiyor?**

- Sinyal: + Şarj başladı, Şarj bitti, Oksijen, Cilt sıcaklığı, Cihaz testi. Sinyalin cihaz bloğuna şarj, takılı, bağlantı yolu, kalite, ölçüm zamanı (gönderim zamanından ayrı) ve üzerinden gelinen cihaz eklenir.
- Olay: + KAPSAMA BOŞLUĞU, YERİNDE KONTROL; saat çıkarıldı / pil bitti / bağlantı yok bunun nedenleri olur; kalp anomalisi → değer uyarısı.
- Zincir adımları: + Tümünü çaldır, Sesli cihazı ara (sıradaki), Belirli cihazı ara, Anahtar sahibi; arama sonucu: + çevrimdışı — atlandı.
- Olaya: doğrulanma durumu, kaynak cihazlar listesi, iptal eden cihaz.

**S8.3 — Hangi API uçları eklenecek?** (OpenAPI'ye işlenir)

- `GET /protected-persons/{id}/devices`, `GET /protected-persons/{id}/coverage`
- `PATCH /devices/{id}` (vücut konumu, sesli arama sırası, takma ad), `DELETE /devices/{id}` (kayıp/çalıntı: kapsama anında yeniden hesaplanır)
- `POST /devices/{id}/commands` (çaldır, soru, konum, test), `POST /devices/{id}/charging-intent`
- `GET|PUT /protected-persons/{id}/charging-plan`
- `GET /device-models`, `POST /vendor-links/{vendor}/oauth/callback`, `POST /webhooks/vendors/{vendor}` (imza doğrulamalı)
- `GET /events/{id}/vitals` (yalnız olay açıkken), `GET /supervisor/coverage`, `GET /admin/devices/fleet`

**S8.4 — Kural paketine (tr.yaml) neler girer?**

```yaml
coverage: { onlineMin: { A: 15, B: 30 }, locationStaleMin: 30 }
battery: { planPct: 30, familyPct: 15, criticalPct: 10, deadPct: 5, planHour: "18:00" }
charging: { defaultWindow: "19:00-21:00", chargeDonePct: 80, chargeDoneMin: 20,
            putOnMin: [15, 30], familyGapMin: 90, familyGapOffPlanMin: 60, maxGapMin: 120, intentMin: 90 }
coverageNone: { remindMin: 20, familyMin: 45, eventMin: 60, welfareSilentH: 6, welfareDroppedH: 2 }
fusion: { corroborateSec: 90, corroboratedPromptSec: 30 }
call112DeadlineSec: { SOS: 180, FALL: 300, INACTIVITY: 1200 }
vitals: { learnDays: 14, minValidDays: 7, sustainedMin: 10, comboMin: 5, cooldownH: 24,
          worsenPct: 20, maxChecksPerWeek: 2, claimSlaMin: 15 }
```

**S8.5 — Mesaj kataloğuna hangi kodlar eklenir?** (Türkçe metinler katalogda yazılır)

- Saat/kolye: W-CHARGE-DONE, W-WEAR-REMIND, W-BAT-PLAN
- Telefon: P-CHARGE-COVER, P-CHARGE-DONE, P-WEAR-REMIND, P-CHARGE-NOW, P-COVERAGE-\*
- Aile: F-CHARGE-GAP, F-COVERAGE-NONE, F-COVERAGE-BACK, F-PENDANT-BATTERY, F-DEVICE-LIMIT, F-VITAL-TREND, F-UI-COVERAGE-\*, F-UI-NIGHT-CHARGE-WARN, F-UI-DEVICES
- Operatör: O-TYPE-COVERAGE\_GAP, O-TYPE-WELFARE\_CHECK, O-SCRIPT-COVERAGE, O-SCRIPT-VITALS, O-SCRIPT-APPLE-112, O-UI-DEVICES, O-UI-112-DEADLINE, O-RES-SKIPPED\_OFFLINE, O-OEM-LATENCY, O-SERVICE-BATTERY
- Sesli: V-VITAL-ASK, V-NO-OPERATOR

## 9. Güvenlik, KVKK, tıbbi cihaz mevzuatı ve OEM sözleşmeleri

Karar: Yanımda ilk sürümlerde bir **sosyal alarm hizmeti** olarak konumlanır, tıbbi cihaz olarak değil. Otomatik düşme algılama ve eşikli değer uyarıları bu sınırı zorlar; değer kuralları yazılı bir uzman görüşü alınana kadar kapalı kalır.

**S9.1 — Hangi özellik bizi tıbbi cihaz yapar?** AB MDR Kural 11'e göre fizyolojik süreçleri izleyen yazılım Sınıf IIa'dır; değişimi ani tehlike yaratabilecek hayati parametreleri izliyorsa IIb. [Johner](https://blog.johner-institute.com/regulatory-affairs/mdr-rule-11/) Türkiye'de 2021 Tıbbi Cihaz Yönetmeliği MDR'ye göre hazırlandı. [TİTCK](https://titck.gov.tr/storage/Archive/2024/announcement/duyurumetni_67231ed0-2553-4708-8231-7951c767e066.pdf)

| Özellik | Muhtemel konum |
| --- | --- |
| Elle basılan SOS'u operatöre yönlendirmek | Sosyal alarm, tıbbi cihaz değil |
| Aileye haftalık eğilim (sağlık-amaçlı) | Düşük risk |
| Otomatik düşme algılama | Kural 11 kapsamına girebilir; düşmeyi cihaz üreticisi algılıyorsa sorumluluk onlarda kalır |
| Eşikli nabız/oksijen uyarısı, operatör kararına destek | Muhtemelen IIa, hayati parametre alarmı IIb |

Bu tablo bir araştırma çıkarımıdır; onaylanmış kuruluş veya hukuk görüşüyle teyit edilmelidir.

**S9.2 — Hangi standartları hedeflemeliyiz?** EN 50134 sosyal alarm serisi: -1 sistem, -2 tetik cihazı (örn. kolye), -7 hizmet sunumu. [NSAI](https://shop.standards.ie/en-ie/standards/i-s-en-50134-7-2017-856796_saig_nsai_nsai_2038213) İngiltere TEC kalite çerçevesi alarm çağrılarının %97,5'inin 60 sn, %99'unun 180 sn içinde cevaplanmasını ve tüm sesli alarm çağrılarının kaydedilmesini ister. [TEC](https://www.tecquality.org.uk/tec-monitoring) Üstlenme hedefimizi buna göre koyduk. Her A sınıfı cihaz için aylık uçtan uca test (EN 50134 uygulaması) eklenir.

**S9.3 — KVKK açısından ne değişiyor?** 7499 sayılı Kanunla 1 Haziran 2024'ten beri sağlık verisi açık rıza dışında da işlenebiliyor (örn. rıza veremeyen kişinin hayatını koruma); yurt dışı aktarım yeterlilik kararı, Kurul onaylı güvence veya 5 iş günü içinde bildirilen standart sözleşmeyle yapılır. [Erdem & Erdem](https://www.erdem-erdem.av.tr/bilgi-bankasi/kisisel-verilerin-korunmasi-kanununda-neler-degisti) Oura, Samsung, Google bulutları yurt dışındadır: her bulut bağlantısı ayrı açık rıza ve aktarım dayanağı ister. Anahtar sahibi ve komşu gibi üçüncü kişilerin bilgisi için de aydınlatma gerekir.

**S9.4 — Sağlık verisi nasıl korunur?** Değer örnekleri `health` şemasındadır ve yalnız olay anında çözülür; operatör yalnız açık olayda görür, erişim denetime yazılır. Log'a kişisel veri ve ham değer yazılmaz. Bulut belirteçleri alan düzeyinde şifrelenir. Kayıp veya çalınan cihaz iptal edilince belirteci anında geçersiz olur ve kapsama yeniden hesaplanır.

**S9.5 — OEM sözleşmesinde neler olmalı?** Veri işleme sözleşmesi ve veri bölgesi; olay teslim SLA'ı (≤15 sn p95, %99,9 erişilebilirlik); 1 saat içinde olay bildirimi ve 7/24 irtibat; yazılım güncellemelerinin 14 gün önceden bildirimi; düşme algılama hassasiyet ayarlarının bize açılması; ortak merkezin 112'yi kendi arayıp aramadığının net tanımı (çift arama ve "kimse aramadı" riskleri); sözleşme biterse cihazların geçiş planı.

**S9.6 — Neyi pazarlamada asla söylemeyiz?** Teşhis, "kalp krizi / felci yakalar", "tıbbi izleme", "doktor takibi". Özellik adı: "sağlık eğilimleri ve kontrol araması tetikleyicileri".

## 10. Yol haritası, kabul kriterleri ve sizin kararlarınız

Karar: ilk aşama yeni donanım beklemez; kapsama modeli, şarj ve operatör cihaz şeridi mevcut saat ve telefonla \~4 haftada yapılır. Kolye ortaklığı ikinci, değer kuralları mevzuat görüşünden sonra üçüncü, üretici bulutları en son gelir.

**S10.1 — Her aşama ne zaman bitmiş sayılır?**

| Aşama | Süre | Kabul kriteri |
| --- | --- | --- |
| 1. Kapsama ve şarj | \~4 hafta | İki giyilebilir cihaz birbirini ezmiyor; saat şarjda + kolye takılı = TAM ve sıfır hatırlatma; tek saat şarjda: %80/20 dk'da "şarj tamam", 90 dk'da aile, 120 dk'da operatör, gece hiçbir şey; şarjdan düşen saatin düşmesi yok sayılıyor; tüm kapsama durumları (takılı/şarjda/çevrimdışı × 1–3 cihaz × gece) tablo testinde; mevcut simülatör senaryoları değişmeden geçiyor |
| 2. Merdiven ve kolye | \~6 hafta | Her süre (S5.2, S5.4) tablo testinde; 112 aranmadan P1 "ulaşılamadı" kapanışı amire uyarı üretiyor; kolye + saat aynı düşme → tek olay, doğrulanmış, 30 sn soru; başka cihazdan iptal kaydı ve takip araması; ilk kolye ortağı sertifika listesini (S2.6) geçiyor, SOS ≤15 sn p95 |
| 3. Değerler (bayrakla) | \~6 hafta | Öğrenme süresinde değer olayı yok; Q3 veri tek başına hiç olay açmıyor; 10 dk süreklilik ve takılı/hareketsiz şartı olmadan uyarı yok; yorgunluk sınırları çalışıyor; log'da kişisel veri yok |
| 4. Bulutlar ve Apple | \~4 hafta+ | Hiçbir C sınıfı sinyal kapsamayı değiştirmiyor; watchOS uygulaması Apple izni gelince; radyo kolye ortağı |

**S10.2 — Başlamadan önce sizin karar vermeniz gerekenler**

- [ ] Değer kuralları için yazılı mevzuat görüşü alınsın mı? Cevap "IIa" ise yalnız sosyal alarm olarak kalmayı kabul ediyor musunuz, yoksa onaylanmış kuruluş dosyası için bütçe mi ayırıyorsunuz?
- [ ] 112 son sınırları (SOS 180 sn, düşme 300 sn, hareketsizlik 20 dk) uygun mu? 112 koordinasyon merkeziyle hareketsizlikte "yerinde kontrol" talebinin kabul edilip edilmediği teyit edilmeli.
- [ ] Üstlenilmeyen P1'de sistemin 180 sn'de 1. yakını sesli mesajla aramasına izin veriyor musunuz?
- [ ] Kişi başına 6 cihaz / 3 alarm cihazı sınırı bir fiyat paketine mi bağlanacak?
- [ ] Varsayılan şarj penceresi akşam (önerimiz) mı, sabah mı? Tek saatin gece şarjına uyarıyla izin mi, tamamen yasak mı?
- [ ] İlk kolye ortağı: hücresel (önerimiz) mi, ev üniteli radyo mu? Hangi üretici?
- [ ] Apple fall-detection izni için başvuru yapılsın mı?
- [ ] Yurt dışı üretici bulutlarını (açık rıza akışıyla) kabul ediyor muyuz, yoksa yalnız telefona bağlı BLE cihazlar mı?
- [ ] Anahtar sahibi ve komşu için KVKK aydınlatmasını kim alıyor (aile mi, biz mi)?
- [ ] Başka cihazdan iptal edilen doğrulanmış düşmede P4 takip araması kalsın mı?

**S10.3 — Tartışmada nasıl uzlaşıldı?** Fable 5.1 ve Opus 5.5 iki ayrı öneri yazdı, sonra birbirini eleştirdi. Uzlaşılmayan yerlerde yaşlı için daha güvenli olan seçildi:

| Konu | Fable | Opus | Kitapçıkta |
| --- | --- | --- | --- |
| Doğrulama penceresi | 60 sn | 90 sn | 90 sn (geniş pencere yalnız yardımı hızlandırır) |
| Yaşlı telefonu | en çok 2 | tam 1 | tam 1 (tek, net sesli yol) |
| P1 cihaz arama süresi | 20 sn + yeniden | 15 sn | 20 sn, otomatik cevap 10 sn, + 15 sn yeniden arama (yaşlının cihaza uzanma süresi) |
| Kapsama YOK → operatör | 60 dk | 90 dk | 60 dk |
| Tek anormal nabız | P2 | P3 + 15 dk üstlenme | P3 + 15 dk; hareketsizlikle birleşince P2, gece dahil |
| Değer sessizliği | 24 sa | 6 sa | 24 sa, %20 kötüleşmede delinir; P2 asla sınırlanmaz |
