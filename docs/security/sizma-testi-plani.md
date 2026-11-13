# Dış sızma testi planı

T-081 (5). Bağımsız bir firma tarafından, canlıya çıkıştan önce (v1.0) ve sonra yılda bir ile her büyük mimari
değişiklikte. Kabul: kritik bulgu 0, yüksek bulgular yeniden testte kapalı veya tarihli risk kabulüyle.

## 1. Hedefler

1. Kimliksiz saldırganın kişisel/sağlık verisi okuyamadığını ve sahte acil olay üretemediğini doğrulamak.
2. Rol ve kaynak sınırlarını (operatör ↔ amir ↔ yönetici, aile ↔ başka aile, cihaz ↔ başka cihaz) zorlamak.
3. `asvs-l2.md`'deki ⚠️/❌ maddeleri ve G-1…G-20 açıklarını bağımsız olarak doğrulamak/çürütmek.
4. Mobil uygulamaları MASVS L1 + R (dayanıklılık: sabitleme, root/jailbreak uyarısı) karşısında değerlendirmek.

## 2. Kapsam

Ortam: **staging** (üretimle aynı imaj ve yapılandırma, sentetik veri). Alan adları yer tutucudur.

| Bileşen | Hedef | Öncelikli konular |
| --- | --- | --- |
| REST API | `https://api.staging.yanimda.app/v1/*` | Yetki/IDOR (`/events/{id}`, `/events/{id}/person`, `/protected-persons/{id}/*`, `/devices/{id}/*`), cihaz eşleştirme kaba kuvveti ve DoS (`POST /devices/enroll`, G-1), token'sız/sahte sinyal (`POST /signals`, G-3), hız sınırı (G-2), JWT doğrulama (alg, iss, aud, typ, realm karışımı), `x-admin-token` üretimde kapalı mı (G-4), hata yanıtlarında bilgi sızıntısı |
| WebSocket | `wss://api.staging.yanimda.app/v1/ws/queue` | Kimliksiz bağlantıdan veri alma, süresi dolmuş/yanlış realm token'ı, token yenilemede kimlik değiştirme, büyük/bozuk mesaj, bağlantı tüketme |
| Operatör konsolu | `https://console.staging.yanimda.app` | XSS (olay notu, kişi adı, adres alanları), CSP/başlıklar (G-5), oturum ve çıkış, token saklama, eğitim modu ayrımı |
| Keycloak | `https://auth.staging.yanimda.app` (`operations`, `consumers`) | OTP atlatma, kaba kuvvet ve hesap kilitleme, yönlendirme URI'leri (G-20), parola politikası (G-9), kullanıcı sayımı, yönetici konsolunun dışarıdan erişimi |
| CPaaS webhook'ları | `/v1/webhooks/cpaas/{kind}`, `/v1/webhooks/notify/sms` | İmza atlatma (URL/parametre kanonikleştirme, `CPAAS_WEBHOOK_BASE` uyumsuzluğu), tekrar oynatma (G-17), TwiML enjeksiyonu |
| Aile uygulaması (Flutter) | iOS + Android staging derlemesi | MASVS: depolama, ağ (sertifika sabitleme, `sertifika-sabitleme.md`), kimlik doğrulama (AppAuth/PKCE), başka ailenin kişisine erişim, bildirim içeriğinde PII |
| Eşlikçi telefon uygulamaları | iOS (`yanimda-ios`), Android (`yanimda-android`) | Cihaz token'ının saklanması (Keychain/Keystore), sabitleme, root/jailbreak uyarısı, SOS çevrimdışı kuyruk, yerel log'da PII |
| Wear OS saat | `yanimda-wear` staging derlemesi | Token saklama, telefon–saat iletişimi, sabitleme, ADB/debug yüzeyi |

Kaynak kod ve mimari belgeler (bu repo, `docs/security/`) test firmasıyla paylaşılır (gri kutu).

## 3. Kapsam dışı

- Üretim ortamı ve gerçek kişi verisi.
- Üçüncü taraf altyapısı: Twilio, FCM/APNs, Google Play/App Store, bulut sağlayıcının kendi hizmetleri (yalnız bizim
  yapılandırmamız kapsamda).
