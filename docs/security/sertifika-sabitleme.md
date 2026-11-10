# Sertifika sabitleme (certificate pinning) ve root/jailbreak uyarısı

T-081 (2). Uygulama kodu ayrı depolardadır: `yanimda-wear` (Wear OS saat), `yanimda-android` (Android eşlikçi),
`yanimda-ios` (iOS eşlikçi, `YanimdaKit`), `yanimda-family` (Flutter aile uygulaması). Bu belge o depolar için
yönergedir; bu repoda yalnız pin üretme betiği vardır: `scripts/security/spki-pin.sh`.

## 1. Karar özeti

| Konu | Karar |
| --- | --- |
| Ne sabitlenir | **SPKI** (SubjectPublicKeyInfo, açık anahtar) SHA-256 özeti. Yaprak sertifikanın kendisi değil: sertifika 90 günde bir yenilenir, anahtar yenilenmeyebilir. |
| Hangi anahtar | **Kendi yaprak anahtarımız** (K1) + **en az iki yedek anahtar** (K2, K3). Yedekler önceden üretilir, çevrimdışı saklanır, hiçbir sunucuda kullanılmaz. |
| En az pin sayısı | 2 (kural); önerilen 3 (K1 kullanımda + K2, K3 yedek). Tek pin'li sürüm yayımlanmaz (CI kontrolü, §7). |
| Ara CA / kök pin | Önerilmez (§2). Yalnız kendi anahtarımızı yönetemediğimiz bir CDN zorunlu olursa, iki farklı CA'nın kökü birlikte. |
| Süre | Android `pin-set expiration` = sürüm tarihi + 12 ay. OkHttp ve iOS'ta aynı tarih kodda kontrol edilir; süre dolunca pin denetimi kapanır (normal TLS doğrulaması sürer). |
| Uzaktan kapatma | Yok (§5). Kaçış yolu: yedek anahtar + süre sonu + zorunlu güncelleme. |
| Sabitlenen alan adları | Yalnız bizim API ve Keycloak alan adlarımız (§3). Üçüncü taraflar **asla** sabitlenmez. |
| Debug | Proxy (mitmproxy, Charles) yalnız debug yapılandırmasında. Release'te pin her zaman açık. |
| Pin hatası | Ağ hatası gibi ele alınır: SOS dahil sinyaller çevrimdışı kuyruğa girer (`P-SOS-QUEUED` davranışı). Kullanıcıya teknik ayrıntı gösterilmez. |
| Root/jailbreak | Yalnız **uyarı**; uygulama ve SOS hiçbir koşulda engellenmez (§6). |

## 2. Neden kendi anahtarımız, neden ara CA değil

- **Ara CA pin'i:** CA ara sertifikasını değiştirdiğinde (Let's Encrypt R10/R11, E5/E6 gibi dönüşümler yaygındır)
  bütün eski uygulamalar bağlanamaz. Kontrol bizde değil.
- **Kök CA pin'i:** Aynı CA'dan sertifika alabilen herkese karşı korumaz; CA değişikliği yine sürüm gerektirir.
- **Kendi yaprak anahtarımız:** Rotasyonu biz yönetiriz. Koşul: sertifika yenilenirken **anahtar korunmalı**:
  - cert-manager: `Certificate.spec.privateKey.rotationPolicy: Never` (yeni sürümlerde varsayılan `Always`).
  - certbot: `--reuse-key`; elle CSR: `openssl req -new -key k1.key …`.
  - CDN/WAF sertifikayı kendi anahtarıyla yönetiyorsa (ör. otomatik "universal" sertifika) kendi anahtarımızı
    pin'leyemeyiz: özel sertifika yükleme (anahtar bizde) seçilmeli. Bu, altyapı kararıdır; pin'den önce netleşmeli.
- Anahtar türü: ECDSA P-256 önerilir (küçük, hızlı). Yedekler aynı ya da farklı türde olabilir; iOS kodu her iki
  türü destekler (§4.3).

Yedek anahtar üretimi (çevrimdışı makinede):

```sh
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out yanimda-k2.key
scripts/security/spki-pin.sh --file yanimda-k2.key      # → sha256/<base64>  (pin listesine eklenir)
# yanimda-k2.key: şifreli olarak iki ayrı yerde (Vault/KMS + kasadaki çevrimdışı ortam). Sunucuya konmaz.
```

