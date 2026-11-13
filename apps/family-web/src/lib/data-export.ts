import { ApiError } from './api';

/**
 * T-081 (ASVS 8.3.2, KVKK m.11) "Verilerimi indir": GET /v1/family/data-export yanıtını dosya olarak kaydeder.
 * Saf yardımcılar (birim testli); indirme tetikleyicisi Account.tsx'te. Dosya içeriği log'lanmaz, saklanmaz.
 */

/** API'nin Content-Disposition adıyla aynı (teknik tanımlayıcı, metin değil). */
export const DATA_EXPORT_FILENAME = 'yanimda-data-export.json';

/** Bu özelliğin kullandığı katalog kodları (test: hepsi katalogda). */
export const DATA_EXPORT_CODES = [
  'F-WEB-DATA-EXPORT',
  'F-WEB-DATA-EXPORT-HINT',
  'F-WEB-DATA-EXPORT-DONE',
  'F-WEB-ERROR',
  'F-WEB-ERROR-TOO-MANY',
] as const;

/** Hata → katalog kodu; 401 → yeniden giriş (token süresi 5 dk, yenileme yok). */
export function dataExportError(e: unknown): { code: string | null; relogin: boolean } {
  if (e instanceof ApiError && e.status === 401) return { code: null, relogin: true };
  if (e instanceof ApiError && e.status === 429) return { code: 'F-WEB-ERROR-TOO-MANY', relogin: false };
  return { code: 'F-WEB-ERROR', relogin: false };
}

/** İndirilecek dosya: okunur girintili JSON. */
export function exportBlob(data: unknown): Blob {
  return new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
}

/** Tarayıcıda dosyayı kaydettirir (geçici nesne URL'si hemen bırakılır). */
export function saveBlob(blob: Blob, filename = DATA_EXPORT_FILENAME): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
