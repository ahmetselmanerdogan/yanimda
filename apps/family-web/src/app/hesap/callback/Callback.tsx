'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { t } from '@/lib/i18n';
import { completeLogin } from '@/lib/oidc';

export function Callback() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void completeLogin(new URLSearchParams(window.location.search)).then((ok) =>
      ok ? router.replace('/hesap') : setFailed(true),
    );
  }, [router]);
  return failed ? <p className="alert">{t('F-WEB-ERROR')}</p> : null;
}
