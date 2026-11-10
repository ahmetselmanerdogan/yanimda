import type { ChainStep } from '@yanimda/contracts';
import { useEffect, useRef, useState } from 'react';

import {
  CALL_ACTIVE,
  type CallView,
  type CloseOutcome,
  type DispatchScript,
  type OperatorStatus,
  type PersonCard,
  type QueueItem,
  SELF_STATUSES,
  type SelfStatus,
} from '../lib/api';
import { action, t } from '../lib/i18n';
import { clock } from '../lib/sla';
import type { DeviceState, PhoneSnapshot } from '../lib/softphone';

/**
 * Üst bar: başlık, canlı bağlantı, kuyruk sayısı, yeni olayda yanıp sönme (E-08), operatörün kendi durumu
 * (Müsait / Molada; gelen SOS aramaları yalnız müsait operatöre çalar).
 */
export function TopBar(p: {
  training?: boolean;
  operator: string;
  online: boolean;
  count: number;
  flash: string | null;
  /** İnceleme bulgusu 8: kuyrukta bekleyen gelen SOS aramaları. */
  inbound?: { queued: number; oldestQueuedSec: number | null };
  onLogout(): void;
  onSupervisor?(): void;
  onAdmin?(): void;
  myStatus?: OperatorStatus | null;
  onMyStatus?(s: SelfStatus): void;
}) {
  return (
    <header className={`topbar${p.flash ? ' flash' : ''}`}>
      <span className="brand">{t('O-UI-TITLE')}</span>
      {p.training && <span className="badge-training">{t('O-UI-TRAINING')}</span>}
      <span className={`conn ${p.online ? 'on' : 'off'}`} role="status">
        {p.online ? t('O-UI-ONLINE') : t('O-UI-OFFLINE')}
      </span>
      <span className="count">{t('O-UI-QUEUE', { n: p.count })}</span>
      <span className="flash-text" role="alert">
        {p.flash ?? ''}
      </span>
      {!!p.inbound?.queued && (
        <span className="inbound-waiting" role="status" data-testid="inbound-waiting">
          {t('O-UI-INBOUND-WAITING', { n: p.inbound.queued, wait: clock(p.inbound.oldestQueuedSec ?? 0) })}
        </span>
      )}
      <span className="spacer" />
      <span className="muted small">{t('O-UI-SHORTCUTS')}</span>
      {p.onMyStatus && (
        <span className="my-status" role="group" aria-label={t('O-UI-MY-STATUS')} data-testid="my-status">
          <span className="muted small">{t('O-UI-MY-STATUS')}</span>
          {SELF_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={p.myStatus === s ? `on ${s.toLowerCase()}` : ''}
              aria-pressed={p.myStatus === s}
              onClick={() => p.onMyStatus!(s)}
            >
              {t(`O-UI-SUP-STATUS-${s}`)}
            </button>
          ))}
          {p.myStatus === 'OFFLINE' && <span className="warn small">{t('O-UI-SUP-STATUS-OFFLINE')}</span>}
        </span>
      )}
      {p.onAdmin && (
        <button type="button" onClick={p.onAdmin}>
          {t('O-UI-ADM-TITLE')}
        </button>
      )}
      {p.onSupervisor && (
        <button type="button" onClick={p.onSupervisor}>
          {t('O-UI-SUP-TITLE')}
        </button>
      )}
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
/**
 * Kişi paneli. Tıbbi özet, adres ve kapı notu yalnız olay operatörde iken sunucudan gelir (T-040; her açılış audit'e
 * yazılır). Kopyalama engelli (E-03).
 */
