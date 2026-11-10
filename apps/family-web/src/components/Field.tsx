import type { InputHTMLAttributes } from 'react';

import { t } from '@/lib/i18n';

/** Etiketli giriş alanı; hata katalog kodu ile. */
export function Field({
  id,
  label,
  error,
  hint,
  ...input
}: { id: string; label: string; error?: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <input id={id} name={id} aria-invalid={!!error} aria-describedby={describedBy} {...input} />
      {hint && (
        <p id={`${id}-hint`} className="muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="error" role="alert">
          {t(error)}
        </p>
      )}
    </div>
  );
}
