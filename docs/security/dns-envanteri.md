# DNS envanteri ve alt alan adı devralma koruması

T-081, ASVS 10.3.3. Tarih: 2026-11-13. Alt alan adı devralma: bir DNS kaydı artık bizim olmayan bir kaynağa
(serbest bırakılmış IP, silinmiş bulut kovası, kapatılmış SaaS hesabı) işaret ederken başkasının o kaynağı alıp
bizim adımızla içerik sunması. Sonuç: oltalama (`auth.` taklidi), çerez / CSP güveninin kötüye kullanımı, ACME ile
geçerli sertifika.

## 1. Envanter (kaynak gerçek)

Genel DNS **yalnız Terraform** ile yönetilir: `infra/terraform/modules/yanimda-env/main.tf`
(`huaweicloud_dns_recordset.app`), ad listesi `var.dns_records`, bölge `var.dns_zone` (ortam başına,
`infra/terraform/envs/<ortam>/`). Konsoldan elle kayıt eklenmez; eklenirse bir sonraki denetimde fark olarak çıkar.

| Ad (`<ad>.<dns_zone>`) | Tür | Hedef | Sunan | Sahiplik kanıtı |
| --- | --- | --- | --- | --- |
| `api` | A | VPS EIP (`huaweicloud_vpc_eip.vps`) | Caddy → API (`infra/caddy/Caddyfile`) | EIP Terraform durumunda |
| `console` | A | aynı EIP | Caddy → konsol | aynı |
| `auth` | A | aynı EIP | Caddy → Keycloak | aynı |
| `aile` | A | aynı EIP | Caddy → aile web | aynı |
| `status` | A | aynı EIP | Caddy → durum sayfası | aynı |

- CNAME yok; üçüncü taraf SaaS'a işaret eden kayıt yok (en yüksek devralma riski bu türdedir). Eklenirse (ör. e-posta
  sağlayıcısı DKIM CNAME'i, harici durum sayfası) bu tabloya sağlayıcı hesabı ve sahibiyle yazılır.
- Mobil uygulama yönlendirme şeması `app.yanimda.family:/oauth2redirect` bir DNS adı değildir (özel URI şeması).
- E-posta (Keycloak SMTP) üretim değerleri repoda yok; SPF / DKIM / DMARC kayıtları eklenince bu tabloya girer.

## 2. Kurallar

1. **Sökme sırası:** önce DNS kaydı kaldırılır (`dns_records`'tan çıkar → `terraform apply`), sonra arkasındaki kaynak
   (EIP, kova, SaaS hesabı). EIP serbest bırakılmadan önce ona işaret eden kayıt kalmadığı denetlenir.
2. EIP, `huaweicloud_vpc_eip` ile ayrılmış sabit adrestir; VPS yeniden kurulsa da aynı EIP bağlanır
   (`huaweicloud_compute_eip_associate`). EIP silinmesi gereken her değişiklik PR'da "DNS etkisi" ile işaretlenir.
3. Joker (wildcard) kayıt kullanılmaz.
4. Bölge başına CAA kaydı önerilir (yalnız Caddy'nin kullandığı ACME CA'ları: Let's Encrypt, ZeroSSL) — açık iş N-1.
5. Bilinmeyen `Host` başlığı: Caddy yalnız tanımlı adlara hizmet eder; tanımsız ada sertifika almaz.

## 3. Aylık denetim (ve her altyapı değişikliğinden sonra)

Sorumlu: altyapı nöbetçisi. Sonuç bilete yazılır.

```sh
cd infra/terraform/envs/<ortam>
terraform plan -detailed-exitcode            # 0 = DNS dahil sapma yok; 2 = elle değişiklik var → incele
EIP=$(terraform output -raw vps_public_ip)    # envs/<ortam>/outputs.tf
for n in api console auth aile status; do
  ip=$(dig +short A "$n.$DOMAIN" @8.8.8.8 | tail -1)
  [ "$ip" = "$EIP" ] || echo "UYARI $n.$DOMAIN -> '${ip:-yok}' (beklenen $EIP)"
done
# Bölgedeki TÜM kayıtlar (Terraform dışı kayıt var mı): sağlayıcı konsolu / API ile dışa aktar, §1 ile karşılaştır.
```

Ek denetimler:

- `dig CNAME` ile bölgede CNAME olmadığı (veya §1'deki listede olduğu) doğrulanır; her CNAME hedefinin hâlâ bizim
  hesabımızda olduğu sağlayıcı panelinden kontrol edilir.
- Sertifika şeffaflığı (crt.sh) sorgusu: `%.<dns_zone>` için son 30 günde bizim almadığımız sertifika var mı.
- Blackbox sondaları (`infra/monitoring/targets/blackbox-*.yml`) her genel adı 15 sn'de bir dener; TLS / HTTP
  hatası uyarı üretir (`infra/monitoring/alerts.yml`: `probe_success == 0`, `TlsCertExpiringSoon`). Bir ad sondaya eklenmeden genel DNS'e girmez.

## 4. Bulgu olursa

1. Kaydı hemen kaldır veya bizim kaynağımıza çevir (Terraform; acilse sağlayıcı konsolu + aynı gün Terraform'a işle).
2. crt.sh ile o ada alınmış sertifikaları listele; gerekiyorsa CA'ya iptal başvurusu.
3. O alt alan altında oturum çerezi / OIDC yönlendirme izni var mı denetle (`redirectUris`, `webOrigins`, G-20).
4. Olay kaydı; etki varsa `sirlar.md` sızıntı müdahalesi.

## Açık işler

| # | İş |
| --- | --- |
| N-1 | CAA kaydı (Terraform `huaweicloud_dns_recordset`, tür CAA) |
| N-2 | §3 betiğini zamanlanmış işe çevir (CI `schedule` + bulut salt-okunur anahtarı) |
| N-3 | Üretim ortamı (`envs/prod`) eklenince §1 tablosunu üretim bölgesiyle doldur |