Canlı sunucunun zinciri: `scripts/security/spki-pin.sh api.yanimda.app:443` (her sertifikanın pin'i, `[0]` yaprak).

## 3. Sabitlenecek ve sabitlenmeyecek alan adları

Alan adları yer tutucudur; kesinleşince bu tablo ve uygulama yapılandırması birlikte güncellenir.
(`yanimda-wear/watch/build.gradle.kts` bugün `https://api.yanimda.app/v1` kullanıyor.)

| Alan adı (yer tutucu) | Ne | Kullanan | Pin |
| --- | --- | --- | --- |
| `api.yanimda.app` | REST API (`/v1/*`) | saat, eşlikçi, aile | ✅ K1, K2, K3 |
| `api.yanimda.app` → `wss://…/v1/ws/queue` | WebSocket (bugün yalnız konsol) | ileride mobil | ✅ aynı host, aynı pin seti |
| `auth.yanimda.app` | Keycloak (`consumers` realm; token, JWKS) | aile, eşlikçi | ✅ ayrı anahtar seti önerilir (KA1, KA2, KA3) |
| `api.staging.yanimda.app`, `auth.staging…` | Hazırlık ortamı | test sürümleri | ✅ ayrı pin seti (üretim pin'i staging'de kullanılmaz) |
| Twilio (`*.twilio.com`, Voice SDK uçları) | Telefoni | konsol/eşlikçi | ❌ **asla** |
| FCM, APNs, Google Play Integrity, Firebase | Push, bütünlük | işletim sistemi/SDK | ❌ (OS/SDK yönetir) |
| Harita/geokodlama, çökme raporlama vb. | Üçüncü taraf | — | ❌ |

Üçüncü taraf pin'lenmez çünkü anahtar/CA değişimleri bize haber verilmeden olur; acil durum servisinde telefoni ya da
push kesintisi pin'in sağladığı faydadan büyüktür. Konsol (tarayıcı) pin'lenemez (HPKP kaldırıldı); onun koruması
TLS + HSTS'tir (ASVS V14.4, `asvs-l2.md`).

## 4. Uygulama parçacıkları

Pin değerleri örnektir (`K1…`); gerçek değerler `spki-pin.sh` çıktısından. Tüm platformlarda pin listesi ve süre
sonu tek bir yapılandırma dosyasında tutulur (ör. `pins.json` → derleme anında koda), böylece CI aynı listeyi
canlı sunucuyla karşılaştırabilir (§7).

### 4.1 Android ve Wear OS — `network_security_config.xml` (temel katman)

Platform katmanıdır: `HttpsURLConnection`, OkHttp (platform `X509TrustManager` üzerinden), AppAuth ve WebView
dışındaki çoğu yığın bu kurala uyar.

`src/main/res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />

    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="false">api.yanimda.app</domain>
        <!-- Süre dolunca pin denetimi kapanır, TLS doğrulaması sürer (eski sürümler kilitlenmez). -->
        <pin-set expiration="2027-12-31">
            <pin digest="SHA-256">K1_BASE64=</pin>
            <pin digest="SHA-256">K2_BASE64=</pin>
            <pin digest="SHA-256">K3_BASE64=</pin>
        </pin-set>
    </domain-config>

    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="false">auth.yanimda.app</domain>
        <pin-set expiration="2027-12-31">
            <pin digest="SHA-256">KA1_BASE64=</pin>
            <pin digest="SHA-256">KA2_BASE64=</pin>
            <pin digest="SHA-256">KA3_BASE64=</pin>
        </pin-set>
    </domain-config>

    <!-- Yalnız debuggable derlemede: kullanıcı CA'sı (mitmproxy) kabul edilir ve pin'i geçersiz kılar. -->
    <debug-overrides>
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" overridePins="true" />
        </trust-anchors>
    </debug-overrides>
</network-security-config>
```

`AndroidManifest.xml`: `<application android:networkSecurityConfig="@xml/network_security_config" …>`.

Emülatörde yerel API (`http://10.0.2.2:3000`) için cleartext izni **yalnız** `src/debug/res/xml/` altındaki
ayrı bir kopyada (`<domain-config cleartextTrafficPermitted="true"><domain>10.0.2.2</domain></domain-config>`);
`main` kopyasında asla.

### 4.2 Android ve Wear OS — OkHttp `CertificatePinner` (ikinci katman + telemetri)

Ağ güvenliği yapılandırmasına ek olarak OkHttp'de açık pinner: hatayı yakalayıp ölçebilmek ve kod incelemesinde
görünür olması için. (Wear OS min API ≥ 30; `java.time` kullanılabilir.)

```kotlin
// core/src/main/kotlin/app/yanimda/net/Pinning.kt
object Pinning {
    val API_HOSTS = listOf("api.yanimda.app")
    val AUTH_HOSTS = listOf("auth.yanimda.app")
    val API_PINS = listOf("sha256/K1_BASE64=", "sha256/K2_BASE64=", "sha256/K3_BASE64=")
    val AUTH_PINS = listOf("sha256/KA1_BASE64=", "sha256/KA2_BASE64=", "sha256/KA3_BASE64=")
    /** network_security_config.xml'deki expiration ile aynı. */
    val EXPIRES: LocalDate = LocalDate.parse("2027-12-31")

    fun pinner(today: LocalDate = LocalDate.now(ZoneOffset.UTC)): CertificatePinner {
        val b = CertificatePinner.Builder()
        if (BuildConfig.DEBUG || !today.isBefore(EXPIRES)) return b.build() // debug: proxy serbest; süre doldu: TLS yeter
        API_HOSTS.forEach { h -> API_PINS.forEach { b.add(h, it) } }
        AUTH_HOSTS.forEach { h -> AUTH_PINS.forEach { b.add(h, it) } }
        return b.build()
    }
}

val client = OkHttpClient.Builder()
    .certificatePinner(Pinning.pinner())
    .addInterceptor(PinFailureInterceptor(telemetry))
    .build()

/** Pin hatasını ağ hatası olarak yeniden fırlatır; telemetriye PII'siz kayıt bırakır. */
class PinFailureInterceptor(private val telemetry: PinTelemetry) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response = try {
        chain.proceed(chain.request())
    } catch (e: SSLPeerUnverifiedException) {
        telemetry.pinMismatch(host = chain.request().url.host) // yalnız host, sürüm, zaman
        throw e // çağıran "bağlantı yok" yoluna düşer: sinyal kuyruğu, yeniden deneme
    }
}
```

`CertificatePinner`, OkHttp'nin temizlediği zincirde **herhangi bir** sertifikanın SPKI'si listedeyse geçer; biz
yalnız yaprak anahtarlarını listelediğimiz için fark etmez.

### 4.3 iOS — `NSPinnedDomains` (iOS 14+, temel katman)

`URLSession` ve onu kullanan kütüphaneler (AppAuth-iOS dahil) için bildirimsel pin. `Info.plist`:

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSPinnedDomains</key>
    <dict>
        <key>api.yanimda.app</key>
        <dict>
            <key>NSIncludesSubdomains</key><false/>
            <key>NSPinnedLeafIdentities</key>
            <array>
                <dict><key>SPKI-SHA256-BASE64</key><string>K1_BASE64=</string></dict>
                <dict><key>SPKI-SHA256-BASE64</key><string>K2_BASE64=</string></dict>
                <dict><key>SPKI-SHA256-BASE64</key><string>K3_BASE64=</string></dict>
            </array>
        </dict>
        <key>auth.yanimda.app</key>
        <dict>
            <key>NSIncludesSubdomains</key><false/>
            <key>NSPinnedLeafIdentities</key>
            <array>
                <dict><key>SPKI-SHA256-BASE64</key><string>KA1_BASE64=</string></dict>
                <dict><key>SPKI-SHA256-BASE64</key><string>KA2_BASE64=</string></dict>
                <dict><key>SPKI-SHA256-BASE64</key><string>KA3_BASE64=</string></dict>
            </array>
        </dict>
    </dict>
</dict>
```

Sınırlar: süre sonu yok, hata ayrıntısı yok (genel `NSURLErrorServerCertificateUntrusted` vb.), debug'da kapatmak
için ayrı `Info.plist` (Debug yapılandırması, `INFOPLIST_FILE` ayrımı) gerekir. Bu yüzden `YanimdaKit`'teki
`URLSession` için ayrıca §4.4'teki delegate önerilir (süre sonu + telemetri).

### 4.4 iOS — `URLSessionDelegate` ile SPKI denetimi (Swift)

`SecKeyCopyExternalRepresentation` SPKI değil **ham** anahtarı verir (RSA: PKCS#1 `RSAPublicKey`, EC: `04‖X‖Y`).
SPKI özeti için anahtar türüne göre sabit ASN.1 başlığı eklenir.

```swift
import CryptoKit
import Foundation
import Security

/// YanimdaKit: api/auth alan adları için SPKI pin denetimi. Debug'da ve süre dolunca yalnız sistem doğrulaması.
final class PinningDelegate: NSObject, URLSessionDelegate {
    static let pins: [String: Set<String>] = [
        "api.yanimda.app": ["K1_BASE64=", "K2_BASE64=", "K3_BASE64="],
        "auth.yanimda.app": ["KA1_BASE64=", "KA2_BASE64=", "KA3_BASE64="],
    ]
    static let expires = ISO8601DateFormatter().date(from: "2027-12-31T00:00:00Z")!
    private let telemetry: PinTelemetry
    init(telemetry: PinTelemetry) { self.telemetry = telemetry }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            return completionHandler(.performDefaultHandling, nil)
        }
        let host = challenge.protectionSpace.host
        // 1) Önce normal zincir + ad doğrulaması (pin, TLS doğrulamasının yerine geçmez).
        var error: CFError?
        guard SecTrustEvaluateWithError(trust, &error) else {
            return completionHandler(.cancelAuthenticationChallenge, nil)
        }
        #if DEBUG
        return completionHandler(.useCredential, URLCredential(trust: trust))
        #else
        guard let expected = Self.pins[host], Date() < Self.expires else {
            return completionHandler(.useCredential, URLCredential(trust: trust)) // pin'siz host / süre doldu
        }
        // 2) Yaprak anahtarın SPKI özeti (iOS 14+: SecTrustCopyKey yaprak açık anahtarını verir).
        if let key = SecTrustCopyKey(trust), let pin = Self.spkiSHA256(key), expected.contains(pin) {
            return completionHandler(.useCredential, URLCredential(trust: trust))
        }
        telemetry.pinMismatch(host: host) // PII yok: host, uygulama sürümü, zaman
        completionHandler(.cancelAuthenticationChallenge, nil) // çağıran "bağlantı yok" yoluna düşer
        #endif
    }

    /// SubjectPublicKeyInfo = ASN.1 başlığı (tür + boyut) + ham anahtar; base64(SHA-256).
    static func spkiSHA256(_ key: SecKey) -> String? {
        guard let raw = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              let attrs = SecKeyCopyAttributes(key) as? [CFString: Any],
              let type = attrs[kSecAttrKeyType] as? String,
              let bits = attrs[kSecAttrKeySizeInBits] as? Int,
              let header = asn1Header(type: type, bits: bits) else { return nil }
        return Data(SHA256.hash(data: header + raw)).base64EncodedString()
    }

    private static func asn1Header(type: String, bits: Int) -> Data? {
        switch (type, bits) {
        case (kSecAttrKeyTypeRSA as String, 2048):
            return Data([0x30, 0x82, 0x01, 0x22, 0x30, 0x0D, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D,
                         0x01, 0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x01, 0x0F, 0x00])
        case (kSecAttrKeyTypeRSA as String, 4096):
            return Data([0x30, 0x82, 0x02, 0x22, 0x30, 0x0D, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D,
                         0x01, 0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x02, 0x0F, 0x00])
        case (kSecAttrKeyTypeECSECPrimeRandom as String, 256):
            return Data([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01, 0x06,
                         0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00])
        case (kSecAttrKeyTypeECSECPrimeRandom as String, 384):
            return Data([0x30, 0x76, 0x30, 0x10, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01, 0x06,
                         0x05, 0x2B, 0x81, 0x04, 0x00, 0x22, 0x03, 0x62, 0x00])
        default:
            return nil // bilinmeyen tür → pin uyuşmaz (güvenli taraf)
        }
    }
}
```

Birim testi: test sertifikasının anahtarını `spkiSHA256` ile hesaplayıp `spki-pin.sh --file` çıktısıyla karşılaştır
(her anahtar türü için bir test).

### 4.5 Flutter aile uygulaması

Dikkat: Dart `dart:io` `HttpClient` kendi TLS yığınını (BoringSSL) kullanır; **Android `network_security_config`
ve iOS `NSPinnedDomains` Dart HTTP isteklerine uygulanmaz**. Ayrıca `badCertificateCallback` yalnız *geçersiz*
sertifikada çağrılır; geçerli ama yanlış anahtarlı (saldırganın aldığı geçerli sertifika) durumu yakalayamaz —
pin için kullanılamaz.

Seçenekler (öncelik sırasıyla):

1. **Platform HTTP yığını:** `cupertino_http` (iOS `URLSession` → `NSPinnedDomains` geçerli) ve Android'de platform
   yığınını kullanan bir istemci (`ok_http`/`cronet_http`; seçilen paketin pin desteği ve NSC'ye uyumu
   doğrulanmalı). Giriş için `flutter_appauth` kullanılırsa token uç noktası çağrısı yerel AppAuth'tan gider;
   §4.1 ve §4.3 o çağrıyı da kapsar (tarayıcı oturumu kapsanmaz; tarayıcıda TLS + HSTS geçerli).
2. **Saf Dart, istek göndermeden önce SPKI denetimi:** `HttpClient.connectionFactory` ile soketi biz açarız, el
   sıkışmadan sonra `peerCertificate.der`'den SPKI'yi çıkarıp özetleriz; uyuşmazsa soket kapatılır, hiçbir bayt
   (token dahil) gönderilmez. Taslak (`asn1lib`, `crypto` paketleri; aile uygulaması deposunda birim testle
   doğrulanmalı):

```dart
const pins = {
  'api.yanimda.app': {'K1_BASE64=', 'K2_BASE64=', 'K3_BASE64='},
  'auth.yanimda.app': {'KA1_BASE64=', 'KA2_BASE64=', 'KA3_BASE64='},
};
final pinsExpire = DateTime.utc(2027, 12, 31);

