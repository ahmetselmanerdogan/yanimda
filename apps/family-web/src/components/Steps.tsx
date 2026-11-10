import { t } from '@/lib/i18n';

/** 3 adım göstergesi (C-01: paket → hesap + ödeme → uygulamayı indir). */
export function Steps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <>
      <p className="muted">{t('F-WEB-STEP-OF', { n: current })}</p>
      <ol className="steps">
        {([1, 2, 3] as const).map((n) => (
          <li key={n} className={n < current ? 'done' : undefined} aria-current={n === current ? 'step' : undefined}>
            {t(`F-WEB-STEP-${n}`)}
          </li>
        ))}
      </ol>
    </>
  );
}
