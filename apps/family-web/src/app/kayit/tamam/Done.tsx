'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Steps } from '@/components/Steps';
import { api } from '@/lib/api';
import { formatDate, type SubscriptionView } from '@/lib/flow';
import { t } from '@/lib/i18n';
import { loadSession } from '@/lib/session';

const APP_STORE = process.env.NEXT_PUBLIC_APP_STORE_URL;
const PLAY_STORE = process.env.NEXT_PUBLIC_PLAY_STORE_URL;

/** Adım 3: durum (ödeme onayı webhook'la gelir; kısa süre yoklanır) ve uygulamayı indir. */
export function Done() {
  const params = useSearchParams();
  const [view, setView] = useState<SubscriptionView | null>(null);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    const s = loadSession();
    const sub = params.get('sub');
    if (!s || s.subscriptionId !== sub) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const v = await api.signupStatus(s.subscriptionId, s.token);
        setView(v);
        // Sağlayıcıya gidildi ama onay henüz gelmedi: 20 sn'ye kadar bekle.
        const pending = v.status === 'TRIAL' && v.provider !== null && !v.paymentMethodOnFile;
        setWaiting(pending && tries < 10);
        if (pending && tries++ < 10) timer = setTimeout(poll, 2000);
      } catch {
        setWaiting(false);
      }
    };
    void poll();
    return () => clearTimeout(timer);
  }, [params]);

  return (
    <>
      <h1>{t('F-WEB-DONE')}</h1>
      <Steps current={3} />
      {waiting && <p className="alert">{t('F-WEB-PAY-WAITING')}</p>}
      {view?.status === 'ACTIVE' && <p className="alert ok">{t('F-WEB-DONE-ACTIVE')}</p>}
      {view?.status === 'TRIAL' && !waiting && (
        <p className="alert ok">{t('F-WEB-DONE-TRIAL', { date: formatDate(view.trialEndsAt) })}</p>
      )}
      <p>{t('F-WEB-EMAIL-SENT')}</p>
      <h2>{t('F-WEB-STEP-3')}</h2>
      <p>{t('F-WEB-DOWNLOAD')}</p>
      <div className="row">
        {APP_STORE && (
          <a className="button" href={APP_STORE} rel="noopener">
            {t('F-WEB-STORE-IOS')}
          </a>
        )}
        {PLAY_STORE && (
          <a className="button" href={PLAY_STORE} rel="noopener">
            {t('F-WEB-STORE-ANDROID')}
          </a>
        )}
      </div>
    </>
  );
}
