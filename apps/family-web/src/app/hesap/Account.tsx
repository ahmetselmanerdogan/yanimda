'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Members } from '@/components/Members';
import { api, ApiError } from '@/lib/api';
import { openCheckout } from '@/lib/checkout';
import { dataExportError, exportBlob, saveBlob } from '@/lib/data-export';
import { cancellable, errorCode, needsPayment, statusLine, type SubscriptionView } from '@/lib/flow';
import { t } from '@/lib/i18n';
import type { MemberRole } from '@/lib/members';
import { accessToken, login, logout } from '@/lib/oidc';

interface Item {
  personId: string;
  name: string;
  owner: boolean;
  myRole: MemberRole | null;
  sub: SubscriptionView | null;
}

/**
 * "Aboneliğim": durum, tek tık iptal (koruma hemen kapanır), ödemeyi tamamla; kişi başına "Aile üyeleri" (T-040).
 * Giriş: consumers realm PKCE.
 */
export function Account() {
  const [token, setToken] = useState<string | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [billing, setBilling] = useState({ city: '', address: '' });
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async (at: string) => {
    try {
      const persons = await api.persons(at);
      setItems(
        await Promise.all(
          persons.items.map(async (p) => ({
            personId: p.id,
            name: p.displayName,
            owner: p.myRole === 'OWNER',
            myRole: p.myRole === 'OWNER' || p.myRole === 'MEMBER' ? p.myRole : null,
            sub: await api.subscription(at, p.id).catch(() => null),
          })),
        ),
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setToken(null);
      else setError('F-WEB-ERROR');
    }
  }, []);

  useEffect(() => {
    const at = accessToken();
    setToken(at);
    if (at) void load(at);
  }, [load]);

  async function cancel(it: Item) {
    if (!token || !window.confirm(t('F-WEB-CANCEL-CONFIRM'))) return;
    setBusy(it.personId);
    setError(null);
    try {
      const sub = await api.cancel(token, it.personId);
      setItems((xs) => xs?.map((x) => (x.personId === it.personId ? { ...x, sub } : x)) ?? null);
      setNotice('F-WEB-CANCELED');
    } catch (e) {
      setError(e instanceof ApiError ? errorCode(e.status, 'cancel') : 'F-WEB-ERROR');
    } finally {
      setBusy(null);
    }
  }

  /** T-081 (ASVS 8.3.2, KVKK m.11): hesabın ve kişilerinin verisi tek JSON dosyası. */
  async function exportData() {
    if (!token) return;
    setBusy('export');
    setError(null);
    setNotice(null);
    try {
      saveBlob(exportBlob(await api.dataExport(token)));
      setNotice('F-WEB-DATA-EXPORT-DONE');
    } catch (e) {
      const r = dataExportError(e);
      if (r.relogin) setToken(null);
      else setError(r.code);
    } finally {
      setBusy(null);
    }
  }

  async function pay(it: Item) {
    if (!token || !it.sub) return;
    const tr = it.sub.countryCode === 'TR';
    if (tr && (!billing.city.trim() || !billing.address.trim())) {
      setError('F-WEB-ERROR-INVALID');
      return;
    }
    setBusy(it.personId);
    setError(null);
    try {
      openCheckout(
        await api.checkoutForPerson(
          token,
          it.personId,
          tr ? { city: billing.city, address: billing.address } : undefined,
        ),
        box.current,
      );
    } catch (e) {
      setError(e instanceof ApiError ? errorCode(e.status, 'checkout') : 'F-WEB-ERROR');
    } finally {
      setBusy(null);
    }
  }

  if (!token)
    return (
      <>
        <h1>{t('F-WEB-ACCOUNT-PAGE')}</h1>
        <button type="button" onClick={() => void login()}>
          {t('F-WEB-LOGIN')}
        </button>
      </>
    );

  return (
    <>
      <h1>{t('F-WEB-ACCOUNT-PAGE')}</h1>
      {error && (
        <p className="alert" role="alert">
          {t(error)}
        </p>
      )}
      {notice && (
        <p className="alert ok" role="status">
          {t(notice)}
        </p>
      )}
      {items?.length === 0 && <p>{t('F-WEB-NO-SUBSCRIPTION')}</p>}
      {items?.map((it) => {
        const line = it.sub ? statusLine(it.sub) : null;
        return (
          <section className="card" key={it.personId} aria-label={it.name}>
            <h2>{it.name}</h2>
            {line ? <p>{t(line.code, line.vars)}</p> : <p>{t('F-WEB-NO-SUBSCRIPTION')}</p>}
            {it.owner && it.sub && needsPayment(it.sub) && (
              <>
                {it.sub.countryCode === 'TR' && (
                  <>
                    <label htmlFor={`city-${it.personId}`}>{t('F-WEB-BILLING-CITY')}</label>
                    <input
                      id={`city-${it.personId}`}
                      type="text"
                      value={billing.city}
                      onChange={(e) => setBilling((b) => ({ ...b, city: e.target.value }))}
                    />
                    <label htmlFor={`addr-${it.personId}`}>{t('F-WEB-BILLING-ADDRESS')}</label>
                    <input
                      id={`addr-${it.personId}`}
                      type="text"
                      value={billing.address}
                      onChange={(e) => setBilling((b) => ({ ...b, address: e.target.value }))}
                    />
                  </>
                )}
                <div className="row">
                  <button type="button" disabled={busy === it.personId} onClick={() => void pay(it)}>
                    {t('F-WEB-COMPLETE-PAYMENT')}
                  </button>
                </div>
              </>
            )}
            {it.owner && it.sub && cancellable(it.sub) && (
              <div className="row">
                <button
                  type="button"
                  className="danger"
                  disabled={busy === it.personId}
                  onClick={() => void cancel(it)}
                >
                  {t('F-WEB-CANCEL')}
                </button>
              </div>
            )}
            <Members
              token={token}
              personId={it.personId}
              myRole={it.myRole}
              onLeft={() => {
                setItems((xs) => xs?.filter((x) => x.personId !== it.personId) ?? null);
                setNotice('F-WEB-MEMBERS-REMOVED');
              }}
              onUnauthorized={() => setToken(null)}
            />
          </section>
        );
      })}
      <div id="iyzipay-checkout-form" className="responsive" ref={box} />
      <section className="card" aria-labelledby="data-export-title">
        <h2 id="data-export-title">{t('F-WEB-DATA-EXPORT')}</h2>
        <p>{t('F-WEB-DATA-EXPORT-HINT')}</p>
        <div className="row">
          <button type="button" className="secondary" disabled={busy === 'export'} onClick={() => void exportData()}>
            {t('F-WEB-DATA-EXPORT')}
          </button>
        </div>
      </section>
      <div className="row">
        <Link href="/hesap/davet" className="button secondary">
          {t('F-WEB-MEMBERS-HAVE-CODE')}
        </Link>
        <button type="button" className="secondary" onClick={logout}>
          {t('F-WEB-LOGOUT')}
        </button>
      </div>
    </>
  );
}
