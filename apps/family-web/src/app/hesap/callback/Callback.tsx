'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { t } from '@/lib/i18n';
import { completeLogin, takeReturnPath } from '@/lib/oidc';

export function Callback() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // Ağ hatası / bozuk yanıt da (reddedilen söz) "giriş tamamlanamadı" gösterir; boş sayfada kalınmaz.
    void completeLogin(new URLSearchParams(window.location.search)).then(
      (ok) => (ok ? router.replace(takeReturnPath()) : setFailed(true)),
      () => setFailed(true),
    );
  }, [router]);
  return failed ? (
    <p className="alert" role="alert">
      {t('F-WEB-ERROR')}
    </p>
  ) : null;
}