- Hizmet engelleme (yük/DDoS) testleri — ayrı, önceden planlanmış yük testi penceresi dışında. Tek istekle kilitleme
  (ör. G-1 kayıt kilidi) **kanıt düzeyinde** gösterilebilir, sürdürülmez.
- 112 veya gerçek telefon numaralarına arama/SMS: staging `CPAAS_PROVIDER=fake` veya yalnız test numaraları.
- Sosyal mühendislik, fiziksel güvenlik, çalışanlara oltalama.
- Gerçek akıllı saat donanımına fiziksel saldırı (yalnız uygulama katmanı).

## 4. Kurallar (rules of engagement)

- Test penceresi, kaynak IP'ler ve test hesapları yazılı onayla; pencere dışı test yok.
- Yük sınırı: istemci başına ≤ 20 istek/sn; tarayıcı/fuzzer eşzamanlılığı onaylı değerin üstüne çıkmaz.
- Elde edilen veri (sentetik olsa bile) test bitiminde imha; kanıt ekran görüntülerinde kişi verisi maskelenir.
- Kalıcı değişiklik (kullanıcı silme, kural paketi yükleme) yalnız test hesaplarının kaynaklarında.
- Kritik bulgu (ör. kimliksiz sağlık verisi okuma, sahte olay) bulunduğunda test o vektörde durur, **1 saat içinde**
  §7'deki kişilere bildirilir; rapor beklenmez.
- Operatör kuyruğunu dolduracak sahte olaylar yalnız `isTest` işaretli test kişileri üzerinden; staging amir
  uyarıları test süresince bu kişiler için susturulur.

## 5. Ortam ve test hesapları

Staging, test başlamadan bir hafta önce dondurulur (imaj etiketi ve rule pack sürümü rapora yazılır).

| Hesap / veri | Adet | Not |
| --- | --- | --- |
| `operations` realm: OPERATOR | 2 | Her biri kendi TOTP'u; olay sahipliği testleri için iki operatör |
| `operations` realm: SUPERVISOR | 1 | — |
| `operations` realm: ADMIN | 1 | Yalnız yetki sınırı testleri |
| `consumers` realm: FAMILY | 2 aile × 1 | Aile A ↔ aile B çapraz erişim testleri |
| Korunan kişi | Aile başına 2 | Sentetik ad/adres/telefon, sahte tıbbi özet |
| Cihaz | Kişi başına 1 saat + 1 telefon | Eşleştirme kodları test sırasında aile hesabıyla üretilir |
| `x-admin-token` | — | **Tanımsız**: staging `NODE_ENV=production`, API `ADMIN_TOKEN` doluyken açılmaz ve başlığı yok sayar (G-4 kapandı). Test: başlıkla yönetici uçları 401/403 |

Hesap bilgileri şifreli kanaldan (parola yöneticisi paylaşımı) iletilir; e-postayla gönderilmez. Mobil derlemeler
staging pin setiyle (`sertifika-sabitleme.md` §3) ve ek olarak pin'siz bir "test" varyantıyla verilir (sunucu
testleri için proxy).

## 6. Yöntem

- **Web/API:** OWASP WSTG v4.2 (özellikle ATHN, ATHZ, SESS, INPV, BUSL, CRYP, ERRH, CONF) ve OWASP API Security Top
  10 (2023): BOLA, kırık kimlik doğrulama, BOPLA, kaynak tüketimi, BFLA, hassas iş akışları, SSRF, yanlış
  yapılandırma, envanter, güvenilmeyen API tüketimi.
- **Doğrulama referansı:** `asvs-l2.md` satırları; test firması her ⚠️/❌ için "doğrulandı / çürütüldü" işaretler.
- **Mobil:** OWASP MASTG ile MASVS v2 (STORAGE, CRYPTO, AUTH, NETWORK, PLATFORM, CODE, RESILIENCE). NETWORK için
  `sertifika-sabitleme.md` §8 kontrol listesi.
- **Otomatik + elle:** otomatik tarama (ZAP vb.) yalnız başlangıç; bulguların çoğu elle doğrulanmalı. CI'daki
  ZAP baseline ve Semgrep sonuçları (CI güvenlik işleri) firmayla paylaşılır.

Asgari senaryolar:

1. Davet kodu kaba kuvveti: tek IP, çok IP (IPv6), `X-Forwarded-For` ile; ingress arkasında kilitleme etkisi (G-1).
2. Başka cihazın `deviceId`/`protectedPersonId`'si ile sinyal; token'sız sinyal (G-3); kaldırılmış cihazın eski
   token'ı ve token'sız yeniden denemesi.
3. Operatör A'nın operatör B'nin olayında kişi kartı/112 şablonu; kapanmış olayda kişi kartı; FAMILY token'ıyla
   operatör uçları; `consumers` token'ı ile `operations` rolü taşıma (realm karışımı).
4. WS: auth mesajı olmadan veri; FAMILY token'ı; süresi dolan token sonrası yayın almaya devam.
5. Webhook: imzasız, yanlış URL tabanıyla imzalı, tekrar oynatılmış istek; `kind`/`call` manipülasyonu.
6. Konsol: kişi adı/adres/notta depolanmış XSS → token çalma.
7. Hata yanıtları ve log'lar: tetiklenen hatalarda stack trace, SQL, PII var mı (log'lar firmaya maskeli örnek
   olarak verilir).
8. Mobil: cihaz token'ı yedeklemeden/yerel depodan çıkarma; mitmproxy ile sabitleme atlatma; root'lu cihazda
   uygulamanın engellenmediği ve uyarının göründüğü.

## 7. Takvim

| Hafta | İş |
| --- | --- |
| H−2 | Kapsam ve kurallar imzası, staging dondurma, hesapların hazırlanması |
| H−1 | Firmaya kaynak kod/belgeler, açılış toplantısı (mimari anlatımı, 30 dk) |
| H1–H2 | API, WebSocket, konsol, Keycloak, webhook testleri |
| H2–H3 | Mobil (aile, eşlikçi iOS/Android, Wear OS) |
| H3 sonu | Taslak rapor; kritik/yüksek bulgular için ara toplantı |
| H4–H6 | Düzeltmeler |
| H7 | Yeniden test (yalnız bulunan açıklar + regresyon) ve son rapor |

## 8. Raporlama ve yeniden test

- Her bulgu: başlık, önem (CVSS v3.1 veya v4.0 + iş etkisi), etkilenen uç/bileşen, adım adım yeniden üretim, kanıt
  (maskelenmiş), önerilen düzeltme, ilgili ASVS/MASVS maddesi.
- Önem eşlemesi: **Kritik** = kimliksiz kişisel/sağlık verisi okuma veya sahte acil olay; **Yüksek** = kimlikli
  yetki aşımı, ölçeklenebilir kötüye kullanım (maliyet, kuyruk); **Orta / Düşük** = derinlemesine savunma eksikleri.
- Düzeltme süreleri (rapor tarihinden): kritik 72 saat (canlıya çıkış engeli), yüksek 2 hafta, orta 1 ay, düşük bir
  sonraki sürüm.
- Bulgular iş takibine `security` etiketiyle girer; düzeltme commit mesajı ilgili PRD kimliğiyle
  (`<alan>(<PRD-id>): …`).
- Yeniden test sonrası `asvs-l2.md` güncellenir; rapor gizli dokümandır, repoya konmaz (özeti ve bulgu numaraları
  `docs/security/` altında).

## 9. İletişim ve acil durdurma

| Rol | Kişi | Ulaşım |
| --- | --- | --- |
| Test sorumlusu (Yanımda) | `<AD SOYAD>` | `<TELEFON>`, `<E-POSTA>` |
| Acil durdurma (7/24) | `<NÖBETÇİ>` | `<TELEFON>` — "DURDUR" çağrısıyla test anında durur |
| Altyapı nöbetçisi | `<AD SOYAD>` | `<TELEFON>` |
| Operasyon amiri (staging kuyruğu) | `<AD SOYAD>` | `<TELEFON>` |
| Test firması sorumlusu | `<AD SOYAD>` | `<TELEFON>`, `<E-POSTA>` |

Durdurma ölçütleri: staging dışında etki belirtisi, üçüncü taraf hizmete (Twilio vb.) beklenmeyen trafik, gerçek
numaraya arama/SMS, gerçek kişi verisiyle karşılaşma.
