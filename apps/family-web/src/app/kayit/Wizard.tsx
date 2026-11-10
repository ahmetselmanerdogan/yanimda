'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { Field } from '@/components/Field';
import { Steps } from '@/components/Steps';
import { api, ApiError, type Plan, type PlansResponse } from '@/lib/api';
import { openCheckout } from '@/lib/checkout';
import {
  type AccountForm,
  type Country,
  errorCode,
  type FieldErrors,
  formatPrice,
  normalizePhone,
  validateAccount,
} from '@/lib/flow';
import { t } from '@/lib/i18n';
import { loadSession, saveSession, type SignupSession } from '@/lib/session';

type Stage = 'plan' | 'account' | 'phone' | 'payment';

const emptyForm: AccountForm = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  elderName: '',
  kvkkRead: false,
  explicitConsent: false,
};

const codeOf = (e: unknown, step: Parameters<typeof errorCode>[1]) =>
  e instanceof ApiError ? errorCode(e.status, step) : 'F-WEB-ERROR';

/**
 * C-01 web abonelik sihirbazı: (1) paket → (2) hesap + telefon doğrulama + ödeme → (3) /kayit/tamam.
 * Parola burada sorulmaz: Keycloak e-postadaki bağlantıyla e-posta doğrulatıp parola belirletir.
 */
