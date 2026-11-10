# Telefoni — Türkiye numarası, SIP trunk, gelen SOS ve 112 (T-051 kalan, T-052)

E-05. Bu belge yapılandırmayı, gelen SOS aramalarının yönlendirmesini ve 112 masa hattı prosedürünü anlatır.
Kodun yaptığı ile gerçek hesap gerektiren işler ayrı başlıklarda. Konsol metinleri `packages/messages/tr.json`'da
(O-CALL-112-*, O-UI-INBOUND-*, V-INBOUND-WAIT).

## 1. Numara modeli

| Numara | Nerede | Not |
| --- | --- | --- |
| Servis gelen SOS numarası (ana) | `CPAAS_INBOUND_NUMBER` | Saatlerin ve telefon uygulamasının aradığı numara. 0850 önerilir (coğrafi değil, taşınabilir). |
| Yedek numara | `CPAAS_BACKUP_NUMBER` | Ana numara/trunk düşerse saat yapılandırmasında ikinci numara. |
| Giden arayan numara | `TWILIO_FROM_NUMBER` | Aranan kişinin ekranında görünen numara; ana numarayla aynı olabilir. |
| Masa sabit hattı | `CPAAS_AGENT_NUMBER` | Operatör masasındaki sabit hat. 112 buradan aranır; yazılım telefonu kapalıysa operatör ucu da budur. |
| 112, 183, 182 | `packages/rules/tr.yaml` → `numbers` | Resmi hatlar; CPaaS bunları aramaz. |

Biçim: ortam değişkenlerindeki tüm numaralar E.164 (`+90…`). API açılışta denetler (`numbers.ts`
`telephonyEnvProblems`): bozuk numara, bozuk BYOC kimliği ya da aralık dışı süreler varsa telefoni açılmaz ve hata
düzeltme önerisiyle yazılır (ör. `0212 000 00 00` → `+902120000000`). `COUNTRY_CODE=TR` iken TR dışı numara açılışta
uyarıdır (Twilio deneme hesabı ABD numarasıyla çalışır; kabul aramaları TR numarasından yapılmalı).

TR numara türleri (`trNumberKind`): cep `+905…`, coğrafi `+90[2-4]…` (444 hariç), coğrafi olmayan `+90850…`,
ücretsiz `+90800…` (yalnız gelen). Arayan numara SIP trunk'tan ulusal biçimde ya da `sip:` URI içinde gelebilir
(`sip:05321234567@…`); eşleştirmeden önce E.164'e çevrilir (`normalizePhone`).

## 2. Bağlantı seçenekleri

1. **Twilio TR numarası** (varsa): Twilio Console → Phone Numbers. TR numaraları düzenleyici paket (Regulatory Bundle)
   ister ve her zaman stokta değildir.
2. **Netgsm / Verimor SIP trunk → Twilio BYOC** (önerilen):
   - Sağlayıcıdan 0850 numara + SIP trunk (IP doğrulamalı) alınır.
   - Twilio: Voice → BYOC Trunks → yeni trunk; sağlayıcının SIP sunucusu "Origination" (giden) hedefi; Connection
     Policy'ye sağlayıcı IP'leri. Trunk SID'i (`BY…`) `TWILIO_BYOC_TRUNK_SID`'e.
   - Gelen: sağlayıcı DID'i Twilio SIP Domain'e yönlendirir (`<alan>.sip.twilio.com`); SIP Domain'in "Call Control"
     Voice URL'i aşağıdaki gelen SOS adresidir.
   - Giden: `TWILIO_BYOC_TRUNK_SID` verilince aranan bacak `<Number byoc>`, konferansa eklenen yakın, sesli bildirim
     ve masa hattı Calls API'de `Byoc` ile trunk'tan çıkar; yazılım telefonu (`client:`) bacakları Twilio içinde kalır.

## 3. Gelen SOS aramaları (T-051 kalan)

Twilio numarası / SIP Domain:

- Voice URL: `POST {CPAAS_WEBHOOK_BASE}/v1/webhooks/cpaas-inbound/call`
- Status callback: `POST {CPAAS_WEBHOOK_BASE}/v1/webhooks/cpaas-inbound/status`

Akış (`InboundService`):

1. Arayan "Bu görüşme kaydedilmektedir." duyar (V-CALL-RECORDED); görüşme iki kanallı kaydedilir, kayıt S3'e
   (`recordings/<ülke>/<olay>/inbound-<id>.mp3`, olay yoksa `recordings/<ülke>/inbound/<id>.mp3`).
