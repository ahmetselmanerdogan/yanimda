'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';

import { Field } from '@/components/Field';
import { api, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { memberErrorCode, normalizeMemberCode } from '@/lib/members';
import { accessToken, login } from '@/lib/oidc';

/** T-040 aile davetini kabul (C-02): hesap sahibinin ilettiği kodu giren aile hesabı "Aile üyesi" olur. */
export function Accept() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setToken(accessToken());
    setReady(true);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    const normalized = normalizeMemberCode(code);
    if (!normalized) {
      setError('F-MEMBER-CODE-INVALID');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.acceptMemberInvite(token, normalized);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setToken(null);
      else setError(memberErrorCode(err, 'accept'));
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <h1>{t('F-WEB-MEMBERS-ACCEPT-TITLE')}</h1>;

  if (!token)
    return (
      <>
        <h1>{t('F-WEB-MEMBERS-ACCEPT-TITLE')}</h1>
        <button type="button" onClick={() => void login('/hesap/davet')}>
          {t('F-WEB-LOGIN')}
        </button>
      </>
    );

  if (done)
    return (
      <>
        <h1>{t('F-WEB-MEMBERS-ACCEPT-TITLE')}</h1>
        <p className="alert ok" role="status">
          {t('F-WEB-MEMBERS-ACCEPTED')}
        </p>
        <div className="row">
          <Link href="/hesap" className="button">
            {t('F-WEB-MEMBERS-TO-ACCOUNT')}
          </Link>
        </div>
      </>
    );

  return (
    <>
      <h1>{t('F-WEB-MEMBERS-ACCEPT-TITLE')}</h1>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <Field
          id="member-code"
          label={t('F-WEB-MEMBERS-ACCEPT-CODE')}
          hint={t('F-WEB-MEMBERS-ACCEPT-HINT')}
          error={error ?? undefined}
          type="text"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={20}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <div className="row">
          <button type="submit" disabled={busy}>
            {t('F-WEB-MEMBERS-ACCEPT')}
          </button>
          <Link href="/hesap" className="button secondary">
            {t('F-WEB-MEMBERS-TO-ACCOUNT')}
          </Link>
        </div>
      </form>
    </>
  );
}