export function Wizard() {
  const router = useRouter();
  const params = useSearchParams();
  const [country, setCountry] = useState<Country>('TR');
  const [plans, setPlans] = useState<PlansResponse | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [stage, setStage] = useState<Stage>('plan');
  const [form, setForm] = useState<AccountForm>(emptyForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<SignupSession | null>(null);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | undefined>();
  const [billing, setBilling] = useState({ city: '', address: '' });
  const checkoutRef = useRef<HTMLDivElement>(null);

  // Ödeme sayfasından dönüş (iptal / hata): oturum varsa doğrudan ödeme adımı.
  useEffect(() => {
    const s = loadSession();
    if (s && params.get('sub') === s.subscriptionId) {
      setSession(s);
      setCountry(s.country);
      setStage(s.phoneVerified ? 'payment' : 'phone');
      if (params.get('hata')) setError('F-WEB-PAY-FAILED');
    }
  }, [params]);

  useEffect(() => {
    let live = true;
    setPlans(null);
    api
      .plans(country)
      .then((p) => live && setPlans(p))
      .catch(() => live && setError('F-WEB-ERROR'));
    return () => {
      live = false;
    };
  }, [country]);

  const set = <K extends keyof AccountForm>(k: K, v: AccountForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function submitAccount(e: FormEvent) {
    e.preventDefault();
    const errs = validateAccount(form, country);
    setErrors(errs);
    if (Object.keys(errs).length || !plan || !plans) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.signup({
        plan: plan.code,
        country,
        account: {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim(),
          phone: normalizePhone(form.phone, country),
        },
        protectedPerson: { displayName: form.elderName.trim() },
        consents: { kvkkNoticeVersion: plans.kvkkNoticeVersion, explicitConsent: form.explicitConsent },
      });
      const s: SignupSession = {
        subscriptionId: r.subscriptionId,
        protectedPersonId: r.protectedPersonId,
        token: r.signupToken,
        trialEndsAt: r.trialEndsAt,
        country,
        phoneVerified: false,
      };
      saveSession(s);
      setSession(s);
      setDevCode(r.devCode);
      setStage('phone');
    } catch (err) {
      setError(codeOf(err, 'signup'));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await api.verifyPhone(session.subscriptionId, session.token, code.trim());
      const s = { ...session, phoneVerified: true };
      saveSession(s);
      setSession(s);
      setStage('payment');
    } catch (err) {
      setError(codeOf(err, 'verify'));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!session) return;
    setError(null);
    try {
      setDevCode((await api.resendCode(session.subscriptionId, session.token)).devCode);
    } catch (err) {
      setError(codeOf(err, 'other'));
    }
  }

  async function pay(e: FormEvent) {
    e.preventDefault();
    if (!session) return;
    if (session.country === 'TR' && (!billing.city.trim() || !billing.address.trim())) {
      setError('F-WEB-ERROR-INVALID');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const s = await api.checkout(
        session.subscriptionId,
        session.token,
        session.country === 'TR' ? { city: billing.city.trim(), address: billing.address.trim() } : undefined,
      );
      openCheckout(s, checkoutRef.current);
      if (s.kind === 'embed') setBusy(false);
    } catch (err) {
      setError(codeOf(err, 'checkout'));
      setBusy(false);
    }
  }

  return (
    <>
      <h1>{t('F-WEB-TITLE')}</h1>
      <Steps current={stage === 'plan' ? 1 : 2} />
      {error && (
        <p className="alert" role="alert">
          {t(error)}
        </p>
      )}

      {stage === 'plan' && (
        <section aria-labelledby="plan-h">
          <h2 id="plan-h">{t('F-WEB-STEP-1')}</h2>
          <label htmlFor="country">{t('F-WEB-COUNTRY')}</label>
          <select id="country" value={country} onChange={(e) => setCountry(e.target.value as Country)}>
            <option value="TR">{t('F-WEB-COUNTRY-TR')}</option>
            <option value="US">{t('F-WEB-COUNTRY-US')}</option>
          </select>
          {plans && (
            <>
              <p>{t('F-WEB-TRIAL', { days: plans.trialDays })}</p>
              {plans.plans.map((p) => (
                <div className="card" key={p.code}>
                  <h3>{t(p.nameCode)}</h3>
                  <p className="price">
                    {formatPrice(p.amountMinor, p.currency, country === 'US' ? 'en-US' : 'tr-TR')}
                    <span className="muted"> {t(`F-WEB-PER-${p.interval}`)}</span>
                  </p>
                  <p className="muted">{t('F-WEB-PLAN-INCLUDES')}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setPlan(p);
                      setStage('account');
                    }}
                  >
                    {t('F-WEB-CHOOSE')}
                  </button>
                </div>
              ))}
              {plans.plans.some((p) => p.placeholder) && <p className="muted">{t('F-WEB-PRICE-PLACEHOLDER')}</p>}
            </>
          )}
        </section>
      )}

      {stage === 'account' && plan && (
        <form onSubmit={submitAccount} noValidate aria-labelledby="acc-h">
          <h2 id="acc-h">{t('F-WEB-ACCOUNT')}</h2>
          <p className="muted">
            {t(plan.nameCode)} · {formatPrice(plan.amountMinor, plan.currency, country === 'US' ? 'en-US' : 'tr-TR')}{' '}
            {t(`F-WEB-PER-${plan.interval}`)}
          </p>
          <Field
            id="firstName"
            label={t('F-WEB-FIRST-NAME')}
            autoComplete="given-name"
            value={form.firstName}
            error={errors.firstName}
            onChange={(e) => set('firstName', e.target.value)}
            type="text"
          />
          <Field
            id="lastName"
            label={t('F-WEB-LAST-NAME')}
            autoComplete="family-name"
            value={form.lastName}
            error={errors.lastName}
            onChange={(e) => set('lastName', e.target.value)}
            type="text"
          />
          <Field
            id="email"
            label={t('F-WEB-EMAIL')}
            type="email"
            autoComplete="email"
            value={form.email}
            error={errors.email}
            onChange={(e) => set('email', e.target.value)}
          />
          <Field
            id="phone"
            label={t('F-WEB-PHONE')}
            type="tel"
            autoComplete="tel"
            hint={t('F-WEB-PHONE-HINT')}
            value={form.phone}
            error={errors.phone}
            onChange={(e) => set('phone', e.target.value)}
          />
          <h2>{t('F-WEB-ELDER')}</h2>
          <Field
            id="elderName"
            label={t('F-WEB-ELDER-NAME')}
            type="text"
            value={form.elderName}
            error={errors.elderName}
            onChange={(e) => set('elderName', e.target.value)}
          />
          <p className="alert">{t('F-WEB-LEGAL-PENDING')}</p>
          <label className="check">
            <input type="checkbox" checked={form.kvkkRead} onChange={(e) => set('kvkkRead', e.target.checked)} />
            <span>
              <Link href="/kvkk#aydinlatma" target="_blank">
                {t('F-WEB-KVKK-NOTICE')}
              </Link>
              {' — '}
              {t('F-WEB-KVKK-READ')}
            </span>
          </label>
          {errors.kvkkRead && <p className="error">{t(errors.kvkkRead)}</p>}
          <label className="check">
            <input
              type="checkbox"
              checked={form.explicitConsent}
              onChange={(e) => set('explicitConsent', e.target.checked)}
            />
            <span>
              <Link href="/kvkk#acik-riza" target="_blank">
                {t('F-WEB-CONSENT-TEXT')}
              </Link>
              {' — '}
              {t('F-WEB-CONSENT')}
            </span>
          </label>
          {errors.explicitConsent && <p className="error">{t(errors.explicitConsent)}</p>}
          <div className="row">
            <button type="button" className="secondary" onClick={() => setStage('plan')}>
              {t('F-WEB-BACK')}
            </button>
            <button type="submit" disabled={busy}>
              {t('F-WEB-CREATE-ACCOUNT')}
            </button>
          </div>
        </form>
      )}

      {stage === 'phone' && session && (
        <form onSubmit={verify} aria-labelledby="ph-h">
          <h2 id="ph-h">{t('F-WEB-PHONE')}</h2>
          <p className="alert ok">{t('F-WEB-EMAIL-SENT')}</p>
          <p>{t('F-WEB-PHONE-CODE-SENT', { phone: normalizePhone(form.phone, country) || '' })}</p>
          {devCode && <p className="muted">{t('F-WEB-DEV-CODE', { code: devCode })}</p>}
          <Field
            id="code"
            label={t('F-WEB-PHONE-CODE')}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <div className="row">
            <button type="submit" disabled={busy || code.length !== 6}>
              {t('F-WEB-PHONE-VERIFY')}
            </button>
            <button type="button" className="secondary" onClick={resend}>
              {t('F-WEB-PHONE-RESEND')}
            </button>
          </div>
        </form>
      )}

      {stage === 'payment' && session && (
        <form onSubmit={pay} aria-labelledby="pay-h">
          <h2 id="pay-h">{t('F-WEB-STEP-2')}</h2>
          <p className="alert ok">{t('F-WEB-PHONE-OK')}</p>
          {session.country === 'TR' && (
            <>
              <h3>{t('F-WEB-BILLING')}</h3>
              <Field
                id="city"
                label={t('F-WEB-BILLING-CITY')}
                type="text"
                autoComplete="address-level1"
                value={billing.city}
                onChange={(e) => setBilling((b) => ({ ...b, city: e.target.value }))}
              />
              <Field
                id="address"
                label={t('F-WEB-BILLING-ADDRESS')}
                type="text"
                autoComplete="street-address"
                value={billing.address}
                onChange={(e) => setBilling((b) => ({ ...b, address: e.target.value }))}
              />
            </>
          )}
          <p className="muted">{t('F-WEB-PAY-SECURE')}</p>
          <div className="row">
            <button type="submit" disabled={busy}>
              {t('F-WEB-PAY')}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => router.push(`/kayit/tamam?sub=${session.subscriptionId}`)}
            >
              {t('F-WEB-PAY-LATER')}
            </button>
          </div>
          {/* iyzico Checkout Form buraya yerleşir */}
          <div id="iyzipay-checkout-form" className="responsive" ref={checkoutRef} />
        </form>
      )}
    </>
  );
}