2. Arayan numara rehberdeki saat (WATCH) ya da kişinin telefonu (ELDER) ile eşleşirse ve kişinin açık olayı varsa
   önce **o olayı yürüten operatör** çalar (bağlıysa; molada olsa bile — kendi olayının kişisi).
3. Sonra **bağlı ve Müsait** operatörler sırayla (`INBOUND_RING_SEC`, varsayılan 20 sn): amirler, molada/çevrim dışı
   olanlar, 90 sn'dir görülmeyenler ve aramada olanlar atlanır; açık olayı olmayan ve en uzun boşta kalan önce.
4. Kimse yoksa arama kuyruğa girer; arayan her turda V-INBOUND-WAIT duyar. Bir operatör Müsait olunca (ya da cevapsız
   operatörün `INBOUND_RETRY_SEC` süresi dolunca) arama kuyruktan çıkar ve ona çalar.
5. Konsolda gelen arama **çalar** (köprü bacakları gibi kendiliğinden açılmaz): Cevapla / Reddet; arayanın olayı varsa
   "Olayı aç". Reddedilen ya da cevapsız arama sıradakine geçer.

Operatör durumu: konsol üst barında **Durumum: Müsait / Molada** (`PUT /v1/operators/me/status`, audit). Çevrim dışı
amir işidir (amir panosu).

Masa hattı modu (`CPAAS_SOFTPHONE=off`): gelen arama doğrudan masa hattına çalar; meşgul/cevapsızsa kuyruk.

Arayan numara hiçbir tabloya ve log'a yazılmaz; `telephony.inbound_call` yalnız eşleşen kişi, olay, denenen
operatörler ve süreleri tutar.

## 4. 112 prosedürü (masa sabit hattı)

112 (ve 183, 182) **CPaaS'tan aranmaz**: arayan numara doğrulaması ve geri arama için operatör masasındaki sabit
hattan aranır. Zincirin 112 adımı konsolda **MANUEL** işaretlidir.

Konsolda 112 adımı:

1. Uyarı: "112'yi masadaki sabit hattan arayın; yazılım telefonu veya cep telefonu kullanmayın."
2. Masa hattı tanımlıysa geri arama numarası gösterilir (`CPAAS_AGENT_NUMBER`, ulusal biçim) — 112 sorarsa okunur.
3. Operatör 112 betiğini (O-SCRIPT-112: olay, kişi, yaş, adres, hastalıklar, ilaçlar, alerjiler, kapı notu) okur;
   "Okundu" işaretlenir.
4. "Sabit hattan aradım" (A) adımı arandı olarak işaretler (CPaaS araması açılmaz).
5. Sonuç **elle** girilir (1 ulaşıldı, 2 cevap yok, 3 meşgul, 4 yanlış numara); 112'nin söyledikleri nota yazılır.
   Ulaşıldı → olay "112 yönlendirildi".

Doğrudan 112'ye aktarma (Ctrl+1, gerekçe zorunlu) aynı adıma götürür.

Masa hattı gereksinimleri (operasyon): her masada sabit hat (analog/IP), arayan numara gösterimi açık; numara 112
çağrı merkezine kurum numarası olarak bildirilmiş; hat yedeği (ikinci hat ya da GSM yedeği) prosedürde.

## 5. Gerçek hesap gerektiren açık işler

- [ ] Twilio hesabı (ücretli), Voice API anahtarı, TwiML App; gerçek WebRTC ile iki operatör kabul testi: gelen arama
      müsait olana düşer, ilk operatör reddedince ikincisine geçer, kuyruk anonsu duyulur.
- [ ] TR numarası: Twilio TR numarası (düzenleyici paket) ya da Netgsm/Verimor 0850 + SIP trunk sözleşmesi.
- [ ] Twilio BYOC trunk kurulumu (Origination URI, Connection Policy, sağlayıcı IP'leri), SIP Domain → Voice URL;
      sağlayıcının arayan numarayı hangi biçimde ilettiğinin doğrulanması (E.164 / ulusal / `sip:`).
- [ ] Kabul aramaları TR numarasından: giden köprü, konferansa aile ekleme, bekletme, gelen SOS, kayıt S3'te.
- [ ] Masa sabit hatlarının kurulumu ve 112'ye kurum numarası bildirimi; 112 ile tatbikat (resmi izinle).
- [ ] Saat/telefon uygulamasında ana ve yedek numaranın yapılandırılması.
- [ ] Kayıt saklama süresi ve arayana anons metninin KVKK hukuk değerlendirmesi.
- [ ] Twilio numarasının Status callback'inin ayarlanması (arayan kuyrukta kapatınca "vazgeçti" kaydı buna bağlı).
