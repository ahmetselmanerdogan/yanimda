# Karar: 2026-11-11 gece geliştirme sırası (iki model tartışması)

Kullanıcı isteği: çağrı merkezi ve yönetim panelleri tam kapsamlı (kim kime cevap vermiş, ses kayıtları, analiz), 112
bildirim / intikal / süreç takibi, düzenli "yanınızdayız" aramaları, web + mobil uyum; algoritma üst düzey.

Yöntem: iki bağımsız model (Fable 5.1, Opus 5.5) aynı kodu (salt okuma) inceledi, önerdi, sonra birbirinin önerisini
eleştirip birleşik liste verdi. Aşağıdaki sıra iki nihai listenin ortak kesişimidir; ayrıştıkları yerde gerekçeli seçim
yazıldı.

## Ortak bulgular (kodda doğrulandı)
- Acil kapanış 112 aranmadan `DISPATCH` geçişi yapıyordu → sahte 112 süreci, aileye "ambulans yolda", sonsuz uyarı.
- 112 takip zamanlayıcısı commit'ten sonra kuruluyordu; tekrar teslimde bir daha kurulmuyordu (sessiz kayıp).
- Amir uyarıları uçucu (yalnız birkaç saniyelik konsol vurgusu, herkese yayın), kalıcı kayıt / "gördüm" yok.
- Tüm öncelikler için tek üstlenme eşiği (10 sn); P1 kuyrukta beklerken aktif uyarı yok.
- Düzenli arama başlatma atomik değil; kişinin açık (SOS) olayına eklenebiliyor; görüşme sürerken "kaçırıldı" yazılabiliyor;
  aynı dakikaya yığılma; ulaşılamayana yeniden deneme ve aile bildirimi yok.
- Panelde operatör adı yok, kayıt dinleme gerekçesi sunucuda zorunlu değil, test olayları analize karışıyor; olay dosyası ve
  bildirim teslim kanıtı yok.

## Sıra
1. 112 doğruluk + güvenilirlik (DISPATCH yalnız 112 arandıysa; test olayında süreç yok; zamanlayıcı işlemle; tahmini varışa
   göre bekleme, en çok 3 uyarı sonra `O-DISPATCH-ESCALATE`; nakil / hastane ayrı bildirim; liste en yeni önce).
2. Kalıcı amir uyarıları + "gördüm" + öncelik bazlı üstlenme SLA'sı. **Seçim:** Fable — olay başına zamanlayıcı yerine mevcut
   tarama; Opus'un P1 10 / P2 30 / P3 120 / P4 600 eşikleri.
3. Düzenli arama güvenilirliği + kapasiteye göre yayılma (Opus) + SKIPPED kuralları (Fable).
4. Ulaşılamayan düzenli arama: tek yeniden deneme, sonra aileye bildirim; aile okuma ucu.
5. Panel doğruluğu.
6. Olay dosyası (vaka) + bildirim teslim kanıtı.
7. 112 takip araması (zaman kalırsa).
8. Yanınızdayız konuşma metni (aile web plan formu kapsam dışı — Opus gerekçesi: abonelik sitesi).

## Yapılmayacaklar (iki modelin ortak listesi)
Makine öğrenmesi risk puanı veya kuyrukta yeniden sıralama; otomatik operatör ataması; gerçek taşma / 112 API / ses dökümü;
Kafka; eski migration değişikliği.