String spkiSha256(X509Certificate cert) {
  final certSeq = ASN1Parser(cert.der).nextObject() as ASN1Sequence;
  final tbs = certSeq.elements[0] as ASN1Sequence;
  final hasVersion = tbs.elements[0].tag == 0xA0; // [0] EXPLICIT version
  final spki = tbs.elements[hasVersion ? 6 : 5]; // serial, sigAlg, issuer, validity, subject, SPKI
  return base64.encode(sha256.convert(spki.encodedBytes).bytes);
}

HttpClient pinnedHttpClient() {
  final client = HttpClient()..findProxy = (_) => 'DIRECT';
  if (kDebugMode || DateTime.now().toUtc().isAfter(pinsExpire)) return client;
  client.connectionFactory = (uri, proxyHost, proxyPort) async {
    final expected = pins[uri.host];
    final task = await SecureSocket.startConnect(uri.host, uri.port);
    if (expected == null) return task; // pin'siz host: normal TLS
    final checked = task.socket.then((s) {
      final cert = s.peerCertificate;
      if (cert == null || !expected.contains(spkiSha256(cert))) {
        s.destroy();
        pinTelemetry.mismatch(uri.host); // PII yok
        throw const HandshakeException('pin');
      }
      return s;
    });
    return ConnectionTask.fromSocket(checked, task.cancel);
  };
  return client;
}
```

3. Sertifika parmak izi (yaprak sertifikanın tamamının özeti) karşılaştıran paketler **kullanılmaz**: her yenilemede
   (90 gün) pin bozulur.

## 5. Rotasyon prosedürü ve zaman çizelgesi

Pin setini değiştirmek uygulama sürümü gerektirir; bu yüzden anahtar değişimi her zaman **önceden dağıtılmış**
yedeğe yapılır.

| Zaman | Adım | Sorumlu |
| --- | --- | --- |
| T−0 (ilk sürüm) | K1 sunucuda; K2, K3 çevrimdışı üretilir. Uygulama pin'leri {K1, K2, K3}, süre sonu = +12 ay. | Altyapı + mobil |
| Her sürüm | Süre sonu yeniden +12 aya çekilir. CI: ≥ 2 pin, süre sonu ≥ bugün + 90 gün (§7). | Mobil |
| Her sertifika yenilemesi (≈ 60–90 gün) | Aynı anahtarla yenile (`rotationPolicy: Never` / `--reuse-key`). Yenileme sonrası §7 canlı kontrol. | Altyapı |
| Planlı rotasyon (yılda bir veya K1 riskliyse) | (1) Etkin kurulumların ≥ %95'i K2'yi içeren sürümde mi (hepsi T−0'dan beri içerir) — telemetri/mağaza verisi. (2) Staging'de K2'li sertifika, test listesi §8. (3) Üretimde K2'ye geç. (4) Yeni yedek K4 üret; sonraki sürüm pin'leri {K2, K3, K4}. (5) K1'i kullanan sertifika iptal, K1 imha (kayıt altına). | Altyapı + mobil |
| Acil rotasyon (K1 sızdı) | Aynı gün: K2 ile sertifika al, üretime geç, K1 sertifikasını iptal et. 1 hafta içinde {K2, K3, K4} sürümü; `minimum desteklenen sürüm` yükseltilir. | Güvenlik nöbetçisi |
| Yedek de kullanılamaz durumda | Son çare: süre sonu dolmuş eski sürümler TLS'e düşer; daha yeni sürümler zorunlu güncellemeyle düzeltilir. Bu yüzden yedekler iki ayrı yerde. | — |

Uzaktan kapatma (kill switch) kullanılmaz: pin'i kapatan yapılandırma pin'li kanaldan gelirse tam da gerektiği
anda (pin bozukken) ulaşamaz; pin'siz kanaldan gelirse saldırganın hedefi olur. Gerekirse yalnız imzalı (uygulamaya
gömülü açık anahtarla doğrulanan) ve yalnız **önceden gömülü yedek pin setine geçişe** izin veren bir mekanizma
düşünülebilir; v1.0 kapsamında yok.

## 6. Root / jailbreak uyarısı (engel değil)

İlke: yaşlı kullanıcının cihazı root'lu olsa bile koruma çalışmaya devam eder; SOS, düşme ve hareketsizlik akışları
hiçbir koşulda engellenmez. Sonuç yalnız (a) bir kez gösterilen bilgilendirme, (b) PII'siz telemetri.

- **Android / Wear OS:** Play Integrity API (`MEETS_DEVICE_INTEGRITY` yoksa uyarı). Karar token'ı sunucuda
  çözülmelidir (Google API); bu API tarafında yeni iş olur (ör. kayıt sırasında `integrity` alanı) — T-081 kapsamı
  dışında, ayrı görev. O zamana kadar istemci tarafı sezgiler: `su` ikili dosyası (`/system/xbin/su`, `/sbin/su` …),
  `Build.TAGS` içinde `test-keys`, bilinen root yöneticisi paketleri. Wear OS'ta Play Integrity desteği cihaz
  modeline göre doğrulanmalı; yoksa yalnız sezgiler.
- **iOS:** sezgiler: `/Applications/Cydia.app`, `/bin/bash`, `/usr/sbin/sshd`, `/etc/apt` varlığı; sandbox dışına
  (`/private/…`) yazabilme; yüklü dylib adlarında `MobileSubstrate`, `frida`. Simülatörde atlanır.
- **Flutter:** platform kanalıyla yukarıdaki yerel kontroller (ayrı paket bağımlılığı eklemeden önce lisans ve
  bakım durumu değerlendirilmeli).
- Sezgiler kolayca atlatılır; güvenlik kararı (yetkilendirme) buna dayandırılmaz.

### Mesaj kataloğu önerisi

Kullanıcıya gösterilen her metin `packages/messages` kataloğundan gelir (kod biçimi `<kanal önü>-<KONU>[-<n>]`:
`W-` saat, `P-` telefon, `F-` aile, `O-` konsol). Katalog bu görevde **düzenlenmedi**; aşağıdaki anahtarlar
önerilir, metinler 04-ux-ui ve PRD mesaj tablosu sürecinden geçerek eklenir:

| Önerilen anahtar | Kanal | Ne zaman | Taslak metin (onaya tabi) |
| --- | --- | --- | --- |
| `P-SEC-ROOTED` | phone | Eşlikçi açılışında root/jailbreak sezildi, sürüm başına bir kez | "Telefonunuzun güvenlik ayarları değiştirilmiş görünüyor. Yanımda çalışmaya devam ediyor." |
| `F-SEC-ROOTED` | family | Aile uygulamasında aynı durum | "Bu telefonun güvenlik ayarları değiştirilmiş görünüyor. Uygulama çalışmaya devam ediyor." |
| `P-SEC-CONN` | phone | Pin hatası sürüyor (ör. 3 ardışık deneme) | "Güvenli bağlantı kurulamadı. Başka bir internet bağlantısı deneyin." |
| `F-SEC-CONN` | family | Aile uygulamasında aynı durum | "Güvenli bağlantı kurulamadı. Başka bir internet bağlantısı deneyin." |

Saat (`W-`) için yeni metin önerilmez: saatte uyarı gösterilmez, telemetri yeter. Pin hatası anında SOS için mevcut
`P-SOS-QUEUED` metni ve davranışı kullanılır; `P-SEC-CONN` yalnız SOS dışı ekranlarda gösterilir.

## 7. Sürekli kontroller (öneri)

- Mobil depolarda birim test: pin listesi ≥ 2, en az biri canlı anahtar, süre sonu ≥ bugün + 90 gün.
- Zamanlanmış iş (günlük): `scripts/security/spki-pin.sh api.yanimda.app:443` çıktısındaki `[0]` pin'i, yayımdaki
  pin listesinde mi? Değilse alarm (sertifika yenilemesi anahtarı değiştirmiş demektir; uygulamalar bağlanamaz).
- Pin hatası telemetrisi panosu: host ve uygulama sürümüne göre sayaç; ani artış = yanlış yenileme veya MITM.

Telemetri yükü (yalnız bunlar): `{event: "pin_mismatch", host, appVersion, os, osVersion, at}`. Kullanıcı/kişi/cihaz
kimliği, IP, ad, telefon, konum, token, sertifika zinciri **gönderilmez**. Pin'li kanal bozukken gönderilemeyeceği
için yerelde biriktirilir, ilk başarılı bağlantıda iletilir (API'de bunun için uç yok; ayrı görev) ya da
pin'lenmeyen çökme/analitik SDK'sına anonim sayaç olarak.

## 8. Test kontrol listesi

Release derlemesiyle, staging pin setiyle:

- [ ] mitmproxy (Android: köklü emülatörde **sistem** CA'sı olarak yüklü; iOS: profil yüklü ve "tam güven" açık)
      → API ve Keycloak istekleri **başarısız**, uygulama "bağlantı yok" davranışında; çökme yok.
- [ ] Aynı senaryoda SOS → sinyal çevrimdışı kuyrukta (`P-SOS-QUEUED`); proxy kapatılınca idempotencyKey ile
      tek olay olarak iletilir.
- [ ] Debug derlemede mitmproxy (kullanıcı CA'sı) **çalışır** (debug-overrides / `#if DEBUG` / `kDebugMode`).
- [ ] Staging sertifikası yedek anahtar K2 ile yeniden üretildi → release uygulama **bağlanır**.
- [ ] Rastgele anahtarlı geçerli sertifika (pin listesinde yok) → **başarısız** + `pin_mismatch` telemetri kaydı.
- [ ] Telemetri yükünde yalnız §7 alanları var (proxy ile yük incelenir): kimlik, telefon, ad, IP, token yok.
- [ ] `pin-set expiration` geçmiş tarihli test derlemesi → pin denetimi kapalı, TLS doğrulaması açık
      (geçersiz sertifika hâlâ reddedilir).
- [ ] FCM/APNs push, Twilio (varsa), Play Integrity, harita çağrıları pin'den etkilenmiyor.
- [ ] Flutter: Dart HTTP istekleri gerçekten pin'li (yalnız platform yapılandırmasına güvenilmedi), §4.5.
- [ ] Root'lu emülatör / jailbreak'li cihaz: uyarı bir kez görünür, kapatılabilir, SOS/düşme akışı etkilenmez.
- [ ] Root uyarısı ve pin hatası metinleri katalogdan geliyor (sabit metin yok).