export function PersonPanel({ item, card, mine }: { item: QueueItem | null; card?: PersonCard | null; mine: boolean }) {
  const [warn, setWarn] = useState(false);
  const med = card?.medical;
  const listRow = (code: string, xs: string[] | undefined) =>
    xs && xs.length > 0 ? (
      <>
        <dt>{t(code)}</dt>
        <dd>{xs.join(', ')}</dd>
      </>
    ) : null;
  return (
    <aside
      id="person-panel"
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
      {card && (card.address || card.doorAccessNote) && (
        <dl className="person-facts">
          {card.address && (
            <>
              <dt>{t('O-UI-ADDRESS')}</dt>
              <dd>{card.address}</dd>
            </>
          )}
          {card.doorAccessNote && (
            <>
              <dt>{t('O-UI-DOOR-NOTE')}</dt>
              <dd>{card.doorAccessNote}</dd>
            </>
          )}
        </dl>
      )}
      <h3>{t('O-UI-MEDICAL')}</h3>
      {!mine || card === undefined ? (
        <p className="muted">{t(mine ? 'O-UI-MEDICAL-NONE' : 'O-UI-MEDICAL-LOCKED')}</p>
      ) : med ? (
        <dl className="medical" data-testid="medical">
          {listRow('O-UI-CONDITIONS', med.conditions)}
          {listRow('O-UI-MEDICATIONS', med.medications)}
          {listRow('O-UI-ALLERGIES', med.allergies)}
          {med.bloodType && (
            <>
              <dt>{t('O-UI-BLOOD-TYPE')}</dt>
              <dd>{med.bloodType}</dd>
            </>
          )}
          {med.notes && (
            <>
              <dt>{t('O-UI-MEDICAL-NOTES')}</dt>
              <dd>{med.notes}</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="muted">{t('O-UI-MEDICAL-NONE')}</p>
      )}
      {warn && (
        <p className="warn" role="alert">
          {t('O-UI-COPY-BLOCKED')}
        </p>
      )}
    </aside>
  );
}

/**
 * 05 konuşma metni (katalog O-SCRIPT-*); eksik alan "bilinmiyor". 112 adımında metin sunucudan doldurulur (T-024:
 * kişi, yaş, konum, tıbbi alanlar); kopyala ve "okundu" zaman damgası adıma yazılır.
 */
export function ScriptPanel(p: {
  step: ChainStep;
  vars: Record<string, string | number | null | undefined>;
  dispatch?: DispatchScript | null;
  onRead(): void;
}) {
  const [copied, setCopied] = useState(false);
  const is112 = p.step.kind === 'CALL_112';
  const text = is112 && p.dispatch ? p.dispatch.text : t(p.step.script!, p.vars);
  return (
    <section className="script" aria-labelledby="script-title">
      <h3 id="script-title">{t('O-UI-SCRIPT')}</h3>
      <p>{text}</p>
      {is112 && (
        <div className="row">
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard?.writeText(text).then(() => {
                setCopied(true);
                if (!p.step.scriptReadAt) p.onRead();
              })
            }
          >
            {copied ? t('O-UI-COPIED') : t('O-UI-COPY')}
          </button>
          <button type="button" onClick={p.onRead} disabled={!!p.step.scriptReadAt}>
            {t('O-UI-SCRIPT-READ')}
          </button>
        </div>
      )}
    </section>
  );
}

const OUTCOMES: CloseOutcome[] = ['OK', 'FALSE_ALARM', 'UNREACHABLE', 'TEST', 'EMERGENCY'];

export const DEFAULT_FOLLOW_UP_HOURS = 24;

/**
 * E-07 kapatma: sonuç zorunlu, not ≤ 2000, takip araması (varsayılan 24 saat; EMERGENCY'de zorunlu). Acil teyitli
 * olay yalnız EMERGENCY ile.
 */
export function ClosePanel(p: {
  allowed: CloseOutcome[];
  initialNote: string;
  busy: boolean;
  onSubmit(outcome: CloseOutcome, note: string, followUpAfterHours?: number): void;
  onCancel(): void;
}) {
  const choices = OUTCOMES.filter((o) => p.allowed.includes(o));
  const [outcome, setOutcome] = useState<CloseOutcome | null>(choices.length === 1 ? choices[0]! : null);
  const [note, setNote] = useState(p.initialNote);
  const [followUp, setFollowUp] = useState(false);
  const [hours, setHours] = useState(DEFAULT_FOLLOW_UP_HOURS);
  const forced = outcome === 'EMERGENCY';
  const plan = forced || followUp;
  const hoursOk = Number.isInteger(hours) && hours >= 1 && hours <= 168;
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
          if (outcome && (!plan || hoursOk)) p.onSubmit(outcome, note.trim(), plan ? hours : undefined);
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
        <div className="row">
          <label className="radio">
            <input type="checkbox" checked={plan} disabled={forced} onChange={(e) => setFollowUp(e.target.checked)} />
            {t('O-UI-FOLLOWUP-PLAN')}
          </label>
          {plan && (
            <label className="hours">
              {t('O-UI-FOLLOWUP-HOURS')}
              <input type="number" min={1} max={168} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
            </label>
          )}
        </div>
        {forced && <p className="muted small">{t('O-UI-FOLLOWUP-REQUIRED')}</p>}
        {plan && hoursOk && <p className="muted small">{t('O-UI-FOLLOWUP', { hours })}</p>}
        <div className="row end">
          <button type="button" onClick={p.onCancel}>
            {t('O-UI-CANCEL')}
          </button>
          <button type="submit" className="primary" disabled={!outcome || (plan && !hoursOk) || p.busy}>
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

const DEVICE_TEXT: Record<DeviceState, string> = {
  starting: 'O-UI-PHONE-STARTING',
  'mic-denied': 'O-UI-PHONE-MIC-DENIED',
  'mic-none': 'O-UI-PHONE-MIC-NONE',
  ready: 'O-UI-PHONE-READY',
  fake: 'O-UI-PHONE-FAKE',
  unavailable: 'O-UI-PHONE-NONE',
  error: 'O-UI-PHONE-ERROR',
};
const DEVICE_TONE: Record<DeviceState, string> = {
  starting: 'muted',
  'mic-denied': 'warn',
  'mic-none': 'warn',
  ready: 'ok',
  fake: 'muted',
  unavailable: 'muted',
  error: 'warn',
};

const mmss = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

/**
 * T-051 telefon barı: cihaz durumu (mikrofon izni girişte), süren görüşmenin durumu ve süresi, beklet / devam,
 * konferansa aile ekle, aramayı bitir. Görüşme bilgisi sunucudaki arama kaydından (numara yok). Gelen SOS araması
 * çalarken Cevapla / Reddet (reddedilen ya da cevapsız arama sıradaki müsait operatöre geçer); arayanın açık olayı
 * varsa "Olayı aç".
 */
export function PhoneBar(p: {
  phone: PhoneSnapshot;
  call: CallView | null;
  now: number;
  busy: boolean;
  /** Son gelen SOS aramasının olayı (çalarken ve görüşürken). */
  inboundEventId?: string | null;
  onHold(on: boolean): void;
  onAddFamily(): void;
  onHangup(): void;
  onAccept?(): void;
  onReject?(): void;
  onOpenEvent?(eventId: string): void;
}) {
  const { call } = p;
  // Süre: görüşmenin "sürüyor"a geçtiği an (istemcide ilk görüldüğü an) başlar.
  const [since, setSince] = useState<{ id: string; at: number } | null>(null);
  const talking = call?.status === 'in-progress';
  useEffect(() => {
    if (talking && call && since?.id !== call.id) setSince({ id: call.id, at: Date.now() });
  }, [talking, call, since?.id]);
  const active = !!call && CALL_ACTIVE.includes(call.status);
  const elapsed = talking && since?.id === call!.id ? Math.max(0, Math.floor((p.now - since.at) / 1000)) : null;
  const ringing = p.phone.incoming ?? null;
  const inboundTalking = !!p.phone.inbound && p.phone.connected;
  const inboundEvent = ringing ? ringing.eventId : inboundTalking ? (p.inboundEventId ?? null) : null;
  return (
    <footer className="phonebar" aria-label={t('O-UI-PHONE')}>
      <strong>{t('O-UI-PHONE')}</strong>
      <span className={`phone-device ${DEVICE_TONE[p.phone.device]}`} data-testid="phone-device">
        {t(DEVICE_TEXT[p.phone.device])}
      </span>
      {ringing && (
        <span className="phone-inbound" role="alert" data-testid="phone-inbound">
          <strong>{t('O-UI-INBOUND')}</strong>
          <span>{t(ringing.eventId ? 'O-UI-INBOUND-EVENT' : 'O-UI-INBOUND-UNKNOWN')}</span>
          <button type="button" className="ok" onClick={p.onAccept}>
            {t('O-UI-INBOUND-ACCEPT')}
          </button>
          <button type="button" onClick={p.onReject}>
            {t('O-UI-INBOUND-REJECT')}
          </button>
        </span>
      )}
      {inboundEvent && p.onOpenEvent && (
        <button type="button" onClick={() => p.onOpenEvent!(inboundEvent)}>
          {action('O-UI-INBOUND-EVENT')}
        </button>
      )}
      <span className="phone-call" role="status" aria-live="polite" data-testid="phone-call">
        {inboundTalking && !active ? (
          <span>{t('O-UI-INBOUND-TALKING')}</span>
        ) : call && active ? (
          <>
            <span>{t(`O-CALL-${call.status}`)}</span>
            {elapsed !== null && <span className="phone-time">{mmss(elapsed)}</span>}
            {call.held && <span className="badge-held">{t('O-UI-PHONE-HELD')}</span>}
            {!!call.parties && <span className="muted">{t('O-UI-PHONE-PARTIES', { n: call.parties })}</span>}
          </>
        ) : (
          <span className="muted">{t('O-UI-PHONE-IDLE')}</span>
        )}
      </span>
      <span className="spacer" />
      <button type="button" disabled={!talking || p.busy} onClick={() => p.onHold(!call?.held)}>
        {t(call?.held ? 'O-UI-PHONE-RESUME' : 'O-UI-PHONE-HOLD')}
      </button>
      <button type="button" disabled={!talking || p.busy} onClick={p.onAddFamily}>
        {t('O-UI-PHONE-ADD-FAMILY')}
      </button>
      <button type="button" className="danger" disabled={(!active && !inboundTalking) || p.busy} onClick={p.onHangup}>
        {t('O-UI-PHONE-HANGUP')}
      </button>
    </footer>
  );
}
