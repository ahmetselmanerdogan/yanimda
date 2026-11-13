import catalog from '@yanimda/messages/tr.json';
import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { DATA_EXPORT_CODES, DATA_EXPORT_FILENAME, dataExportError, exportBlob } from './data-export';

describe('verilerimi indir (T-081, ASVS 8.3.2)', () => {
  it('hata → katalog kodu; 401 oturumu kapatır (yeniden giriş)', () => {
    expect(dataExportError(new ApiError(429))).toEqual({ code: 'F-WEB-ERROR-TOO-MANY', relogin: false });
    expect(dataExportError(new ApiError(401))).toEqual({ code: null, relogin: true });
    expect(dataExportError(new ApiError(403))).toEqual({ code: 'F-WEB-ERROR', relogin: false });
    expect(dataExportError(new Error('ağ'))).toEqual({ code: 'F-WEB-ERROR', relogin: false });
  });

  it('dosya: JSON, okunur girintili, sabit ad', async () => {
    const blob = exportBlob({ format: 'yanimda.data-export.v1', persons: [] });
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe('{\n  "format": "yanimda.data-export.v1",\n  "persons": []\n}\n');
    expect(DATA_EXPORT_FILENAME).toBe('yanimda-data-export.json');
  });

  it('kullanılan her metin katalogda', () => {
    expect(DATA_EXPORT_CODES.filter((c) => !(c in catalog))).toEqual([]);
  });
});
