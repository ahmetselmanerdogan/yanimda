import type { ChainStep } from '@yanimda/contracts';
import { useEffect, useRef, useState } from 'react';

import type { CloseOutcome, QueueItem } from '../lib/api';
import { action, t } from '../lib/i18n';

/** Üst bar: başlık, canlı bağlantı, kuyruk sayısı, yeni olayda yanıp sönme (E-08). */
export function TopBar(p: {
  operator: string;
  online: boolean;
  count: number;
  flash: string | null;
  onLogout(): void;
}) {
  return (
    <header className={`topbar${p.flash ? ' flash' : ''}`}>
      <span className="brand">{t('O-UI-TITLE')}</span>
      <span className={`conn ${p.online ? 'on' : 'off'}`} role="status">
        {p.online ? t('O-UI-ONLINE') : t('O-UI-OFFLINE')}
      </span>
      <span className="count">{t('O-UI-QUEUE', { n: p.count })}</span>
      <span className="flash-text" role="alert">
        {p.flash ?? ''}
      </span>
      <span className="spacer" />
      <span className="muted small">{t('O-UI-SHORTCUTS')}</span>
      <span className="operator">{p.operator}</span>
      <button type="button" onClick={p.onLogout}>
        {t('O-UI-LOGOUT')}
      </button>
    </header>
  );
}

/**
 * Kişi paneli (260 px). Tıbbi özet yalnız olay açıkken gelir (T-040 sağlık şeması bağlanınca); kişisel bilgi
 * kopyalanamaz (user-select: none + kopyalama denemesinde uyarı).
 */
export function PersonPanel({ item }: { item: QueueItem | null }) {
  const [warn, setWarn] = useState(false);
  return (
    <aside
      className="person no-copy"
      aria-labelledby="person-title"
      onCopy={(e) => {
        e.preventDefault();
        setWarn(true);
      }}
    >
      <h2 id="person-title">{t('O-UI-PERSON')}</h2>
      {item?.person ? (
        <p className="person-name">
          <strong>{item.person.displayName}</strong>
          {item.person.age !== null && <span> · {t('O-UI-AGE-YEARS', { age: item.person.age })}</span>}
        </p>
      ) : (
        <p className="muted">{t('O-UI-PERSON-UNKNOWN')}</p>
      )}
      <h3>{t('O-UI-MEDICAL')}</h3>
      <p className="muted">{t('O-UI-MEDICAL-NONE')}</p>
      {warn && (
        <p className="warn" role="alert">
          {t('O-UI-COPY-BLOCKED')}
        </p>
      )}
    </aside>
  );
}

/** 05 konuşma metni (katalog O-SCRIPT-*); eksik alan "bilinmiyor". */
export function ScriptPanel(p: {
  step: ChainStep;
  vars: Record<string, string | number | null | undefined>;
  onRead(): void;
}) {
  return (
    <section className="script" aria-labelledby="script-title">
      <h3 id="script-title">{t('O-UI-SCRIPT')}</h3>
      <p>{t(p.step.script!, p.vars)}</p>
      {p.step.kind === 'CALL_112' && (
        <button type="button" onClick={p.onRead} disabled={!!p.step.scriptReadAt}>
          {t('O-UI-SCRIPT-READ')}
        </button>
      )}
    </section>
  );
}

const OUTCOMES: CloseOutcome[] = ['OK', 'FALSE_ALARM', 'UNREACHABLE', 'TEST', 'EMERGENCY'];

/** E-07 kapatma: sonuç zorunlu, not ≤ 2000. Acil teyitli olay yalnız EMERGENCY ile. */
export function ClosePanel(p: {
  allowed: CloseOutcome[];
  initialNote: string;
  busy: boolean;
  onSubmit(outcome: CloseOutcome, note: string): void;
  onCancel(): void;
}) {
  const choices = OUTCOMES.filter((o) => p.allowed.includes(o));
  const [outcome, setOutcome] = useState<CloseOutcome | null>(choices.length === 1 ? choices[0]! : null);
  const [note, setNote] = useState(p.initialNote);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <div className="dialog-backdrop">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (outcome) p.onSubmit(outcome, note.trim());
        }}
      >
        <h2 id="close-title">{t('O-UI-CLOSE')}</h2>
        <fieldset>
          <legend>{t('O-UI-OUTCOME')}</legend>
          {choices.map((o, i) => (
            <label key={o} className="radio">
              <input
                ref={i === 0 ? first : undefined}
                type="radio"
                name="outcome"
                value={o}
                checked={outcome === o}
                onChange={() => setOutcome(o)}
              />
              {t(`O-OUT-${o}`)}
            </label>
          ))}
        </fieldset>
        <label htmlFor="close-note">{t('O-UI-NOTE')}</label>
        <textarea id="close-note" value={note} maxLength={2000} rows={3} onChange={(e) => setNote(e.target.value)} />
        <div className="row end">
          <button type="button" onClick={p.onCancel}>
            {t('O-UI-CANCEL')}
          </button>
          <button type="submit" className="primary" disabled={!outcome || p.busy}>
            {action('O-UI-CLOSE')}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Ctrl+1 doğrudan 112: gerekçe zorunlu. */
export function EscalateDialog(p: { busy: boolean; onSubmit(reason: string): void; onCancel(): void }) {
  const [reason, setReason] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="dialog-backdrop">
      <form
        className="dialog danger-border"
        role="dialog"
        aria-modal="true"
        aria-labelledby="esc-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) p.onSubmit(reason.trim());
        }}
      >
        <h2 id="esc-title">{t('O-UI-112')}</h2>
        <label htmlFor="esc-reason">{t('O-UI-112-REASON')}</label>
        <textarea
          id="esc-reason"
          ref={ref}
          value={reason}
          maxLength={500}
          rows={2}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (reason.trim()) p.onSubmit(reason.trim());
            }
          }}
        />
        <div className="row end">
          <button type="button" onClick={p.onCancel}>
            {t('O-UI-CANCEL')}
          </button>
          <button type="submit" className="danger" disabled={!reason.trim() || p.busy}>
            {action('O-UI-112')}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Telefon barı (T-051 softphone gelene kadar yer tutucu). */
export function PhoneBar() {
  return (
    <footer className="phonebar" aria-label={t('O-UI-PHONE')}>
      <strong>{t('O-UI-PHONE')}</strong>
      <span className="muted">{t('O-UI-PHONE-NONE')}</span>
    </footer>
  );
}
