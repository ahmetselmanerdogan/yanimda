'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { api } from '@/lib/api';
import { t } from '@/lib/i18n';

/** Geliştirme: sahte sağlayıcının ödeme sayfası (PAYMENT_PROVIDER=fake). Gerçek tahsilat yok. */
export function FakeCheckout() {
  const ref = useSearchParams().get('ref') ?? '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const go = async (outcome: 'success' | 'fail') => {
    setBusy(true);
    try {
      window.location.assign((await api.fakePay(ref, outcome)).redirect);
    } catch {
      setError(true);
      setBusy(false);
    }
  };
  return (
    <>
      <h1>{t('F-WEB-FAKE-TITLE')}</h1>
      {error && <p className="alert">{t('F-WEB-ERROR')}</p>}
      <div className="row">
        <button type="button" disabled={busy || !ref} onClick={() => go('success')}>
          {t('F-WEB-FAKE-PAY')}
        </button>
        <button type="button" className="danger" disabled={busy || !ref} onClick={() => go('fail')}>
          {t('F-WEB-FAKE-FAIL')}
        </button>
      </div>
    </>
  );
}
